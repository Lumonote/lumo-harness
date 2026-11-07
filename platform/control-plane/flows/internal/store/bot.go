package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/flows/internal/domain"
)

// Receipts and outbox entries commit together. Keep receipts for as long as the
// channel may retry; deleting one explicitly permits that message to run again.
const botDDL = `
CREATE TABLE IF NOT EXISTS flow_bot_receipts (
 realm TEXT NOT NULL,
 channel TEXT NOT NULL,
 message_id TEXT NOT NULL,
 payload_hash BYTEA NOT NULL,
 trigger_id BIGINT NOT NULL REFERENCES flow_trigger_outbox(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (realm, channel, message_id)
);
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS bot_scope JSONB;
`

var ErrBotMessageConflict = errors.New("bot message ID reused with different content")
var ErrBotSenderUnauthorized = errors.New("bot sender is not currently authorized")

// EnqueueBotTrigger deduplicates even across replicas and restarts. The digest
// includes the configured event name, so changing a channel's binding cannot
// silently deliver an old message to a different automation.
func (s *Store) EnqueueBotTrigger(ctx context.Context, realm, channel, messageID, name string, payload json.RawMessage) (id int64, duplicate bool, err error) {
	return s.enqueueBotTrigger(ctx, realm, channel, messageID, name, "", payload)
}

// EnqueueBotSubjectTrigger is called only after a channel's v2 signature has
// authenticated its external subject. Never extract authority from payload.
func (s *Store) EnqueueBotSubjectTrigger(ctx context.Context, realm, channel, messageID, name, subject string, payload json.RawMessage) (int64, bool, error) {
	if subject == "" {
		return 0, false, ErrBotSenderUnauthorized
	}
	return s.enqueueBotTrigger(ctx, realm, channel, messageID, name, subject, payload)
}

func (s *Store) enqueueBotTrigger(ctx context.Context, realm, channel, messageID, name, subject string, payload json.RawMessage) (id int64, duplicate bool, err error) {
	if realm == "" || channel == "" || messageID == "" || name == "" || name == "*" || !json.Valid(payload) {
		return 0, false, fmt.Errorf("invalid bot event")
	}
	digestInput := name + "\n"
	if subject != "" {
		digestInput += subject + "\n"
	}
	digest := sha256.Sum256(append([]byte(digestInput), payload...))
	envelope, err := json.Marshal(struct {
		Channel   string          `json:"channel"`
		MessageID string          `json:"message_id"`
		Data      json.RawMessage `json:"data"`
	}{channel, messageID, payload})
	if err != nil {
		return 0, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback(ctx)
	scope := domain.BotScope{Channel: channel, Subject: subject, MessageID: messageID}
	if subject != "" {
		err := tx.QueryRow(ctx, `SELECT b.user_id,b.revision FROM governance_bot_subjects b
		 JOIN governance_users u ON u.realm=b.realm AND u.id=b.user_id AND u.status='active'
		 WHERE b.realm=$1 AND b.channel=$2 AND b.subject=$3 AND b.status='active' FOR SHARE OF b,u`, realm, channel, subject).
			Scan(&scope.UserID, &scope.BindingRevision)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, ErrBotSenderUnauthorized
		}
		if err != nil {
			return 0, false, err
		}
		rows, err := tx.Query(ctx, `SELECT team_id,project_id,agent_id,capability,revision FROM governance_bot_grants
		 WHERE realm=$1 AND channel=$2 AND subject=$3 AND subject_user_id=$4 AND subject_revision=$5 AND status='active'
		 ORDER BY team_id,project_id,agent_id,capability FOR SHARE`, realm, channel, subject, scope.UserID, scope.BindingRevision)
		if err != nil {
			return 0, false, err
		}
		for rows.Next() {
			var grant domain.BotGrantScope
			if err := rows.Scan(&grant.TeamID, &grant.ProjectID, &grant.AgentID, &grant.Capability, &grant.Revision); err != nil {
				rows.Close()
				return 0, false, err
			}
			scope.Grants = append(scope.Grants, grant)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return 0, false, err
		}
	}
	metadata, err := json.Marshal(scope)
	if err != nil {
		return 0, false, err
	}
	// Insert the candidate outbox row first to keep trigger_id NOT NULL. A loser
	// rolls the entire transaction back, including its candidate outbox row.
	if err = tx.QueryRow(ctx, `INSERT INTO flow_trigger_outbox (realm,event_name,payload,bot_scope) VALUES ($1,$2,$3,$4) RETURNING id`, realm, name, envelope, metadata).Scan(&id); err != nil {
		return 0, false, err
	}
	var inserted int64
	err = tx.QueryRow(ctx, `INSERT INTO flow_bot_receipts (realm,channel,message_id,payload_hash,trigger_id)
  VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING trigger_id`, realm, channel, messageID, digest[:], id).Scan(&inserted)
	if err == nil {
		return id, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, err
	}
	var same bool
	if err = tx.QueryRow(ctx, `SELECT trigger_id, payload_hash=$4 FROM flow_bot_receipts WHERE realm=$1 AND channel=$2 AND message_id=$3`, realm, channel, messageID, digest[:]).Scan(&id, &same); err != nil {
		return 0, false, err
	}
	if !same {
		return 0, false, ErrBotMessageConflict
	}
	return id, true, nil // deferred rollback removes the unreferenced candidate
}
