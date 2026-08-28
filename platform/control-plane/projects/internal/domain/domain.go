// Package domain 项目工作区领域层（§11.1，设计说明 2026-08-26 §3）。
//
// 与 TS 契约 shared/seam-contracts/projects.ts 同矩阵同状态机——契约双实现，
// 任何一侧漂移由两侧各自的逐格测试逮住（判据 7）。语义注释见 TS 侧；此处只留
// Go 侧的落地理由。
package domain

import (
	"fmt"
	"time"
)

// Status 项目生命周期状态闭集。删除不是状态——归档是常态，删除是终局动作
// （须先归档 + X-Lumo-Confirm 显式确认，两层闸）。
const (
	StatusActive   = "active"
	StatusArchived = "archived"
)

// Role 成员角色闭集（§11.1 权限行）。
const (
	RoleOwner  = "owner"
	RoleEditor = "editor"
	RoleViewer = "viewer"
)

// Action 动作闭集（§11.1 表格直译）。
const (
	ActionRead          = "project.read"
	ActionEdit          = "project.edit"
	ActionMembersManage = "members.manage"
	ActionArchive       = "project.archive"
	ActionDelete        = "project.delete"
	ActionBudgetConfig  = "budget.configure"
)

// Project 项目实体（projects 表的领域投影）。
type Project struct {
	ID         string     `json:"id"`
	Realm      string     `json:"realm"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	CreatedBy  string     `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	ArchivedAt *time.Time `json:"archivedAt,omitempty"`
}

// Member 项目成员（project_members 表的领域投影）。
type Member struct {
	ProjectID string    `json:"projectId"`
	UserID    string    `json:"userId"`
	Role      string    `json:"role"`
	AddedAt   time.Time `json:"addedAt"`
}

// Artifact 项目挂载的可发布制品。
type Artifact struct {
	ProjectID string `json:"projectId"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Version   string `json:"version"`
}

// Space 项目内知识协作空间。
type Space struct {
	ID        string `json:"spaceId"`
	ProjectID string `json:"projectId"`
	Realm     string `json:"realm"`
	Name      string `json:"name"`
}

// Automation 项目绑定的触发器与流程。
type Automation struct {
	ID          string `json:"automationId"`
	ProjectID   string `json:"projectId"`
	TriggerKind string `json:"triggerKind"`
	TriggerSpec string `json:"triggerSpec"`
	FlowRef     string `json:"flowRef"`
	Enabled     bool   `json:"enabled"`
}

// UsageItem 项目用量聚合的一行（usage_ledger 按 cost_type 聚合，仪表板最小后端）。
type UsageItem struct {
	CostType string  `json:"costType"`
	Qty      float64 `json:"qty"`
	CostUSD  float64 `json:"costUsd"`
}

// BudgetSnapshot 项目树预算四态（读自 budget_trees，总额模型口径）。
type BudgetSnapshot struct {
	Remaining int64  `json:"remaining"`
	Budget    int64  `json:"budget"`
	SoftLimit int64  `json:"softLimit"`
	Overdraft int64  `json:"overdraft"`
	State     string `json:"state"`
}

// CanProject 角色能力矩阵（3×6 逐格，无默认放行分支）。闭集外报错——未知值是
// 契约漂移，静默 false 会把「新动作全员不可用」藏到生产。
func CanProject(role, action string) (bool, error) {
	if role != RoleOwner && role != RoleEditor && role != RoleViewer {
		return false, fmt.Errorf("未知项目角色 %q，合法取值：owner / editor / viewer", role)
	}
	if action != ActionRead && action != ActionEdit && action != ActionMembersManage &&
		action != ActionArchive && action != ActionDelete && action != ActionBudgetConfig {
		return false, fmt.Errorf("未知项目动作 %q", action)
	}
	caps := map[string]map[string]bool{
		RoleOwner: {
			ActionRead: true, ActionEdit: true, ActionMembersManage: true,
			ActionArchive: true, ActionDelete: true, ActionBudgetConfig: true,
		},
		RoleEditor: {
			ActionRead: true, ActionEdit: true,
		},
		RoleViewer: {
			ActionRead: true,
		},
	}
	return caps[role][action], nil
}

// TransitionProject 生命周期状态机：active ↔ archived。自反转移幂等（重复
// archive 是重放不是错误）。闭集外报错。
func TransitionProject(status, event string) (string, error) {
	switch status {
	case StatusActive, StatusArchived:
	default:
		return "", fmt.Errorf("未知项目状态 %q，合法取值：active / archived", status)
	}
	switch event {
	case "archive":
		return StatusArchived, nil
	case "unarchive":
		return StatusActive, nil
	default:
		return "", fmt.Errorf("未知生命周期事件 %q，合法取值：archive / unarchive", event)
	}
}
