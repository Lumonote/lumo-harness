package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const remoteComputerDDL = `
CREATE TABLE IF NOT EXISTS governance_remote_computer_requests (
 id TEXT PRIMARY KEY,realm TEXT NOT NULL,node_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,
 connection_id TEXT NOT NULL,device_revision BIGINT NOT NULL,execution_key TEXT NOT NULL,
 authority JSONB NOT NULL,plan_json TEXT NOT NULL,digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','denied','cancelled','unknown')),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),summary TEXT NOT NULL DEFAULT '',
 expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(realm,execution_key),FOREIGN KEY(realm,node_id) REFERENCES governance_desktop_nodes(realm,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS governance_remote_computer_active_device ON governance_remote_computer_requests(realm,node_id) WHERE state IN ('pending','running');
CREATE TABLE IF NOT EXISTS governance_remote_computer_receipts (
 request_id TEXT NOT NULL REFERENCES governance_remote_computer_requests(id),revision BIGINT NOT NULL,
 phase TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,revision)
);`

type RemoteComputerAuthority struct {
	Channel         string `json:"channel"`
	Subject         string `json:"subject"`
	Sender          string `json:"sender_user_id"`
	BindingRevision int64  `json:"binding_revision"`
	GrantRevision   int64  `json:"grant_revision"`
	FlowID          string `json:"flow_id"`
	FlowVersion     int    `json:"flow_version"`
	FlowNode        string `json:"flow_node_id"`
	Author          string `json:"author_user_id"`
	ProjectID       string `json:"project_id"`
	TeamID          string `json:"team_id"`
	Captain         string `json:"captain_session_ref"`
	AgentID         string `json:"agent_id"`
	TeamOwner       string `json:"team_owner_user_id"`
	TeamRevision    string `json:"team_revision"`
	PresetRevision  int    `json:"preset_revision"`
}
type RemoteComputerPlan struct {
	Realm      string    `json:"realm"`
	NodeID     string    `json:"node_id"`
	Owner      string    `json:"owner_user_id"`
	ProjectID  string    `json:"project_id"`
	SessionRef string    `json:"session_ref"`
	Capability string    `json:"capability"`
	ExpiresAt  time.Time `json:"expires_at"`
	Intent     string    `json:"intent"`
	Channel    string    `json:"channel"`
	Subject    string    `json:"subject"`
	Sender     string    `json:"sender_user_id"`
	TeamID     string    `json:"team_id"`
	AgentID    string    `json:"agent_id"`
}
type RemoteComputerEnvelope struct {
	Version   int    `json:"version"`
	RequestID string `json:"request_id"`
	Digest    string `json:"digest"`
	PlanJSON  string `json:"plan_json"`
}
type RemoteComputerRequest struct {
	RemoteComputerEnvelope
	State     string                  `json:"state"`
	Revision  int64                   `json:"revision"`
	ExpiresAt time.Time               `json:"expires_at"`
	Summary   string                  `json:"summary"`
	Authority RemoteComputerAuthority `json:"-"`
	Plan      RemoteComputerPlan      `json:"-"`
}
type RemoteComputerLeaseInput struct {
	Digest           string `json:"digest"`
	ExpectedRevision int64  `json:"expected_revision"`
	Phase            string `json:"phase"`
	State            string `json:"state,omitempty"`
	Summary          string `json:"summary,omitempty"`
}

const remoteComputerSelect = `SELECT id,digest,plan_json,state,revision,expires_at,summary,authority FROM governance_remote_computer_requests`

