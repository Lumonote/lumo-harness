// Package crdt 提供 CRDT 合并内核的接口与默认实现。
//
// §12.3 例外条款：Yjs 生态无生产级 Go 实现，合并内核走 y-crdt（Rust）FFI。
// 本包定义接口，使服务主体保持纯 Go；FFI 实现以构建标签隔离（见 yrs_cgo.go）。
package crdt

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// Merger 把「上次状态 + 增量序列」合并为新状态。
//
// 实现须满足 CRDT 的收敛性：相同增量集合无论顺序都产出等价状态。
type Merger interface {
	Merge(state []byte, updates []domain.Update) ([]byte, error)
	// Name 用于日志与能力上报（区分 FFI 内核与占位实现）。
	Name() string
}

// UpdateSetMerger 是服务端的确定性更新集内核。
//
// 它不解释 Yjs 二进制 payload，而是把更新当作 CRDT 内核的输入集合：按
// actor/seq/digest 去重并排序，因而同一集合无论跨节点以何顺序到达，都生成
// 同一份可重放状态。Yjs 的文本 materialize 仍由客户端或 yrs FFI 完成；服务端
// 不把“原样二进制转发”冒充成文档语义合并。
type UpdateSetMerger struct{}

type updateSetState struct {
	Version int             `json:"version"`
	Updates []updateSetItem `json:"updates"`
}

type updateSetItem struct {
	DocID   string `json:"docId"`
	Seq     int64  `json:"seq"`
	Actor   string `json:"actor"`
	Digest  string `json:"digest"`
	Payload string `json:"payload"`
}

func (UpdateSetMerger) Name() string { return "deterministic-update-set" }

func (UpdateSetMerger) Merge(state []byte, updates []domain.Update) ([]byte, error) {
	set := updateSetState{Version: 1}
	if len(state) > 0 {
		if err := json.Unmarshal(state, &set); err != nil {
			return nil, fmt.Errorf("collaborator: CRDT 状态解析失败: %w", err)
		}
		if set.Version != 1 {
			return nil, fmt.Errorf("collaborator: 不支持的 CRDT 状态版本 %d", set.Version)
		}
	}
	seen := make(map[string]updateSetItem, len(set.Updates)+len(updates))
	for _, item := range set.Updates {
		seen[item.Digest] = item
	}
	for _, update := range updates {
		if len(update.Payload) == 0 {
			continue
		}
		sum := sha256.Sum256(update.Payload)
		digest := hex.EncodeToString(sum[:])
		seen[digest] = updateSetItem{DocID: string(update.DocID), Seq: update.Seq, Actor: update.Actor, Digest: digest, Payload: base64.StdEncoding.EncodeToString(update.Payload)}
	}
	set.Updates = set.Updates[:0]
	for _, item := range seen {
		set.Updates = append(set.Updates, item)
	}
	sort.Slice(set.Updates, func(a, b int) bool {
		if set.Updates[a].Seq != set.Updates[b].Seq {
			return set.Updates[a].Seq < set.Updates[b].Seq
		}
		if set.Updates[a].Actor != set.Updates[b].Actor {
			return set.Updates[a].Actor < set.Updates[b].Actor
		}
		return set.Updates[a].Digest < set.Updates[b].Digest
	})
	return json.Marshal(set)
}

// AppendOnlyMerger 兼容旧状态读取与历史测试；新装配不得使用它。
type AppendOnlyMerger struct{}

func (AppendOnlyMerger) Name() string { return "append-only(占位，非生产)" }

func (AppendOnlyMerger) Merge(state []byte, updates []domain.Update) ([]byte, error) {
	out := make([]byte, 0, len(state)+len(updates)*64)
	out = append(out, state...)
	for _, u := range updates {
		if len(u.Payload) == 0 {
			continue
		}
		// 长度前缀 + 负载：保持可重放的边界
		out = append(out, byte(len(u.Payload)>>24), byte(len(u.Payload)>>16),
			byte(len(u.Payload)>>8), byte(len(u.Payload)))
		out = append(out, u.Payload...)
	}
	return out, nil
}

// ErrKernelUnavailable 表示语义内核未配置或拒绝了输入更新。
type ErrKernelUnavailable struct{ Detail string }

func (e *ErrKernelUnavailable) Error() string {
	return fmt.Sprintf("collaborator: CRDT 合并内核不可用: %s", e.Detail)
}
