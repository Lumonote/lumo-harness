-- Governance owns sender mappings and capability grants. Flows owns the
-- immutable ingress scope attached to each durable trigger and its replays.
CREATE TABLE IF NOT EXISTS governance_bot_subjects (
 realm TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','revoked')), revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(realm,channel,subject)
);
CREATE TABLE IF NOT EXISTS governance_bot_grants (
 realm TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT NOT NULL, team_id TEXT NOT NULL,
 captain_session_ref TEXT NOT NULL, team_revision TEXT NOT NULL, team_owner_user_id TEXT NOT NULL,
 subject_user_id TEXT NOT NULL, subject_revision BIGINT NOT NULL CHECK(subject_revision>0), preset_revision INTEGER NOT NULL CHECK(preset_revision>0),
 project_id TEXT NOT NULL, agent_id TEXT NOT NULL, capability TEXT NOT NULL CHECK(capability='delegation.create'),
 status TEXT NOT NULL CHECK(status IN ('active','revoked')), revision BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(realm,channel,subject,team_id,project_id,agent_id,capability)
);
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS bot_scope JSONB;
DO $bot_scope_upgrade$ BEGIN
WITH RECURSIVE bot_scopes(id,scope) AS (
 SELECT o.id,COALESCE(o.bot_scope,jsonb_build_object('channel',b.channel,'message_id',b.message_id))
 FROM flow_trigger_outbox o JOIN flow_bot_receipts b ON b.trigger_id=o.id
 UNION
 SELECT child.id,COALESCE(child.bot_scope,parent.scope)
 FROM bot_scopes parent JOIN flow_runs r ON r.trigger_id=parent.id
 JOIN flow_trigger_outbox child ON child.replay_of_run_id=r.id
)
UPDATE flow_trigger_outbox o SET bot_scope=b.scope FROM bot_scopes b WHERE o.id=b.id AND o.bot_scope IS NULL;
END $bot_scope_upgrade$;
