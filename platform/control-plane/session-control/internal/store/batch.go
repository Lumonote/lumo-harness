package store

import (
	"context"
	"fmt"
	"strings"
)

const MaxControlBatch = 100

// Controls returns registered rows for a bounded set of authorized references.
// Missing and other-realm references are indistinguishable; reads never register sessions.
func (s *Store) Controls(ctx context.Context, realm string, refs []string) ([]Row, error) {
	if strings.TrimSpace(realm) == "" || len(refs) == 0 || len(refs) > MaxControlBatch {
		return nil, fmt.Errorf("realm 和 1..100 个会话标识必填")
	}
	rows, err := s.pool.Query(ctx, `SELECT session_ref, realm, state, revision, last_command, last_actor,
       last_reason, correlation_id, updated_at
       FROM session_control_state WHERE realm=$1 AND session_ref=ANY($2::text[]) ORDER BY session_ref`, realm, refs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Row, 0)
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
