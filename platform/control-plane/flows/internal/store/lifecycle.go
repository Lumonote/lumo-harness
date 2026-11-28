package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/flows/internal/domain"
)

// MutationActor is supplied only by the authenticated HTTP boundary. Trusted
// internal callers can omit it. Project-authorized HTTP mutations provide it;
// initial review retains the separately enforced global reviewer contract.
type MutationActor struct {
	Realm    string
	UserID   string
	Admin    bool
	Reviewer bool
}

// CanMutateFlow is shared by management capabilities and legacy mutation routes.
func CanMutateFlow(f *domain.Flow, action, role string, active bool, actor MutationActor) bool {
	if !active || role == "" || actor.Realm != f.Realm || actor.UserID == "" {
		return false
	}
	author := f.Author == actor.UserID && (role == domain.RoleOwner || role == domain.RoleEditor)
	switch action {
	case "edit", domain.EventSubmit:
		return author
	case domain.EventDeprecate:
		return role == domain.RoleOwner || actor.Admin || (f.Status == domain.StatusDraft && author)
	case "review":
		return actor.Reviewer && f.Author != actor.UserID
	case domain.EventTarget, "rollback":
		return role == domain.RoleOwner
	}
	return false
}

// Lock the flow before computing its next state, and keep current project
// authority stable until commit. A concurrent revoke either wins first or waits.
func lockMutationFlow(ctx context.Context, tx pgx.Tx, id, action string, actors []MutationActor) (*domain.Flow, error) {
	f, err := scanFlow(tx.QueryRow(ctx, "SELECT "+flowCols+" FROM flows WHERE id=$1 FOR UPDATE", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(actors) > 0 {
		a := actors[0]
		var role string
		var active bool
		err := tx.QueryRow(ctx, `SELECT m.role,p.status='active' FROM projects p
            JOIN project_members m ON m.project_id=p.id
            WHERE p.id=$1 AND p.realm=$2 AND m.user_id=$3 FOR SHARE OF p,m`, f.ProjectID, a.Realm, a.UserID).Scan(&role, &active)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrManagementForbidden
		}
		if err != nil {
			return nil, err
		}
		if !CanMutateFlow(f, action, role, active, a) {
			return nil, ErrManagementForbidden
		}
	}
	return f, nil
}
