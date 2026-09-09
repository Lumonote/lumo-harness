package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func (s *Server) prepareDelegationIntent(ctx context.Context, c caller, spec *domain.DelegationSpec, schedule **delegationSchedule) error {
	contract, err := domain.NormalizeIntent(spec.Intent, spec.IntentContract)
	if err != nil {
		return fmt.Errorf("%w: %v", store.ErrBadRequest, err)
	}
	if contract.ParentTaskID != "" {
		parent, err := s.store.GetDelegationTask(ctx, c.realm, contract.ParentTaskID)
		if err != nil {
			return err
		}
		if parent.ProjectID != spec.ProjectID || (parent.RequesterUserID != c.userID && parent.AssigneeUserID != c.userID) {
			return store.ErrForbidden
		}
		parentIntent, err := domain.NormalizeIntent(parent.Intent, parent.IntentContract)
		if err != nil {
			return err
		}
		if parent.IntentContract != nil {
			parentIntent = *parent.IntentContract
		}
		contract, err = domain.InheritIntent(contract, parentIntent)
		if err != nil {
			return fmt.Errorf("%w: %v", store.ErrBadRequest, err)
		}
		parentSchedule, err := scheduleFromTask(parent)
		if err != nil {
			return fmt.Errorf("%w: invalid parent schedule", store.ErrBadRequest)
		}
		if parentSchedule != nil {
			if spec.Residency != "" && parentSchedule.Residency != "" && spec.Residency != parentSchedule.Residency {
				return fmt.Errorf("%w: child residency conflicts with parent", store.ErrBadRequest)
			}
			if spec.RequiredTrustLevel != "" && parentSchedule.TrustLevel != "" && spec.RequiredTrustLevel != parentSchedule.TrustLevel {
				return fmt.Errorf("%w: child trust level conflicts with parent", store.ErrBadRequest)
			}
			if parentSchedule.Residency != "" {
				spec.Residency = parentSchedule.Residency
			}
			if parentSchedule.TrustLevel != "" {
				spec.RequiredTrustLevel = parentSchedule.TrustLevel
			}
			if schedule != nil {
				if *schedule == nil {
					*schedule = &delegationSchedule{}
				}
				child := *schedule
				if child.ClusterID != "" && parentSchedule.ClusterID != "" && child.ClusterID != parentSchedule.ClusterID {
					return fmt.Errorf("%w: child cluster conflicts with parent", store.ErrBadRequest)
				}
				if parentSchedule.ClusterID != "" {
					child.ClusterID = parentSchedule.ClusterID
				}
				if parentSchedule.DeadlineMS > 0 && (child.DeadlineMS == 0 || child.DeadlineMS > parentSchedule.DeadlineMS) {
					child.DeadlineMS = parentSchedule.DeadlineMS
				}
				child.AvoidNodes = append(append([]string{}, parentSchedule.AvoidNodes...), child.AvoidNodes...)
			}
		}
	}
	if schedule != nil {
		if *schedule == nil {
			*schedule = &delegationSchedule{}
		}
		child := *schedule
		if (child.Residency != "" && spec.Residency != "" && child.Residency != spec.Residency) ||
			(child.TrustLevel != "" && spec.RequiredTrustLevel != "" && child.TrustLevel != spec.RequiredTrustLevel) {
			return fmt.Errorf("%w: scheduling constraints conflict with intent", store.ErrBadRequest)
		}
		if spec.Residency != "" {
			child.Residency = strings.TrimSpace(spec.Residency)
		}
		if spec.RequiredTrustLevel != "" {
			child.TrustLevel = strings.TrimSpace(spec.RequiredTrustLevel)
		}
		if child.ClusterID == "" {
			child.ClusterID = s.cfg.ClusterID
		}
	}
	spec.IntentContract = &contract
	return nil
}

func (s *Server) listChildTasks(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireDelegationAuthority(w, c) {
		return
	}
	if _, ok := s.taskParticipant(w, r, c); !ok {
		return
	}
	tasks, err := s.store.ListChildTasks(r.Context(), c.realm, r.PathValue("taskID"))
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
}
