package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

var ErrDocumentFenced = errors.New("collaborator: document writer lease is unavailable or expired")
var ErrSnapshotConflict = errors.New("collaborator: snapshot base changed")

const DocumentLeaseTTL = 10 * time.Second

type DocumentLease struct {
	Document domain.DocumentID
	Holder   string
	Epoch    int64
}

// AcquireDocumentLease never steals an unexpired owner's lease. The hash ring
// routes requests; this row, rather than discovery, grants exclusive write access.
func (s *Store) AcquireDocumentLease(ctx context.Context, id domain.DocumentID, holder string) (DocumentLease, error) {
	if holder == "" {
		return DocumentLease{}, ErrDocumentFenced
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return DocumentLease{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO collab_document_runtime(doc_id) VALUES ($1) ON CONFLICT DO NOTHING`, string(id)); err != nil {
		return DocumentLease{}, err
	}
	var previous string
	var epoch int64
	var valid, migrated bool
	if err := tx.QueryRow(ctx, `SELECT holder,epoch,expires_at>clock_timestamp(),migrated FROM collab_document_runtime WHERE doc_id=$1 FOR UPDATE`, string(id)).Scan(&previous, &epoch, &valid, &migrated); err != nil {
		return DocumentLease{}, err
	}
	if valid && previous != holder {
		return DocumentLease{}, ErrDocumentFenced
	}
	if !valid || previous != holder {
		epoch++
	}
	if !migrated {
		if err := s.importLegacyDocumentWAL(ctx, tx, id); err != nil {
			return DocumentLease{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE collab_document_runtime SET holder=$2,epoch=$3,expires_at=clock_timestamp()+$4*interval '1 millisecond',migrated=true WHERE doc_id=$1`, string(id), holder, epoch, DocumentLeaseTTL.Milliseconds()); err != nil {
		return DocumentLease{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DocumentLease{}, err
	}
	return DocumentLease{Document: id, Holder: holder, Epoch: epoch}, nil
}

// Import is deliberately under the document lock. Old versions must be stopped
// before upgrading: an old binary cannot obey a fence introduced by a new binary.
func (s *Store) importLegacyDocumentWAL(ctx context.Context, tx pgx.Tx, id domain.DocumentID) error {
	var snapshot int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT wal_seq FROM collab_state WHERE doc_id=$1),0)`, string(id)).Scan(&snapshot); err != nil {
		return err
	}
	head := snapshot
	if s.rdb == nil {
		return errors.New("collaborator: existing document needs legacy Redis WAL import; quiesce old writers and configure Redis before upgrade")
	}
	if s.rdb != nil {
		updates, err := s.ReadWALFrom(ctx, id, snapshot)
		if err != nil {
			return fmt.Errorf("collaborator: legacy Redis WAL import failed; preserve Redis and retry: %w", err)
		}
		for _, update := range updates {
			if update.DocID != id {
				return errors.New("collaborator: legacy WAL document identity mismatch")
			}
			if update.Seq <= snapshot {
				update.Seq = head + 1
			}
			if update.Seq != head+1 {
				return fmt.Errorf("collaborator: legacy WAL gap after %d", head)
			}
			blob, err := json.Marshal(update)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO collab_document_wal(doc_id,seq,update) VALUES ($1,$2,$3::jsonb)`, string(id), update.Seq, blob); err != nil {
				return err
			}
			head = update.Seq
		}
	}
	_, err := tx.Exec(ctx, `UPDATE collab_document_runtime SET head=$2 WHERE doc_id=$1`, string(id), head)
	return err
}

func (s *Store) RenewDocumentLease(ctx context.Context, lease DocumentLease) error {
	result, err := s.pg.Exec(ctx, `UPDATE collab_document_runtime SET expires_at=clock_timestamp()+$4*interval '1 millisecond' WHERE doc_id=$1 AND holder=$2 AND epoch=$3 AND expires_at>clock_timestamp()`, string(lease.Document), lease.Holder, lease.Epoch, DocumentLeaseTTL.Milliseconds())
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrDocumentFenced
	}
	return nil
}

func (s *Store) ReleaseDocumentLease(ctx context.Context, lease DocumentLease) error {
	_, err := s.pg.Exec(ctx, `UPDATE collab_document_runtime SET expires_at='-infinity' WHERE doc_id=$1 AND holder=$2 AND epoch=$3`, string(lease.Document), lease.Holder, lease.Epoch)
	return err
}

