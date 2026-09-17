package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/observability"
)

const RunTimeout = 4 * time.Minute
const RunExpiry = RunTimeout + time.Minute

// PrepareTriggerBindings fixes the entire fan-out before the first effect. An
// empty match is a snapshot too; retries must not pick up later automation edits.
func (s *Store) PrepareTriggerBindings(ctx context.Context, id uint64, realm string) ([]EventBinding, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var prepared bool
	if err := tx.QueryRow(ctx, `SELECT bindings_prepared FROM flow_trigger_outbox
	  WHERE id = $1 AND realm = $2 FOR UPDATE`, id, realm).Scan(&prepared); err != nil {
		return nil, err
	}
	if !prepared {
		// Existing attempts are the only safe snapshot for events from older versions.
		_, err = tx.Exec(ctx, `INSERT INTO flow_trigger_bindings (trigger_id, automation_id, flow_id, flow_version)
		  SELECT trigger_id, automation_id, flow_id, flow_version FROM flow_runs WHERE trigger_id = $1
		  UNION ALL
		  SELECT t.id, t.replay_automation_id, t.replay_flow_id, t.replay_flow_version
		    FROM flow_trigger_outbox t WHERE t.id = $1 AND t.replay_of_run_id IS NOT NULL
		      AND NOT EXISTS (SELECT 1 FROM flow_runs WHERE trigger_id = $1)
		  ON CONFLICT DO NOTHING`, id)
		if err != nil {
			return nil, err
		}
		var hasSnapshot bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM flow_trigger_bindings WHERE trigger_id = $1)`, id).Scan(&hasSnapshot); err != nil {
			return nil, err
		}
		if !hasSnapshot {
			// 两条绑定路径：event/webhook 按 trigger_spec（即事件名）扇出到所有订阅者；
			// cron 只投给游标对应的那一个自动化，不按表达式匹配——两个自动化写同一个
			// cron 表达式是合法的，按表达式匹配会让它们互相触发。
			_, err = tx.Exec(ctx, `INSERT INTO flow_trigger_bindings (trigger_id, automation_id, flow_id, flow_version)
			  SELECT t.id, a.automation_id, f.id, f.version
			  FROM flow_trigger_outbox t
			  JOIN project_automations a ON a.enabled AND (
			       (t.source = 'event' AND a.trigger_kind IN ('event','webhook') AND a.trigger_spec = t.event_name)
			    OR (t.source = 'cron' AND a.trigger_kind = 'cron' AND a.automation_id = t.cron_automation_id)
			  )
			  JOIN flows f ON f.id = a.flow_ref AND f.project_id = a.project_id AND f.realm = t.realm
			  JOIN projects p ON p.id = a.project_id AND p.realm = t.realm AND p.status = 'active'
			  JOIN flow_versions v ON v.flow_id = f.id AND v.version = f.version
			  WHERE t.id = $1 AND t.replay_of_run_id IS NULL AND f.status IN ('published','targeted')`, id)
			if err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE flow_trigger_outbox SET bindings_prepared = true WHERE id = $1`, id); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `SELECT automation_id, flow_id, flow_version FROM flow_trigger_bindings
	  WHERE trigger_id = $1 ORDER BY automation_id`, id)
	if err != nil {
		return nil, err
	}
	bindings, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (EventBinding, error) {
		var binding EventBinding
		err := row.Scan(&binding.AutomationID, &binding.FlowID, &binding.FlowVersion)
		return binding, err
	})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return bindings, nil
}

// Scheduled executions use the flow author's current grants and membership.
func (s *Store) AutomationIdentity(ctx context.Context, realm, flowID string) (observability.Identity, error) {
	var identity observability.Identity
	err := s.pool.QueryRow(ctx, `SELECT u.realm,u.id,u.primary_dept_id,f.project_id,
	  ARRAY(SELECT ur.role_id FROM governance_user_roles ur JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id
	    WHERE ur.realm=u.realm AND ur.user_id=u.id AND r.status='active' AND (ur.expires_at IS NULL OR ur.expires_at>now()) ORDER BY ur.role_id)
	  FROM flows f JOIN projects p ON p.id=f.project_id AND p.realm=f.realm AND p.status='active'
	  JOIN project_members m ON m.project_id=p.id AND m.user_id=f.author AND m.role IN ('owner','editor')
	  JOIN governance_users u ON u.realm=f.realm AND u.id=f.author AND u.status='active'
	  WHERE f.id=$1 AND f.realm=$2 AND f.status IN ('published','targeted')`, flowID, realm).
		Scan(&identity.Realm, &identity.UserID, &identity.DeptID, &identity.ProjectID, &identity.Roles)
	return identity, err
}
