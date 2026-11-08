package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const botAuthorizationDDL = `
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
ALTER TABLE governance_bot_grants DROP CONSTRAINT IF EXISTS governance_bot_grants_capability_check;
ALTER TABLE governance_bot_grants ADD CONSTRAINT governance_bot_grants_capability_check CHECK(capability IN ('delegation.create','computer-use.request'));
`

type BotSubject struct {
	Realm    string `json:"realm"`
	Channel  string `json:"channel"`
	Subject  string `json:"subject"`
	UserID   string `json:"user_id"`
	Status   string `json:"status"`
	Revision int64  `json:"revision"`
}
type BotGrant struct {
	BotSubject
	TeamID          string `json:"team_id"`
	Captain         string `json:"captain_session_ref"`
	TeamRevision    string `json:"team_revision"`
	TeamOwner       string `json:"team_owner_user_id"`
	ProjectID       string `json:"project_id"`
	AgentID         string `json:"agent_id"`
	Capability      string `json:"capability"`
	SubjectUserID   string `json:"subject_user_id"`
	SubjectRevision int64  `json:"subject_revision"`
	PresetRevision  int    `json:"preset_revision"`
}

func validBotRef(value string) bool {
	return value != "" && value == strings.TrimSpace(value) && len(value) <= 512 && !strings.ContainsAny(value, "\x00\r\n")
}
func (s *Store) UpsertBotSubject(ctx context.Context, value BotSubject) (BotSubject, error) {
	if !validBotRef(value.Realm) || !validBotRef(value.Channel) || !validBotRef(value.Subject) || !validBotRef(value.UserID) || (value.Status != "active" && value.Status != "revoked") {
		return BotSubject{}, fmt.Errorf("invalid Bot subject mapping")
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO governance_bot_subjects(realm,channel,subject,user_id,status) VALUES($1,$2,$3,$4,$5)
	 ON CONFLICT(realm,channel,subject) DO UPDATE SET user_id=EXCLUDED.user_id,status=EXCLUDED.status,revision=governance_bot_subjects.revision+1,updated_at=now() RETURNING revision`, value.Realm, value.Channel, value.Subject, value.UserID, value.Status).Scan(&value.Revision)
	return value, err
}
func (s *Store) BotSubject(ctx context.Context, realm, channel, subject string) (BotSubject, error) {
	var value BotSubject
	err := s.pool.QueryRow(ctx, `SELECT realm,channel,subject,user_id,status,revision FROM governance_bot_subjects WHERE realm=$1 AND channel=$2 AND subject=$3`, realm, channel, subject).
		Scan(&value.Realm, &value.Channel, &value.Subject, &value.UserID, &value.Status, &value.Revision)
	return value, err
}
func (s *Store) UpsertBotGrant(ctx context.Context, value BotGrant) (BotGrant, error) {
	for _, field := range []string{value.Realm, value.Channel, value.Subject, value.TeamID, value.Captain, value.TeamRevision, value.TeamOwner, value.ProjectID, value.AgentID, value.SubjectUserID} {
		if !validBotRef(field) {
			return BotGrant{}, fmt.Errorf("invalid Bot team grant")
		}
	}
	if (value.Capability != "delegation.create" && value.Capability != "computer-use.request") || value.SubjectRevision < 1 || value.PresetRevision < 1 || (value.Status != "active" && value.Status != "revoked") {
		return BotGrant{}, fmt.Errorf("invalid Bot capability")
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO governance_bot_grants(realm,channel,subject,team_id,captain_session_ref,team_revision,team_owner_user_id,project_id,agent_id,capability,status,subject_user_id,subject_revision,preset_revision)
	 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(realm,channel,subject,team_id,project_id,agent_id,capability) DO UPDATE
	 SET captain_session_ref=EXCLUDED.captain_session_ref,team_revision=EXCLUDED.team_revision,team_owner_user_id=EXCLUDED.team_owner_user_id,
	 subject_user_id=EXCLUDED.subject_user_id,subject_revision=EXCLUDED.subject_revision,preset_revision=EXCLUDED.preset_revision,
	 status=EXCLUDED.status,revision=governance_bot_grants.revision+1,updated_at=now() RETURNING revision`, value.Realm, value.Channel, value.Subject, value.TeamID, value.Captain, value.TeamRevision, value.TeamOwner, value.ProjectID, value.AgentID, value.Capability, value.Status, value.SubjectUserID, value.SubjectRevision, value.PresetRevision).Scan(&value.Revision)
	return value, err
}
func (s *Store) BotGrant(ctx context.Context, realm, channel, subject, team, project, agent string) (BotGrant, error) {
	return s.BotCapabilityGrant(ctx, realm, channel, subject, team, project, agent, "delegation.create")
}
func (s *Store) BotCapabilityGrant(ctx context.Context, realm, channel, subject, team, project, agent, capability string) (BotGrant, error) {
	var value BotGrant
	err := s.pool.QueryRow(ctx, `SELECT realm,channel,subject,team_id,captain_session_ref,team_revision,team_owner_user_id,project_id,agent_id,capability,status,revision,subject_user_id,subject_revision,preset_revision
	 FROM governance_bot_grants WHERE realm=$1 AND channel=$2 AND subject=$3 AND team_id=$4 AND project_id=$5 AND agent_id=$6 AND capability=$7`, realm, channel, subject, team, project, agent, capability).
		Scan(&value.Realm, &value.Channel, &value.Subject, &value.TeamID, &value.Captain, &value.TeamRevision, &value.TeamOwner, &value.ProjectID, &value.AgentID, &value.Capability, &value.Status, &value.Revision, &value.SubjectUserID, &value.SubjectRevision, &value.PresetRevision)
	return value, err
}

// Read the immutable reviewed node and current author/project state from the
// owning service tables; an authorization body cannot select an unreviewed target.
func (s *Store) BotFlowNode(ctx context.Context, realm, flowID string, version int, nodeID string) (author, project, operator string, config map[string]any, err error) {
	var definition []byte
	err = s.pool.QueryRow(ctx, `SELECT f.author,f.project_id,v.definition FROM flows f
	 JOIN flow_versions v ON v.flow_id=f.id AND v.version=$3 JOIN projects p ON p.id=f.project_id AND p.realm=f.realm AND p.status='active'
	 WHERE f.realm=$1 AND f.id=$2 AND f.status IN ('published','targeted')`, realm, flowID, version).Scan(&author, &project, &definition)
	if err != nil {
		return
	}
	var value struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Operator string         `json:"operator"`
			Config   map[string]any `json:"config"`
		} `json:"nodes"`
	}
	if err = json.Unmarshal(definition, &value); err != nil {
		return
	}
	for _, node := range value.Nodes {
		if node.ID == nodeID {
			return author, project, node.Operator, node.Config, nil
		}
	}
	err = ErrNotFound
	return
}