func lockDocumentWriter(ctx context.Context, tx pgx.Tx, lease DocumentLease) (int64, error) {
	var head int64
	err := tx.QueryRow(ctx, `SELECT head FROM collab_document_runtime WHERE doc_id=$1 AND holder=$2 AND epoch=$3 AND expires_at>clock_timestamp() AND migrated FOR UPDATE`, string(lease.Document), lease.Holder, lease.Epoch).Scan(&head)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrDocumentFenced
	}
	return head, err
}

// AppendDocumentWAL allocates seq, validates ownership and persists the update in
// one transaction. Ack means a synchronous PostgreSQL commit, not a Redis RPUSH.
func (s *Store) AppendDocumentWAL(ctx context.Context, lease DocumentLease, update domain.Update) (int64, error) {
	if update.DocID != lease.Document {
		return 0, ErrDocumentFenced
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return 0, err
	}
	head, err := lockDocumentWriter(ctx, tx, lease)
	if err != nil {
		return 0, err
	}
	update.Seq = head + 1
	blob, err := json.Marshal(update)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO collab_document_wal(doc_id,seq,update) VALUES ($1,$2,$3::jsonb)`, string(update.DocID), update.Seq, blob); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE collab_document_runtime SET head=$2,expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE doc_id=$1`, string(update.DocID), update.Seq, DocumentLeaseTTL.Milliseconds()); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return update.Seq, nil
}

func (s *Store) DocumentHead(ctx context.Context, id domain.DocumentID) (int64, error) {
	var head int64
	err := s.pg.QueryRow(ctx, `SELECT head FROM collab_document_runtime WHERE doc_id=$1 AND migrated`, string(id)).Scan(&head)
	return head, err
}

// ReadDocumentWAL returns exactly the captured prefix, never unaccounted newer
// updates. A snapshot's seq must describe precisely the state being persisted.
func (s *Store) ReadDocumentWAL(ctx context.Context, id domain.DocumentID, from, through int64) ([]domain.Update, error) {
	if through < from {
		return nil, ErrSnapshotConflict
	}
	rows, err := s.pg.Query(ctx, `SELECT seq,update FROM collab_document_wal WHERE doc_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq`, string(id), from, through)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	updates := make([]domain.Update, 0)
	next := from + 1
	for rows.Next() {
		var seq int64
		var blob []byte
		if err := rows.Scan(&seq, &blob); err != nil {
			return nil, err
		}
		if seq != next {
			return nil, fmt.Errorf("collaborator: WAL gap at %d", next)
		}
		var update domain.Update
		if err := json.Unmarshal(blob, &update); err != nil {
			return nil, err
		}
		if update.Seq != seq || update.DocID != id {
			return nil, errors.New("collaborator: WAL envelope mismatch")
		}
		updates = append(updates, update)
		next++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if next != through+1 {
		return nil, fmt.Errorf("collaborator: WAL gap at %d", next)
	}
	return updates, nil
}

// SaveDocumentSnapshot atomically checks owner+base, writes the exact prefix,
// and removes only the updates it covers. A stale writer cannot overwrite or trim.
func (s *Store) SaveDocumentSnapshot(ctx context.Context, lease DocumentLease, state []byte, base, through int64) error {
	if through < base {
		return ErrSnapshotConflict
	}
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return err
	}
	head, err := lockDocumentWriter(ctx, tx, lease)
	if err != nil {
		return err
	}
	if head < through {
		return ErrSnapshotConflict
	}
	var count int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM collab_document_wal WHERE doc_id=$1 AND seq>$2 AND seq<=$3`, string(lease.Document), base, through).Scan(&count); err != nil {
		return err
	}
	if count != through-base {
		return errors.New("collaborator: snapshot cannot cover an incomplete WAL prefix")
	}
	result, err := tx.Exec(ctx, `INSERT INTO collab_state(doc_id,state,wal_seq) SELECT $1,$2,$3 WHERE $4::bigint=0 ON CONFLICT(doc_id) DO UPDATE SET state=EXCLUDED.state,wal_seq=EXCLUDED.wal_seq,updated_at=clock_timestamp() WHERE collab_state.wal_seq=$4 AND collab_state.wal_seq<=EXCLUDED.wal_seq`, string(lease.Document), state, through, base)
	// Existing rows with base>0 need an UPDATE: the INSERT SELECT above emits no row.
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 && base > 0 {
		result, err = tx.Exec(ctx, `UPDATE collab_state SET state=$2,wal_seq=$3,updated_at=clock_timestamp() WHERE doc_id=$1 AND wal_seq=$4 AND wal_seq<=$3`, string(lease.Document), state, through, base)
		if err != nil {
			return err
		}
	}
	if result.RowsAffected() != 1 {
		return ErrSnapshotConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM collab_document_wal WHERE doc_id=$1 AND seq<=$2`, string(lease.Document), through); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
