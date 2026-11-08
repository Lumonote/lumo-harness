package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

type WorkforceProgressPage struct {
	Items        []domain.WorkforceProgressItem             `json:"items"`
	Summary      domain.WorkforceProgressSummary            `json:"summary"`
	SummaryScope string                                     `json:"summary_scope"`
	ByWorkerKind map[string]domain.WorkforceProgressSummary `json:"by_worker_kind"`
	NextCursor   string                                     `json:"next_cursor"`
}

// All rows and their latest run/checkpoint are read from one repeatable-read
// snapshot. Supervisory scope never replaces task ACLs. The server's normal
// project/OPA decision may further narrow this set, before summary or pagination.
func (s *Store) WorkforceProgressSnapshot(ctx context.Context, realm, userID string, all, department, admin bool) ([]domain.WorkforceProgressItem, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT CURRENT_TIMESTAMP`).Scan(&now); err != nil {
		return nil, err
	}
	// The department candidate query is mine OR department. Intersecting that
	// with task ACLs for a non-admin is exactly the mine visibility query.
	if !admin {
		all, department = false, false
	}
	query, args := delegationVisibilityQuery(realm, userID, all, department)
	rows, err := tx.Query(ctx, query+` ORDER BY t.created_at DESC,t.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	tasks := []domain.DelegatedTask{}
	for rows.Next() {
		var task domain.DelegatedTask
		if err := scanDelegatedTask(rows, &task); err != nil {
			rows.Close()
			return nil, err
		}
		tasks = append(tasks, task)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	items, err := taskProgressItems(ctx, tx, realm, tasks, now)
	if err != nil {
		return nil, err
	}
	return items, tx.Commit(ctx)
}

// Cursor identity includes normalized predicates. The cursor never conveys
// authority: every request rebuilds current authorized rows and scope totals.
func WorkforceProgressCursor(realm, userID, scope string, filter domain.WorkforceProgressFilter, cursor string) (func(domain.DelegatedTask) bool, func(domain.DelegatedTask) string, error) {
	filter.Normalize()
	if err := filter.Validate(); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	raw, _ := json.Marshal([]any{realm, userID, scope, filter})
	hash := sha256.Sum256(raw)
	identity := hex.EncodeToString(hash[:])
	var boundary delegationCursor
	if cursor != "" {
		if len(cursor) > 4096 {
			return nil, nil, fmt.Errorf("%w: invalid workforce cursor", ErrBadRequest)
		}
		decoded, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(decoded, &boundary) != nil || boundary.Version != 2 || boundary.Scope != identity || boundary.Created.IsZero() || boundary.ID == "" || len(boundary.ID) > 200 {
			return nil, nil, fmt.Errorf("%w: invalid workforce cursor or changed filters", ErrBadRequest)
		}
	}
	after := func(task domain.DelegatedTask) bool {
		return cursor == "" || task.CreatedAt.Before(boundary.Created) || task.CreatedAt.Equal(boundary.Created) && task.ID < boundary.ID
	}
	encode := func(task domain.DelegatedTask) string {
		data, _ := json.Marshal(delegationCursor{Version: 2, Scope: identity, Created: task.CreatedAt, ID: task.ID})
		return base64.RawURLEncoding.EncodeToString(data)
	}
	return after, encode, nil
}

// BuildWorkforceProgressPage receives only authorized snapshot rows. Filtering,
// complete-scope counts and groups precede the cursor/limit, including on the
// last or empty continuation page. No percentage implies task completion.
func BuildWorkforceProgressPage(items []domain.WorkforceProgressItem, filter domain.WorkforceProgressFilter, limit int, after func(domain.DelegatedTask) bool, encode func(domain.DelegatedTask) string) WorkforceProgressPage {
	filtered := make([]domain.WorkforceProgressItem, 0, len(items))
	groups := map[string][]domain.WorkforceProgressItem{"employee": {}, "agent": {}, "unassigned": {}}
	for _, item := range items {
		if !filter.Matches(item) {
			continue
		}
		filtered = append(filtered, item)
		kind := domain.WorkforceWorkerKind(item.Task)
		groups[kind] = append(groups[kind], item)
	}
	page := WorkforceProgressPage{Items: []domain.WorkforceProgressItem{}, Summary: domain.SummarizeWorkforce(filtered), SummaryScope: "filtered_scope", ByWorkerKind: map[string]domain.WorkforceProgressSummary{}}
	for kind, rows := range groups {
		page.ByWorkerKind[kind] = domain.SummarizeWorkforce(rows)
	}
	for _, item := range filtered {
		if !after(item.Task) {
			continue
		}
		if len(page.Items) == limit {
			page.NextCursor = encode(page.Items[len(page.Items)-1].Task)
			break
		}
		page.Items = append(page.Items, item)
	}
	return page
}
