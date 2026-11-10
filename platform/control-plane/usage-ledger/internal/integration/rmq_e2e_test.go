package integration_test

// RocketMQ 传输端到端（真 PG + 真 broker + 真 proxy gRPC，skip 可见——同仓库惯例）。
//
// 前置（2026-08-26 实测链路）：
//   - LUMO_TEST_PG_DSN：真 PG（standalone 拓扑 15432）；
//   - LUMO_TEST_RMQ_ENDPOINT：proxy gRPC 端点（standalone 拓扑 8081——注意不是
//     namesrv 9876/19876：v5 客户端走 gRPC，broker 须以 mqproxy -n 起代理）；
//   - 6 个 usage-events-* topic 已预建（TestMain 会清空重建；broker
//     autoCreateTopicEnable 只救发送，不救启动期路由查询——topic 必须先于
//     producer.Start 存在）。
//
// 隔离策略：TestMain 清空重建闭集 topic（历史不跨运行累积）+ 每测试独立 PG schema +
// 独立消费组 + 断言按本运行唯一 event_key 前缀过滤。

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	rmq "github.com/apache/rocketmq-clients/golang/v5"
	"github.com/apache/rocketmq-clients/golang/v5/credentials"
	v2 "github.com/apache/rocketmq-clients/golang/v5/protocol/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	"github.com/lumo-harness/platform/usage-ledger/internal/ledger"
	"github.com/lumo-harness/platform/usage-ledger/internal/rmqconsume"
	"github.com/lumo-harness/platform/usage-ledger/internal/rmqpublish"
)

