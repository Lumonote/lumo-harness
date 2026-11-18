package store

import (
	"context"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"
)

// NewWithLeaseTTL creates the scheduler's store with server-enforced ceilings
// for runtime transactions. A suspended process can't run its Go deadlines or
// close its PostgreSQL connections, so the database must release those locks.
func NewWithLeaseTTL(ctx context.Context, dsn string, leaseTTLMS int64) (*Store, error) {
	if leaseTTLMS < 3 {
		return nil, fmt.Errorf("scheduler: lease TTL must be at least 3ms")
	}
	s, err := New(ctx, dsn)
	if err != nil {
		return nil, err
	}

	// A backend may be running a statement when the client stops, or it may
	// already be waiting for the client's next command. Bound both phases.
	// Each ceiling is half a lease TTL, in PostgreSQL's signed 32-bit ms range.
	limitMS := min(leaseTTLMS/2, math.MaxInt32)
	s.workTxOptions.BeginQuery = fmt.Sprintf(`BEGIN;
		SELECT set_config('statement_timeout', LEAST(%[1]d,
			NULLIF(EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000, 0))::bigint::text, true),
		       set_config('idle_in_transaction_session_timeout', LEAST(%[1]d,
			NULLIF(EXTRACT(EPOCH FROM current_setting('idle_in_transaction_session_timeout')::interval) * 1000, 0))::bigint::text, true)`, limitMS)
	return s, nil
}

// beginWork applies the ceilings before taking any locks, in the same round
// trip as BEGIN. set_config(..., true) keeps them transaction-local and LEAST
// preserves stricter database settings (0 means disabled). Schema setup has
// its own transaction so index creation isn't subject to a lease-sized budget.
func (s *Store) beginWork(ctx context.Context) (pgx.Tx, error) {
	return s.pool.BeginTx(ctx, s.workTxOptions)
}
