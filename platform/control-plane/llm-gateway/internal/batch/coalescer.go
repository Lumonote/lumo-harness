// Package batch LLM 网关的批处理汇聚（架构 §7.2「LLM 批处理网关（吞吐命脉）」）。
//
// # 这一层到底做什么
//
// §7.2 的诉求是「在时间窗内汇聚多个并发 agent.request，合并成 MoE 需要的大
// batch——agent 并发越高、吞吐越高，而非雪崩」。网关是**代理**，它不能改写上游
// 的推理请求格式（那是推理集群自己的连续批处理调度），所以它能做且必须做的
// 只有一件事：**把随机到达的请求对齐成同时到达**。
//
// 上游的连续批处理按「调度窗口内到达的请求」组批。请求散着来，每个窗口只组出
// 1~2 条，GPU 就一直在跑小 batch；网关在门前按模型把并发请求攒一小会儿再一起
// 放行，同一个上游窗口就能拿到整批。吞吐随并发上升的性质由此成立。
//
// # 代价是首 token 延迟，且必须是有界的
//
// 攒批就是人为延迟。§7.2 明确「首 token 延迟不受批处理拖累」，所以：
//
//   - **窗口有硬上界**：任何请求最多被延迟 `Window`，与并发数无关。这是加法而
//     不是乘法——最坏情况是 TTFT 预算多花一个窗口，不是「排队等前面的人」。
//   - **批满即放行**：达到 `MaxBatch` 立刻释放，不必等窗口走完。
//   - **窗口为 0 = 整体关闭**：直通路径不建 goroutine、不起定时器，与没有这层
//     完全同形。默认关闭，因为「拿 TTFT 换吞吐」是部署决策，不是代码能替用户
//     拍的板（集群形态与单机形态的最优解不同）。
//
// # 不做的事
//
// 不合并请求体（做不到，见上）、不跨模型混批（不同模型走不同上游，混批等于把
// 请求发给错误的上游）、不做背压队列（那会引入无界等待，违背「有界延迟」）。
package batch

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Config 汇聚参数。
//
// 两个字段都可为零值：`Window == 0` 表示关闭（直通），`MaxBatch == 0` 在窗口
// 关闭时无意义、在窗口打开时由 Validate 拒绝——「开了窗口但没给批上限」会让
// 批无限增长，而上游的批是有上限的，超出的部分会在上游侧退化成排队。
type Config struct {
	// Window 汇聚窗口。任何请求被延迟的上界。
	Window time.Duration
	// MaxBatch 单批请求数上限。达到即释放。
	MaxBatch int
}

// DefaultWindow 默认窗口。
//
// 20ms 的取法：它要小到在 TTFT 预算里可以忽略（§21.1 的预算是百毫秒级），又
// 要大到一个上游调度窗口能收到整批。两侧都留有余量，所以这个数不需要精调；
// 真要调，调的是「观测到的批大小」而不是这个常量。
const DefaultWindow = 20 * time.Millisecond

// DefaultMaxBatch 默认批上限。
const DefaultMaxBatch = 32

// Validate 校验配置，**反了要拒绝启动并点名变量**，不要静默夹取。
//
// 静默夹取的后果是：运维写了一个不可能生效的值，服务照常起来，现象是「配了
// 但没效果」——本仓库反复清理过这一类「语法合法、永远不生效」的东西（见
// `cluster-gap-analysis.md` 里两条结构性死告警规则）。
func (c Config) Validate() error {
	if c.Window < 0 {
		return fmt.Errorf("LUMO_LLM_BATCH_WINDOW_MS 不能为负（0 = 关闭汇聚）: %s", c.Window)
	}
	if c.Window > 0 && c.MaxBatch <= 0 {
		return fmt.Errorf("LUMO_LLM_BATCH_MAX 必须在开启汇聚（窗口 %s）时为正数", c.Window)
	}
	if c.MaxBatch < 0 {
		return fmt.Errorf("LUMO_LLM_BATCH_MAX 不能为负（0 仅在窗口关闭时合法）: %d", c.MaxBatch)
	}
	return nil
}

// Enabled 窗口 > 0 才汇聚。
func (c Config) Enabled() bool { return c.Window > 0 }

// waiter 一个在窗口里等放行的请求。
type waiter struct{ ch chan struct{} }

// group 同一个 key（模型）在同一个窗口里的一批请求。
type group struct {
	waiters []*waiter
	timer   *time.Timer
}

// Coalescer 按 key 汇聚并发请求。
//
// key 的粒度由调用方定，网关侧用**模型名**：不同模型走不同上游，混批等于把请求
// 发给错误的上游。
type Coalescer struct {
	cfg Config

	mu     sync.Mutex
	groups map[string]*group

	waiting  atomic.Int64
	released atomic.Uint64
	closed   atomic.Bool
}

