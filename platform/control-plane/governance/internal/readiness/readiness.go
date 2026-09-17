// Package readiness adapts the heartbeat watcher to the governance gate's
// health source.
//
// The two types are kept apart on purpose. heartbeat knows about databases and
// nothing about governance; domain knows about the gate and nothing about
// databases. This package is the only place that has to know both, which keeps
// the pure gate testable without a database and the watcher reusable by any
// service that wants a readiness endpoint.
package readiness

import (
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/heartbeat"
)

// Snapshotter is the part of a heartbeat watcher this adapter needs. Taking the
// narrow interface rather than the concrete watcher keeps the mapping below
// testable without a database.
type Snapshotter interface {
	Snapshot() heartbeat.Snapshot
}

// Source presents a heartbeat watcher as the gate's health source.
type Source struct {
	watcher Snapshotter
}

func New(watcher Snapshotter) *Source { return &Source{watcher: watcher} }

// Health returns the cached verdict. The watcher has already applied its own
// fail-closed rules, so this only renames fields.
//
// Known is derived from EvaluatedAt rather than from Ready: a snapshot that says
// "not ready" is a known verdict, while one that has never been taken is not.
func (s *Source) Health() domain.ClusterHealth {
	snapshot := s.watcher.Snapshot()
	return domain.ClusterHealth{
		Known:       !snapshot.EvaluatedAt.IsZero(),
		Ready:       snapshot.Ready,
		Reason:      snapshot.Reason,
		Unready:     snapshot.Unhealthy,
		EvaluatedAt: snapshot.EvaluatedAt,
	}
}
