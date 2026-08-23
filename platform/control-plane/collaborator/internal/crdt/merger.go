// Package crdt 提供 CRDT 合并内核的接口与默认实现。
//
// §12.3 例外条款：Yjs 生态无生产级 Go 实现，合并内核走 y-crdt（Rust）FFI。
// 本包定义接口，使服务主体保持纯 Go；FFI 实现以构建标签隔离（见 yrs_cgo.go）。
package crdt

import (
	"fmt"

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

// AppendOnlyMerger 占位实现：把增量按序拼接保存，不做真正的 CRDT 合并。
//
// **不可用于生产**：它不压缩状态、不消解并发冲突，仅用于在 FFI 内核就位前
// 打通持久化与恢复链路。启用时必须打印显式警告（不静默降级，铁律 21）。
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

// ErrKernelUnavailable FFI 内核不可用时的显式错误（不静默回退到占位实现）。
type ErrKernelUnavailable struct{ Detail string }

func (e *ErrKernelUnavailable) Error() string {
	return fmt.Sprintf("collaborator: CRDT 合并内核不可用: %s", e.Detail)
}
