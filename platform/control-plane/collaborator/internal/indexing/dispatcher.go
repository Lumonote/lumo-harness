package indexing

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// Source 是调度器需要的 outbox 侧能力，刻意窄于 *store.Store。
//
// 依赖方向是 indexing → store（反向写就成环），所以行类型 PendingPublish 住在 store。
// 这里只声明用到的四个方法：换存储、加缓存、写测试替身都不用改调度逻辑。
type Source interface {
	PendingPublishes(ctx context.Context, limit, maxAttempts int) ([]store.PendingPublish, error)
	MarkDispatched(ctx context.Context, id domain.DocumentID, version int) error
	// RecordDispatchFailure 返回累加后的 attempts，0 表示该行已被确认、无需记录。
	RecordDispatchFailure(ctx context.Context, id domain.DocumentID, version int, reason string, maxAttempts int, terminal bool) (int, error)
}

// 编译期确认生产实现满足接口（*store.Store 就是真库实现）。
var _ Source = (*store.Store)(nil)

// 默认时序。poll 取 2s：发布是低频人工动作，秒级延迟完全够用，而更短的轮询只是
// 让空闲实例持续打数据库。
const (
	defaultPoll        = 2 * time.Second
	defaultLimit       = 50
	defaultMaxAttempts = 8
)

// Report 一轮派发的结果，用于日志与测试断言。
type Report struct {
	// Scanned 本轮取到的待派发行数。
	Scanned int
	// Indexed 成功写入下游并已确认的行数。
	Indexed int
	// Rejected 载荷被判定为终态非法的行数（不会再被扫描）。
	Rejected int
	// Failed 可重试失败的行数（仍在队列里，下一轮再试）。
	Failed int
}

// Dispatcher 把发布 outbox 投影进知识库 seam。
//
// 幂等性来自两侧的配合，缺一不可：
//   - 上游：确认（MarkDispatched）在写入成功之后，崩溃/失败只是重扫，不是丢失。
//   - 下游：ingest 按 (doc_id, chunk_index) upsert 且分片是内容的纯函数，
//     所以重扫写入的是同一份内容。
//
// 因此这里**不需要**认领列、租约或分布式锁。多副本同时派发同一行是允许的：
// 结果是重复的幂等写，而不是重复的索引记录。
type Dispatcher struct {
	source       Source
	indexer      Indexer
	model        string
	chunkOptions ChunkOptions
	maxAttempts  int
	poll         time.Duration
	limit        int
	onError      func(error)
	onCycle      func(Report)
}

// NewDispatcher 构造调度器。embeddingModel 为空时直接报错。
//
// 为什么不给默认值：下游 query 按 embedding_model 过滤，模型标识写错的后果不是报错
// 而是**检索永远查不到**（一条静默的、无法从日志发现的功能失效）。宁可启动失败。
func NewDispatcher(source Source, indexer Indexer, embeddingModel string) (*Dispatcher, error) {
	if source == nil {
		return nil, fmt.Errorf("indexing: 未提供 outbox 来源")
	}
	if indexer == nil {
		return nil, fmt.Errorf("indexing: 未提供知识库下游")
	}
	if strings.TrimSpace(embeddingModel) == "" {
		return nil, fmt.Errorf("indexing: 未配置 embedding 模型标识（与知识库 Provider 必须一致）")
	}
	return &Dispatcher{
		source:       source,
		indexer:      indexer,
		model:        embeddingModel,
		chunkOptions: DefaultChunkOptions(),
		maxAttempts:  defaultMaxAttempts,
		poll:         defaultPoll,
		limit:        defaultLimit,
	}, nil
}

// SetTiming 调整轮询间隔与单轮批量上限。
func (d *Dispatcher) SetTiming(poll time.Duration, limit int) {
	if poll > 0 {
		d.poll = poll
	}
	if limit > 0 {
		d.limit = limit
	}
}

// SetMaxAttempts 调整单行重试上限（达到上限即停滞，不再被扫描）。
func (d *Dispatcher) SetMaxAttempts(n int) {
	if n > 0 {
		d.maxAttempts = n
	}
}

// SetChunkOptions 调整分片参数。
func (d *Dispatcher) SetChunkOptions(opts ChunkOptions) { d.chunkOptions = opts }

// SetErrorHandler 接收运维级错误（扫描失败、确认失败、记录失败等）。未设置时静默。
func (d *Dispatcher) SetErrorHandler(handler func(error)) { d.onError = handler }

