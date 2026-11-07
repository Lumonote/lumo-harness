package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/projects/internal/domain"
)

type mutationActorKey struct{}
type mutationActor struct{ projectID, realm, userID, action string }

// WithProjectMutationActor carries the authenticated HTTP actor to the write
// transaction. Trusted service/import callers keep their existing signatures;
// HTTP preflight permissions never substitute for this transaction-time check.
func WithProjectMutationActor(ctx context.Context, projectID, realm, userID, action string) context.Context {
	return context.WithValue(ctx, mutationActorKey{}, mutationActor{projectID, realm, userID, action})
}

func authorizeMutation(ctx context.Context, tx pgx.Tx, project domain.Project) error {
	actor, ok := ctx.Value(mutationActorKey{}).(mutationActor)
	if !ok {
		return nil // trusted internal call, not an HTTP authorization decision
	}
	if actor.projectID != project.ID || actor.realm != project.Realm || actor.userID == "" {
		return ErrWriteForbidden
	}
	// This statement starts only after the parent lock is held, so membership
	// changes that committed while we waited are visible in READ COMMITTED.
	var role string
	err := tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, actor.userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrWriteForbidden
	}
	if err != nil {
		return err
	}
	allowed, err := domain.CanProject(role, actor.action)
	if err != nil || !allowed {
		return ErrWriteForbidden
	}
	return nil
}

// A common parent row lock keeps lifecycle changes and resource writes ordered.
// It also serializes owner removals: counting owners alone does not protect the
// invariant when two different membership rows are modified concurrently.
func lockProject(ctx context.Context, tx pgx.Tx, projectID string, active bool) (domain.Project, error) {
	var p domain.Project
	err := tx.QueryRow(ctx, `SELECT id, realm, name, status, created_by, created_at, archived_at FROM projects WHERE id=$1 FOR UPDATE`, projectID).
		Scan(&p.ID, &p.Realm, &p.Name, &p.Status, &p.CreatedBy, &p.CreatedAt, &p.ArchivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	if err := authorizeMutation(ctx, tx, p); err != nil {
		return p, err
	}
	if active && p.Status != domain.StatusActive {
		return p, ErrArchived
	}
	return p, nil
}

func (s *Store) beginActiveProject(ctx context.Context, projectID string) (pgx.Tx, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := lockProject(ctx, tx, projectID, true); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// RenameProject uses the name the caller read as a precondition, so another
// editor's rename is never silently overwritten.
func (s *Store) RenameProject(ctx context.Context, projectID, name, expectedName string) (domain.Project, error) {
	tx, err := s.beginActiveProject(ctx, projectID)
	if err != nil {
		return domain.Project{}, err
	}
	defer tx.Rollback(ctx)
	p, err := lockProject(ctx, tx, projectID, true)
	if err != nil {
		return domain.Project{}, err
	}
	if p.Name != expectedName {
		return domain.Project{}, ErrNameStale
	}
	if _, err := tx.Exec(ctx, `UPDATE projects SET name=$2 WHERE id=$1`, projectID, name); err != nil {
		if isUniqueViolation(err) {
			return domain.Project{}, ErrNameTaken
		}
		return domain.Project{}, err
	}
	p.Name = name
	return p, tx.Commit(ctx)
}
