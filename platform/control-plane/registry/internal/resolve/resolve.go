// Package resolve 求制品的依赖闭包。
//
// 三条 fail closed 规矩（设计说明 §5）：
//   - 成环        → 拒，报出环路径
//   - 同名多版本  → 拒，**不做自动仲裁**
//   - 依赖不存在  → 拒，报出是谁引入的
//
// 第二条是本包唯一的判断题。包管理器通常自动选最高版本，但制品带 scope 权限：
// connector-jira@1.2 声明 [jira:read]，1.5 改成了 [jira:write]，
// 自动仲裁就把写权限装进了只申请读的部署里。静默升版 = 静默提权。
// 口径与 provenance（未声明工具判 external）、recovery（孤儿意图转人工）一致：
// 不确定时把问题交给人，而不是替人做决定。
package resolve

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/lumo-harness/platform/registry/internal/manifest"
)

var (
	// ErrCycle 依赖成环。
	ErrCycle = errors.New("registry: 依赖成环")
	// ErrVersionConflict 闭包内同一制品出现多个版本。
	ErrVersionConflict = errors.New("registry: 依赖版本冲突")
	// ErrMissing 依赖的制品未发布。
	ErrMissing = errors.New("registry: 依赖的制品不存在")
)

// CycleError 携带完整环路径，首尾为同一节点。
type CycleError struct{ Path []string }

func (e *CycleError) Error() string {
	return fmt.Sprintf("%s: %s", ErrCycle.Error(), strings.Join(e.Path, " -> "))
}
func (e *CycleError) Unwrap() error { return ErrCycle }

// ConflictError 携带冲突的制品名与两个版本。
// 刻意不给出「建议版本」——给了就会有人照抄，等于变相自动仲裁。
type ConflictError struct {
	Name     string
	Existing string // 闭包中已定的版本
	Incoming string // 新遇到的版本
	Via      string // 引入 Incoming 的那个制品
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("%s: %s 同时被要求 %s 与 %s（后者由 %s 引入），请显式统一版本",
		ErrVersionConflict.Error(), e.Name, e.Existing, e.Incoming, e.Via)
}
func (e *ConflictError) Unwrap() error { return ErrVersionConflict }

// MissingError 携带缺失制品与引入方。Via 为空表示缺的是根制品。
type MissingError struct {
	Name    string
	Version string
	Via     string
}

func (e *MissingError) Error() string {
	if e.Via == "" {
		return fmt.Sprintf("%s: %s@%s（根制品）", ErrMissing.Error(), e.Name, e.Version)
	}
	return fmt.Sprintf("%s: %s@%s，由 %s 引入", ErrMissing.Error(), e.Name, e.Version, e.Via)
}
func (e *MissingError) Unwrap() error { return ErrMissing }

// Node 是闭包中的一个制品。
//
// Digest 与 Sig 对本包是**不透明透传**：resolve 不解释它们，
// 只把它们带到 plan 包，由 plan 取字节、验签、重解析后做执法。
type Node struct {
	Name    string
	Version string
	Digest  string
	Sig     []byte
	Deps    []manifest.Dep
}

// LookupFunc 按 (name, version) 取一个节点。制品不存在时返回包裹 ErrMissing 的错误。
type LookupFunc func(ctx context.Context, name, version string) (*Node, error)

// Closure 从 root 出发求依赖闭包，返回拓扑序（被依赖者在前）。
//
// 拓扑序不是锦上添花：安装端可以照序逐个装而不必再排一次，
// 少一次排序就少一处「两边排法不同」的失配来源。
func Closure(ctx context.Context, root manifest.Dep, lookup LookupFunc) ([]Node, error) {
	r := &resolver{
		lookup: lookup,
		chosen: map[string]string{}, // name -> version
		state:  map[string]int{},    // key -> 0 未访问 / 1 在栈上 / 2 已完成
	}
	if err := r.visit(ctx, root, ""); err != nil {
		return nil, err
	}
	return r.ordered, nil
}

const (
	stateOnStack = 1
	stateDone    = 2
)

type resolver struct {
	lookup  LookupFunc
	chosen  map[string]string
	state   map[string]int
	stack   []string
	ordered []Node
}

func (r *resolver) visit(ctx context.Context, d manifest.Dep, via string) error {
	key := d.Name + "@" + d.Version

	// 版本冲突先于一切检查：同名不同版本时，即使那个版本已经解析完成，
	// 也必须拒——闭包里不允许并存两个版本。
	if v, ok := r.chosen[d.Name]; ok && v != d.Version {
		return &ConflictError{Name: d.Name, Existing: v, Incoming: d.Version, Via: via}
	}

	switch r.state[key] {
	case stateOnStack:
		// 环：从栈里第一次出现该 key 的位置切到栈顶，再补上自己形成闭环。
		start := 0
		for i, k := range r.stack {
			if k == key {
				start = i
				break
			}
		}
		path := append(append([]string{}, r.stack[start:]...), key)
		return &CycleError{Path: path}
	case stateDone:
		return nil
	}

	node, err := r.lookup(ctx, d.Name, d.Version)
	if err != nil {
		if errors.Is(err, ErrMissing) {
			return &MissingError{Name: d.Name, Version: d.Version, Via: via}
		}
		return err
	}

	r.chosen[d.Name] = d.Version
	r.state[key] = stateOnStack
	r.stack = append(r.stack, key)

	for _, child := range node.Deps {
		if err := r.visit(ctx, child, key); err != nil {
			return err
		}
	}

	r.stack = r.stack[:len(r.stack)-1]
	r.state[key] = stateDone
	r.ordered = append(r.ordered, *node) // 后序 = 拓扑序
	return nil
}
