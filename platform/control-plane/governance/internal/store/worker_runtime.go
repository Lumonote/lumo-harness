package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

// WorkerNodes returns only current execution facts. Human tasks can use any
// activated device owned by that employee; Agent tasks use replicas running
// the current preset revision. The Scheduler still enforces realm, cluster,
// capability, residency, capacity and anti-affinity on this intersection.
func (s *Store) WorkerNodes(ctx context.Context, realm, workerID, projectID string) ([]string, error) {
	kind, id, ok := strings.Cut(workerID, ":")
	if !ok || !managedID.MatchString(id) || (kind != "user" && kind != "agent") {
		return nil, fmt.Errorf("%w: invalid worker id", ErrBadRequest)
	}
	var rows pgx.Rows
	var err error
	if kind == "user" {
		rows, err = s.pool.Query(ctx, `SELECT n.id
		  FROM governance_desktop_nodes n
		  JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
		  JOIN governance_device_connections d ON d.realm=n.realm AND d.node_id=n.id
		  WHERE n.realm=$1 AND n.owner_user_id=$2 AND u.status='active'
		    AND n.status='ONLINE' AND n.scheduling_eligible AND n.last_seen_at >= now()-interval '30 seconds'
		    AND d.revision>0 AND d.applied_revision=d.revision AND d.report_error=''
		    AND d.connection_id<>'' AND d.connection_expires>now() AND d.certificate_expires>now()
		  ORDER BY n.id`, realm, id)
	} else {
		rows, err = s.pool.Query(ctx, `SELECT h.node_id
		  FROM governance_worker_heartbeats h
		  JOIN governance_agent_presets p ON p.realm=h.realm AND 'agent:'||p.id=h.worker_id
		  JOIN governance_users u ON u.realm=p.realm AND u.id=p.owner_user_id
		  WHERE h.realm=$1 AND h.worker_id=$2 AND h.status='active' AND p.status='active' AND u.status='active'
		    AND h.preset_revision=p.revision AND h.updated_at >= now()-interval '30 seconds'
		    AND (p.project_id='' OR p.project_id=$3)
		  ORDER BY h.node_id`, realm, workerID, projectID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) ReportWorkerRuntime(ctx context.Context, realm, workerID string, report domain.WorkerRuntimeReport) error {
	if realm == "" || !strings.HasPrefix(workerID, "agent:") || !managedID.MatchString(strings.TrimPrefix(workerID, "agent:")) ||
		!managedID.MatchString(report.NodeID) || report.InstanceID == "" || len(report.InstanceID) > 160 ||
		report.PresetRevision < 1 || report.MaxConcurrency < 1 || report.MaxConcurrency > 1024 ||
		(report.Status != "active" && report.Status != "draining" && report.Status != "disabled") {
		return fmt.Errorf("%w: invalid worker runtime report", ErrBadRequest)
	}
	preset, err := s.GetAgentPreset(ctx, realm, strings.TrimPrefix(workerID, "agent:"))
	if err != nil {
		return err
	}
	if preset.Revision != report.PresetRevision {
		return ErrConflict
	}
	if report.Status == "active" && preset.Status != "active" {
		return ErrForbidden
	}
	result, err := s.pool.Exec(ctx, `INSERT INTO governance_worker_heartbeats
	  (realm,worker_id,node_id,instance_id,preset_revision,max_concurrency,status)
	  VALUES ($1,$2,$3,$4,$5,$6,$7)
	  ON CONFLICT (realm,worker_id,node_id) DO UPDATE SET instance_id=EXCLUDED.instance_id,
	    preset_revision=EXCLUDED.preset_revision,max_concurrency=EXCLUDED.max_concurrency,status=EXCLUDED.status,updated_at=now()
	  WHERE governance_worker_heartbeats.instance_id=EXCLUDED.instance_id
	    OR governance_worker_heartbeats.status='disabled'
	    OR governance_worker_heartbeats.updated_at < now()-interval '30 seconds'`,
		realm, workerID, report.NodeID, report.InstanceID, report.PresetRevision, report.MaxConcurrency, report.Status)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}
