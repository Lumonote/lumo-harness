package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// SpaceProject resolves the Projects-owned binding. A caller cannot pair an
// accessible project with a Space from another project to bypass membership.
// An absent Projects schema or unknown Space is an unknown authorization fact.
func (s *Store) SpaceProject(ctx context.Context, realm, spaceID string) (string, bool, error) {
	var projectID string
	err := s.pool.QueryRow(ctx, `SELECT p.id FROM project_spaces ps
	 JOIN projects p ON p.id=ps.project_id AND p.realm=ps.realm
	 WHERE ps.realm=$1 AND ps.space_id=$2`, realm, spaceID).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) || isUndefinedTable(err) {
		return "", false, nil
	}
	return projectID, err == nil, err
}