// SetCycleHandler 接收每轮统计。与错误分开：统计是常态日志，走错误通道会让
// 正常的每轮汇报被当成故障。
func (d *Dispatcher) SetCycleHandler(handler func(Report)) { d.onCycle = handler }

// Cycle 执行一轮：取待派发行 → 分片 → 写入 → 确认。
//
// 单行失败**不中断本轮**：中断会让一条坏行挡住它后面所有新发布（队头阻塞），
// 而坏行自身会被 attempts 上限收敛掉。
func (d *Dispatcher) Cycle(ctx context.Context) Report {
	var report Report
	rows, err := d.source.PendingPublishes(ctx, d.limit, d.maxAttempts)
	if err != nil {
		d.report(fmt.Errorf("indexing: 读取待派发发布失败: %w", err))
		return report
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return report
		}
		report.Scanned++

		entry, buildErr := d.build(row)
		if buildErr != nil {
			d.fail(ctx, row, buildErr, true)
			report.Rejected++
			continue
		}
		if ingestErr := d.indexer.Ingest(ctx, entry); ingestErr != nil {
			terminal := IsRejected(ingestErr)
			d.fail(ctx, row, ingestErr, terminal)
			if terminal {
				report.Rejected++
			} else {
				report.Failed++
			}
			continue
		}
		// 确认失败只记日志：下一轮会重扫同一行，下游 upsert 幂等，结果是重复写而非丢失。
		if err := d.source.MarkDispatched(ctx, row.DocID, row.Version); err != nil {
			d.report(fmt.Errorf("indexing: 确认发布失败（文档 %s v%d）: %w", row.DocID, row.Version, err))
			report.Failed++
			continue
		}
		report.Indexed++
	}
	return report
}

// Run 持续派发直到 ctx 结束。先跑一轮再进入 ticker：重启后积压应立即开始消费，
// 而不是先空等一个轮询周期。
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.poll)
	defer ticker.Stop()
	for {
		report := d.Cycle(ctx)
		if d.onCycle != nil {
			d.onCycle(report)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// build 把 outbox 行转成投影载荷。
func (d *Dispatcher) build(row store.PendingPublish) (Ingest, error) {
	// 本地先挡一次：realm/space 是 host 的非空校验项，缺了必然是 400。
	// 提前拒绝省掉一次 embedding 往返，也让原因更直白。
	if row.Realm == "" || row.Space == "" {
		return Ingest{}, fmt.Errorf("%w: 发布事件缺少 realm/space（文档 %s v%d）",
			ErrRejected, row.DocID, row.Version)
	}
	title := strings.TrimSpace(row.Title)
	if title == "" {
		// 无标题文档是合法的，但 host 要求 title 非空；回落到 docId 而不是拒绝，
		// 否则这类文档会永远无法进入知识库。
		title = string(row.DocID)
	}
	return Ingest{
		Doc: Doc{
			DocID:          string(row.DocID),
			Realm:          string(row.Realm),
			Space:          string(row.Space),
			Title:          title,
			SourceVersion:  row.Version,
			EmbeddingModel: d.model,
		},
		Chunks: ChunkContent(row.Content, d.chunkOptions),
	}, nil
}

// fail 记录一次失败并累计 attempts；跨越停滞阈值时单独报一次。
func (d *Dispatcher) fail(ctx context.Context, row store.PendingPublish, cause error, terminal bool) {
	reason := cause.Error()
	if len(reason) > 500 {
		reason = reason[:500]
	}
	d.report(fmt.Errorf("indexing: 投影失败（文档 %s v%d terminal=%t）: %w",
		row.DocID, row.Version, terminal, cause))
	attempts, err := d.source.RecordDispatchFailure(ctx, row.DocID, row.Version, reason, d.maxAttempts, terminal)
	if err != nil {
		d.report(fmt.Errorf("indexing: 记录投影失败失败（文档 %s v%d）: %w", row.DocID, row.Version, err))
		return
	}
	// attempts 恰好等于上限就是「刚刚越过」：非终态每次加一，终态直接跳到上限，
	// 两种路径都只会命中一次，因此不需要额外的去重状态。
	// 越过之后该行不再被扫描，恢复途径是修配置后重新发布该文档（新行 attempts 归零）。
	if attempts >= d.maxAttempts {
		d.report(fmt.Errorf("indexing: 发布 %s v%d 已停滞（attempts=%d），不再重试；last_error=%s",
			row.DocID, row.Version, attempts, reason))
	}
}

func (d *Dispatcher) report(err error) {
	if d.onError != nil {
		d.onError(err)
	}
}
