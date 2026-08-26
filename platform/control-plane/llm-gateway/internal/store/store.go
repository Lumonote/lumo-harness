// Package store LLM 网关存储层：provider 注册表 + 预算执法镜像。
//
// budget_trees / usage_event_outbox 的 DDL 真相源在 TS pg-meter.ts——本服务不建表
// 不迁表（缺表 = metering 未初始化，启动/首请求时报）。网关是这两个表的第二个
// 写入方（第一个是 TS metering 插件）：同一 outbox、同一批树，行级原子性由 PG
// 事务保证，语义一致性由集成测试同断言锁定（设计说明 §7 首风险）。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
)

// DDL 只含网关自有表（llm_providers）。
const DDL = `
CREATE TABLE IF NOT EXISTS llm_providers (
  model              TEXT PRIMARY KEY,
  upstream_base_url  TEXT NOT NULL,
  api_key            TEXT NOT NULL DEFAULT '',
  price_in_per_mtok  NUMERIC(20,6) NOT NULL DEFAULT 0,
  price_out_per_mtok NUMERIC(20,6) NOT NULL DEFAULT 0,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

var ErrUnknownModel = errors.New("未知或已停用的模型")

// Provider 一个对外模型的路由与费率。
type Provider struct {
	Model          string  `json:"model"`
	UpstreamBaseURL string `json:"upstreamBaseUrl"`
	APIKey         string  `json:"-"`
	PriceInPerMtok float64 `json:"priceInPerMtok"`
	PriceOutPerMtok float64 `json:"priceOutPerMtok"`
}

// ReserveResult 前置检查结论（镜像 TS MeterResult 的裁决面）。
type ReserveResult struct {
	Approved bool
	Reason   string // ok | denied-user-budget | denied-project-budget
	State    string // 双树取更严者
}

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("建 llm_providers 失败: %w", err)
	}
	return nil
}

// Provider 路由查表。
func (s *Store) Provider(ctx context.Context, model string) (*Provider, error) {
	var p Provider
	var key string
	err := s.pool.QueryRow(ctx, `
		SELECT model, upstream_base_url, api_key, price_in_per_mtok, price_out_per_mtok
		FROM llm_providers WHERE model = $1 AND enabled`, model).
		Scan(&p.Model, &p.UpstreamBaseURL, &key, &p.PriceInPerMtok, &p.PriceOutPerMtok)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnknownModel
	}
	if err != nil {
		return nil, err
	}
	p.APIKey = key
	return &p, nil
}

func treeRow(ctx context.Context, tx pgx.Tx, kind, id string) (*domain.TreeRow, error) {
	var r domain.TreeRow
	err := tx.QueryRow(ctx, `
		SELECT budget, budget_total, soft_limit, overdraft FROM budget_trees
		WHERE kind = $1 AND id = $2 FOR UPDATE`, kind, id).
		Scan(&r.Budget, &r.BudgetTotal, &r.SoftLimit, &r.Overdraft)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// Reserve 前置拦截（镜像 TS reserve）：双树 FOR UPDATE 四态，worst=hard 即拒；
// reason 区分是哪棵树先硬（proj hard 且 user 非 hard → project，否则 user——
// TS 的判序原样照搬：调用方依赖 reason 语义）。
func (s *Store) Reserve(ctx context.Context, a domain.Attribution, estimate int64) (ReserveResult, error) {
	need := estimate
	if need <= 0 {
		need = 1
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReserveResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	userRow, err := treeRow(ctx, tx, "user", a.UserID)
	if err != nil {
		return ReserveResult{}, err
	}
	projRow, err := treeRow(ctx, tx, "project", a.ProjectID)
	if err != nil {
		return ReserveResult{}, err
	}
	userState := domain.StateOfTree(userRow, need)
	projState := domain.StateOfTree(projRow, need)
	worst := domain.WorseOf(userState, projState)
	if projState == domain.StateHard && userState != domain.StateHard {
		return ReserveResult{Approved: false, Reason: "denied-project-budget", State: worst}, nil
	}
	if userState == domain.StateHard {
		return ReserveResult{Approved: false, Reason: "denied-user-budget", State: worst}, nil
	}
	return ReserveResult{Approved: true, Reason: "ok", State: worst}, nil
}

// Commit 落账（镜像 TS commit）：单事务——双树**无条件扣减，允许负数**（封顶可判的
// 既定决策：余额永远非负时「已透支多少」这个量根本不存在）+ outbox INSERT。
// event_key 由 PG 生成（两侧写入方不各自造键格式）。ts 用 outbox 列缺省 now()
// （事件时刻 = 网关观测到流结束的时刻，即事件发生时刻）。
func (s *Store) Commit(ctx context.Context, e domain.CostEvent) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deduct := func(kind, id string) error {
		_, err := tx.Exec(ctx,
			`UPDATE budget_trees SET budget = budget - $2 WHERE kind = $1 AND id = $3`,
			kind, e.Qty, id)
		return err
	}
	if err := deduct("user", e.Context.UserID); err != nil {
		return err
	}
	if err := deduct("project", e.Context.ProjectID); err != nil {
		return err
	}
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO usage_event_outbox (event_key, payload) VALUES (gen_random_uuid(), $1)`,
		payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
