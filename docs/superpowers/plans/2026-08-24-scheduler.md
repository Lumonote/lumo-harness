# Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec（`docs/superpowers/specs/2026-08-24-scheduler-design.md`）交付 `platform/control-plane/scheduler`：PG 租约 leader 选举 + 放置事务 fencing + 最小过滤式放置 + PG outbox 派发 + 无 leader 快速失败降级（评审 N1）。

**Architecture:** 独立 Go 服务（§3.1 分界：Scheduler 是控制面服务，不塞进 dsh 插件），对齐 collaborator 骨架（Go 1.24 / pgx/v5 / net/http / slog）。fencing token 与写路径同源：单行租约表 + 放置事务内 `FOR UPDATE` 校验；本地形态用 PG 目录与 outbox 替代 Nacos/RocketMQ（§13.2 Local-lite）。

**Tech Stack:** Go 1.24、github.com/jackc/pgx/v5 v5.7.2、标准库 net/http（1.22+ 方法路由）、slog、Docker Compose（PG 16 pgvector 镜像）。

## Global Constraints

- **第一铁律**：绝不修改 `deepseek-harness/`（本计划任何步骤都不触及该树）。全部任务完成后必须核验：`git -C deepseek-harness describe --tags --dirty` 输出 `dsh-v0.1.1-rc.2`（无 `-dirty`），`git -C deepseek-harness status --porcelain -uno` 输出为空。
- 模块路径 `github.com/lumo-harness/platform/scheduler`，Go 1.24（对齐 collaborator go.mod）。
- **payload 类列一律 TEXT 存 JSON 文本**，禁用 JSONB（session-log 实测：JSONB 拒收 `\u0000`，静默丢行留空洞）。
- **时间一律取库端时钟**：`(EXTRACT(EPOCH FROM now()) * 1000)::bigint`，不用节点本地时钟。
- 中文注释 + 设计理由（对齐 collaborator / session-log 的注释密度）。
- 提交信息格式 `feat(scheduler): …` / `docs(scheduler): …`，直接提交到 main（本仓库既有约定）。
- 活库测试 DSN：`postgres://lumo:lumo@localhost:55432/lumo`（compose 暴露的 55432 端口）。无 `LUMO_TEST_PG_DSN` 时集成测试跳过。
- 集成测试互斥：所有活库用例共享同一 PG，通过 `TRUNCATE` 隔离，**不得**用 `t.Parallel()`。
- 错误路径显式返回领域错误（`FencedOutError` / `NoCapacityError` / `TaskNotFoundError` / `ErrNotAcquired`），HTTP 层映射 503/404（spec §6 表）。

---

## File Structure

```
platform/control-plane/scheduler/
├── go.mod / go.sum
├── Dockerfile
├── cmd/scheduler/main.go                  # 装配：选举循环 + drain loop + HTTP + 优雅停机顺序
├── internal/domain/domain.go              # Task/Node/Lease/Placement/TaskState + 领域错误
├── internal/store/store.go                # DDL + 租约 + 放置事务（fencing 校验点）+ 排队/回报/认领/对账
├── internal/election/election.go          # State + Run 选主循环
├── internal/catalog/catalog.go            # NodeCatalog 接口 + PG 实现
├── internal/planner/planner.go            # 过滤式放置决策（纯函数）
├── internal/dispatch/dispatch.go          # Envelope + Sink 接口 + PgSink（outbox）
├── internal/server/server.go              # HTTP API
├── internal/planner/planner_test.go       # 纯单元测试（无需 PG）
└── internal/integration/                  # 活库集成测试（无 DSN 跳过）
    ├── helpers_test.go                    # testDSN / newStore / waitFor / rowCount
    ├── ddl_test.go                        # 建表幂等
    ├── lease_test.go                      # 场景 1/2/4
    ├── catalog_test.go                    # 目录往返
    ├── placement_test.go                  # 场景 3/5/8
    ├── drain_test.go                      # 场景 7
    └── http_test.go                       # 场景 6 + 全流程
```

---

### Task 1: 模块骨架 + 领域模型 + DDL

**Files:**
- Create: `platform/control-plane/scheduler/go.mod`
- Create: `platform/control-plane/scheduler/internal/domain/domain.go`
- Create: `platform/control-plane/scheduler/internal/dispatch/dispatch.go`
- Create: `platform/control-plane/scheduler/internal/store/store.go`（本任务只含 DDL + 连接管理）
- Test: `platform/control-plane/scheduler/internal/integration/ddl_test.go`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `domain.TaskState`（`PENDING/PLACED/RUNNING/COMPLETED/FAILED/ABORTED` + `Active()` / `Terminal()` 方法）
  - `domain.Task{TaskID, Realm, ClusterID, Requires []Requirement, Priority}`、`domain.Requirement{Key, Value}`
  - `domain.Node{NodeID, ClusterID, Capacity, Capabilities}` + `Satisfies(reqs) bool`
  - `domain.Lease{Holder, FencingToken, ExpiresAt}`、`domain.Placement{TaskID, NodeID, Attempt, State, FencingToken}`
  - 错误：`domain.ErrNotAcquired`（var）、`*domain.NoLeaderError`、`*domain.FencedOutError{Token, Current}`、`*domain.NoCapacityError`、`*domain.TaskNotFoundError{TaskID}`
  - `dispatch.Envelope{TaskID, Attempt, NodeID, Realm, ClusterID, Priority, Requires}`、`dispatch.Sink{WriteInto(ctx, tx pgx.Tx, env Envelope) error}`、`dispatch.PgSink{}`
  - `store.New(ctx, dsn) (*Store, error)`、`store.NewWithSink(ctx, dsn, sink) (*Store, error)`、`(*Store).Init(ctx) error`、`(*Store).Pool() *pgxpool.Pool`、`(*Store).Close()`

- [ ] **Step 1: 写失败的测试**

创建 `internal/integration/ddl_test.go`（包名 `integration_test`）：

```go
package integration_test

import (
	"context"
	"os"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// testDSN 活库集成测试的入口闸：无 LUMO_TEST_PG_DSN 时跳过（离线环境友好）。
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过活库集成测试")
	}
	return dsn
}

// TestDDLIdempotent 建表幂等 + 五张表齐备 + 预插空租约行。
func TestDDLIdempotent(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testDSN(t))
	if err != nil {
		t.Fatalf("连接 PG 失败: %v", err)
	}
	t.Cleanup(st.Close)

	if err := st.Init(ctx); err != nil {
		t.Fatalf("首次建表失败: %v", err)
	}
	if err := st.Init(ctx); err != nil {
		t.Fatalf("二次建表（幂等）失败: %v", err)
	}

	for _, table := range []string{
		"scheduler_leader_lease", "scheduler_nodes", "scheduler_tasks",
		"scheduler_dispatch_outbox", "scheduler_reconcile_ledger",
	} {
		var n int
		if err := st.Pool().QueryRow(ctx,
			`SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatalf("查表 %s 失败: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("表 %s 不存在", table)
		}
	}

	// 预插租约行存在且为空租约
	var holder string
	if err := st.Pool().QueryRow(ctx,
		`SELECT holder FROM scheduler_leader_lease WHERE id = 1`).Scan(&holder); err != nil {
		t.Fatalf("预插租约行缺失: %v", err)
	}
	if holder != "" {
		t.Fatalf("初始租约应为空, got %q", holder)
	}
}
```

- [ ] **Step 2: 运行确认失败**

```sh
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness/platform/control-plane/scheduler
go test ./...
```

Expected: FAIL（`no required module provides package github.com/lumo-harness/platform/scheduler/...` 或模块不存在）。

- [ ] **Step 3: 建模块**

创建 `go.mod`：

```
module github.com/lumo-harness/platform/scheduler

go 1.24
```

```sh
go mod tidy   # 拉取 pgx/v5 v5.7.2 并生成 go.sum
```

- [ ] **Step 4: 写 domain.go**

创建 `internal/domain/domain.go`：

```go
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

