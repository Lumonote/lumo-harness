// Package hub 管理活跃文档的内存态与订阅广播（§5.4.7.4）。
//
// 归属约束：**每个活跃文档由唯一一个实例持有**（documentId 一致性哈希），
// 避免多副本分叉。本包只负责本实例持有的文档；路由由 ownership 包裁决。
package hub

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// Subscriber 一个已连接的编辑者（WS 连接的抽象）。
type Subscriber struct {
	UserID string
	// Send 向该订阅者推送增量；实现须非阻塞（满则丢弃并断开，防慢消费者拖垮广播）。
	Send func(domain.Update) error
}

// Doc 一篇活跃文档的内存态。
type Doc struct {
	mu sync.RWMutex

	meta domain.Document
	// state 最近落库的 CRDT 状态（y-crdt 合并内核的输入；本服务不解释其语义）
	state    []byte
	stateSeq int64
	walSeq   int64
	dirty    bool
	lastUse  time.Time

	subs map[string]*Subscriber
}

// Hub 本实例持有的文档集合。
type Hub struct {
	mu     sync.RWMutex
	docs   map[domain.DocumentID]*Doc
	store  *store.Store
	limits domain.Limits

	// draining 优雅排空标记：置位后拒绝接管新文档（缩容前必须先迁移归属）
	draining bool
}

func New(st *store.Store, limits domain.Limits) *Hub {
	return &Hub{
		docs:   make(map[domain.DocumentID]*Doc),
		store:  st,
		limits: limits,
	}
}

// Open 惰性加载文档到内存：PG 状态快照 + Redis WAL 尾部重建（RTO < 10s 的路径）。
func (h *Hub) Open(ctx context.Context, meta domain.Document) (*Doc, error) {
	h.mu.RLock()
	if d, ok := h.docs[meta.ID]; ok {
		h.mu.RUnlock()
		d.touch()
		return d, nil
	}
	draining := h.draining
	count := len(h.docs)
	h.mu.RUnlock()

	if draining {
		return nil, &domain.ErrCapacity{Detail: "实例正在排空，拒绝接管新文档"}
	}
	if count >= h.limits.MaxDocsPerInstance {
		return nil, &domain.ErrCapacity{
			Detail: fmt.Sprintf("本实例活跃文档数已达上限 %d", h.limits.MaxDocsPerInstance),
		}
	}

	if err := h.store.EnsureDocument(ctx, meta); err != nil {
		return nil, err
	}

	state, seq, err := h.store.LoadState(ctx, meta.ID)
	if err != nil {
		return nil, err
	}
	// WAL 尾部：快照之后的增量（崩溃恢复的补差）
	tail, err := h.store.ReadWALFrom(ctx, meta.ID, seq)
	if err != nil {
		return nil, err
	}
	walSeq := maxWALSeq(seq, tail)
	if err := h.store.EnsureWALSeq(ctx, meta.ID, walSeq); err != nil {
		return nil, err
	}

	d := &Doc{
		meta:     meta,
		state:    state,
		stateSeq: seq,
		walSeq:   walSeq,
		lastUse:  time.Now(),
		subs:     make(map[string]*Subscriber),
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	// 双检：并发 Open 时复用先到者
	if existing, ok := h.docs[meta.ID]; ok {
		return existing, nil
	}
	h.docs[meta.ID] = d
	return d, nil
}

// Subscribe 订阅文档增量；返回取消函数。
func (h *Hub) Subscribe(id domain.DocumentID, sub *Subscriber) (func(), error) {
	h.mu.RLock()
	d, ok := h.docs[id]
	h.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("collaborator: 文档 %s 未在本实例打开", id)
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.subs) >= h.limits.MaxEditorsPerDoc {
		return nil, &domain.ErrCapacity{
			Detail: fmt.Sprintf("文档并发编辑者已达上限 %d", h.limits.MaxEditorsPerDoc),
		}
	}
	d.subs[sub.UserID] = sub
	d.lastUse = time.Now()

	return func() {
		d.mu.Lock()
		delete(d.subs, sub.UserID)
		d.mu.Unlock()
	}, nil
}