func scanRemoteComputer(row pgx.Row) (RemoteComputerRequest, error) {
	var out RemoteComputerRequest
	var authority []byte
	err := row.Scan(&out.RequestID, &out.Digest, &out.PlanJSON, &out.State, &out.Revision, &out.ExpiresAt, &out.Summary, &authority)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.Version = 1
	if err = json.Unmarshal(authority, &out.Authority); err != nil {
		return out, err
	}
	err = json.Unmarshal([]byte(out.PlanJSON), &out.Plan)
	return out, err
}
func (s *Store) RemoteComputerRequest(ctx context.Context, realm, id string) (RemoteComputerRequest, error) {
	if err := s.refreshRemoteComputer(ctx, realm); err != nil {
		return RemoteComputerRequest{}, err
	}
	return scanRemoteComputer(s.pool.QueryRow(ctx, remoteComputerSelect+` WHERE realm=$1 AND id=$2`, realm, id))
}
func (s *Store) ListRemoteComputerRequests(ctx context.Context, realm, node string) ([]RemoteComputerRequest, error) {
	if err := s.refreshRemoteComputer(ctx, realm); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, remoteComputerSelect+` WHERE realm=$1 AND node_id=$2 ORDER BY created_at DESC LIMIT 50`, realm, node)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RemoteComputerRequest{}
	for rows.Next() {
		r, e := scanRemoteComputer(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Store) refreshRemoteComputer(ctx context.Context, realm string) error {
	_, err := s.pool.Exec(ctx, `WITH stale AS (
 UPDATE governance_remote_computer_requests q SET state='unknown',revision=q.revision+1,summary='Device lease or request deadline ended; execution is never replayed',updated_at=now()
 FROM governance_device_connections d,governance_desktop_nodes n
 WHERE q.realm=$1 AND q.realm=d.realm AND q.node_id=d.node_id AND n.realm=q.realm AND n.id=q.node_id AND q.state IN ('pending','running')
 AND (q.expires_at<=clock_timestamp() OR q.connection_id<>d.connection_id OR q.device_revision<>d.revision OR q.owner_user_id<>n.owner_user_id OR n.status<>'ONLINE' OR d.connection_expires<=clock_timestamp() OR d.certificate_expires<=clock_timestamp())
 RETURNING q.id,q.revision,q.state,q.summary)
 INSERT INTO governance_remote_computer_receipts(request_id,revision,phase,state,summary)SELECT id,revision,'lease_lost',state,summary FROM stale`, realm)
	return err
}

// The organizational lock orders role/subject/user/device changes. Project rows
// are locked too: another service must not revoke membership while this CAS commits.
func remoteComputerCurrent(ctx context.Context, tx pgx.Tx, realm string, a RemoteComputerAuthority, owner string) error {
	var subjectRevision int64
	err := tx.QueryRow(ctx, `SELECT b.revision FROM governance_bot_subjects b JOIN governance_bot_grants g
 ON g.realm=b.realm AND g.channel=b.channel AND g.subject=b.subject
 JOIN governance_agent_presets p ON p.realm=g.realm AND p.id=g.agent_id
 WHERE b.realm=$1 AND b.channel=$2 AND b.subject=$3 AND b.status='active' AND b.user_id=$4 AND b.revision=$5
 AND g.capability='computer-use.request' AND g.status='active' AND g.revision=$6 AND g.subject_user_id=b.user_id AND g.subject_revision=b.revision
 AND g.team_id=$7 AND g.project_id=$8 AND g.agent_id=$9 AND g.captain_session_ref=$10 AND g.team_owner_user_id=$11 AND g.team_revision=$12
 AND p.status='active' AND p.project_id=g.project_id AND p.owner_user_id=g.team_owner_user_id AND p.revision=$13 AND g.preset_revision=p.revision FOR SHARE OF b,g,p`, realm, a.Channel, a.Subject, a.Sender, a.BindingRevision, a.GrantRevision, a.TeamID, a.ProjectID, a.AgentID, a.Captain, a.TeamOwner, a.TeamRevision, a.PresetRevision).Scan(&subjectRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	for _, user := range []string{a.Sender, a.Author, a.TeamOwner, owner} {
		var id string
		err = tx.QueryRow(ctx, `SELECT u.id FROM governance_users u JOIN projects p ON p.realm=u.realm AND p.id=$3 AND p.status='active'
   JOIN project_members m ON m.project_id=p.id AND m.user_id=u.id WHERE u.realm=$1 AND u.id=$2 AND u.status='active' FOR SHARE OF u,p,m`, realm, user, a.ProjectID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if err = requireCurrentArtifactRole(ctx, tx, realm, user); err != nil {
			return err
		}
	}
	return nil
}

// Authorization may wait on project and Bot grant rows after the device was
// locked. Read the database clock again after those waits; the transaction's
// start time and a web replica's wall clock cannot extend a device lease.
func remoteComputerClock(ctx context.Context, tx pgx.Tx, d DeviceConnection, expires time.Time) (time.Time, error) {
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return now, err
	}
	if d.Status != "ONLINE" || d.ConnectionID == "" || d.AppliedRevision != d.Revision || d.ConnectionExpires == nil || !d.ConnectionExpires.After(now) || d.CertificateExpires == nil || !d.CertificateExpires.After(now) || !expires.IsZero() && !expires.After(now) {
		return now, ErrConflict
	}
	return now, nil
}

func (s *Store) CreateRemoteComputerRequest(ctx context.Context, realm, node, executionKey string, a RemoteComputerAuthority, session, capability, intent string, ttl time.Duration) (RemoteComputerRequest, error) {
	var out RemoteComputerRequest
	if !validBotRef(executionKey) || !validBotRef(session) || len(session) > 256 || strings.TrimSpace(intent) == "" || len([]rune(intent)) > 4000 || (capability != "computer.observe" && capability != "computer.interact") || ttl < 5*time.Second || ttl > 2*time.Minute {
		return out, ErrBadRequest
	}
	tx, d, err := s.deviceLock(ctx, realm, node)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = remoteComputerClock(ctx, tx, d, time.Time{}); err != nil {
		return out, err
	}
	if err = remoteComputerCurrent(ctx, tx, realm, a, d.Owner); err != nil {
		return out, err
	}
	existing, e := scanRemoteComputer(tx.QueryRow(ctx, remoteComputerSelect+` WHERE realm=$1 AND execution_key=$2`, realm, executionKey))
	if e == nil {
		if existing.Plan.NodeID != node || existing.Plan.SessionRef != session || existing.Plan.Capability != capability || existing.Plan.Intent != intent || existing.Authority != a {
			return out, ErrConflict
		}
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(e, ErrNotFound) {
		return out, e
	}
	// An expired/disconnected attempt has an unknown outcome and is never replayed.
	if _, err = tx.Exec(ctx, `UPDATE governance_remote_computer_requests SET state='unknown',revision=revision+1,updated_at=now() WHERE realm=$1 AND node_id=$2 AND state IN ('pending','running') AND (expires_at<=clock_timestamp() OR connection_id<>$3 OR device_revision<>$4)`, realm, node, d.ConnectionID, d.Revision); err != nil {
		return out, err
	}
	var busy bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_remote_computer_requests WHERE realm=$1 AND node_id=$2 AND state IN ('pending','running'))`, realm, node).Scan(&busy); err != nil {
		return out, err
	}
	if busy {
		return out, ErrConflict
	}
	id, err := deviceRandom()
	if err != nil {
		return out, err
	}
	commandID, err := deviceRandom()
	if err != nil {
		return out, err
	}
	now, err := remoteComputerClock(ctx, tx, d, time.Time{})
	if err != nil {
		return out, err
	}
	expires := now.UTC().Add(ttl)
	plan := RemoteComputerPlan{realm, node, d.Owner, a.ProjectID, session, capability, expires, intent, a.Channel, a.Subject, a.Sender, a.TeamID, a.AgentID}
	raw, err := json.Marshal(plan)
	if err != nil {
		return out, err
	}
	digest := sha256.Sum256(raw)
	out = RemoteComputerRequest{RemoteComputerEnvelope: RemoteComputerEnvelope{1, id, "sha256:" + hex.EncodeToString(digest[:]), string(raw)}, State: "pending", Revision: 1, ExpiresAt: expires, Authority: a, Plan: plan}
	auth, _ := json.Marshal(a)
	body, _ := json.Marshal(out.RemoteComputerEnvelope)
	if _, err = tx.Exec(ctx, `INSERT INTO governance_remote_computer_requests(id,realm,node_id,owner_user_id,connection_id,device_revision,execution_key,authority,plan_json,digest,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)`, id, realm, node, d.Owner, d.ConnectionID, d.Revision, executionKey, auth, out.PlanJSON, out.Digest, expires); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_device_commands(id,realm,node_id,actor_id,revision,connection_id,action,body,expires_at) VALUES($1,$2,$3,$4,$5,$6,'computer_use_request',$7,$8)`, commandID, realm, node, a.Sender, d.Revision, d.ConnectionID, body, expires); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *Store) RemoteComputerLease(ctx context.Context, realm, node, connection, id string, input RemoteComputerLeaseInput) (RemoteComputerRequest, error) {
	var out RemoteComputerRequest
	if input.ExpectedRevision < 1 || len([]rune(input.Summary)) > 1000 {
		return out, ErrBadRequest
	}
	tx, d, err := s.deviceLock(ctx, realm, node)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out, err = scanRemoteComputer(tx.QueryRow(ctx, remoteComputerSelect+` WHERE realm=$1 AND node_id=$2 AND id=$3 FOR UPDATE`, realm, node, id))
	if err != nil {
		return out, err
	}
	var bound bool
	err = tx.QueryRow(ctx, `SELECT connection_id=$4 AND device_revision=$5 AND owner_user_id=$6 FROM governance_remote_computer_requests WHERE realm=$1 AND node_id=$2 AND id=$3`, realm, node, id, connection, d.Revision, d.Owner).Scan(&bound)
	if err != nil {
		return out, err
	}
	if !bound || d.ConnectionID != connection || out.Digest != input.Digest || out.Revision != input.ExpectedRevision {
		return out, ErrConflict
	}
	if _, err = remoteComputerClock(ctx, tx, d, time.Time{}); err != nil {
		return out, err
	}
	terminal := out.State != "pending" && out.State != "running"
	if terminal {
		return out, ErrConflict
	}
	switch input.Phase {
	case "approve", "check":
		if (input.Phase == "approve" && out.State != "pending") || (input.Phase == "check" && out.State != "running") {
			return out, ErrConflict
		}
		if err = remoteComputerCurrent(ctx, tx, realm, out.Authority, d.Owner); err != nil {
			return out, err
		}
		if _, err = remoteComputerClock(ctx, tx, d, out.ExpiresAt); err != nil {
			return out, err
		}
		out.State = "running"
	case "deny":
		if out.State != "pending" {
			return out, ErrConflict
		}
		out.State = "denied"
	case "cancel":
		out.State = "cancelled"
	case "finish":
		if out.State != "running" || !(input.State == "completed" || input.State == "failed" || input.State == "cancelled" || input.State == "unknown") {
			return out, ErrConflict
		}
		out.State = input.State
	default:
		return out, ErrBadRequest
	}
	out.Revision++
	out.Summary = input.Summary
	if _, err = tx.Exec(ctx, `UPDATE governance_remote_computer_requests SET state=$2,revision=$3,summary=$4,updated_at=now() WHERE id=$1`, id, out.State, out.Revision, out.Summary); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_remote_computer_receipts(request_id,revision,phase,state,summary) VALUES($1,$2,$3,$4,$5)`, id, out.Revision, input.Phase, out.State, out.Summary); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *Store) RevokeRemoteComputerRequest(ctx context.Context, realm, node, id, actor string) (RemoteComputerRequest, error) {
	var out RemoteComputerRequest
	tx, d, err := s.deviceLock(ctx, realm, node)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out, err = scanRemoteComputer(tx.QueryRow(ctx, remoteComputerSelect+` WHERE realm=$1 AND node_id=$2 AND id=$3 FOR UPDATE`, realm, node, id))
	if err != nil {
		return out, err
	}
	if actor != d.Owner && actor != out.Authority.Sender {
		return out, ErrForbidden
	}
	if out.State != "pending" && out.State != "running" {
		return out, ErrConflict
	}
	out.State = "cancelled"
	out.Revision++
	if _, err = tx.Exec(ctx, `UPDATE governance_remote_computer_requests SET state='cancelled',revision=$2,updated_at=now() WHERE id=$1`, id, out.Revision); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO governance_remote_computer_receipts(request_id,revision,phase,state)VALUES($1,$2,'revoke','cancelled')`, id, out.Revision); err != nil {
		return out, err
	}
	command, err := deviceRandom()
	if err != nil {
		return out, err
	}
	body, _ := json.Marshal(map[string]any{"version": 1, "request_id": id, "digest": out.Digest})
	if _, err = tx.Exec(ctx, `INSERT INTO governance_device_commands(id,realm,node_id,actor_id,revision,connection_id,action,body,expires_at)VALUES($1,$2,$3,$4,$5,$6,'computer_use_revoke',$7,now()+interval '2 minutes')`, command, realm, node, actor, d.Revision, d.ConnectionID, body); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (r RemoteComputerRequest) ValidateTeam(owner, captain, revision string) error {
	if r.Authority.TeamOwner != owner || r.Authority.Captain != captain || r.Authority.TeamRevision != revision {
		return fmt.Errorf("%w: current team changed", ErrForbidden)
	}
	return nil
}