// Placement 一次放置决策的结果。
type Placement struct {
	TaskID       string
	NodeID       string
	Attempt      int
	State        TaskState
	FencingToken int64
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
```

- [ ] **Step 5: 写 dispatch.go**

创建 `internal/dispatch/dispatch.go`：

```go
// Package dispatch 定义放置派发落点。
//
// 本地实现写 PG outbox（与放置同事务，§13.2 的 RocketMQ 替代——PG 事务
// 天然提供「扣槽位 + 发任务」的原子性）；生产实现同一接口换 relay 语义。
package dispatch

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Envelope 投递给执行节点的任务信封（outbox payload，JSON 文本）。
type Envelope struct {
	TaskID    string                `json:"task_id"`
	Attempt   int                   `json:"attempt"`
	NodeID    string                `json:"node_id"`
	Realm     string                `json:"realm"`
	ClusterID string                `json:"cluster_id"`
	Priority  int                   `json:"priority"`
	Requires  []domain.Requirement `json:"requires"`
}

// Sink 派发落点：必须在放置事务内写入，保证「放置 ⟺ 派发」原子。
type Sink interface {
	WriteInto(ctx context.Context, tx pgx.Tx, env Envelope) error
}

// PgSink 本地实现：写 scheduler_dispatch_outbox。
type PgSink struct{}

func (PgSink) WriteInto(ctx context.Context, tx pgx.Tx, env Envelope) error {
	payload, err := json.Marshal(env)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_dispatch_outbox (task_id, attempt, node_id, payload, created_at)
		VALUES ($1, $2, $3, $4, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)`,
		env.TaskID, env.Attempt, env.NodeID, string(payload)); err != nil {
		return err
	}
	return nil
}
```

- [ ] **Step 6: 写 store.go（DDL + 连接管理）**

创建 `internal/store/store.go`（本任务版本；后续任务追加方法）：

```go
// Package store 实现调度服务的持久化：租约、放置事务、任务生命周期。
//
// fencing 校验点是放置事务内对租约行的 FOR UPDATE 锁：它同时把并发放置
// 串行化，槽位计数因此无竞态（spec §4）。
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/scheduler/internal/dispatch"
)

// nowMS 库端当前时刻（毫秒）。所有租约与时间比较都走它，不用节点本地时钟。
const nowMS = `(EXTRACT(EPOCH FROM now()) * 1000)::bigint`

// DDL 调度服务的表结构（幂等）。
const DDL = `
CREATE TABLE IF NOT EXISTS scheduler_leader_lease (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder        TEXT    NOT NULL,
  fencing_token BIGINT  NOT NULL,
  expires_at    BIGINT  NOT NULL
);

-- 预插空租约行：让 acquire 的 UPSERT 恒走 UPDATE 分支，语义单一
INSERT INTO scheduler_leader_lease (id, holder, fencing_token, expires_at)
SELECT 1, '', 0, 0 WHERE NOT EXISTS (SELECT 1 FROM scheduler_leader_lease WHERE id = 1);

CREATE TABLE IF NOT EXISTS scheduler_nodes (
  node_id       TEXT    PRIMARY KEY,
  cluster_id    TEXT    NOT NULL,
  capacity      INTEGER NOT NULL,
  capabilities  TEXT    NOT NULL,  -- JSON 数组文本（NUL 教训：payload 类列一律 TEXT）
  registered_at BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_tasks (
  task_id       TEXT    PRIMARY KEY,
  realm         TEXT    NOT NULL,
  cluster_id    TEXT    NOT NULL,
  requires      TEXT    NOT NULL,  -- JSON 文本
  priority      INTEGER NOT NULL DEFAULT 0,
  state         TEXT    NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 0,
  node_id       TEXT,
  fencing_token BIGINT  NOT NULL DEFAULT 0,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_pending
  ON scheduler_tasks (priority DESC, created_at) WHERE state = 'PENDING';

CREATE TABLE IF NOT EXISTS scheduler_dispatch_outbox (
  id         BIGSERIAL PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  attempt    INTEGER NOT NULL,
  node_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,  -- JSON 文本
  claimed_by TEXT,
  claimed_at BIGINT,
  created_at BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON scheduler_dispatch_outbox (node_id, id) WHERE claimed_by IS NULL;

-- 对账账本（降级占位语义：只接收 + 去重 + 落账）
CREATE TABLE IF NOT EXISTS scheduler_reconcile_ledger (
  entry_id    TEXT   PRIMARY KEY,
  task_id     TEXT   NOT NULL,
  cluster_id  TEXT   NOT NULL,
  state       TEXT   NOT NULL,
  recorded_at BIGINT NOT NULL
);
`

// Store 调度服务持久层。
type Store struct {
	pool *pgxpool.Pool
	sink dispatch.Sink
}

// New 建立连接池；默认派发落点为 PG outbox（§13.2 本地替代 RocketMQ）。
func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 连接 PG 失败: %w", err)
	}
	return &Store{pool: pool, sink: dispatch.PgSink{}}, nil
}

// NewWithSink 注入派发落点（测试注入故障 sink 验证回滚；生产换 relay 语义）。
func NewWithSink(ctx context.Context, dsn string, sink dispatch.Sink) (*Store, error) {
	s, err := New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s.sink = sink
	return s, nil
}

// Init 幂等建表（含预插空租约行）。
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("scheduler: 建表失败: %w", err)
	}
	return nil
}

// Pool 暴露连接池给同进程的目录与测试组件。
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Close 关闭连接池。
func (s *Store) Close() { s.pool.Close() }
```

- [ ] **Step 7: 运行确认通过**

```sh
gofmt -l .          # 必须无输出
go vet ./...        # 必须无输出
go build ./...
docker compose -f /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness/platform/deploy/compose.local.yml up -d postgres
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: `ok github.com/lumo-harness/platform/scheduler/internal/integration`。

- [ ] **Step 8: 提交**

```bash
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness
git add platform/control-plane/scheduler/
git commit -m "feat(scheduler): 模块骨架与领域模型（domain + DDL + dispatch seam）"
```

---

### Task 2: PG 租约选主（acquire / release / 竞态测试）

**Files:**
- Modify: `platform/control-plane/scheduler/internal/store/store.go`（追加 Acquire / Release / CurrentLease）
- Create: `platform/control-plane/scheduler/internal/election/election.go`
- Test: `platform/control-plane/scheduler/internal/integration/helpers_test.go`、`platform/control-plane/scheduler/internal/integration/lease_test.go`

**Interfaces:**
- Consumes: Task 1 全部产出
- Produces:
  - `(*store.Store).Acquire(ctx, holder string, ttlMs int64) (*domain.Lease, error)`（未取得返回 `domain.ErrNotAcquired`）
  - `(*store.Store).Release(ctx, holder string) error`（`expires_at=0`，不删行）
  - `(*store.Store).CurrentLease(ctx) (*domain.Lease, error)`（无持有者返回 nil）
  - `election.State`（`Current() *domain.Lease`、`IsLeader() bool`）
  - `election.Run(ctx, st *State, s *store.Store, holder string, ttl time.Duration, onChange func(bool))`

- [ ] **Step 1: 写失败的测试**

创建 `internal/integration/helpers_test.go`：

```go
package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// newStore 建 store 并清空调度表，保证用例隔离（活库共享，禁用 t.Parallel）。
func newStore(t *testing.T) *store.Store {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, testDSN(t))
	if err != nil {
		t.Fatalf("连接 PG 失败: %v", err)
	}
	t.Cleanup(st.Close)
	if err := st.Init(ctx); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := st.Pool().Exec(ctx, `
		TRUNCATE scheduler_tasks, scheduler_dispatch_outbox, scheduler_nodes,
		         scheduler_reconcile_ledger, scheduler_leader_lease`); err != nil {
		t.Fatalf("清表失败: %v", err)
	}
	// TRUNCATE 删掉了预插租约行，重跑 DDL 恢复
	if err := st.Init(ctx); err != nil {
		t.Fatalf("重建租约行失败: %v", err)
	}
	return st
}

// waitFor 轮询条件直至超时（选举是异步循环，断言前先等它就位）。
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("条件在超时内未满足")
}
```

创建 `internal/integration/lease_test.go`：

```go
package integration_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// TestElectionRace spec §7 场景 1：20 轮 × 20 并发抢租，每轮恰好 1 胜出。
func TestElectionRace(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	for round := 0; round < 20; round++ {
		if _, err := st.Pool().Exec(ctx, `TRUNCATE scheduler_leader_lease`); err != nil {
			t.Fatalf("第 %d 轮清租约失败: %v", round, err)
		}
		if err := st.Init(ctx); err != nil {
			t.Fatalf("第 %d 轮重建租约行失败: %v", round, err)
		}

		var mu sync.Mutex
		winners := 0
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				if l, err := st.Acquire(ctx, fmt.Sprintf("node-%d", i), 5000); err == nil && l != nil {
					mu.Lock()
					winners++
					mu.Unlock()
				}
			}(i)
		}
		wg.Wait()
		if winners != 1 {
			t.Fatalf("第 %d 轮胜出 %d 个, 应为 1", round, winners)
		}
	}
}

// TestTakeoverAfterExpiry spec §7 场景 2：持租未过期他人不可接管；过期后备节点接管，token +1。
func TestTakeoverAfterExpiry(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	const ttl = int64(800)

	a, err := st.Acquire(ctx, "node-a", ttl)
	if err != nil {
		t.Fatalf("a 首任应成功: %v", err)
	}
	if _, err := st.Acquire(ctx, "node-b", ttl); !errors.Is(err, domain.ErrNotAcquired) {
		t.Fatalf("a 持租未过期, b 不应接管, got %v", err)
	}

	time.Sleep(1200 * time.Millisecond) // 等 a 过期（无续租）

	b, err := st.Acquire(ctx, "node-b", ttl)
	if err != nil {
		t.Fatalf("过期后 b 应接管: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}
}

// TestGracefulRelease spec §7 场景 4：释放置 expires_at=0 → 备节点零等待接管。
func TestGracefulRelease(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	a, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("a 建租失败: %v", err)
	}
	if err := st.Release(ctx, "node-a"); err != nil {
		t.Fatalf("a 释放失败: %v", err)
	}

	b, err := st.Acquire(ctx, "node-b", 5000) // 无需等待 TTL
	if err != nil {
		t.Fatalf("释放后 b 应立即接管: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}
}
```

- [ ] **Step 2: 运行确认失败**

```sh
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness/platform/control-plane/scheduler
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./internal/integration/ -run 'TestElectionRace|TestTakeoverAfterExpiry|TestGracefulRelease' -count=1
```

Expected: FAIL（`st.Acquire undefined` 等编译错误）。

- [ ] **Step 3: store.go 追加租约方法**

在 `store.go` 顶部 import 块加入 `errors`、`pgx`、`domain` 包，并在 `Close` 方法后追加：

```go
// Acquire 建租 / 续租 / 接管三种情形一条语句完成（session-log 同形）。
//
// 续租不换 token（换则持有者自己的在途写会被自己的新 token 判为过期），
// 易主才 +1。返回 ErrNotAcquired 表示他人持有未过期租约——调用方不应等待。
func (s *Store) Acquire(ctx context.Context, holder string, ttlMs int64) (*domain.Lease, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO scheduler_leader_lease (id, holder, fencing_token, expires_at)
		VALUES (1, $1, 1, `+nowMS+` + $2)
		ON CONFLICT (id) DO UPDATE SET
			holder = EXCLUDED.holder,
			fencing_token = CASE WHEN scheduler_leader_lease.holder = EXCLUDED.holder
				THEN scheduler_leader_lease.fencing_token
				ELSE scheduler_leader_lease.fencing_token + 1 END,
			expires_at = EXCLUDED.expires_at
		WHERE scheduler_leader_lease.holder = EXCLUDED.holder
		   OR scheduler_leader_lease.expires_at < `+nowMS+`
		RETURNING holder, fencing_token, expires_at`,
		holder, ttlMs)
	var l domain.Lease
	if err := row.Scan(&l.Holder, &l.FencingToken, &l.ExpiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotAcquired
		}
		return nil, fmt.Errorf("scheduler: acquire 失败: %w", err)
	}
	return &l, nil
}

// Release 令租约立即过期而非删行：token 高水位不回落，删行会让下一个
// 持有者从 1 重新开始，旧持有者的过期令牌反而「复活」（spec §3 不变式 3）。
func (s *Store) Release(ctx context.Context, holder string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE scheduler_leader_lease SET expires_at = 0
		WHERE id = 1 AND holder = $1`, holder); err != nil {
		return fmt.Errorf("scheduler: release 失败: %w", err)
	}
	return nil
}

// CurrentLease 读取当前租约；无持有者（expires_at=0 空租约哨兵）返回 nil。
func (s *Store) CurrentLease(ctx context.Context) (*domain.Lease, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT holder, fencing_token, expires_at FROM scheduler_leader_lease WHERE id = 1`)
	var l domain.Lease
	if err := row.Scan(&l.Holder, &l.FencingToken, &l.ExpiresAt); err != nil {
		return nil, fmt.Errorf("scheduler: 读租约失败: %w", err)
	}
	if l.ExpiresAt == 0 {
		return nil, nil
	}
	return &l, nil
}
```

- [ ] **Step 4: 写 election.go**

创建 `internal/election/election.go`：

```go
// Package election 选主循环：acquire + 续租 + 领导权变更回调。
//
// 最终权威在库端 fencing（写路径每次校验租约行）；State 只是进程内快照，
// 供 HTTP 层做 no-leader 快速失败判定（spec §6：绝不挂起等待）。
package election

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// State 进程内领导权状态。
type State struct {
	current atomic.Pointer[domain.Lease]
}

// Current 当前租约快照；非 leader 返回 nil。
func (st *State) Current() *domain.Lease { return st.current.Load() }

// IsLeader 本进程当前是否 leader。
func (st *State) IsLeader() bool { return st.current.Load() != nil }

func (st *State) set(l *domain.Lease) { st.current.Store(l) }
func (st *State) clear()              { st.current.Store(nil) }

// Run 循环执行 acquire/续租直到 ctx 取消。
//
// onChange(true) 仅在获得（或重获）领导权时回调，续租不回调。
// 库不可用时保持现状：若本进程是 leader，写路径自会被库端 fencing 拒绝，
// 无需在选举层伪造降级。
func Run(ctx context.Context, st *State, s *store.Store, holder string, ttl time.Duration, onChange func(bool)) {
	try := func() {
		l, err := s.Acquire(ctx, holder, ttl.Milliseconds())
		if err != nil && !errors.Is(err, domain.ErrNotAcquired) {
			return
		}
		was := st.IsLeader()
		if l == nil {
			if was {
				st.clear()
				onChange(false)
			}
			return
		}
		if !was || st.Current().FencingToken != l.FencingToken {
			st.set(l)
			onChange(true)
		}
	}
	try()
	ticker := time.NewTicker(ttl / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			try()
		}
	}
}
```

- [ ] **Step 5: 运行确认通过**

```sh
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: 全绿。竞态测试约需数秒（20 轮 × 清表重建）。

- [ ] **Step 6: 提交**

```bash
git add platform/control-plane/scheduler/
git commit -m "feat(scheduler): PG 租约选主（acquire/release + 竞态/接管/零等待释放测试）"
```

---

### Task 3: 节点目录 + 过滤式放置（catalog + planner）

**Files:**
- Create: `platform/control-plane/scheduler/internal/catalog/catalog.go`
- Create: `platform/control-plane/scheduler/internal/planner/planner.go`
- Test: `platform/control-plane/scheduler/internal/planner/planner_test.go`（纯单元，无需 PG）、`platform/control-plane/scheduler/internal/integration/catalog_test.go`

**Interfaces:**
- Consumes: Task 1 的 `domain` / `store`
- Produces:
  - `catalog.Catalog{List(ctx) ([]domain.Node, error), Upsert(ctx, domain.Node) error}`、`catalog.Pg{Pool *pgxpool.Pool}`
  - `planner.Pick(task domain.Task, nodes []domain.Node, active map[string]int) *domain.Node`

- [ ] **Step 1: 写失败的测试**

创建 `internal/planner/planner_test.go`：

```go
package planner

import (
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

func reqs(keys ...string) []domain.Requirement {
	out := make([]domain.Requirement, len(keys))
	for i, k := range keys {
		out[i] = domain.Requirement{Key: k}
	}
	return out
}

func TestPickFiltersByCapability(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 4, Capabilities: []string{"llm"}},
		{NodeID: "b", Capacity: 4, Capabilities: []string{"doris"}},
	}
	task := domain.Task{Requires: reqs("llm")}
	got := Pick(task, nodes, map[string]int{})
	if got == nil || got.NodeID != "a" {
		t.Fatalf("应按能力过滤, got %+v", got)
	}
}

func TestPickSkipsFullNodes(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 1, Capabilities: []string{"llm"}},
		{NodeID: "b", Capacity: 2, Capabilities: []string{"llm"}},
	}
	task := domain.Task{Requires: reqs("llm")}
	got := Pick(task, nodes, map[string]int{"a": 1})
	if got == nil || got.NodeID != "b" {
		t.Fatalf("满槽节点应跳过, got %+v", got)
	}
}

func TestPickBalancesAndTiesDeterministically(t *testing.T) {
	nodes := []domain.Node{
		{NodeID: "a", Capacity: 2, Capabilities: []string{"llm"}},
		{NodeID: "b", Capacity: 2, Capabilities: []string{"llm"}},
	}
	task := domain.Task{Requires: reqs("llm")}
	if got := Pick(task, nodes, map[string]int{}); got == nil || got.NodeID != "a" {
		t.Fatalf("空载应选字典序最小, got %+v", got)
	}
	if got := Pick(task, nodes, map[string]int{"a": 1}); got == nil || got.NodeID != "b" {
		t.Fatalf("应选负载低者, got %+v", got)
	}
}

func TestPickNilWhenNoCandidate(t *testing.T) {
	nodes := []domain.Node{{NodeID: "a", Capacity: 1, Capabilities: []string{"llm"}}}
	task := domain.Task{Requires: reqs("doris")}
	if got := Pick(task, nodes, map[string]int{}); got != nil {
		t.Fatalf("无候选应为 nil, got %+v", got)
	}
}
```

创建 `internal/integration/catalog_test.go`：

```go
package integration_test

import (
	"context"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// TestCatalogRoundtrip upsert 后 List 读回，且重复 upsert 覆盖而非重复。
func TestCatalogRoundtrip(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}

	n := domain.Node{NodeID: "N1", ClusterID: "c1", Capacity: 4, Capabilities: []string{"llm", "pg"}}
	if err := cat.Upsert(ctx, n); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	n.Capacity = 8
	if err := cat.Upsert(ctx, n); err != nil {
		t.Fatalf("覆盖登记失败: %v", err)
	}

	nodes, err := cat.List(ctx)
	if err != nil {
		t.Fatalf("列节点失败: %v", err)
	}
	if len(nodes) != 1 {
		t.Fatalf("应有 1 个节点, got %d", len(nodes))
	}
	got := nodes[0]
	if got.NodeID != "N1" || got.Capacity != 8 || len(got.Capabilities) != 2 {
		t.Fatalf("节点读回不符: %+v", got)
	}
}
```

- [ ] **Step 2: 运行确认失败**

```sh
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./internal/... -count=1
```

Expected: FAIL（`no required module provides package .../catalog`、`undefined: Pick`）。

- [ ] **Step 3: 写 catalog.go**

创建 `internal/catalog/catalog.go`：

```go
// Package catalog 节点目录：放置候选的来源。
// 本地实现 PG（Local-lite）；生产换 Nacos Naming，接口不变（铁律 21）。
package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Catalog 放置候选目录。
type Catalog interface {
	List(ctx context.Context) ([]domain.Node, error)
	Upsert(ctx context.Context, n domain.Node) error
}

// Pg 本地实现：scheduler_nodes 表。
type Pg struct {
	Pool *pgxpool.Pool
}

func (p *Pg) List(ctx context.Context) ([]domain.Node, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT node_id, cluster_id, capacity, capabilities FROM scheduler_nodes`)
	if err != nil {
		return nil, fmt.Errorf("catalog: 列节点失败: %w", err)
	}
	defer rows.Close()
	var out []domain.Node
	for rows.Next() {
		var n domain.Node
		var caps string
		if err := rows.Scan(&n.NodeID, &n.ClusterID, &n.Capacity, &caps); err != nil {
			return nil, fmt.Errorf("catalog: 扫描节点失败: %w", err)
		}
		if err := json.Unmarshal([]byte(caps), &n.Capabilities); err != nil {
			return nil, fmt.Errorf("catalog: 解析 capabilities 失败: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (p *Pg) Upsert(ctx context.Context, n domain.Node) error {
	caps, err := json.Marshal(n.Capabilities)
	if err != nil {
		return fmt.Errorf("catalog: 序列化 capabilities 失败: %w", err)
	}
	if _, err := p.Pool.Exec(ctx, `
		INSERT INTO scheduler_nodes (node_id, cluster_id, capacity, capabilities, registered_at)
		VALUES ($1, $2, $3, $4, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
		ON CONFLICT (node_id) DO UPDATE SET
			cluster_id = EXCLUDED.cluster_id, capacity = EXCLUDED.capacity,
			capabilities = EXCLUDED.capabilities,
			registered_at = EXCLUDED.registered_at`,
		n.NodeID, n.ClusterID, n.Capacity, string(caps)); err != nil {
		return fmt.Errorf("catalog: 登记节点失败: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: 写 planner.go**

创建 `internal/planner/planner.go`：

```go
// Package planner 过滤式放置决策（spec §1：不做打分公式——A4 P2）。
package planner

import (
	"math"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Pick 在候选节点里选负载比最低者；同负载按 node_id 字典序（确定性，防抖）。
// 无候选（能力不匹配或全满）返回 nil。
func Pick(task domain.Task, nodes []domain.Node, active map[string]int) *domain.Node {
	var best *domain.Node
	bestRatio := math.Inf(1)
	for i := range nodes {
		n := &nodes[i]
		if !n.Satisfies(task.Requires) {
			continue
		}
		a := active[n.NodeID]
		if a >= n.Capacity {
			continue
		}
		ratio := float64(a) / float64(n.Capacity)
		if ratio < bestRatio || (ratio == bestRatio && best != nil && n.NodeID < best.NodeID) {
			best, bestRatio = n, ratio
		}
	}
	return best
}
```

- [ ] **Step 5: 运行确认通过**

```sh
gofmt -l . && go vet ./... && go build ./...
go test ./internal/planner/ -count=1
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./internal/integration/ -run TestCatalogRoundtrip -count=1
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add platform/control-plane/scheduler/
git commit -m "feat(scheduler): 节点目录与过滤式放置（catalog + planner）"
```

---

### Task 4: 放置事务 + fencing（attempt 单飞 + outbox 原子）

**Files:**
- Modify: `platform/control-plane/scheduler/internal/store/store.go`（追加 checkFencing / PlaceTask / QueueTask / CompleteTask / GetPlacement）
- Modify: `platform/control-plane/scheduler/internal/integration/helpers_test.go`（追加 rowCount）
- Test: `platform/control-plane/scheduler/internal/integration/placement_test.go`

**Interfaces:**
- Consumes: Task 1–3 全部产出
- Produces:
  - `(*store.Store).PlaceTask(ctx, lease *domain.Lease, task domain.Task, nodeID string) (domain.Placement, error)`（FencedOut / NoCapacity / 幂等返回）
  - `(*store.Store).QueueTask(ctx, lease *domain.Lease, task domain.Task) (domain.TaskState, error)`
  - `(*store.Store).CompleteTask(ctx, taskID string, final domain.TaskState) (domain.Placement, error)`
  - `(*store.Store).GetPlacement(ctx, taskID string) (domain.Placement, error)`

- [ ] **Step 1: 写失败的测试**

在 `helpers_test.go` 末尾追加：

```go
// rowCount 单值计数断言辅助。
func rowCount(t *testing.T, st *store.Store, query string) int {
	t.Helper()
	var n int
	if err := st.Pool().QueryRow(context.Background(), query).Scan(&n); err != nil {
		t.Fatalf("计数失败: %v", err)
	}
	return n
}
```

创建 `internal/integration/placement_test.go`：

```go
package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/dispatch"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// nodeN1 一个 cap 4 的单节点目录。
func nodeN1(t *testing.T, st *store.Store) {
	t.Helper()
	if err := (&catalog.Pg{Pool: st.Pool()}).Upsert(context.Background(),
		domain.Node{NodeID: "N1", ClusterID: "c1", Capacity: 4, Capabilities: []string{"llm"}}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
}

func outboxCount(t *testing.T, st *store.Store, taskID string) int {
	t.Helper()
	return rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = '`+taskID+`'`)
}

// TestFencedOutPlacement spec §7 场景 3：旧 leader 被 fencing 拒写；接管后重放 attempt+1 而非双执行。
func TestFencedOutPlacement(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)

	a, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("a 建租失败: %v", err)
	}
	if err := st.Release(ctx, "node-a"); err != nil {
		t.Fatalf("a 释放失败: %v", err)
	}
	b, err := st.Acquire(ctx, "node-b", 5000) // 零等待接管，token = a+1
	if err != nil {
		t.Fatalf("b 接管失败: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}

	task := domain.Task{TaskID: "t1", Realm: "r1", ClusterID: "c1",
		Requires: []domain.Requirement{{Key: "llm"}}}

	// 旧 leader 用旧租约放置 → FencedOut
	_, err = st.PlaceTask(ctx, a, task, "N1")
	var fo *domain.FencedOutError
	if !errors.As(err, &fo) {
		t.Fatalf("旧 leader 放置应被 fencing 拒, got %v", err)
	}

	// 新 leader 放置成功
	p, err := st.PlaceTask(ctx, b, task, "N1")
	if err != nil || p.Attempt != 1 || p.State != domain.StatePlaced {
		t.Fatalf("新 leader 放置失败: %+v err=%v", p, err)
	}

	// 旧 attempt 终态后重放 → attempt+1
	if _, err := st.CompleteTask(ctx, "t1", domain.StateFailed); err != nil {
		t.Fatalf("回报终态失败: %v", err)
	}
	p2, err := st.PlaceTask(ctx, b, task, "N1")
	if err != nil || p2.Attempt != 2 {
		t.Fatalf("重放应 attempt+1: %+v err=%v", p2, err)
	}

	// 活跃 attempt 再重放 → 幂等返回既有放置，不产生双执行
	p3, err := st.PlaceTask(ctx, b, task, "N1")
	if err != nil || p3.Attempt != 2 || p3.NodeID != "N1" {
		t.Fatalf("活跃 attempt 应幂等返回: %+v err=%v", p3, err)
	}
	if n := outboxCount(t, st, "t1"); n != 2 {
		t.Fatalf("outbox 应恰好 2 条（每 attempt 一条）, got %d", n)
	}
}

// TestIdempotentResubmit spec §7 场景 5：同 task_id 重交只产生一次放置与一条 outbox。
func TestIdempotentResubmit(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}

	task := domain.Task{TaskID: "t1", Realm: "r1", ClusterID: "c1"}
	p1, err := st.PlaceTask(ctx, l, task, "N1")
	if err != nil {
		t.Fatalf("首放失败: %v", err)
	}
	p2, err := st.PlaceTask(ctx, l, task, "N1")
	if err != nil {
		t.Fatalf("重交失败: %v", err)
	}
	if p1.Attempt != p2.Attempt || p1.NodeID != p2.NodeID || p2.Attempt != 1 {
		t.Fatalf("重交应返回同一放置: %+v vs %+v", p1, p2)
	}
	if n := outboxCount(t, st, "t1"); n != 1 {
		t.Fatalf("outbox 应恰好 1 条, got %d", n)
	}
}

// TestOutboxAtomicity spec §7 场景 8：放置 ⟺ 派发同事务，任一失败两行皆无。
func TestOutboxAtomicity(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}

	// 故障 sink：派发写失败 → 整个放置回滚
	bad, err := store.NewWithSink(ctx, testDSN(t), failingSink{})
	if err != nil {
		t.Fatalf("建故障 store 失败: %v", err)
	}
	t.Cleanup(bad.Close)

	task := domain.Task{TaskID: "t-bad", Realm: "r1", ClusterID: "c1"}
	if _, err := bad.PlaceTask(ctx, l, task, "N1"); err == nil {
		t.Fatal("派发失败应导致放置失败")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id = 't-bad'`); n != 0 {
		t.Fatalf("失败放置的任务行应回滚, got %d 行", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = 't-bad'`); n != 0 {
		t.Fatalf("失败放置的 outbox 应回滚, got %d 行", n)
	}

	// 正常 sink：两行同在
	if _, err := st.PlaceTask(ctx, l, task, "N1"); err != nil {
		t.Fatalf("正常放置失败: %v", err)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id = 't-bad'`); n != 1 {
		t.Fatalf("任务行应在, got %d", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = 't-bad'`); n != 1 {
		t.Fatalf("outbox 行应在, got %d", n)
	}
}

type failingSink struct{}

func (failingSink) WriteInto(context.Context, pgx.Tx, dispatch.Envelope) error {
	return errors.New("sink 故障")
}
```

- [ ] **Step 2: 运行确认失败**

```sh
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./internal/integration/ -run 'TestFencedOutPlacement|TestIdempotentResubmit|TestOutboxAtomicity' -count=1
```

Expected: FAIL（`st.PlaceTask undefined` 等编译错误）。

- [ ] **Step 3: store.go 追加放置事务方法**

在 `store.go` import 块加入 `encoding/json`、`errors`、`pgx`、`domain`（如尚未加入），在 `CurrentLease` 后追加：

```go
// checkFencing 校验本节点仍是当前代 leader：holder、token、租约未过期三者全对。
// FOR UPDATE 锁租约行——同时把并发放置串行化（槽位闸无竞态的前提，spec §4）。
func checkFencing(ctx context.Context, tx pgx.Tx, lease *domain.Lease) error {
	var token int64
	err := tx.QueryRow(ctx, `
		SELECT fencing_token FROM scheduler_leader_lease
		WHERE id = 1 AND holder = $1 AND expires_at > `+nowMS+`
		FOR UPDATE`, lease.Holder).Scan(&token)
	if errors.Is(err, pgx.ErrNoRows) {
		// holder 已易主，或租约已过期（此刻任何人可接管，本节点已无排他性）
		return &domain.FencedOutError{Token: lease.FencingToken}
	}
	if err != nil {
		return fmt.Errorf("scheduler: 读租约失败: %w", err)
	}
	if token != lease.FencingToken {
		return &domain.FencedOutError{Token: lease.FencingToken, Current: token}
	}
	return nil
}

// PlaceTask 把任务放到指定节点：fencing 校验 + 槽位闸 + attempt 单飞 + outbox 同事务。
//
// 幂等语义：任务已有活跃 attempt 时返回既有放置，不产生第二次派发；
// 旧 attempt 已终态（或任务仅 PENDING）时开启 attempt+1。
// attempt 单飞由本事务的 FOR UPDATE + 状态检查保证——task_id 是主键，
// 每任务只有一行，无需 spec §4 初稿设想的唯一部分索引。
func (s *Store) PlaceTask(ctx context.Context, lease *domain.Lease, task domain.Task, nodeID string) (domain.Placement, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := checkFencing(ctx, tx, lease); err != nil {
		return domain.Placement{}, err
	}

	// 槽位闸：事务内计数。租约行 FOR UPDATE 已把并发放置串行化，计数无竞态。
	var capacity int
	if err := tx.QueryRow(ctx,
		`SELECT capacity FROM scheduler_nodes WHERE node_id = $1`, nodeID).Scan(&capacity); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Placement{}, &domain.NoCapacityError{}
		}
		return domain.Placement{}, fmt.Errorf("scheduler: 查询节点容量失败: %w", err)
	}
	var active int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM scheduler_tasks
		WHERE node_id = $1 AND state IN ('PLACED', 'RUNNING')`, nodeID).Scan(&active); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 槽位计数失败: %w", err)
	}
	if active >= capacity {
		return domain.Placement{}, &domain.NoCapacityError{}
	}

	// attempt 单飞判定
	var prevState string
	var prevNode *string
	var prevAttempt int
	var prevToken int64
	err = tx.QueryRow(ctx, `
		SELECT state, node_id, attempt, fencing_token FROM scheduler_tasks
		WHERE task_id = $1 FOR UPDATE`, task.TaskID).
		Scan(&prevState, &prevNode, &prevAttempt, &prevToken)
	if err == nil && domain.TaskState(prevState).Active() {
		if err := tx.Commit(ctx); err != nil {
			return domain.Placement{}, fmt.Errorf("scheduler: 提交幂等返回失败: %w", err)
		}
		p := domain.Placement{TaskID: task.TaskID, Attempt: prevAttempt,
			State: domain.TaskState(prevState), FencingToken: prevToken}
		if prevNode != nil {
			p.NodeID = *prevNode
		}
		return p, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return domain.Placement{}, fmt.Errorf("scheduler: 查询任务失败: %w", err)
	}
	attempt := 1
	if err == nil {
		attempt = prevAttempt + 1 // 终态或 PENDING：开启新 attempt
	}

	requiresJSON, err := json.Marshal(task.Requires)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 序列化 requires 失败: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, priority, state, attempt, node_id, fencing_token, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'PLACED', $6, $7, $8, `+nowMS+`, `+nowMS+`)
		ON CONFLICT (task_id) DO UPDATE SET
			state = 'PLACED', attempt = $6, node_id = $7,
			fencing_token = $8, requires = $4, updated_at = `+nowMS+``,
		task.TaskID, task.Realm, task.ClusterID, string(requiresJSON), task.Priority,
		attempt, nodeID, lease.FencingToken); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写任务失败: %w", err)
	}

	if err := s.sink.WriteInto(ctx, tx, dispatch.Envelope{
		TaskID:    task.TaskID,
		Attempt:   attempt,
		NodeID:    nodeID,
		Realm:     task.Realm,
		ClusterID: task.ClusterID,
		Priority:  task.Priority,
		Requires:  task.Requires,
	}); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写派发失败: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 提交放置失败: %w", err)
	}
	return domain.Placement{
		TaskID: task.TaskID, NodeID: nodeID, Attempt: attempt,
		State: domain.StatePlaced, FencingToken: lease.FencingToken,
	}, nil
}

// QueueTask 无候选节点时把任务落 PENDING（drain loop 后续重试）。
// 幂等：活跃 attempt 保持不变；终态任务重置回 PENDING（保留 attempt 高水位，
// 下次放置自然 +1）。
func (s *Store) QueueTask(ctx context.Context, lease *domain.Lease, task domain.Task) (domain.TaskState, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := checkFencing(ctx, tx, lease); err != nil {
		return "", err
	}

	var state string
	err = tx.QueryRow(ctx, `SELECT state FROM scheduler_tasks WHERE task_id = $1 FOR UPDATE`, task.TaskID).Scan(&state)
	if err == nil {
		if domain.TaskState(state).Terminal() {
			if _, err := tx.Exec(ctx, `
				UPDATE scheduler_tasks SET state = 'PENDING', updated_at = `+nowMS+`
				WHERE task_id = $1`, task.TaskID); err != nil {
				return "", fmt.Errorf("scheduler: 重置排队失败: %w", err)
			}
			state = string(domain.StatePending)
		}
		if err := tx.Commit(ctx); err != nil {
			return "", fmt.Errorf("scheduler: 提交排队失败: %w", err)
		}
		return domain.TaskState(state), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("scheduler: 查询任务失败: %w", err)
	}

	requiresJSON, err := json.Marshal(task.Requires)
	if err != nil {
		return "", fmt.Errorf("scheduler: 序列化 requires 失败: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, priority, state, attempt, fencing_token, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'PENDING', 0, $6, `+nowMS+`, `+nowMS+`)`,
		task.TaskID, task.Realm, task.ClusterID, string(requiresJSON), task.Priority, lease.FencingToken); err != nil {
		return "", fmt.Errorf("scheduler: 写排队任务失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("scheduler: 提交排队失败: %w", err)
	}
	return domain.StatePending, nil
}

// CompleteTask 执行器回报终态：仅从活跃态转终态，幂等。
// 不需要 fencing：这不是放置决策（N1 只管放置写入），状态条件 UPDATE 天然幂等。
func (s *Store) CompleteTask(ctx context.Context, taskID string, final domain.TaskState) (domain.Placement, error) {
	if !final.Terminal() {
		return domain.Placement{}, fmt.Errorf("scheduler: 非终态回报 %q", final)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE scheduler_tasks SET state = $2, updated_at = `+nowMS+`
		WHERE task_id = $1 AND state IN ('PLACED', 'RUNNING')`, taskID, string(final))
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 回报终态失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return s.GetPlacement(ctx, taskID) // 已终态 → 幂等返回现有；不存在 → TaskNotFound
	}
	return s.GetPlacement(ctx, taskID)
}

// GetPlacement 查询任务当前状态（API 观测用）。
func (s *Store) GetPlacement(ctx context.Context, taskID string) (domain.Placement, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT state, node_id, attempt, fencing_token FROM scheduler_tasks WHERE task_id = $1`, taskID)
	var p domain.Placement
	var state string
	var nodeID *string
	if err := row.Scan(&state, &nodeID, &p.Attempt, &p.FencingToken); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Placement{}, &domain.TaskNotFoundError{TaskID: taskID}
		}
		return domain.Placement{}, fmt.Errorf("scheduler: 查询放置失败: %w", err)
	}
	p.TaskID = taskID
	p.State = domain.TaskState(state)
	if nodeID != nil {
		p.NodeID = *nodeID
	}
	return p, nil
}
```

- [ ] **Step 4: 运行确认通过**

```sh
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add platform/control-plane/scheduler/
git commit -m "feat(scheduler): 放置事务与 fencing（attempt 单飞 + outbox 原子 + 幂等重交）"
```

---

### Task 5: 排队读取 + 派发认领 + drain 流程

**Files:**
- Modify: `platform/control-plane/scheduler/internal/store/store.go`（追加 PendingTasks / ActiveCounts / ClaimDispatch）
- Test: `platform/control-plane/scheduler/internal/integration/drain_test.go`

**Interfaces:**
- Consumes: Task 4 全部产出
- Produces:
  - `(*store.Store).PendingTasks(ctx, limit int) ([]domain.Task, error)`（priority 降序、created_at 升序）
  - `(*store.Store).ActiveCounts(ctx) (map[string]int, error)`
  - `(*store.Store).ClaimDispatch(ctx, nodeID string, limit int) ([]dispatch.Envelope, error)`

- [ ] **Step 1: 写失败的测试**

创建 `internal/integration/drain_test.go`：

```go
package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
)

// TestSlotGateAndDrain spec §7 场景 7：槽位满 → 排队 PENDING；首任务终态后 drain 放置成功。
func TestSlotGateAndDrain(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "N1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	l, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}

	t1 := domain.Task{TaskID: "t1", Realm: "r1", ClusterID: "c1"}
	t2 := domain.Task{TaskID: "t2", Realm: "r1", ClusterID: "c1", Priority: 5}
	if _, err := st.PlaceTask(ctx, l, t1, "N1"); err != nil {
		t.Fatalf("t1 放置失败: %v", err)
	}

	// 槽位满（cap 1）：直接放置拒绝，排队入 PENDING
	if _, err := st.PlaceTask(ctx, l, t2, "N1"); !errors.As(err, new(*domain.NoCapacityError)) {
		t.Fatalf("槽位满应 NoCapacity, got %v", err)
	}
	state, err := st.QueueTask(ctx, l, t2)
	if err != nil || state != domain.StatePending {
		t.Fatalf("t2 应排队 PENDING: %v err=%v", state, err)
	}
	if n := outboxCount(t, st, "t2"); n != 0 {
		t.Fatalf("排队任务不应有派发, got %d", n)
	}

	// 首任务终态 → 槽位释放 → drain：pending → 规划 → 放置
	if _, err := st.CompleteTask(ctx, "t1", domain.StateCompleted); err != nil {
		t.Fatalf("t1 回报终态失败: %v", err)
	}
	pending, err := st.PendingTasks(ctx, 10)
	if err != nil || len(pending) != 1 || pending[0].TaskID != "t2" {
		t.Fatalf("pending 应含 t2: %+v err=%v", pending, err)
	}
	nodes, err := cat.List(ctx)
	if err != nil {
		t.Fatalf("列节点失败: %v", err)
	}
	active, err := st.ActiveCounts(ctx)
	if err != nil {
		t.Fatalf("活跃计数失败: %v", err)
	}
	n := planner.Pick(pending[0], nodes, active)
	if n == nil {
		t.Fatal("槽位释放后应有候选节点")
	}
	p, err := st.PlaceTask(ctx, l, pending[0], n.NodeID)
	if err != nil || p.State != domain.StatePlaced || p.Attempt != 1 {
		t.Fatalf("drain 放置失败: %+v err=%v", p, err)
	}
	if n := outboxCount(t, st, "t2"); n != 1 {
		t.Fatalf("drain 放置应恰好 1 条派发, got %d", n)
	}

	// 派发认领闭环：节点取走信封，二次认领为空
	envs, err := st.ClaimDispatch(ctx, "N1", 10)
	if err != nil || len(envs) != 1 || envs[0].TaskID != "t2" {
		t.Fatalf("认领应取回 t2: %+v err=%v", envs, err)
	}
	envs2, err := st.ClaimDispatch(ctx, "N1", 10)
	if err != nil || len(envs2) != 0 {
		t.Fatalf("二次认领应为空: %+v err=%v", envs2, err)
	}
}
```

- [ ] **Step 2: 运行确认失败**

```sh
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./internal/integration/ -run TestSlotGateAndDrain -count=1
```

Expected: FAIL（`st.PendingTasks undefined` 等编译错误）。

- [ ] **Step 3: store.go 追加排队/计数/认领方法**

在 `GetPlacement` 后追加：

```go
// PendingTasks 供 drain loop 取排队任务（priority 高者先，同优先级先到先得）。
func (s *Store) PendingTasks(ctx context.Context, limit int) ([]domain.Task, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT task_id, realm, cluster_id, requires, priority FROM scheduler_tasks
		WHERE state = 'PENDING' ORDER BY priority DESC, created_at LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 取排队任务失败: %w", err)
	}
	defer rows.Close()
	var out []domain.Task
	for rows.Next() {
		var t domain.Task
		var requires string
		if err := rows.Scan(&t.TaskID, &t.Realm, &t.ClusterID, &requires, &t.Priority); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描排队任务失败: %w", err)
		}
		if err := json.Unmarshal([]byte(requires), &t.Requires); err != nil {
			return nil, fmt.Errorf("scheduler: 解析 requires 失败: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ActiveCounts 每节点活跃放置数（放置规划的槽位输入）。
func (s *Store) ActiveCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT node_id, count(*) FROM scheduler_tasks
		WHERE state IN ('PLACED', 'RUNNING') GROUP BY node_id`)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 活跃计数失败: %w", err)
	}
	defer rows.Close()
	out := make(map[string]int)
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描活跃计数失败: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

// ClaimDispatch 执行节点认领派发给它的信封；claimed_by 置位即被取走（幂等）。
func (s *Store) ClaimDispatch(ctx context.Context, nodeID string, limit int) ([]dispatch.Envelope, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE scheduler_dispatch_outbox SET claimed_by = $1, claimed_at = `+nowMS+`
		WHERE id IN (
			SELECT id FROM scheduler_dispatch_outbox
			WHERE node_id = $1 AND claimed_by IS NULL ORDER BY id LIMIT $2
		)
		RETURNING payload`, nodeID, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 认领派发失败: %w", err)
	}
	defer rows.Close()
	var out []dispatch.Envelope
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描派发失败: %w", err)
		}
		var env dispatch.Envelope
		if err := json.Unmarshal([]byte(payload), &env); err != nil {
			return nil, fmt.Errorf("scheduler: 解析派发失败: %w", err)
		}
		out = append(out, env)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: 运行确认通过**

```sh
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add platform/control-plane/scheduler/
git commit -m "feat(scheduler): 排队读取与派发认领（drain 闭环测试）"
```

---

### Task 6: HTTP API + 降级快速失败

**Files:**
- Create: `platform/control-plane/scheduler/internal/server/server.go`
- Modify: `platform/control-plane/scheduler/internal/store/store.go`（追加 ReconcileEntry / Reconcile）
- Test: `platform/control-plane/scheduler/internal/integration/http_test.go`

**Interfaces:**
- Consumes: Task 1–5 全部产出
- Produces:
  - `server.New(st *store.Store, elec *election.State, cat catalog.Catalog, log *slog.Logger) *Server`
  - `(*Server).Routes() http.Handler`
  - `(*store.Store).Reconcile(ctx, lease *domain.Lease, entries []ReconcileEntry) (int, error)`、`store.ReconcileEntry{EntryID, TaskID, ClusterID, State}`

- [ ] **Step 1: 写失败的测试**

创建 `internal/integration/http_test.go`：

```go
package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/server"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestHTTPNoLeaderFastFailAndFullFlow spec §7 场景 6 + 全流程：
// 无 leader 503 快速失败 → 选举就位 → 注册/放置/查询/终态/对账。
func TestHTTPNoLeaderFastFailAndFullFlow(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	elec := &election.State{}
	ts := httptest.NewServer(server.New(st, elec, &catalog.Pg{Pool: st.Pool()}, discardLogger()).Routes())
	defer ts.Close()

	post := func(path, realm, body string) (*http.Response, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatalf("构造请求失败: %v", err)
		}
		if realm != "" {
			req.Header.Set("X-Lumo-Realm", realm)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	get := func(path string) (*http.Response, string) {
		t.Helper()
		resp, err := http.DefaultClient.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	// 无 leader：放置与对账都 503 快速失败
	resp, body := post("/v1/placements", "r1", `{"task_id":"t1","cluster_id":"c1"}`)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("无 leader 应 503 no-leader: %d %s", resp.StatusCode, body)
	}
	resp, body = post("/v1/reconcile", "", `{"entries":[{"entry_id":"e1","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "no-leader") {
		t.Fatalf("无 leader 对账应 503 no-leader: %d %s", resp.StatusCode, body)
	}

	// 选举就位：Run 循环首轮立即 acquire，轮询等待
	eCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go election.Run(eCtx, elec, st, "node-test", 5000, func(bool) {})
	waitFor(t, 2*time.Second, elec.IsLeader)

	// 全流程：注册节点 → 放置 → 查询 → 回报终态
	resp, body = post("/v1/nodes", "", `{"node_id":"N1","cluster_id":"c1","capacity":2,"capabilities":["llm"]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("注册节点失败: %d %s", resp.StatusCode, body)
	}
	resp, body = post("/v1/placements", "r1", `{"task_id":"t1","cluster_id":"c1","requires":[{"key":"llm"}],"priority":5}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("放置失败: %d %s", resp.StatusCode, body)
	}
	var p domain.Placement
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("解析放置响应失败: %v", err)
	}
	if p.Attempt != 1 || p.NodeID != "N1" || p.State != domain.StatePlaced {
		t.Fatalf("放置响应不符: %+v", p)
	}

	resp, body = get("/v1/placements/t1")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "PLACED") {
		t.Fatalf("查询放置失败: %d %s", resp.StatusCode, body)
	}

	// 回报终态（幂等：二次回报同样成功）
	for i := 0; i < 2; i++ {
		resp, body = post("/v1/tasks/t1/result", "", `{"state":"COMPLETED"}`)
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, "COMPLETED") {
			t.Fatalf("回报终态失败: %d %s", resp.StatusCode, body)
		}
	}

	// leader 观测
	resp, body = get("/v1/leader")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, "node-test") {
		t.Fatalf("leader 应为本测试节点: %d %s", resp.StatusCode, body)
	}

	// 对账：leader 就位后入库 + 幂等去重
	resp, body = post("/v1/reconcile", "", `{"entries":[{"entry_id":"e1","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"recorded":1`) {
		t.Fatalf("对账应记录 1 条: %d %s", resp.StatusCode, body)
	}
	resp, body = post("/v1/reconcile", "", `{"entries":[{"entry_id":"e1","task_id":"t9","cluster_id":"c1","state":"RUNNING"}]}`)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"recorded":0`) {
		t.Fatalf("重复对账应去重记录 0 条: %d %s", resp.StatusCode, body)
	}
}
```

