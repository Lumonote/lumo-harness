// Package domain 第五类制品（用户自定义流程）领域层（§11 后半，设计说明
// 2026-08-26 §3）。与 TS 契约 shared/seam-contracts/flows.ts 同矩阵——契约双实现，
// 两侧逐格测试互为镜像（判据 7）。语义注释见 TS 侧。
package domain

import (
	"fmt"
	"time"
)

// Status 生命周期状态闭集。deprecated 是终态（复活走版本回滚，不走状态机）。
const (
	StatusDraft      = "draft"
	StatusSubmitted  = "submitted"
	StatusPublished  = "published"
	StatusTargeted   = "targeted"
	StatusDeprecated = "deprecated"
)

// Event 事件闭集。rollback 不在事件里——回滚重指版本，不改状态。
const (
	EventSubmit    = "submit"
	EventApprove   = "approve"
	EventReject    = "reject"
	EventTarget    = "target"
	EventDeprecate = "deprecate"
)

// Visibility 可见性闭集（与状态正交）。
const (
	VisibilityPrivate  = "private"
	VisibilityTargeted = "targeted"
	VisibilityGlobal   = "global"
)

// 项目成员角色（闭集真相源在 shared/seam-contracts/projects.ts；此处是消费侧投影
// ——flows 只读 project_members 表做成员判定，不重复实现角色语义）。
const (
	RoleOwner  = "owner"
	RoleEditor = "editor"
)

// Flow 流程实体（flows 表领域投影）。
type Flow struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"projectId"`
	Realm         string     `json:"realm"`
	Name          string     `json:"name"`
	Status        string     `json:"status"`
	Visibility    string     `json:"visibility"`
	Author        string     `json:"author"`
	Version       int        `json:"version"`
	Audience      *Audience  `json:"audience,omitempty"`
	ReviewComment *string    `json:"reviewComment,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	SubmittedAt   *time.Time `json:"submittedAt,omitempty"`
	PublishedAt   *time.Time `json:"publishedAt,omitempty"`
	DeprecatedAt  *time.Time `json:"deprecatedAt,omitempty"`
}

// Audience 定向分发的受众（manifest 字段）。
type Audience struct {
	Roles []string `json:"roles,omitempty"`
	Depts []string `json:"depts,omitempty"`
	Users []string `json:"users,omitempty"`
}

// Caller 视图侧调用者身份（面板过滤用）。
type Caller struct {
	User  string   `json:"user"`
	Roles []string `json:"roles"`
	Depts []string `json:"depts"`
}

// transitions 合法转移表（与 TS TRANSITIONS 逐格一致）。
var transitions = map[string]map[string]string{
	StatusDraft:     {EventSubmit: StatusSubmitted, EventDeprecate: StatusDeprecated},
	StatusSubmitted: {EventApprove: StatusPublished, EventReject: StatusDraft},
	StatusPublished: {EventTarget: StatusTargeted, EventDeprecate: StatusDeprecated},
	StatusTargeted:  {EventTarget: StatusTargeted, EventDeprecate: StatusDeprecated},
	StatusDeprecated: {},
}

// TransitionFlow 状态机。闭集外或非法转移报错——静默放行会把拼写错误藏到生产。
func TransitionFlow(status, event string) (string, error) {
	row, okStatus := transitions[status]
	if !okStatus {
		return "", fmt.Errorf("未知流程状态 %q", status)
	}
	switch event {
	case EventSubmit, EventApprove, EventReject, EventTarget, EventDeprecate:
	default:
		return "", fmt.Errorf("未知生命周期事件 %q", event)
	}
	next, ok := row[event]
	if !ok {
		return "", fmt.Errorf("非法转移：%s --%s-->", status, event)
	}
	return next, nil
}

// Definition DAG 形状（入库护栏的输入）。
type Definition struct {
	Nodes []struct {
		ID       string `json:"id"`
		Operator string `json:"operator"`
	} `json:"nodes"`
	Edges []struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"edges"`
}

// ValidateDefinition 入库护栏：形状、节点唯一、算子非空、边引用存在、DAG 无环（Kahn）。
// 环会让 FlowEngine 的断点续跑永不出活——入库前拦。
func ValidateDefinition(def *Definition) error {
	if def == nil || len(def.Nodes) == 0 {
		return fmt.Errorf("流程定义至少一个节点——空流程没有定义语义")
	}
	adj := map[string][]string{}
	indeg := map[string]int{}
	for _, n := range def.Nodes {
		if n.ID == "" {
			return fmt.Errorf("节点 id 必须是非空字符串")
		}
		if _, dup := adj[n.ID]; dup {
			return fmt.Errorf("节点 id 必须唯一：%s 重复", n.ID)
		}
		if n.Operator == "" {
			return fmt.Errorf("节点 %s 缺算子（operator）——空算子是未完成的定义", n.ID)
		}
		adj[n.ID] = nil
		indeg[n.ID] = 0
	}
	for _, e := range def.Edges {
		if _, ok := adj[e.From]; !ok {
			return fmt.Errorf("边 %s→%s 引用了不存在的节点", e.From, e.To)
		}
		if _, ok := adj[e.To]; !ok {
			return fmt.Errorf("边 %s→%s 引用了不存在的节点", e.From, e.To)
		}
		adj[e.From] = append(adj[e.From], e.To)
		indeg[e.To]++
	}
	queue := make([]string, 0, len(adj))
	for id, d := range indeg {
		if d == 0 {
			queue = append(queue, id)
		}
	}
	visited := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		visited++
		for _, next := range adj[cur] {
			indeg[next]--
			if indeg[next] == 0 {
				queue = append(queue, next)
			}
		}
	}
	if visited != len(adj) {
		return fmt.Errorf("流程定义含环——DAG 是硬约束（拓扑排序未收敛）")
	}
	return nil
}

// AudienceMatches 定向可见性判据：任一维度命中即真；空 audience 恒假（配置错误
// 宁可全员不可见，不要越权面）。
func AudienceMatches(a *Audience, c Caller) bool {
	if a == nil {
		return false
	}
	if len(a.Roles) == 0 && len(a.Depts) == 0 && len(a.Users) == 0 {
		return false
	}
	for _, u := range a.Users {
		if u == c.User {
			return true
		}
	}
	for _, r := range c.Roles {
		for _, ar := range a.Roles {
			if r == ar {
				return true
			}
		}
	}
	for _, d := range c.Depts {
		for _, ad := range a.Depts {
			if d == ad {
				return true
			}
		}
	}
	return false
}