// Apply 接收一条 CRDT 增量：**先落 WAL 再广播**（RPO 0 的实现点）。
//
// 返回的 seq 是给客户端的 ack 依据——本函数返回即代表已持久化。
func (h *Hub) Apply(ctx context.Context, id domain.DocumentID, actor string, payload []byte) (int64, error) {
	h.mu.RLock()
	d, ok := h.docs[id]
	h.mu.RUnlock()
	if !ok {
		return 0, fmt.Errorf("collaborator: 文档 %s 未在本实例打开", id)
	}

	if len(payload) > h.limits.MaxDocBytes {
		return 0, &domain.ErrCapacity{
			Detail: fmt.Sprintf("单次增量 %d 字节超出上限 %d", len(payload), h.limits.MaxDocBytes),
		}
	}

	u := domain.Update{
		DocID:    id,
		Actor:    actor,
		Payload:  payload,
		Received: time.Now(),
	}

	// 1) WAL 先行：失败即拒绝，绝不向客户端确认
	seq, err := h.store.AppendWAL(ctx, u)
	if err != nil {
		return 0, err
	}
	u.Seq = seq

	// 2) 更新内存态并广播给其它订阅者
	d.mu.Lock()
	d.walSeq = seq
	d.dirty = true
	d.lastUse = time.Now()
	targets := make([]*Subscriber, 0, len(d.subs))
	for uid, s := range d.subs {
		if uid != actor {
			targets = append(targets, s)
		}
	}
	d.mu.Unlock()

	for _, s := range targets {
		// 慢消费者不阻塞广播：Send 实现须非阻塞
		_ = s.Send(u)
	}
	return seq, nil
}

// Snapshot 周期性把脏文档的状态合并落 PG 并裁剪 WAL。
//
// 合并语义由 y-crdt 内核提供；此处的 merge 回调接收「上次状态 + WAL 增量」
// 返回新状态（Rust FFI 的注入点，§12.3 既有例外条款）。
func (h *Hub) Snapshot(ctx context.Context, merge func(state []byte, updates []domain.Update) ([]byte, error)) error {
	h.mu.RLock()
	ids := make([]domain.DocumentID, 0, len(h.docs))
	for id := range h.docs {
		ids = append(ids, id)
	}
	h.mu.RUnlock()

	for _, id := range ids {
		h.mu.RLock()
		d, ok := h.docs[id]
		h.mu.RUnlock()
		if !ok {
			continue
		}

		d.mu.RLock()
		dirty, state, stateSeq, seq := d.dirty, d.state, d.stateSeq, d.walSeq
		d.mu.RUnlock()
		if !dirty {
			continue
		}

		updates, err := h.store.ReadWALFrom(ctx, id, stateSeq)
		if err != nil {
			return err
		}
		merged, err := merge(state, updates)
		if err != nil {
			return fmt.Errorf("collaborator: 合并 CRDT 状态失败 (%s): %w", id, err)
		}
		if err := h.store.SaveState(ctx, id, merged, seq); err != nil {
			return err
		}
		if err := h.store.TrimWAL(ctx, id, seq); err != nil {
			return err
		}

		d.mu.Lock()
		d.state = merged
		d.stateSeq = seq
		// Apply may have appended a newer WAL record while this snapshot was
		// being merged. Keep the document dirty so the newer tail is not
		// falsely reported as persisted.
		d.dirty = d.walSeq > seq
		d.mu.Unlock()
	}
	return nil
}

func maxWALSeq(base int64, updates []domain.Update) int64 {
	max := base
	for _, update := range updates {
		if update.Seq > max {
			max = update.Seq
		}
	}
	// Legacy direct records did not persist seq. Their tail is still ordered,
	// so retain the old length-based estimate as a conservative compatibility
	// fallback while new records use their explicit global sequence.
	if candidate := base + int64(len(updates)); candidate > max {
		max = candidate
	}
	return max
}

// EvictIdle 闲置回收：无订阅者且超时的文档落最终快照后卸载出内存。
func (h *Hub) EvictIdle(ctx context.Context) int {
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()

	evicted := 0
	for id, d := range h.docs {
		d.mu.RLock()
		idle := len(d.subs) == 0 && now.Sub(d.lastUse) > h.limits.IdleEvictAfter && !d.dirty
		d.mu.RUnlock()
		if idle {
			delete(h.docs, id)
			evicted++
		}
	}
	return evicted
}

// Drain 优雅排空：停止接管新文档，等待现有订阅者断开（缩容前必须调用）。
//
// §5.4.7.4：缩容必须先迁移归属再下线，不可直接杀实例。
func (h *Hub) Drain(ctx context.Context, timeout time.Duration) error {
	h.mu.Lock()
	h.draining = true
	h.mu.Unlock()

	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		h.mu.RLock()
		active := 0
		for _, d := range h.docs {
			d.mu.RLock()
			active += len(d.subs)
			d.mu.RUnlock()
		}
		h.mu.RUnlock()

		if active == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("collaborator: 排空超时，仍有 %d 个活跃连接", active)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Stats 运行指标（供 OTel 导出与容量告警）。
func (h *Hub) Stats() (docs, subscribers int, draining bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, d := range h.docs {
		d.mu.RLock()
		subscribers += len(d.subs)
		d.mu.RUnlock()
	}
	return len(h.docs), subscribers, h.draining
}

func (d *Doc) touch() {
	d.mu.Lock()
	d.lastUse = time.Now()
	d.mu.Unlock()
}

// Meta 返回文档元数据副本。
func (d *Doc) Meta() domain.Document {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.meta
}
