package store

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

// Governance owns task affiliation. A project query parameter is only a
// permission scope, never evidence that a task actually belongs to it.
// Hold a shared lock until the report operation finishes, so a reassignment
// cannot race between the check and the read/write.
func requireTaskProject(ctx context.Context, tx pgx.Tx, realm, projectID, taskID string) error {
	var actual string
	err := tx.QueryRow(ctx, `SELECT project_id FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR SHARE`, realm, taskID).Scan(&actual)
	if errors.Is(err, pgx.ErrNoRows) || isUndefinedTable(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if actual == "" || actual != projectID {
		return ErrNotFound
	}
	return nil
}
