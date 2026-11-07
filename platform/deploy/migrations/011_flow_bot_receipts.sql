-- flows owns this schema; kept aligned with internal/store/bot.go.
-- Run after flows has initialized flow_trigger_outbox; service startup also
-- applies this receipt DDL, so Compose does not depend on migrate.sh.

CREATE TABLE IF NOT EXISTS flow_bot_receipts (
 realm TEXT NOT NULL,
 channel TEXT NOT NULL,
 message_id TEXT NOT NULL,
 payload_hash BYTEA NOT NULL,
 trigger_id BIGINT NOT NULL REFERENCES flow_trigger_outbox(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (realm, channel, message_id)
);
