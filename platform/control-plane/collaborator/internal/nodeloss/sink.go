// Package nodeloss connects Nacos liveness reports to the thread registry's
// existing transactional failure and durable notice path.
package nodeloss

import (
	"context"

	"github.com/lumo-harness/platform/collaborator/internal/store"
	"github.com/lumo-harness/platform/heartbeat"
)

type Sink struct{ Store *store.Store }

// ReportNodeLoss resolves realms from stored thread ownership, never from a
// caller-supplied realm. A partial failure is retried; per-thread transitions
// and notices are already idempotent. Multiple collaborator replicas are safe.
func (s Sink) ReportNodeLoss(ctx context.Context, nodeID, _ string) (heartbeat.NodeLossReceipt, error) {
	realms, err := s.Store.ActiveThreadRealmsForNode(ctx, nodeID)
	if err != nil {
		return heartbeat.NodeLossReceipt{}, err
	}
	var receipt heartbeat.NodeLossReceipt
	for _, realm := range realms {
		outcome, err := s.Store.FailThreadsOnNodeLoss(ctx, realm, nodeID)
		if err != nil {
			return receipt, err
		}
		receipt.Failed += len(outcome.Failed)
		receipt.Ignored += len(outcome.Ignored)
	}
	return receipt, nil
}
