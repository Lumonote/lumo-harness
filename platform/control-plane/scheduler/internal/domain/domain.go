// Package domain 定义调度服务的核心类型：任务、节点、租约与领域错误。
package domain

import (
	"fmt"
	"time"
)

// TaskState 任务状态机：PENDING → PLACED → RUNNING → COMPLETED/FAILED/ABORTED。
// CANCELLING means the execution node accepted a stop request but has not yet
// reported a terminal result; it must never be displayed as already cancelled.
type TaskState string

const (
	StatePending    TaskState = "PENDING"
	StatePlaced     TaskState = "PLACED"
	StateRunning    TaskState = "RUNNING"
	StateCancelling TaskState = "CANCELLING"
	StateCompleted  TaskState = "COMPLETED"
	StateFailed     TaskState = "FAILED"
	StateAborted    TaskState = "ABORTED"
)

// Active 表示该状态下任务占据节点槽位、不允许开新 attempt。
func (s TaskState) Active() bool {
	return s == StatePlaced || s == StateRunning || s == StateCancelling
}

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
	TaskID string `json:"task_id"`
	Realm  string `json:"realm"`
	// WorkerID binds placement to the live devices of a governed employee or
	// Agent preset. Empty retains the infrastructure-task scheduling contract.
	WorkerID  string        `json:"worker_id,omitempty"`
	ProjectID string        `json:"project_id,omitempty"`
	ClusterID string        `json:"cluster_id"`
	Requires  []Requirement `json:"requires"`
	Priority  int           `json:"priority"`
	// Residency is an optional hard data-residency domain (for example cn-east).
	// Empty means the realm policy has not constrained this task.
	Residency string `json:"residency,omitempty"`
	// DeadlineMS is an optional absolute deadline. Pending work is ordered by
	// earliest deadline first (EDF); zero means no deadline.
	DeadlineMS int64 `json:"deadline_ms,omitempty"`
	// Queue and Weight provide weighted fair queuing for pending work. Empty
	// queue uses the default queue and non-positive weights normalize to 1.
	Queue  string `json:"queue,omitempty"`
	Weight int    `json:"weight,omitempty"`
	// AvoidNodes is a hard anti-affinity list, useful for retrying away from a
	// failed or degraded host.
	AvoidNodes []string `json:"avoid_nodes,omitempty"`
	// PreferredClusters is a **soft** cluster preference: it only reorders the
	// hard-eligible candidates (see planner.PickWeighted). ClusterID remains the
	// hard binding; this is for "prefer A, B is acceptable".
	//
	// 顺序不参与打分（当集合用）。有序列表需要第二个权重，而 A4 点名的病正是
	// 「未定义权重的打分」——多一个权重就多一个没人知道该怎么调的数。
	PreferredClusters []string `json:"preferred_clusters,omitempty"`
	// ProjectActiveByCluster 该任务所属项目在各集群上的活跃任务数，由调用方在放置
	// 前填一次（store.ActiveClusterCountsByProjects）。
	//
	// json:"-"：它是**决策输入**而不是任务属性——不进库、不出 API，也不该被
	// 派发到执行节点（同 EnqueuedAt）。放进任务结构是因为打分函数需要它，而给
	// Pick 加参数会扩散到全部 4 个调用点（同 AnnotateClusterStates 的理由）。
	ProjectActiveByCluster map[string]int `json:"-"`
	// EnqueuedAt is server metadata used only for stable queue ordering.
	EnqueuedAt time.Time `json:"-"`
}

// Node 注册进目录的执行节点。
type Node struct {
	NodeID       string   `json:"node_id"`
	Realm        string   `json:"realm"`
	ClusterID    string   `json:"cluster_id"`
	Capacity     int      `json:"capacity"`
	Capabilities []string `json:"capabilities"`
	Residency    string   `json:"residency,omitempty"`
	// ControlURL is the node-local subagent-host endpoint used after placement.
	ControlURL string `json:"control_url,omitempty"`
	// ClusterState 所属集群在联邦注册表里的状态，由目录读取后填一次
	// （见 AnnotateClusterStates）。空值表示本实例没有参与判定。
	ClusterState ClusterState `json:"cluster_state,omitempty"`
	// ClusterVersion 所属集群声明的版本（未声明为空）。只用于诊断与展示——
	// 闸门看的是下面那个布尔，不是这个字符串。
	ClusterVersion string `json:"cluster_version,omitempty"`
	// ClusterVersionUnproven 所属集群的版本**无法证明**与 fleet 版本一致
	// （版本分叉，或该集群根本没声明版本）。
	//
	// 它是一条**事实**，不是一条裁决：目录装饰器生成这个字段时还不知道要放的是什么
	// 任务，所以「要不要拦」由 planner 决定——版本闸门只对**全局**任务生效
	// （EligibleNodes 里的 `task.ClusterID == ""` 那一条）。把裁决写进字段名会诱导
	// 下一个读的人以为它已经含了任务维度，从而漏掉那条条件——实现的第一版就是这么
	// 错的，症状是「显式指定了 cluster_id 的放置也被拦」。
	//
	// **极性刻意取「无法证明」而不是「已证明一致」：零值必须是放行。** 装饰器没装上
	// （版本闸门关闭）、注册表读不到（WithClusterStates 的失败分支）时本字段保持零值；
	// 若零值是「不一致」，一次装配缺失就会让整个平台的全局放置停摆——正是本设计反复
	// 要避免的自伤（同 ClusterState 的零值 ClusterUnjudged 放行）。
	ClusterVersionUnproven bool `json:"cluster_version_unproven,omitempty"`
}

// Satisfies requires 的 key 全在节点能力内。
func (n Node) Satisfies(reqs []Requirement) bool {
	for _, r := range reqs {
		found := false
		for _, c := range n.Capabilities {
			if (r.Value == "" && c == r.Key) || (r.Value != "" && c == r.Key+"="+r.Value) {
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
	// Scope 指明这把租约是**哪一张表里的**那把锁：
	//   ""  = 全局租约（`scheduler_leader_lease`），跨集群唯一决策者；
	//   非空 = 该集群的本地租约（`scheduler_cluster_lease`），降级期间的本集群决策者。
	//
	// 它必须由租约自己带着，而不是由调用方另行传入：`checkFencing` 是唯一校验围栏的地方，
	// 若它需要调用方告诉它「这是哪把锁」，那两处就都有机会说错——而说错的后果是
	// **用一把锁的 token 去校验另一把锁**，也就是围栏形同虚设。
	Scope string
}

// Placement 一次放置决策的结果（API 面，wire 按全仓 snake_case 约定输出 ——
// 任务侧消费端断言 node_id，Task/Node 同训）。
type Placement struct {
	TaskID       string    `json:"task_id"`
	Realm        string    `json:"realm"`
	NodeID       string    `json:"node_id"`
	Attempt      int       `json:"attempt"`
	State        TaskState `json:"state"`
	FencingToken int64     `json:"fencing_token"`
}

// ControlCommand identifies a durable request sent to an execution node. A
// preemption uses the same stop RPC as a user cancellation, but keeps a
// distinct audit command so operators can tell the two causes apart.
type ControlCommand string

const (
	ControlCommandCancel  ControlCommand = "CANCEL"
	ControlCommandPreempt ControlCommand = "PREEMPT"
)

// PreemptionCandidate is the lower-priority active placement selected for a
// possible stop request. Selection never changes its state: the node must
// first acknowledge the control request, after which it becomes CANCELLING.
type PreemptionCandidate struct {
	TaskID   string
	Realm    string
	NodeID   string
	Attempt  int
	Priority int
	State    TaskState
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
