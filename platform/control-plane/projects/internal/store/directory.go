package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

// ProjectDirectory keeps counts, membership visibility and page contents in a
// single PostgreSQL statement snapshot. Even an empty/out-of-range page retains
// its real total, without counting projects outside the caller's membership.
func (s *Store) ProjectDirectory(ctx context.Context, realm, userID string, query domain.ProjectDirectoryQuery) (domain.ProjectDirectory, error) {
	q, err := query.Normalize()
	if err != nil {
		return domain.ProjectDirectory{}, fmt.Errorf("%w: %v", ErrInvalidResource, err)
	}
	result := domain.ProjectDirectory{Projects: []domain.ProjectDirectoryItem{}, Limit: q.Limit, Offset: q.Offset}
	var page []byte
	err = s.pool.QueryRow(ctx, `
		WITH visible AS MATERIALIZED (
			SELECT p.*, m.role AS your_role
			FROM projects p
			JOIN project_members m ON m.project_id=p.id AND m.user_id=$2
			WHERE p.realm=$1
		), filtered AS MATERIALIZED (
			SELECT * FROM visible
			WHERE ($3='' OR strpos(lower(name), lower($3))>0 OR strpos(lower(id), lower($3))>0)
			  AND ($4='' OR status=$4) AND ($5='' OR your_role=$5)
		), page AS (
			SELECT p.*, (SELECT count(*) FROM project_members member WHERE member.project_id=p.id) AS member_count
			FROM filtered p
			ORDER BY CASE WHEN $6='name' THEN lower(p.name) END, p.created_at DESC, p.id
			LIMIT $7 OFFSET $8
		)
		SELECT (SELECT count(*) FROM visible),
		       (SELECT count(*) FROM visible WHERE status='active'),
		       (SELECT count(*) FROM visible WHERE status='archived'),
		       (SELECT count(*) FROM filtered),
		       COALESCE((SELECT jsonb_agg(jsonb_build_object(
		          'id', id, 'realm', realm, 'name', name, 'status', status,
		          'createdBy', created_by, 'createdAt', created_at, 'archivedAt', archived_at,
		          'yourRole', your_role, 'memberCount', member_count
		       ) ORDER BY CASE WHEN $6='name' THEN lower(name) END, created_at DESC, id) FROM page), '[]'::jsonb)`,
		realm, userID, q.Query, q.Status, q.Role, q.Sort, q.Limit, q.Offset).
		Scan(&result.Summary.Total, &result.Summary.Active, &result.Summary.Archived, &result.Total, &page)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(page, &result.Projects); err != nil {
		return result, fmt.Errorf("decode project directory: %w", err)
	}
	result.HasMore = int64(q.Offset+len(result.Projects)) < result.Total
	return result, nil
}