// New 构造。非法配置在此拒绝（点名变量），不返回一个「部分生效」的实例。
func New(cfg Config) (*Coalescer, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Coalescer{cfg: cfg, groups: make(map[string]*group)}, nil
}

// Config 回读生效配置（启动日志用）。
func (c *Coalescer) Config() Config { return c.cfg }

// Acquire 在 key 对应的批里排队，直到本批被放行或 ctx 结束。
//
// 返回 nil 表示「可以发上游了」，不代表请求成功。ctx 结束时返回 ctx.Err()。
// 关闭状态下直接返回 nil，调用路径与没有这一层完全同形。
func (c *Coalescer) Acquire(ctx context.Context, key string) error {
	if c == nil || !c.cfg.Enabled() || c.closed.Load() {
		return nil
	}
	// 已经结束的 ctx 不该进来占一个名额再被摘掉——上游那边反正会失败，
	// 提前返回也省掉一次定时器操作。
	if err := ctx.Err(); err != nil {
		return err
	}

	w := &waiter{ch: make(chan struct{})}

	c.mu.Lock()
	g := c.groups[key]
	if g == nil {
		g = &group{}
		c.groups[key] = g
	}
	g.waiters = append(g.waiters, w)
	c.waiting.Add(1)
	if len(g.waiters) >= c.cfg.MaxBatch {
		// 批满即放行：不必等窗口走完，这是「延迟上界」之外的第二个出口。
		c.releaseLocked(key, g)
	} else if g.timer == nil {
		// 定时器回调带 group 指针：窗口到点时若这一批已被批满释放、且同 key
		// 已经开了新的一批，旧回调必须什么都不做（否则会误放行下一批）。
		g.timer = time.AfterFunc(c.cfg.Window, func() { c.release(key, g) })
	}
	c.mu.Unlock()

	select {
	case <-w.ch:
		return nil
	default:
	}
	select {
	case <-w.ch:
		return nil
	case <-ctx.Done():
		c.drop(key, g, w)
		// 摘名额与放行可能刚好撞上：以「已放行」为准（下游会用自己的 ctx
		// 失败），否则这里会把一个已经放行的请求报成取消。
		select {
		case <-w.ch:
			return nil
		default:
		}
		return ctx.Err()
	}
}

// release 定时器回调路径：只在 key 仍指向同一个 group 时释放。
func (c *Coalescer) release(key string, g *group) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.groups[key] != g {
		return
	}
	c.releaseLocked(key, g)
}

// releaseLocked 放行一整批。调用方持锁。
func (c *Coalescer) releaseLocked(key string, g *group) {
	if g.timer != nil {
		g.timer.Stop()
		g.timer = nil
	}
	delete(c.groups, key)
	batch := g.waiters
	g.waiters = nil
	c.waiting.Add(-int64(len(batch)))
	c.released.Add(1)
	for _, w := range batch {
		close(w.ch)
	}
}

// drop 把取消掉的请求从批里摘出去。
//
// 不摘的后果是它一直占着 `MaxBatch` 的名额：批里只剩「已经走掉的请求」时永远
// 攒不满，后面的请求只能等窗口到点——表现为「并发一高，吞吐反而掉」。
func (c *Coalescer) drop(key string, g *group, w *waiter) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.groups[key] != g {
		return // 已经放行了，名额已由 releaseLocked 扣回
	}
	kept := g.waiters[:0]
	removed := false
	for _, x := range g.waiters {
		if x == w {
			removed = true
			continue
		}
		kept = append(kept, x)
	}
	g.waiters = kept
	if removed {
		c.waiting.Add(-1)
	}
}

// Close 停止所有定时器。幂等；关闭后 Acquire 直通。
func (c *Coalescer) Close() {
	if c == nil || c.closed.Swap(true) {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, g := range c.groups {
		if g.timer != nil {
			g.timer.Stop()
		}
		delete(c.groups, key)
	}
}

// Stats 当前在窗口里等待的请求数与已放行的批数。
//
// 两个数各回答一个不同的问题：`waiting` 长期贴在 MaxBatch 上说明上游吃不下，
// `released` 是吞吐侧的分母。**没有「批大小」指标**：它每次都不同，做成标签会
// 把基数预算吃光，而真正要看的分布用 histogram 表达，不是 gauge。
func (c *Coalescer) Stats() (waiting int64, released uint64) {
	if c == nil {
		return 0, 0
	}
	return c.waiting.Load(), c.released.Load()
}
