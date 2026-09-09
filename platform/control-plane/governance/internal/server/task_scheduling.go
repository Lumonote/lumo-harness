package server

import (
	"context"
	"strings"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

// RunScheduling retries only delivery of a durable Run. Explicit retry or
// reassignment creates a different run id, including after uncertain HTTP I/O.
func (s *Server) RunScheduling(ctx context.Context) {
	if domain.RequireCluster(s.cfg.DeploymentMode, s.cfg.ClusterStatus) != nil || strings.TrimSpace(s.cfg.SchedulerURL) == "" {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		pending, err := s.store.PendingRunSchedules(ctx)
		if err != nil && ctx.Err() == nil {
			s.log.Warn("read pending run schedules", "err", err)
		}
		for _, item := range pending {
			if ctx.Err() != nil {
				return
			}
			if err := s.scheduleRun(ctx, item.Realm, item.RunID); err != nil {
				s.log.Warn("run scheduling deferred", "run_id", item.RunID, "err", err)
				if err := s.store.DeferRunSchedule(ctx, item.Realm, item.RunID, err.Error()); err != nil && ctx.Err() == nil {
					s.log.Warn("persist schedule delivery error", "err", err)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) scheduleRun(ctx context.Context, realm, runID string) error {
	run, err := s.store.GetTaskRun(ctx, realm, runID)
	if err != nil {
		return err
	}
	task, err := s.store.GetDelegationTask(ctx, realm, run.TaskID)
	if err != nil {
		return err
	}
	if !domain.DelegationStateActive(run.State) || task.SchedulerTaskID != run.ID {
		return s.store.RecordRunPlacement(ctx, realm, run.ID, run.State, run.AssignedNodeID)
	}
	schedule, err := scheduleFromTask(task)
	if err != nil {
		return err
	}
	placement, err := s.placeRun(ctx, realm, run.ID, schedule, task)
	if err != nil {
		return err
	}
	return s.store.RecordRunPlacement(ctx, realm, run.ID, placement.State, placement.NodeID)
}