// TestMain：e2e 前清空重建闭集 topic。**为什么必须**：broker 保留全部历史，而新
// 消费组会重放全部保留历史（实测，设计说明 §8.3）——不清则历史随每轮测试单调
// 累积，新组的重放预算线性膨胀，套件最终必然超时（红过两次才认清）。经 docker
// exec mqadmin（容器由 resolveBrokerContainer 解析：显式变量 > compose 服务标签反查，
// 见其注释）；不可用则警告降级（套件变慢但语义不变）。LUMO_TEST_RMQ_RESET=0 可显式关闭。
func TestMain(m *testing.M) {
	// SDK 在后台创建连接时无锁读取这个进程级开关。只在启动任何客户端前设置，
	// 不在 producer/consumer helper 中重写，否则会与已有客户端的拨号产生 data race。
	rmq.EnableSsl = false // 本地 proxy TLS permissive；生产 TLS 随 helm 形态
	if endpoint := os.Getenv("LUMO_TEST_RMQ_ENDPOINT"); endpoint != "" {
		topics, err := rmqpublish.Topics(rmqpublish.TopicPrefixDefault)
		if err != nil {
			fmt.Fprintln(os.Stderr, "构造 RocketMQ topics:", err)
			os.Exit(1)
		}
		if os.Getenv("LUMO_TEST_RMQ_RESET") != "0" {
			if container := resolveBrokerContainer(); container == "" {
				fmt.Fprintln(os.Stderr, "警告: 无法确定 rocketmq broker 容器，跳过 topic 重置"+
					"（新消费组会重放全部保留历史，套件可能因此超时）；"+
					"设置 LUMO_TEST_RMQ_CONTAINER 可显式指定")
			} else {
				resetTopics(container, topics)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		err = waitForTopicRoutes(ctx, endpoint, topics)
		cancel()
		if err != nil {
			fmt.Fprintln(os.Stderr, "RocketMQ topic 路由未就绪:", err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

// resolveBrokerContainer 决定用哪个容器跑 mqadmin。
//
// 显式设置 LUMO_TEST_RMQ_CONTAINER 时以它为准。否则按 compose 服务标签反查**正在运行**
// 的 broker。默认值曾经写死成 standalone 的容器名，而 cluster 拓扑下那是另一个名字——
// 于是 cluster 验收里重置静默退化成警告，历史照样跨运行累积，套件最终超时（正是上面
// TestMain 注释说的那个失败形态）。
//
// 反查不到（非 compose 部署 / docker 不可用 / broker 未起）返回空串；查到多个则无法从
// 容器名判断该清哪一个（两个拓扑可能同时起着），同样返回空串并点名候选与变量，不猜。
func resolveBrokerContainer() string {
	if explicit := os.Getenv("LUMO_TEST_RMQ_CONTAINER"); explicit != "" {
		return explicit
	}
	out, err := exec.Command("docker", "ps",
		"--filter", "label=com.docker.compose.service=rocketmq",
		"--format", "{{.Names}}").Output()
	if err != nil {
		return ""
	}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		if name := strings.TrimSpace(line); name != "" {
			names = append(names, name)
		}
	}
	switch len(names) {
	case 1:
		return names[0]
	case 0:
		return ""
	default:
		fmt.Fprintf(os.Stderr,
			"警告: 发现多个 rocketmq 容器 %v，无法判断该重置哪一个；请设置 LUMO_TEST_RMQ_CONTAINER\n", names)
		return ""
	}
}

// resetTopics 删除并重建闭集 topic。mqadmin 不可用则警告降级（套件变慢但语义不变）。
func resetTopics(container string, topics []string) {
	for _, topic := range topics {
		for _, args := range [][]string{
			{"deleteTopic", "-n", "localhost:9876", "-c", "DefaultCluster", "-t", topic},
			{"updateTopic", "-n", "localhost:9876", "-c", "DefaultCluster", "-t", topic},
		} {
			cmd := exec.Command("docker", append([]string{"exec", container, "sh", "mqadmin"}, args...)...)
			if out, err := cmd.CombinedOutput(); err != nil {
				fmt.Fprintf(os.Stderr, "警告: topic 重置失败（%s %s，容器 %s）: %v\n%s",
					topic, args[0], container, err, out)
			}
		}
	}
}

// mqadmin 成功只证明 broker 配置写入成功。proxy 的 topic config 缓存可能在删除窗口
// 读到不存在的 topic，并在重建后继续返回 UNSPECIFIED（5.3.1 默认 20s 后异步刷新）。
// producer.Start 会接受这份路由，第一次 Send 才报消息类型不匹配。因此在启动 producer
// 之前，通过它实际使用的 gRPC 端点等待所有队列恢复 NORMAL；不发送探针消息污染断言。
func waitForTopicRoutes(ctx context.Context, endpoint string, topics []string) error {
	host, portText, err := net.SplitHostPort(endpoint)
	if err != nil {
		return fmt.Errorf("解析 endpoint %q: %w", endpoint, err)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return fmt.Errorf("endpoint %q 的端口无效", endpoint)
	}
	scheme := v2.AddressScheme_DOMAIN_NAME
	if ip := net.ParseIP(host); ip != nil {
		scheme = v2.AddressScheme_IPv6
		if ip.To4() != nil {
			scheme = v2.AddressScheme_IPv4
		}
	}
	conn, err := grpc.NewClient(endpoint, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer conn.Close()
	client := v2.NewMessagingServiceClient(conn)
	endpoints := &v2.Endpoints{Scheme: scheme, Addresses: []*v2.Address{{Host: host, Port: int32(port)}}}
	ctx = metadata.AppendToOutgoingContext(ctx, "x-mq-client-id", fmt.Sprintf("lumo-rmq-readiness-%d", time.Now().UnixNano()))
	var pending []string
	for {
		pending = nil
		for _, topic := range topics {
			queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			response, queryErr := client.QueryRoute(queryCtx, &v2.QueryRouteRequest{
				Topic: &v2.Resource{Name: topic}, Endpoints: endpoints,
			})
			cancel()
			if queryErr != nil {
				pending = append(pending, fmt.Sprintf("%s: %v", topic, queryErr))
				continue
			}
			if response.GetStatus().GetCode() != v2.Code_OK || len(response.GetMessageQueues()) == 0 {
				pending = append(pending, fmt.Sprintf("%s: %v, queues=%d", topic, response.GetStatus(), len(response.GetMessageQueues())))
				continue
			}
			for _, queue := range response.GetMessageQueues() {
				normal := false
				for _, messageType := range queue.GetAcceptMessageTypes() {
					normal = normal || messageType == v2.MessageType_NORMAL
				}
				if !normal {
					pending = append(pending, fmt.Sprintf("%s: queue=%d accept=%v", topic, queue.GetId(), queue.GetAcceptMessageTypes()))
					break
				}
			}
		}
		if len(pending) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %s", ctx.Err(), strings.Join(pending, "; "))
		case <-time.After(time.Second):
		}
	}
}

func rmqEndpoint(t *testing.T) string {
	t.Helper()
	ep := os.Getenv("LUMO_TEST_RMQ_ENDPOINT")
	if ep == "" {
		t.Skip("LUMO_TEST_RMQ_ENDPOINT 未设置，跳过 RocketMQ 传输 e2e（需 standalone 拓扑 mqproxy gRPC 8081）")
	}
	return ep
}

func newProducer(t *testing.T, endpoint string) rmq.Producer {
	t.Helper()
	p, err := rmq.NewProducer(&rmq.Config{
		Endpoint:    endpoint,
		Credentials: &credentials.SessionCredentials{AccessKey: "", AccessSecret: ""},
	}, rmq.WithTopics(mustTopics(t)...))
	if err != nil {
		t.Fatalf("NewProducer: %v", err)
	}
	if err := p.Start(); err != nil {
		t.Fatalf("producer.Start（topic 未预建？）: %v", err)
	}
	t.Cleanup(func() { _ = p.GracefulStop() })
	return p
}

func newSimpleConsumer(t *testing.T, endpoint, group string, topics ...string) rmq.SimpleConsumer {
	t.Helper()
	all, err := rmqconsume.SubscriptionExpressions(rmqpublish.TopicPrefixDefault)
	if err != nil {
		t.Fatalf("构造订阅: %v", err)
	}
	// SDK 每轮 Receive 从无序 map 重建 topic 列表，再按递增 index 选一个。
	// 单 topic 合同测试显式限定订阅，避免对其余空 topic 的长轮询耗尽预算。
	if len(topics) == 0 {
		t.Fatal("必须显式声明本测试实际发送的 topic")
	}
	subs := make(map[string]*rmq.FilterExpression, len(topics))
	for _, topic := range topics {
		filter, ok := all[topic]
		if !ok {
			t.Fatalf("topic 不在成本闭集: %s", topic)
		}
		subs[topic] = filter
	}
	sc, err := rmq.NewSimpleConsumer(&rmq.Config{
		Endpoint:      endpoint,
		ConsumerGroup: group,
		Credentials:   &credentials.SessionCredentials{AccessKey: "", AccessSecret: ""},
	},
		rmq.WithSimpleAwaitDuration(3*time.Second),
		rmq.WithSimpleSubscriptionExpressions(subs),
	)
	if err != nil {
		t.Fatalf("NewSimpleConsumer: %v", err)
	}
	if err := sc.Start(); err != nil {
		t.Fatalf("simpleConsumer.Start: %v", err)
	}
	t.Cleanup(func() { _ = sc.GracefulStop() })
	return sc
}

// observedConsumer 委托真实 broker Ack，只有其成功才记录消息身份；不模拟传输。
// 重放断言必须证明第二消费组读到并处理了原 messageId，不能只读首组已写好的行。
type observedConsumer struct {
	rmq.SimpleConsumer
	mu    sync.Mutex
	acked map[string]string
}

func observeConsumer(sc rmq.SimpleConsumer) *observedConsumer {
	return &observedConsumer{SimpleConsumer: sc, acked: make(map[string]string)}
}

func (sc *observedConsumer) Ack(ctx context.Context, message *rmq.MessageView) error {
	if err := sc.SimpleConsumer.Ack(ctx, message); err != nil {
		return err
	}
	sc.mu.Lock()
	sc.acked[message.GetProperties()["eventKey"]] = message.GetMessageId()
	sc.mu.Unlock()
	return nil
}

func (sc *observedConsumer) acknowledged(prefix string) map[string]string {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	result := make(map[string]string)
	for key, id := range sc.acked {
		if strings.HasPrefix(key, prefix) {
			result[key] = id
		}
	}
	return result
}

func runConsumer(t *testing.T, consumer *rmqconsume.Consumer) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = consumer.Run(ctx)
	}()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("消费循环未在取消后退出")
			}
		})
	}
	t.Cleanup(stop)
	return stop
}