- [ ] **Step 2: 运行确认失败**

```sh
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./internal/integration/ -run TestHTTPNoLeaderFastFailAndFullFlow -count=1
```

Expected: FAIL（`no required module provides package .../server` 编译错误）。

- [ ] **Step 3: store.go 追加对账方法**

在 `ClaimDispatch` 后追加：

```go
// ReconcileEntry 集群本地放置记录（降级对账，占位语义）。
type ReconcileEntry struct {
	EntryID   string `json:"entry_id"`
	TaskID    string `json:"task_id"`
	ClusterID string `json:"cluster_id"`
	State     string `json:"state"`
}

// Reconcile 对账占位语义（spec §6）：接收 + 去重 + 落账，需 leader。
// 多集群的合并裁决逻辑留给 §7.4 集群 Scheduler 交付时实现——接口形状现在定死。
func (s *Store) Reconcile(ctx context.Context, lease *domain.Lease, entries []ReconcileEntry) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := checkFencing(ctx, tx, lease); err != nil {
		return 0, err
	}
	inserted := 0
	for _, e := range entries {
		if e.EntryID == "" {
			continue
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO scheduler_reconcile_ledger (entry_id, task_id, cluster_id, state, recorded_at)
			VALUES ($1, $2, $3, $4, `+nowMS+`)
			ON CONFLICT (entry_id) DO NOTHING`,
			e.EntryID, e.TaskID, e.ClusterID, e.State)
		if err != nil {
			return 0, fmt.Errorf("scheduler: 对账落账失败: %w", err)
		}
		inserted += int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("scheduler: 提交对账失败: %w", err)
	}
	return inserted, nil
}
```

- [ ] **Step 4: 写 server.go**

创建 `internal/server/server.go`：

```go
// Package server 调度服务 HTTP API。
//
// 身份经网关注入头传递（collaborator 同款）：X-Lumo-Realm 必填，
// 生产形态下边缘网关完成认证并注入；本服务不自行签发凭证（§6.3）。
package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// Server 调度服务 HTTP 层。
type Server struct {
	store   *store.Store
	elec    *election.State
	catalog catalog.Catalog
	log     *slog.Logger
}

