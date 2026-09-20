package store

// 决策记忆的读写（§24.4 项目决策记忆；表结构见 store.go 的 DDL，那里逐字照抄设计
// 说明 §11）。本包是 `project_decisions` 的唯一建表方与唯一写入方——TS 侧
// `@lumo/project` 只读不写，原因不是权限，而是**取代动作必须是一个事务**：
// 「插新行 + 只回填旧行的 superseded_by」要么整体发生要么不发生；两个实现各写一遍，
// 迟早有一边漏掉 `AND superseded_by IS NULL` 这个条件，于是同一行被两条新决策同时
// 取代，反向指针指向后写的那条，前一条的取代关系静默丢失。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

// 决策记忆的领域错误（server 层映射 HTTP 状态）。
var (
	// ErrDecisionNotFound 不存在，或不在本 realm/项目内——两者不区分，避免用
	// 一个 supersede 失败来探测别的 realm 有哪些决策 id。
	ErrDecisionNotFound = errors.New("决策条目不存在（或不属于本 realm/项目）")
	// ErrDecisionSuperseded 目标条目已被取代。**不允二次取代**：如果允许把
	// superseded_by 从 A 改写成 B，那么「这条决定是被谁取代的」就成了可变字段，
	// append-only 退化成 final-write-wins——正是本设计要避免的形状。
	ErrDecisionSuperseded = errors.New("该决策条目已被取代（append-only：不原地改，也不重复取代）")
	// ErrDecisionConflict 并发取代：预读时还 live，写回时已被另一个写者取代。
	// CAS 失败必须报错而不是重试——重试等于替人决定哪条取代生效。
	ErrDecisionConflict = errors.New("并发取代：该条目刚被另一条决策取代")
)

const decisionColumns = `id, realm, project_id, kind, summary, body,
	COALESCE(supersedes, ''), COALESCE(superseded_by, ''), evidence, created_at`

// DecisionConsolidationScanCap 固化任务的扫描上限（live 行，新在前）。
//
// 有界是因为固化任务同样跑在人的注意力与机器预算里：索引层默认只常驻 50 行，
// 1000 行的扫描面已经是它的 20 倍，够覆盖「近期腐化」这个目标。触顶时报告
// Truncated=true，不假装干净。
const DecisionConsolidationScanCap = 1000

