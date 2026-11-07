package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/projects/internal/domain"
)

// Space names are display labels; the stable ID used by knowledge sources stays
// intact. Removal detaches this project registry entry without rewriting sources.
func (s *Store) RenameSpace(ctx context.Context, projectID, spaceID, name, expectedName string) (domain.Space, error) {
	tx, err := s.beginActiveProject(ctx, projectID)
	if err != nil {
		return domain.Space{}, err
	}
	defer tx.Rollback(ctx)
	var space domain.Space
	err = tx.QueryRow(ctx, `SELECT space_id,project_id,realm,name FROM project_spaces WHERE project_id=$1 AND space_id=$2 FOR UPDATE`, projectID, spaceID).Scan(&space.ID, &space.ProjectID, &space.Realm, &space.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return space, ErrNotFound
	}
	if err != nil {
		return space, err
	}
	if space.Name != expectedName {
		return space, ErrResourceStale
	}
	if _, err := tx.Exec(ctx, `UPDATE project_spaces SET name=$3 WHERE project_id=$1 AND space_id=$2`, projectID, spaceID, name); err != nil {
		if isUniqueViolation(err) {
			return space, ErrResourceConflict
		}
		return space, err
	}
	space.Name = name
	return space, tx.Commit(ctx)
}

func (s *Store) DeleteSpace(ctx context.Context, projectID, spaceID, expectedName string) error {
	tx, err := s.beginActiveProject(ctx, projectID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var name string
	err = tx.QueryRow(ctx, `SELECT name FROM project_spaces WHERE project_id=$1 AND space_id=$2 FOR UPDATE`, projectID, spaceID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if name != expectedName {
		return ErrResourceStale
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_spaces WHERE project_id=$1 AND space_id=$2`, projectID, spaceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const automationColumns = `automation_id,project_id,trigger_kind,trigger_spec,flow_ref,enabled,revision`

func scanAutomation(row pgx.Row) (domain.Automation, error) {
	var a domain.Automation
	err := row.Scan(&a.ID, &a.ProjectID, &a.TriggerKind, &a.TriggerSpec, &a.FlowRef, &a.Enabled, &a.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

func (s *Store) CreateAutomation(ctx context.Context, a domain.Automation) (domain.Automation, error) {
	tx, err := s.beginActiveProject(ctx, a.ProjectID)
	if err != nil {
		return domain.Automation{}, err
	}
	defer tx.Rollback(ctx)
	saved, err := scanAutomation(tx.QueryRow(ctx, `INSERT INTO project_automations(automation_id,project_id,trigger_kind,trigger_spec,flow_ref,enabled) VALUES($1,$2,$3,$4,$5,$6) RETURNING `+automationColumns, a.ID, a.ProjectID, a.TriggerKind, a.TriggerSpec, a.FlowRef, a.Enabled))
	if isUniqueViolation(err) {
		return saved, ErrResourceConflict
	}
	if err != nil {
		return saved, err
	}
	return saved, tx.Commit(ctx)
}

func (s *Store) UpdateAutomation(ctx context.Context, a domain.Automation, expected int64) (domain.Automation, error) {
	tx, err := s.beginActiveProject(ctx, a.ProjectID)
	if err != nil {
		return domain.Automation{}, err
	}
	defer tx.Rollback(ctx)
	current, err := scanAutomation(tx.QueryRow(ctx, `SELECT `+automationColumns+` FROM project_automations WHERE project_id=$1 AND automation_id=$2 FOR UPDATE`, a.ProjectID, a.ID))
	if err != nil {
		return domain.Automation{}, err
	}
	if current.Revision != expected {
		return domain.Automation{}, ErrResourceStale
	}
	saved, err := scanAutomation(tx.QueryRow(ctx, `UPDATE project_automations SET trigger_kind=$3,trigger_spec=$4,flow_ref=$5,enabled=$6,revision=revision+1 WHERE project_id=$1 AND automation_id=$2 RETURNING `+automationColumns, a.ProjectID, a.ID, a.TriggerKind, a.TriggerSpec, a.FlowRef, a.Enabled))
	if err != nil {
		return saved, err
	}
	return saved, tx.Commit(ctx)
}

// Legacy callers retain idempotent deletion. New editors send the version they
// read and receive a conflict if another editor has changed the rule meanwhile.
func (s *Store) DeleteAutomationVersion(ctx context.Context, projectID, automationID string, expected *int64) error {
	tx, err := s.beginActiveProject(ctx, projectID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if expected != nil {
		var revision int64
		err = tx.QueryRow(ctx, `SELECT revision FROM project_automations WHERE project_id=$1 AND automation_id=$2 FOR UPDATE`, projectID, automationID).Scan(&revision)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if revision != *expected {
			return ErrResourceStale
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_automations WHERE project_id=$1 AND automation_id=$2`, projectID, automationID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) SaveArtifact(ctx context.Context, a domain.Artifact, expected *string) error {
	if a.Kind != "component" && a.Kind != "skill" && a.Kind != "agent" && a.Kind != "connector" && a.Kind != "flow" {
		return ErrInvalidResource
	}
	tx, err := s.beginActiveProject(ctx, a.ProjectID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if expected != nil {
		var current string
		err = tx.QueryRow(ctx, `SELECT version FROM project_artifacts WHERE project_id=$1 AND kind=$2 AND name=$3 FOR UPDATE`, a.ProjectID, a.Kind, a.Name).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			if *expected != "" {
				return ErrResourceStale
			}
		} else if err != nil {
			return err
		} else if current != *expected {
			return ErrResourceStale
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO project_artifacts(project_id,kind,name,version)VALUES($1,$2,$3,$4) ON CONFLICT(project_id,kind,name)DO UPDATE SET version=EXCLUDED.version`, a.ProjectID, a.Kind, a.Name, a.Version); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) DeleteArtifact(ctx context.Context, projectID, kind, name, expected string) error {
	tx, err := s.beginActiveProject(ctx, projectID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var version string
	err = tx.QueryRow(ctx, `SELECT version FROM project_artifacts WHERE project_id=$1 AND kind=$2 AND name=$3 FOR UPDATE`, projectID, kind, name).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if version != expected {
		return ErrResourceStale
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_artifacts WHERE project_id=$1 AND kind=$2 AND name=$3`, projectID, kind, name); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
