package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

type delegationCursor struct {
	Version int       `json:"v"`
	Scope   string    `json:"scope"`
	Created time.Time `json:"created"`
	ID      string    `json:"id"`
}

// ListDelegationTasksPage uses immutable keys. Updates cannot move a row across
// the cursor; new rows appear on refresh. This is a live list, not a DB snapshot.
// Cursor fields never grant authority: every query reapplies the visibility SQL.
func (s *Store) ListDelegationTasksPage(ctx context.Context, realm, userID string, all, departmentScope bool, cursor string, limit int) ([]domain.DelegatedTask, string, error) {
	if limit < 1 || limit > 200 {
		return nil, "", fmt.Errorf("%w: invalid page limit", ErrBadRequest)
	}
	scopeJSON, _ := json.Marshal([]any{realm, userID, all, departmentScope})
	hash := sha256.Sum256(scopeJSON)
	scope := hex.EncodeToString(hash[:])
	query, args := delegationVisibilityQuery(realm, userID, all, departmentScope)
	if cursor != "" {
		if len(cursor) > 4096 {
			return nil, "", fmt.Errorf("%w: invalid page cursor", ErrBadRequest)
		}
		var value delegationCursor
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(raw, &value) != nil || value.Version != 1 || value.Scope != scope || value.Created.IsZero() || value.ID == "" || len(value.ID) > 200 {
			return nil, "", fmt.Errorf("%w: invalid page cursor", ErrBadRequest)
		}
		args = append(args, value.Created, value.ID)
		query += fmt.Sprintf(" AND (t.created_at,t.id) < ($%d,$%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY t.created_at DESC,t.id DESC LIMIT $%d", len(args))
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	tasks := []domain.DelegatedTask{}
	for rows.Next() {
		var task domain.DelegatedTask
		if err := scanDelegatedTask(rows, &task); err != nil {
			return nil, "", err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(tasks) > limit {
		tasks = tasks[:limit]
		last := tasks[len(tasks)-1]
		raw, _ := json.Marshal(delegationCursor{Version: 1, Scope: scope, Created: last.CreatedAt, ID: last.ID})
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	return tasks, next, nil
}
