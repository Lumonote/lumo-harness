// Package domain 定义调度服务的核心类型：任务、节点、租约与领域错误。
package domain

import "fmt"

// TaskState 任务状态机：PENDING → PLACED → RUNNING → COMPLETED/FAILED/ABORTED。
type TaskState string

const (
	StatePending   TaskState = "PENDING"
	StatePlaced    TaskState = "PLACED"
	StateRunning   TaskState = "RUNNING"
	StateCompleted TaskState = "COMPLETED"
	StateFailed    TaskState = "FAILED"
	StateAborted   TaskState = "ABORTED"
)

// Active 表示该状态下任务占据节点槽位、不允许开新 attempt。
func (s TaskState) Active() bool { return s == StatePlaced || s == StateRunning }

// Terminal 表示终态：可开启新 attempt。
func (s TaskState) Terminal() bool {
	return s == StateCompleted || s == StateFailed || s == StateAborted
}

// Requirement 一条能力要求：key 必须是节点 capabilities 的成员。
type Requirement struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Task 待调度任务。
type Task struct {
	TaskID    string        `json:"task_id"`
	Realm     string        `json:"realm"`
	ClusterID string        `json:"cluster_id"`
	Requires  []Requirement `json:"requires"`
	Priority  int           `json:"priority"`
}

// Node 注册进目录的执行节点。
type Node struct {
	NodeID       string   `json:"node_id"`
	ClusterID    string   `json:"cluster_id"`
	Capacity     int      `json:"capacity"`
	Capabilities []string `json:"capabilities"`
}

// Satisfies requires 的 key 全在节点能力内。
func (n Node) Satisfies(reqs []Requirement) bool {
	for _, r := range reqs {
		found := false
		for _, c := range n.Capabilities {
			if c == r.Key {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// Lease 选举租约：续租不换 token，易主才 +1。
type Lease struct {
	Holder       string
	FencingToken int64
	ExpiresAt    int64
}

// Placement 一次放置决策的结果（API 面，wire 按全仓 snake_case 约定输出 ——
// 任务侧消费端断言 node_id，Task/Node 同训）。
type Placement struct {
	TaskID       string    `json:"task_id"`
	NodeID       string    `json:"node_id"`
	Attempt      int       `json:"attempt"`
	State        TaskState `json:"state"`
	FencingToken int64     `json:"fencing_token"`
}

// ErrNotAcquired 租约被他人持有（未过期），本节点不是 leader。调用方不应等待。
var ErrNotAcquired = fmt.Errorf("lease not acquired")

// NoLeaderError 无 leader：请求方应快速失败而非等待。
type NoLeaderError struct{}

func (NoLeaderError) Error() string { return "no leader elected" }

// FencedOutError 写路径 fencing 校验失败：token 不符或租约已过期。
// Current 为库端当前 token；0 表示 holder 已易主或租约已过期。
type FencedOutError struct {
	Token   int64
	Current int64
}

func (e *FencedOutError) Error() string {
	return fmt.Sprintf("fenced out: token %d, current %d", e.Token, e.Current)
}

// NoCapacityError 无满足 requires 且有槽位的节点，任务应排队。
type NoCapacityError struct{}

func (NoCapacityError) Error() string { return "no node with capacity" }

// TaskNotFoundError 任务不存在。
type TaskNotFoundError struct{ TaskID string }

func (e *TaskNotFoundError) Error() string { return "task not found: " + e.TaskID }
