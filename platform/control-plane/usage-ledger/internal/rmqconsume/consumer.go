// Package rmqconsume 消费 RocketMQ 上的计量事件落账（§6.4 异步削峰的消费半边）。
// 校验 → ledger.BatchInsert（幂等）→ Ack；校验失败 → 告警 + Ack（毒丸不得阻塞
// 队列——设计说明 §7「不做 DLQ 持久化，死信只告警不落库」）；落账失败（PG 抖动）
// → 不 Ack，由 invisibleDuration 到期自然重投，重试上限后告警放弃并 Ack。
package rmqconsume

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	rmq "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/usage-ledger/internal/ledger"
	"github.com/lumo-harness/platform/usage-ledger/internal/rmqpublish"
)

const (
	// DefaultMaxMessageNum / DefaultInvisibleDuration 单批拉取量与不可见时长。
	// invisibleDuration 必须 > 20s（v5 客户端约束）；重投即天然重试。
	DefaultMaxMessageNum = 16
	DefaultInvisibleTime = 30 * time.Second
	defaultMaxRetry      = 5
)

// ErrNoNewMessage broker 以错误形态告知「无新消息」（v5 简单消费者语义）——
// 不是故障，是空批次。
const ErrNoNewMessage = "MESSAGE_NOT_FOUND"

// Consumer RocketMQ → usage_ledger 消费者。
type Consumer struct {
	pool          *pgxpool.Pool
	consumer      rmq.SimpleConsumer
	maxMessageNum int32
	invisibleTime time.Duration
	maxRetry      int
	log           *slog.Logger
	// onReject 毒丸/坏消息告警钩子。生产打 slog；测试注入捕获列表。
	// 告警不是可选装饰：校验拒绝若静默，闭集就是一扇没人看着的门。
	onReject func(msg string)

	// attempts 落账瞬时失败的在途重试计数（messageId → 次数）。
	// 仅进程内：重启归零无碍——重投由 broker invisibleDuration 驱动，上限只是
	// 「告警并放弃」的触发线，不是正确性依赖。
	attempts map[string]int
}

type Option func(*Consumer)

// WithOnReject 注入拒绝告警钩子（测试用）。
func WithOnReject(f func(msg string)) Option {
	return func(c *Consumer) { c.onReject = f }
}

func New(pool *pgxpool.Pool, sc rmq.SimpleConsumer, log *slog.Logger, opts ...Option) *Consumer {
	c := &Consumer{
		pool:          pool,
		consumer:      sc,
		maxMessageNum: DefaultMaxMessageNum,
		invisibleTime: DefaultInvisibleTime,
		maxRetry:      defaultMaxRetry,
		log:           slog.Default(),
		attempts:      map[string]int{},
	}
	if log != nil {
		c.log = log
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// SubscriptionExpressions 按 topic 前缀构造全闭集订阅（与 publisher.Topics 同源
// ——topic 命名规则只活在 rmqpublish.TopicFor 一处）。
func SubscriptionExpressions(prefix string) (map[string]*rmq.FilterExpression, error) {
	topics, err := rmqpublish.Topics(prefix)
	if err != nil {
		return nil, err
	}
	subs := make(map[string]*rmq.FilterExpression, len(topics))
	for _, t := range topics {
		subs[t] = rmq.SUB_ALL
	}
	return subs, nil
}

// Run 拉取循环直到 ctx 取消。
func (c *Consumer) Run(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		mvs, err := c.consumer.Receive(ctx, c.maxMessageNum, c.invisibleTime)
		if err != nil {
			// 空批次有两种形态（实测）：MESSAGE_NOT_FOUND 与 awaitDuration 到期的
			// DEADLINE_EXCEEDED——都不是故障。
			if strings.Contains(err.Error(), ErrNoNewMessage) ||
				strings.Contains(err.Error(), "DEADLINE_EXCEEDED") {
				continue
			}
			c.log.Warn("Receive 失败（退避重试）", "err", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
			continue
		}
		for _, mv := range mvs {
			c.handle(ctx, mv)
		}
	}
}

func (c *Consumer) reject(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if c.onReject != nil {
		c.onReject(msg)
	}
	c.log.Error("计量事件被拒绝入账", "reason", msg)
}

func (c *Consumer) handle(ctx context.Context, mv *rmq.MessageView) {
	id := mv.GetMessageId()
	props := mv.GetProperties()
	eventKey := props["eventKey"]
	if eventKey == "" && len(mv.GetKeys()) > 0 {
		eventKey = mv.GetKeys()[0]
	}
	ack := func() {
		if err := c.consumer.Ack(ctx, mv); err != nil {
			c.log.Warn("Ack 失败（将因不可见到期重投，消费幂等兜底）", "messageId", id, "err", err)
		}
	}

	// 不变式②：事件时刻只认传输属性，消费端禁止取 now()。缺属性 = 传输契约被
	// 破坏，按毒丸处理（告警 + Ack），而不是拿当前时间顶上——那会让账期漂移。
	tsStr := props["ts"]
	var ts time.Time
	if eventKey == "" || tsStr == "" {
		c.reject("消息缺 eventKey/ts 属性（messageId=%s）——传输契约被破坏", id)
		ack()
		return
	}
	ts, err := time.Parse(time.RFC3339Nano, tsStr)
	if err != nil {
		c.reject("ts 属性不可解析（messageId=%s, ts=%q）: %v", id, tsStr, err)
		ack()
		return
	}

	var e ledger.Event
	if err := json.Unmarshal(mv.GetBody(), &e); err != nil {
		c.reject("payload 非法 JSON（messageId=%s, eventKey=%s）: %v", id, eventKey, err)
		ack()
		return
	}
	if err := ledger.ValidateEvent(e); err != nil {
		c.reject("校验失败（messageId=%s, eventKey=%s）: %v", id, eventKey, err)
		ack()
		return
	}

	if err := ledger.BatchInsert(ctx, c.pool, []ledger.Row{{Ts: ts, EventKey: eventKey, E: e}}); err != nil {
		c.attempts[id]++
		if c.attempts[id] >= c.maxRetry {
			delete(c.attempts, id)
			c.reject("落账连续 %d 次失败，放弃该消息（messageId=%s, eventKey=%s）: %v",
				c.maxRetry, id, eventKey, err)
			ack()
			return
		}
		c.log.Warn("落账失败，等不可见到期重投", "messageId", id, "attempt", c.attempts[id], "err", err)
		return // 不 Ack：invisibleDuration 到期重投
	}
	delete(c.attempts, id)
	ack()
}