// AppendDecision 追加一条决策；带 supersedes 时**同一事务**内回填旧条目的
// superseded_by。
//
// 事务里的三步各自防一种事故：
//  1. INSERT 新行——只增不改（旧行的 summary/body/kind 一个字节都不动）。
//  2. `SELECT ... FOR UPDATE` 预读旧行——区分「不存在」与「已被取代」，并锁住它，
//     让并发写者排队而不是各自以为成功。
//  3. `UPDATE ... SET superseded_by = $new ... AND superseded_by IS NULL`——只写这一列。
//     0 行受影响 = 预读之后被抢走，报 ErrDecisionConflict。
func (s *Store) AppendDecision(ctx context.Context, d domain.Decision) (domain.Decision, error) {
	if err := domain.ValidateDecisionAppend(d); err != nil {
		return domain.Decision{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Decision{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var evidence any
	if len(d.Evidence) > 0 {
		encoded, err := json.Marshal(d.Evidence)
		if err != nil {
			return domain.Decision{}, fmt.Errorf("序列化 evidence 失败: %w", err)
		}
		evidence = encoded
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO project_decisions (id, realm, project_id, kind, summary, body, supersedes, evidence)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING created_at`,
		d.ID, d.Realm, d.ProjectID, d.Kind, d.Summary, d.Body, nullableText(d.Supersedes), evidence).
		Scan(&d.CreatedAt)
	if err != nil {
		return domain.Decision{}, fmt.Errorf("插入决策失败: %w", err)
	}

	if d.Supersedes != "" {
		var existing *string
		err := tx.QueryRow(ctx, `
			SELECT superseded_by FROM project_decisions
			WHERE id = $1 AND realm = $2 AND project_id = $3
			FOR UPDATE`, d.Supersedes, d.Realm, d.ProjectID).Scan(&existing)
		if errors.Is(err, pgx.ErrNoRows) {
			// 跨项目 / 跨 realm 的取代走同一条分支：作用域不符即不存在。
			return domain.Decision{}, ErrDecisionNotFound
		}
		if err != nil {
			return domain.Decision{}, err
		}
		if existing != nil {
			return domain.Decision{}, ErrDecisionSuperseded
		}
		tag, err := tx.Exec(ctx, `
			UPDATE project_decisions SET superseded_by = $1
			WHERE id = $2 AND realm = $3 AND project_id = $4 AND superseded_by IS NULL`,
			d.ID, d.Supersedes, d.Realm, d.ProjectID)
		if err != nil {
			return domain.Decision{}, fmt.Errorf("回填 superseded_by 失败: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return domain.Decision{}, ErrDecisionConflict
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Decision{}, err
	}
	return d, nil
}

// ListDecisionIndex 索引层读面：**只有 live 行、只有 summary**，行数有界。
//
// realm 是第一个 WHERE 条件而不是后置过滤：跨 realm 查询的正确答案是**空集**，
// 不是错误——上层把「查不到别的 realm 的决策」当成异常，会逼出「先探测再查询」的
// 写法，而那正是跨租户读取的形状。空集让越界查询与「这个 realm 确实没有决策」
// 在调用方看来完全一样，无从利用。
//
// kind 为空表示不过滤（全部 kind）。两种写法分别拼 SQL 而不是 `($3 = ” OR kind = $3)`：
// 后者会让 PG 用不上 project_decisions_live 这个部分索引的第三列。
func (s *Store) ListDecisionIndex(ctx context.Context, realm, projectID, kind string, limit int) ([]domain.DecisionIndexRow, error) {
	bound := domain.ResolveDecisionIndexLimit(limit)
	sql := `SELECT id, kind, summary, COALESCE(supersedes, ''), created_at
		FROM project_decisions
		WHERE realm = $1 AND project_id = $2 AND superseded_by IS NULL`
	args := []any{realm, projectID}
	if kind != "" {
		if err := domain.ValidDecisionKind(kind); err != nil {
			return nil, err
		}
		sql += ` AND kind = $3 ORDER BY created_at DESC, id DESC LIMIT $4`
		args = append(args, kind, bound)
	} else {
		sql += ` ORDER BY created_at DESC, id DESC LIMIT $3`
		args = append(args, bound)
	}
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DecisionIndexRow{}
	for rows.Next() {
		var row domain.DecisionIndexRow
		if err := rows.Scan(&row.ID, &row.Kind, &row.Summary, &row.Supersedes, &row.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// GetDecision 正文层读面：按需读全文。
//
// 被取代的行**照样可读**——索引层过滤它们是为了上下文预算，不是为了隐藏。
// 「当初为什么这么定、后来被什么取代」正是决策记忆要留下的考古层，读到这里才完整。
func (s *Store) GetDecision(ctx context.Context, realm, projectID, id string) (domain.Decision, error) {
	return scanDecision(s.pool.QueryRow(ctx,
		`SELECT `+decisionColumns+` FROM project_decisions WHERE realm = $1 AND project_id = $2 AND id = $3`,
		realm, projectID, id))
}

func scanDecision(row pgx.Row) (domain.Decision, error) {
	var d domain.Decision
	var evidence []byte
	err := row.Scan(&d.ID, &d.Realm, &d.ProjectID, &d.Kind, &d.Summary, &d.Body,
		&d.Supersedes, &d.SupersededBy, &evidence, &d.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Decision{}, ErrDecisionNotFound
	}
	if err != nil {
		return domain.Decision{}, err
	}
	if len(evidence) > 0 {
		if err := json.Unmarshal(evidence, &d.Evidence); err != nil {
			return domain.Decision{}, fmt.Errorf("解析 evidence 失败: %w", err)
		}
	}
	return d, nil
}

// ConsolidateDecisions 固化任务（§24.4 第 5 条）的**接口**：读 live 行的索引投影，
// 交给 domain.Consolidate 出报告。
//
// **不做的事**（刻意留白，写在这里以免被后来者当成遗漏）：
//   - 不写任何东西。报告不是裁决；取代只能由 AppendDecision 显式写下。
//   - 不注册定时触发。触发在 TriggerBus 那一侧（flows 的 `decisions.consolidate` 算子，
//     由 cron 自动化驱动），本函数是**被调用的接口**而不是订阅者：定时机制不在本服务
//     里再造一套，否则同一件事会有两个调度者，而谁在什么时候跑过就说不清了。
func (s *Store) ConsolidateDecisions(ctx context.Context, realm, projectID string, indexCap int) (domain.ConsolidationReport, error) {
	// 多取一行：拿到「还有更多」这个事实，report.Truncated 才能如实置位。
	rows, err := s.pool.Query(ctx, `
		SELECT id, kind, summary, created_at FROM project_decisions
		WHERE realm = $1 AND project_id = $2 AND superseded_by IS NULL
		ORDER BY created_at DESC, id DESC LIMIT $3`, realm, projectID, DecisionConsolidationScanCap+1)
	if err != nil {
		return domain.ConsolidationReport{}, err
	}
	defer rows.Close()
	signals := []domain.DecisionSignal{}
	for rows.Next() {
		var sig domain.DecisionSignal
		if err := rows.Scan(&sig.ID, &sig.Kind, &sig.Summary, &sig.CreatedAt); err != nil {
			return domain.ConsolidationReport{}, err
		}
		signals = append(signals, sig)
	}
	if err := rows.Err(); err != nil {
		return domain.ConsolidationReport{}, err
	}
	truncated := false
	if len(signals) > DecisionConsolidationScanCap {
		signals = signals[:DecisionConsolidationScanCap]
		truncated = true
	}
	report := domain.Consolidate(signals, indexCap)
	report.Truncated = report.Truncated || truncated
	return report, nil
}
