// Package rmqpublish 把 usage_event_outbox 的未发布事件搬上 RocketMQ（§6.4 异步
// 削峰的发布半边）。台账列清单单一真相源在 internal/manifest；本包只拥有「outbox →
// broker」这一段搬运语义，不碰 usage_ledger（那是 ledger 包的事）。
//
// at-least-once 的由来：发送在「行锁事务」内进行——发成功但事务未提交即崩溃 →
// 下轮重发同一 event_key → 消费侧 ON CONFLICT DO NOTHING 去重。安全的前提是
// 幂等键贯穿全链（消息 keys + property eventKey），消费侧不得自造键。
package rmqpublish

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	rmq "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/usage-ledger/internal/manifest"
)

// TopicPrefixDefault Standalone/Cluster 形态的 topic 前缀（§8.3：usage-events-*）。
const TopicPrefixDefault = "usage-events-"

// DefaultBatchSize / DefaultPollInterval 与 TS 侧 drainOnce 的 100/1s 对齐——
// 两条装配路径的背压节奏不应悄悄分叉。
const (
	DefaultBatchSize    = 100
	DefaultPollInterval = time.Second
)

// TopicFor 成本类型 → topic 名。**点号非法**（broker 合法字符集 ^[%|a-zA-Z0-9_-]+$，
// 2026-08-26 真机实证，commit 15b4e94），cost_type 中的 `.` 统一映射 `-`：
// llm.tokens → usage-events-llm-tokens。发布与消费两侧必须用同一函数——两处手写
// 就是第二真相源。
func TopicFor(prefix, costType string) string {
	return prefix + strings.ReplaceAll(costType, ".", "-")
}

// Topics 闭集对应的全部 topic。
func Topics(prefix string) ([]string, error) {
	costTypes, err := manifest.CostTypes()
	if err != nil {
		return nil, err
	}
	topics := make([]string, 0, len(costTypes))
	for t := range costTypes {
		topics = append(topics, TopicFor(prefix, t))
	}
	return topics, nil
}

// Publisher outbox → RocketMQ 搬运器。
type Publisher struct {
	pool        *pgxpool.Pool
	producer    rmq.Producer
	topicPrefix string
	batchSize   int
	log         *slog.Logger
	// waitedOutbox：42P01（outbox 未建）只提示一次——表由 TS 侧 metering 插件
	// 首启建（DDL 真相源在 pg-meter.ts，Go 不重复建表：第二真相源比晚几秒更贵）。
	waitedOutbox bool
}

func New(pool *pgxpool.Pool, producer rmq.Producer, topicPrefix string, log *slog.Logger) *Publisher {
	if topicPrefix == "" {
		topicPrefix = TopicPrefixDefault
	}
	if log == nil {
		log = slog.Default()
	}
	return &Publisher{
		pool:        pool,
		producer:    producer,
		topicPrefix: topicPrefix,
		batchSize:   DefaultBatchSize,
		log:         log,
	}
}

type outboxRow struct {
	Seq      int64
	Ts       time.Time
	EventKey string
	Payload  []byte
}

// PublishOnce 一轮「锁批 → 逐条发布 → 整批标记」。
//
// 事务边界覆盖发送：任一条失败（含毒丸 payload 的 costType 落在闭集外——目标
// topic 不存在，Send 直接失败）整批 ROLLBACK 不标记，下轮重试。毒丸阻塞其后
// 批次是**已知取舍**，与 TS 侧 drainOnce 同语义同注释（§6 已知不足），不改。
func (p *Publisher) PublishOnce(ctx context.Context) (int, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("开启发布事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // 已提交时为空操作

	rows, err := tx.Query(ctx, `
		SELECT seq, ts, event_key, payload FROM usage_event_outbox
		WHERE published_at IS NULL
		ORDER BY seq
		LIMIT $1
		FOR UPDATE SKIP LOCKED`, p.batchSize)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			// outbox 表尚未存在（拓扑未齐：TS 侧 metering 插件未首启）。等表
			// 而不是建表——见 Publisher.waitedOutbox 注释。
			if !p.waitedOutbox {
				p.waitedOutbox = true
				p.log.Info("usage_event_outbox 尚未创建（TS 侧 metering 插件首启时建表），publisher 待命")
			}
			return 0, nil
		}
		return 0, fmt.Errorf("取未发布批次失败: %w", err)
	}
	batch, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (outboxRow, error) {
		var r outboxRow
		if err := row.Scan(&r.Seq, &r.Ts, &r.EventKey, &r.Payload); err != nil {
			return r, err
		}
		return r, nil
	})
	if err != nil {
		return 0, fmt.Errorf("扫描未发布批次失败: %w", err)
	}
	if len(batch) == 0 {
		return 0, nil
	}

	costTypes, err := manifest.CostTypes()
	if err != nil {
		return 0, err
	}
	seqs := make([]int64, 0, len(batch))
	for _, r := range batch {
		// payload 只窥视 costType 做路由；Body 原样透传（事件保真，不做任何改写）。
		var peek struct {
			CostType string `json:"costType"`
		}
		if err := json.Unmarshal(r.Payload, &peek); err != nil {
			return 0, fmt.Errorf("outbox seq=%d payload 非法 JSON（毒丸，阻塞批次）: %w", r.Seq, err)
		}
		if _, ok := costTypes[peek.CostType]; !ok {
			return 0, fmt.Errorf("outbox seq=%d costType=%q 在闭集外（毒丸，阻塞批次）", r.Seq, peek.CostType)
		}
		msg := &rmq.Message{Topic: TopicFor(p.topicPrefix, peek.CostType), Body: r.Payload}
		msg.SetKeys(r.EventKey)
		// 不变式②的传输半边：事件时刻随消息走，消费端**禁止**取 now()。
		msg.AddProperty("ts", r.Ts.UTC().Format(time.RFC3339Nano))
		msg.AddProperty("eventKey", r.EventKey)
		if _, err := p.producer.Send(ctx, msg); err != nil {
			// 崩溃/失败窗口：本条之前可能已发出——重发由消费幂等兜底（至少一次）。
			return 0, fmt.Errorf("发布 outbox seq=%d 到 %s 失败: %w", r.Seq, msg.Topic, err)
		}
		seqs = append(seqs, r.Seq)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE usage_event_outbox SET published_at = now() WHERE seq = ANY($1::bigint[])`, seqs); err != nil {
		return 0, fmt.Errorf("标记 published_at 失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("提交发布事务失败: %w", err)
	}
	return len(batch), nil
}

// Run 轮询搬运直到 ctx 取消。错误只记日志不退出——outbox 不标记自然积压，
// 积压是 §20 已立的可见状态，不是静默失败。
func (p *Publisher) Run(ctx context.Context, pollInterval time.Duration) error {
	if pollInterval <= 0 {
		pollInterval = DefaultPollInterval
	}
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		n, err := p.PublishOnce(ctx)
		if err != nil {
			p.log.Error("发布轮次失败", "err", err)
		} else if n > 0 {
			p.log.Info("发布批次完成", "count", n)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}
