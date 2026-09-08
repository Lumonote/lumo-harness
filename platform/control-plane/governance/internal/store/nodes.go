package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

func (s *Store) SetDesktopNodeState(ctx context.Context, realm, nodeID string, state domain.DesktopNodeStatus, actor string) error {
	if state != domain.NodeDraining && state != domain.NodeRevoked && state != domain.NodePendingActivation {
		return fmt.Errorf("%w: node state must be DRAINING, REVOKED or PENDING_ACTIVATION", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current domain.DesktopNodeStatus
	var owner string
	err = tx.QueryRow(ctx, `SELECT status,owner_user_id FROM governance_desktop_nodes WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, nodeID).Scan(&current, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if current == domain.NodeRevoked && state != domain.NodeRevoked {
		return fmt.Errorf("%w: revoked nodes require a new device identity", ErrForbidden)
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_desktop_nodes SET status=$3,scheduling_eligible=false WHERE realm=$1 AND id=$2`, realm, nodeID, state); err != nil {
		return err
	}
	if state != domain.NodeDraining {
		if _, err = tx.Exec(ctx, `UPDATE governance_device_connections SET enrollment_hash='',enrollment_expires=NULL,public_key_hash='',certificate_serial='',certificate_expires=NULL,certificate_pem='',previous_certificate_serial='',renewal_replay_expires=NULL,
		 connection_id='',connection_expires=NULL,applied_revision=0 WHERE realm=$1 AND node_id=$2`, realm, nodeID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_device_connections SET connection_id='',connection_expires=NULL,applied_revision=0 WHERE realm=$1 AND node_id=$2`, realm, nodeID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_device_commands SET state='interrupted',updated_at=now() WHERE realm=$1 AND node_id=$2 AND state IN ('queued','delivered')`, realm, nodeID); err != nil {
		return err
	}
	if err = recordUserAdminEvent(ctx, tx, realm, owner, "node_updated", actor, map[string]any{"node_id": nodeID, "status": state}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