// New 装配 HTTP 层。
func New(st *store.Store, elec *election.State, cat catalog.Catalog, log *slog.Logger) *Server {
	return &Server{store: st, elec: elec, catalog: cat, log: log}
}

// Routes 路由表（Go 1.22+ 方法+通配语法）。
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /v1/leader", s.handleLeader)
	mux.HandleFunc("POST /v1/placements", s.handlePlace)
	mux.HandleFunc("GET /v1/placements/{taskId}", s.handleGetPlacement)
	mux.HandleFunc("POST /v1/tasks/{taskId}/result", s.handleResult)
	mux.HandleFunc("POST /v1/nodes", s.handleUpsertNode)
	mux.HandleFunc("POST /v1/reconcile", s.handleReconcile)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleLeader(w http.ResponseWriter, _ *http.Request) {
	if l := s.elec.Current(); l != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"holder": l.Holder, "fencing_token": l.FencingToken, "expires_at": l.ExpiresAt,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"holder": nil})
}

// placeRequest 放置请求体。
type placeRequest struct {
	TaskID    string                `json:"task_id"`
	ClusterID string                `json:"cluster_id"`
	Requires  []domain.Requirement `json:"requires"`
	Priority  int                   `json:"priority"`
}

func (s *Server) handlePlace(w http.ResponseWriter, r *http.Request) {
	realm := r.Header.Get("X-Lumo-Realm")
	if realm == "" {
		writeError(w, http.StatusBadRequest, "missing-realm", "缺少网关注入的 X-Lumo-Realm 头")
		return
	}
	var req placeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TaskID == "" {
		writeError(w, http.StatusBadRequest, "bad-request", "请求体非法或缺少 task_id")
		return
	}
	// 降级语义（spec §6）：无 leader 快速失败，绝不挂起等待。
	lease := s.elec.Current()
	if lease == nil {
		writeError(w, http.StatusServiceUnavailable, "no-leader", "当前无 leader，请稍后重试")
		return
	}
	task := domain.Task{
		TaskID: req.TaskID, Realm: realm, ClusterID: req.ClusterID,
		Requires: req.Requires, Priority: req.Priority,
	}

	nodes, err := s.catalog.List(r.Context())
	if err != nil {
		s.log.Error("列节点失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "列节点失败")
		return
	}
	active, err := s.store.ActiveCounts(r.Context())
	if err != nil {
		s.log.Error("活跃计数失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "活跃计数失败")
		return
	}

	n := planner.Pick(task, nodes, active)
	if n == nil {
		state, err := s.store.QueueTask(r.Context(), lease, task)
		if err != nil {
			s.respondStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"task_id": task.TaskID, "state": state})
		return
	}

	p, err := s.store.PlaceTask(r.Context(), lease, task, n.NodeID)
	var ncap *domain.NoCapacityError
	if errors.As(err, &ncap) {
		// 规划后槽位被并发占用：转排队（罕见路径，drain 会接续）
		state, err2 := s.store.QueueTask(r.Context(), lease, task)
		if err2 != nil {
			s.respondStoreError(w, err2)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"task_id": task.TaskID, "state": state})
		return
	}
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) handleGetPlacement(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.GetPlacement(r.Context(), r.PathValue("taskId"))
	var nf *domain.TaskNotFoundError
	if errors.As(err, &nf) {
		writeError(w, http.StatusNotFound, "task-not-found", nf.Error())
		return
	}
	if err != nil {
		s.log.Error("查询放置失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "查询放置失败")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// resultRequest 终态回报体。
type resultRequest struct {
	State domain.TaskState `json:"state"`
}

func (s *Server) handleResult(w http.ResponseWriter, r *http.Request) {
	var req resultRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !req.State.Terminal() {
		writeError(w, http.StatusBadRequest, "bad-request", "state 必须是 COMPLETED/FAILED/ABORTED")
		return
	}
	p, err := s.store.CompleteTask(r.Context(), r.PathValue("taskId"), req.State)
	var nf *domain.TaskNotFoundError
	if errors.As(err, &nf) {
		writeError(w, http.StatusNotFound, "task-not-found", nf.Error())
		return
	}
	if err != nil {
		s.log.Error("回报终态失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "回报终态失败")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleUpsertNode(w http.ResponseWriter, r *http.Request) {
	var n domain.Node
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil || n.NodeID == "" || n.ClusterID == "" || n.Capacity < 1 {
		writeError(w, http.StatusBadRequest, "bad-request", "node_id/cluster_id 必填且 capacity ≥ 1")
		return
	}
	// 节点登记不是放置决策，无需 leader（本地形态；生产走 Nacos Naming，不经此端点）
	if err := s.catalog.Upsert(r.Context(), n); err != nil {
		s.log.Error("登记节点失败", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "登记节点失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"node_id": n.NodeID})
}

// reconcileRequest 对账请求体（占位语义，spec §6）。
type reconcileRequest struct {
	Entries []store.ReconcileEntry `json:"entries"`
}

func (s *Server) handleReconcile(w http.ResponseWriter, r *http.Request) {
	lease := s.elec.Current()
	if lease == nil {
		writeError(w, http.StatusServiceUnavailable, "no-leader", "当前无 leader，快速失败")
		return
	}
	var req reconcileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", "请求体非法")
		return
	}
	recorded, err := s.store.Reconcile(r.Context(), lease, req.Entries)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recorded": recorded})
}

// respondStoreError 领域错误 → HTTP 状态映射（spec §6 表）。
func (s *Server) respondStoreError(w http.ResponseWriter, err error) {
	var fo *domain.FencedOutError
	if errors.As(err, &fo) {
		writeError(w, http.StatusServiceUnavailable, "fenced-out", "本节点已失去领导权，请向新 leader 重交")
		return
	}
	s.log.Error("调度操作失败", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "调度操作失败")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, codeStr, msg string) {
	writeJSON(w, code, map[string]string{"error": codeStr, "message": msg})
}
```

- [ ] **Step 5: 运行确认通过**

```sh
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add platform/control-plane/scheduler/
git commit -m "feat(scheduler): HTTP API 与降级快速失败（no-leader 503 + 对账占位）"
```

---

### Task 7: 服务装配 + 双实例热备（main + Dockerfile + compose）

**Files:**
- Create: `platform/control-plane/scheduler/cmd/scheduler/main.go`
- Create: `platform/control-plane/scheduler/Dockerfile`
- Modify: `platform/deploy/compose.local.yml`（追加 scheduler-0 / scheduler-1 服务）

**Interfaces:**
- Consumes: Task 1–6 全部产出
- Produces: 可运行的 `scheduler` 二进制 + compose 双实例拓扑

- [ ] **Step 1: 写 main.go**

创建 `cmd/scheduler/main.go`：

```go
// Command scheduler 是全局任务调度服务（§6.2 / §7.4.1，评审 N1）。
//
// leader 选举基于 PG 单行租约（spec 决策：fencing 与写路径同源），
// 放置写入事务内 fencing 校验；派发走 PG outbox（§13.2 本地替代 RocketMQ）。
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func main() {
	var (
		pgDSN    = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		listen   = flag.String("listen", envOr("LUMO_LISTEN", ":8083"), "HTTP 监听地址")
		instance = flag.String("instance", envOr("LUMO_INSTANCE", "scheduler-0"), "本实例标识（租约 holder，重启后不得与旧进程重复）")
		ttlMs    = flag.Int64("ttl-ms", envOrInt("LUMO_TTL_MS", 10000), "租约 TTL（毫秒）")
		drainMs  = flag.Int64("drain-ms", envOrInt("LUMO_DRAIN_MS", 1000), "drain loop 周期（毫秒）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接存储失败", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.Init(ctx); err != nil {
		log.Error("初始化表结构失败", "err", err)
		os.Exit(1)
	}

	cat := &catalog.Pg{Pool: st.Pool()}
	elec := &election.State{}

	// 选主循环：acquire + 续租（TTL/3）
	electionCtx, cancelElection := context.WithCancel(ctx)
	go election.Run(electionCtx, elec, st, *instance,
		time.Duration(*ttlMs)*time.Millisecond, func(isLeader bool) {
			log.Info("领导权变更", "leader", isLeader, "instance", *instance)
		})

	// drain loop：leader 时把 PENDING 任务接续放置（非 leader 空转，不查库）
	go func() {
		ticker := time.NewTicker(time.Duration(*drainMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !elec.IsLeader() {
					continue
				}
				drainOnce(ctx, st, cat, elec.Current(), log)
			}
		}
	}()

	srv := &http.Server{
		Addr:              *listen,
		Handler:           server.New(st, elec, cat, log).Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("调度服务启动", "listen", *listen, "instance", *instance, "ttl_ms", *ttlMs)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP 服务异常退出", "err", err)
			stop()
		}
	}()

	<-ctx.Done()

	// 优雅停机顺序（spec §2）：
	// ① 停选主循环——先停止续租，否则 Release 之后一轮续租会把租约「复活」；
	// ② 排空 HTTP——在途放置仍有效（租约尚未过期）；
	// ③ 释放租约（expires_at=0）——备节点零等待接管；
	// ④ 关池（defer st.Close）。
	log.Info("收到停机信号，开始优雅排空")
	cancelElection()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("排空失败", "err", err)
	}
	if err := st.Release(context.Background(), *instance); err != nil {
		log.Warn("释放租约失败", "err", err)
	}
	log.Info("调度服务已停止")
}

// drainOnce 一轮接续：取 PENDING → 规划 → 放置。任何一处失败仅记录并等下一轮。
func drainOnce(ctx context.Context, st *store.Store, cat catalog.Catalog, lease *domain.Lease, log *slog.Logger) {
	pending, err := st.PendingTasks(ctx, 32)
	if err != nil {
		log.Error("取排队任务失败", "err", err)
		return
	}
	if len(pending) == 0 {
		return
	}
	nodes, err := cat.List(ctx)
	if err != nil {
		log.Error("列节点失败", "err", err)
		return
	}
	active, err := st.ActiveCounts(ctx)
	if err != nil {
		log.Error("活跃计数失败", "err", err)
		return
	}
	for _, task := range pending {
		n := planner.Pick(task, nodes, active)
		if n == nil {
			break // 剩余任务同样无候选，等下一轮
		}
		if _, err := st.PlaceTask(ctx, lease, task, n.NodeID); err != nil {
			var ncap *domain.NoCapacityError
			if errors.As(err, &ncap) {
				break
			}
			log.Error("drain 放置失败", "task_id", task.TaskID, "err", err)
			continue
		}
		active[n.NodeID]++
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return fallback
}
```

- [ ] **Step 2: 写 Dockerfile**

创建 `Dockerfile`：

```dockerfile
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/scheduler ./cmd/scheduler

FROM alpine:3.20
COPY --from=build /out/scheduler /usr/local/bin/scheduler
EXPOSE 8083
ENTRYPOINT ["scheduler"]
```

- [ ] **Step 3: compose.local.yml 追加双实例**

在 `platform/deploy/compose.local.yml` 的 `connector-gateway` 服务块之后、`volumes:` 之前追加：

```yaml
  scheduler-0:         # 全局任务调度 §6.2/§7.4.1（评审 N1：leader 选举 + fencing）
    build:
      context: ../control-plane/scheduler
    container_name: lumo-platform-scheduler-0
    environment:
      LUMO_PG_DSN: postgres://lumo:lumo@postgres:5432/lumo
      LUMO_LISTEN: ":8083"
      LUMO_INSTANCE: scheduler-0
    ports:
      - "58083:8083"
    depends_on:
      postgres:
        condition: service_healthy

  scheduler-1:         # 热备（1+1）：kill leader 验证接管（§13.2.5 场景）
    build:
      context: ../control-plane/scheduler
    container_name: lumo-platform-scheduler-1
    environment:
      LUMO_PG_DSN: postgres://lumo:lumo@postgres:5432/lumo
      LUMO_LISTEN: ":8083"
      LUMO_INSTANCE: scheduler-1
    ports:
      - "58084:8083"
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 4: 编译与测试**

```sh
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: 全绿。

- [ ] **Step 5: 端到端双实例验证（活库）**

```sh
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness/platform
docker compose -f deploy/compose.local.yml up -d --build
sleep 3
curl -s localhost:58083/v1/leader && echo
curl -s localhost:58084/v1/leader && echo
```

Expected: 恰一个实例返回 `holder: scheduler-0` 或 `scheduler-1`（fencing_token ≥ 1），另一个 `holder: null`。若 scheduler-0 是 leader（多数情况），继续：

```sh
docker kill lumo-platform-scheduler-0
sleep 11                      # TTL 10s + 余量（备节点续租循环每 TTL/3 尝试接管）
curl -s localhost:58084/v1/leader
```

Expected: `holder: scheduler-1`，且 `fencing_token` 比 kill 前的值 +1。若 leader 是 scheduler-1 则对调端口与容器名。验证后：

```sh
docker start lumo-platform-scheduler-0   # 复活后成为热备（holder: null）
```

- [ ] **Step 6: 提交**

```bash
git add platform/control-plane/scheduler/ platform/deploy/compose.local.yml
git commit -m "feat(scheduler): 服务装配与双实例热备（main + Dockerfile + compose）"
```

---

### Task 8: 文档更新（决策记录 + N1 状态 + spec 修正）

**Files:**
- Modify: `docs/architecture.md`（§6.2 增一行指针、§7.4.1 增决策记录块）
- Modify: `docs/superpowers/specs/2026-08-24-scheduler-design.md`（§4 修正：attempt 单飞实现方式）
- 不改 `docs/design-review.md`：本仓库惯例是闭环标记落在 architecture.md（阶段 2 的 A1/A3/R2 均如此），评审文档保持原始评审记录。

- [ ] **Step 1: architecture.md §6.2 追加指针**

在 §6.2 的「容错」条目（`- **容错**：Task 持久 + 日志复制 → worker 死重投 resume；subtask 持久 → 重 claim；节点下线任务漂回 Global Bus。`）之后追加一行：

```markdown
- **Scheduler 自身的 HA（评审 N1）**：leader 选举 + fencing + 降级语义见 §7.4.1 决策记录；落地 `platform/control-plane/scheduler`。
```

- [ ] **Step 2: architecture.md §7.4.1 追加决策记录**

在 §7.4.1 的「执行记录」条目（`- **执行记录**：一个任务只在**一个集群**执行；……跨集群重放置产生新 attempt 而非并行执行。`）之后追加：

```markdown
> **Scheduler 自身的 HA（评审 N1）**：全局 Scheduler 以 1+1 热备运行，**leader 选举底座取 PG 单行租约**（fencing token 与放置写路径同源，放置事务内校验）——偏离 N1 原文括号的「Nacos/Raft」建议，理由是 fencing 必须与被保护的写路径同源：放置写入落 PG，Nacos 侧身份无法用单次原子操作覆盖「旧 leader 失租后其写仍在新 leader 之后提交」的窗口；若为堵窗口再在 PG 存 term，Nacos 层只是多余一跳。租约三不变式：时间一律取库端时钟；续租不换 token、易主才 +1；释放置过期而非删行（token 高水位不回落）。代价：PG 进入选举关键路径，PG 挂则选不出 leader——复制日志已把 PG 放在关键路径上，未引入新单点；**若日志迁离 PG，此决策需重审**。
>
> 降级曲线（N1 第 2 条）：无 leader 时放置请求**快速失败**（503 no-leader，绝不挂起）；对账接口 `POST /v1/reconcile` 预留（占位语义：接收 + 去重 + 落账）。集群本地放置降级随集群 Scheduler 落地。
>
> 落地：`platform/control-plane/scheduler`（评审 N1 第 1 条闭环；第 2 条按「快速失败 + 对账接口」部分闭环，多集群本地放置随 §7.4）。spec：`docs/superpowers/specs/2026-08-24-scheduler-design.md`。
```

- [ ] **Step 3: spec §4 修正 attempt 单飞实现描述**

把 spec 中：

```markdown
**attempt 单飞**（§7.4.1「一个任务只在一个集群执行」的单集群化）：`task_id` 上带 `state IN (PLACED, RUNNING)` 条件的唯一部分索引。同一任务重放置必须旧 attempt 已终结（COMPLETED/FAILED/ABORTED），新 attempt +1——**重放置产生新 attempt 而非并行执行**。
```

替换为：

```markdown
**attempt 单飞**（§7.4.1「一个任务只在一个集群执行」的单集群化）：task_id 是主键（每任务单行），单飞由放置事务内 `FOR UPDATE` 任务行 + 状态检查保证——活跃 attempt（PLACED/RUNNING）时幂等返回既有放置，不产生第二次派发；旧 attempt 已终结（COMPLETED/FAILED/ABORTED）时开启 attempt+1。**重放置产生新 attempt 而非并行执行**。（实现记录：初稿设想的「task_id 部分唯一索引」无意义——task_id 全局唯一，单行即单状态，事务内状态检查已充分。）
```

- [ ] **Step 4: 全量回归 + 第一铁律核验**

```sh
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness/platform/control-plane/scheduler
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1
```

Expected: 全绿。然后：

```sh
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness
git -C deepseek-harness describe --tags --dirty      # 必须 dsh-v0.1.1-rc.2，无 -dirty
git -C deepseek-harness status --porcelain -uno      # 必须无输出
git status                                           # 只应有本任务的文件改动
```

- [ ] **Step 5: 提交**

```bash
git add docs/architecture.md docs/superpowers/specs/2026-08-24-scheduler-design.md
git commit -m "docs(scheduler): 选举底座决策记录与 N1 状态（§7.4.1）"
```

---

## 收尾核验清单（全部任务完成后执行）

```sh
cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness/platform/control-plane/scheduler
gofmt -l . && go vet ./... && go build ./...
LUMO_TEST_PG_DSN='postgres://lumo:lumo@localhost:55432/lumo' go test ./... -count=1

cd /Users/palmer/IdeaProjects/projectSync/AI/project/lumo-harness
git -C deepseek-harness describe --tags --dirty
git -C deepseek-harness status --porcelain -uno
```

预期：集成测试全绿（spec §7 场景 1–8 + 目录往返 + DDL 幂等）；dsh 树 `dsh-v0.1.1-rc.2` 无 `-dirty`、porcelain 为空。至此评审 N1 第 1 条闭环、第 2 条按「快速失败 + 对账接口」部分闭环，与阶段 2 相同的「对活库端到端核验」标准交付。