func mustTopics(t *testing.T) []string {
	t.Helper()
	topics, err := rmqpublish.Topics(rmqpublish.TopicPrefixDefault)
	if err != nil {
		t.Fatalf("Topics: %v", err)
	}
	return topics
}

// outbox 表：DDL 真相源在 TS 侧 pg-meter.ts（published_at 列属于 Task 4 的
// ALTER）。测试自建仅为 schema 隔离；若与 TS 侧漂移，本 e2e 以「列不存在」红。
const outboxDDL = `
CREATE TABLE IF NOT EXISTS usage_event_outbox (
  seq          BIGSERIAL PRIMARY KEY,
  event_key    TEXT NOT NULL UNIQUE,
  payload      JSONB NOT NULL,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ
)`

func setupRMQ(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	endpoint := rmqEndpoint(t)
	schema := fmt.Sprintf("ul_rmq_%d", time.Now().UnixNano())
	base := testDSN(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("DSN 解析: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	admin, err := pgxpool.New(context.Background(), base)
	if err != nil {
		t.Fatalf("admin 连接: %v", err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	admin.Close()
	pool, err := pgxpool.New(context.Background(), u.String())
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)
	ctx := context.Background()
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("ledger.Init: %v", err)
	}
	if _, err := pool.Exec(ctx, outboxDDL); err != nil {
		t.Fatalf("建 outbox: %v", err)
	}
	return pool, endpoint
}

func e2eEvent(costType string) ledger.Event {
	e := ledger.Event{
		Context: ledger.Attribution{
			UserID: "u1", DeptID: "d1", Role: "viewer", ProjectID: "p1",
			AgentID: "a1", ComponentID: "c1", Feature: "kb:qa", SessionRef: "s1",
		},
		Qty: 12, TraceID: "tr-rmq-e2e", Emitter: "emitter:rmq-e2e", CostUSD: 0.5,
	}
	switch costType {
	case "llm.tokens":
		e.CostType, e.Unit = "llm.tokens", "tokens"
		tk := int64(12)
		e.Tokens, e.Model = &tk, "deepseek"
	case "connector.call":
		e.CostType, e.Unit = "connector.call", "call"
	case "seam.query":
		e.CostType, e.Unit = "seam.query", "rows"
	}
	return e
}

func seedOutbox(t *testing.T, pool *pgxpool.Pool, key string, ts time.Time, payload any) {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO usage_event_outbox (event_key, payload, ts) VALUES ($1, $2, $3)`,
		key, b, ts); err != nil {
		t.Fatalf("seed outbox: %v", err)
	}
}

func countPrefix(t *testing.T, pool *pgxpool.Pool, prefix string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM usage_ledger WHERE event_key LIKE $1`, prefix+"%").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func waitUntil(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("等待超时: %s", what)
}

// 判据 1/2/3：发 3 个事件 → publisher 上 broker → consumer 落账 3 行、事件时刻
// 保真；换新消费组重放（至少一次投递）→ 仍 3 行（event_key 幂等）。
func TestRMQTransportE2E(t *testing.T) {
	pool, endpoint := setupRMQ(t)
	ctx := context.Background()
	prefix := fmt.Sprintf("rmq-e2e-%d-", time.Now().UnixNano())
	// 事件时刻刻意取周期边界附近的三个不同时刻——账期门按事件时刻判，传输不得漂移
	seeded := []time.Time{
		time.Date(2026, 1, 6, 23, 59, 58, 0, time.UTC),
		time.Date(2026, 1, 7, 0, 0, 1, 0, time.UTC),
		time.Date(2026, 1, 7, 12, 0, 0, 0, time.UTC),
	}
	for i, ts := range seeded {
		seedOutbox(t, pool, fmt.Sprintf("%s%d", prefix, i), ts, e2eEvent("llm.tokens"))
	}

	pub := rmqpublish.New(pool, newProducer(t, endpoint), rmqpublish.TopicPrefixDefault, slog.New(slog.DiscardHandler))
	n, err := pub.PublishOnce(ctx)
	if err != nil || n != 3 {
		t.Fatalf("PublishOnce: n=%d err=%v（3 事件应整批发布）", n, err)
	}
	var marked int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM usage_event_outbox WHERE published_at IS NOT NULL`).Scan(&marked); err != nil || marked != 3 {
		t.Fatalf("published_at 标记数: %d err=%v want 3", marked, err)
	}

	// 第一消费组：新组重放该 topic 全部历史，本测试的 3 键必然在内。
	topic := rmqpublish.TopicFor(rmqpublish.TopicPrefixDefault, "llm.tokens")
	sc := observeConsumer(newSimpleConsumer(t, endpoint, fmt.Sprintf("ul-e2e-%d", time.Now().UnixNano()), topic))
	cons := rmqconsume.New(pool, sc, slog.New(slog.DiscardHandler))
	stop := runConsumer(t, cons)
	waitUntil(t, "3 事件落账并得到 broker Ack", 30*time.Second,
		func() bool { return countPrefix(t, pool, prefix) == 3 && len(sc.acknowledged(prefix)) == 3 })
	originalMessages := sc.acknowledged(prefix)

	for i, want := range seeded {
		var got time.Time
		if err := pool.QueryRow(ctx,
			`SELECT ts FROM usage_ledger WHERE event_key = $1`, fmt.Sprintf("%s%d", prefix, i)).Scan(&got); err != nil {
			t.Fatalf("读 ts（%d）: %v", i, err)
		}
		if !got.Equal(want) {
			t.Fatalf("事件时刻未保真（%d）: got %v want %v（outbox.ts=消息属性 ts=ledger.ts 三处必须同值）", i, got, want)
		}
	}
	stop()

	// 第二消费组重放同一批（至少一次投递的重复消费场景）→ 幂等键去重，行数不变
	sc2 := observeConsumer(newSimpleConsumer(t, endpoint, fmt.Sprintf("ul-e2e-replay-%d", time.Now().UnixNano()), topic))
	cons2 := rmqconsume.New(pool, sc2, slog.New(slog.DiscardHandler))
	stopReplay := runConsumer(t, cons2)
	waitUntil(t, "重放组确实处理并 Ack 原3个消息", 30*time.Second,
		func() bool { return len(sc2.acknowledged(prefix)) == 3 })
	stopReplay()
	for key, messageID := range originalMessages {
		if replayed := sc2.acknowledged(prefix)[key]; replayed != messageID || messageID == "" {
			t.Fatalf("重放消息身份不符: key=%s original=%s replay=%s", key, messageID, replayed)
		}
	}
	if n := countPrefix(t, pool, prefix); n != 3 {
		t.Fatalf("重放后前缀行数应仍为 3（event_key 幂等）, got %d", n)
	}
}

// 判据 5：批内毒丸（闭集外 costType → 目标 topic 不存在 → Send 失败）→ 整批
// 回滚不标记（含此前已发出的行——下轮重发，消费幂等兜底）。
func TestPublisherBatchFailureNoMark(t *testing.T) {
	pool, endpoint := setupRMQ(t)
	ctx := context.Background()
	prefix := fmt.Sprintf("rmq-batchfail-%d-", time.Now().UnixNano())
	seedOutbox(t, pool, prefix+"good", time.Now(), e2eEvent("llm.tokens"))
	// 毒丸：闭集外类型排在 good 之后（seq 更大）——good 已发出也必须不标记
	poison := e2eEvent("llm.tokens")
	poison.CostType = "made.up"
	seedOutbox(t, pool, prefix+"bad", time.Now(), poison)

	pub := rmqpublish.New(pool, newProducer(t, endpoint), rmqpublish.TopicPrefixDefault, slog.New(slog.DiscardHandler))
	if _, err := pub.PublishOnce(ctx); err == nil {
		t.Fatalf("含毒丸批次应失败（made.up 无 topic）")
	} else if !strings.Contains(err.Error(), "made.up") {
		t.Fatalf("错误应指向毒丸行: %v", err)
	}
	var unmarked int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM usage_event_outbox WHERE published_at IS NULL`).Scan(&unmarked); err != nil || unmarked != 2 {
		t.Fatalf("失败批次不得标记（整批回滚）: unmarked=%d err=%v want 2", unmarked, err)
	}
}

// 判据 6：消费侧校验拒绝——闭集外 payload（直接发上已存在 topic，绕过 publisher
// 的路由防线）→ 告警钩子触发、毒键零落账、队列不阻塞（Ack 后续消息照常消费）。
func TestConsumerRejectsPoison(t *testing.T) {
	pool, endpoint := setupRMQ(t)
	ctx := context.Background()
	producer := newProducer(t, endpoint)

	poisonKey := fmt.Sprintf("rmq-poison-%d", time.Now().UnixNano())
	poison := e2eEvent("llm.tokens")
	poison.CostType = "made.up" // 闭集外：topic 是 llm-tokens 但 payload 自称 made.up
	body, _ := json.Marshal(poison)
	topic := rmqpublish.TopicFor(rmqpublish.TopicPrefixDefault, "llm.tokens")
	msg := &rmq.Message{Topic: topic, Body: body}
	msg.SetKeys(poisonKey)
	msg.AddProperty("ts", time.Now().UTC().Format(time.RFC3339Nano))
	msg.AddProperty("eventKey", poisonKey)
	if _, err := producer.Send(ctx, msg); err != nil {
		t.Fatalf("发送毒丸: %v", err)
	}

	rejected := make(chan string, 1)
	sc := observeConsumer(newSimpleConsumer(t, endpoint, fmt.Sprintf("ul-poison-%d", time.Now().UnixNano()), topic))
	cons := rmqconsume.New(pool, sc, slog.New(slog.DiscardHandler),
		rmqconsume.WithOnReject(func(m string) {
			if strings.Contains(m, "eventKey="+poisonKey+"）") {
				select {
				case rejected <- m:
				default:
				}
			}
		}))
	stop := runConsumer(t, cons)

	var gotReject string
	waitUntil(t, "毒丸触发告警", 30*time.Second, func() bool {
		select {
		case gotReject = <-rejected:
			return true
		default:
			return false
		}
	})
	if !strings.Contains(gotReject, "made.up") || !strings.Contains(gotReject, poisonKey) {
		t.Fatalf("告警应指向毒丸: %s", gotReject)
	}
	waitUntil(t, "当前毒丸被 broker 确认 Ack", 30*time.Second,
		func() bool { return sc.acknowledged(poisonKey)[poisonKey] != "" })
	// 确认毒丸处理完成后再发正常事件，证明消费循环继续工作，不靠历史行通过。
	goodKey := poisonKey + "-after"
	seedOutbox(t, pool, goodKey, time.Now(), e2eEvent("llm.tokens"))
	pub := rmqpublish.New(pool, producer, rmqpublish.TopicPrefixDefault, slog.New(slog.DiscardHandler))
	if sent, err := pub.PublishOnce(ctx); err != nil || sent != 1 {
		t.Fatalf("毒丸后的正常事件发布失败: sent=%d err=%v", sent, err)
	}
	waitUntil(t, "毒丸后正常事件落账并 Ack", 30*time.Second, func() bool {
		return countPrefix(t, pool, goodKey) == 1 && sc.acknowledged(goodKey)[goodKey] != ""
	})
	stop()
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM usage_ledger WHERE event_key = $1`, poisonKey).Scan(&n); err != nil || n != 0 {
		t.Fatalf("毒丸不得落账: n=%d err=%v", n, err)
	}
}
