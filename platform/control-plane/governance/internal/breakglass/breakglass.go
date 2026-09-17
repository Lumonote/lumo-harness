// Package breakglass contains the policy-neutral emergency access model.
// Role names, retention and key hierarchy are deliberately supplied by the
// caller; this package enforces workflow invariants and produces an audit log.
package breakglass

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrNeedsSecondApprover = errors.New("break-glass requires a second approver")
	ErrExpired             = errors.New("break-glass request expired")
	ErrRevoked             = errors.New("break-glass request revoked")
)

type Status string

const (
	Pending Status = "pending"
	Active  Status = "active"
	Expired Status = "expired"
	Revoked Status = "revoked"
)

type Request struct {
	ID, TenantID, Subject, Reason string
	RequestedBy                   string
	Approvers                     []string
	ExpiresAt                     time.Time
	Status                        Status
	CreatedAt                     time.Time
}

type AuditEvent struct {
	RequestID, Action, Actor, Detail string
	At                               time.Time
}

type Store struct {
	mu       sync.Mutex
	requests map[string]Request
	audit    []AuditEvent
}

func NewStore() *Store { return &Store{requests: make(map[string]Request)} }

func (s *Store) RequestAccess(id, tenant, subject, reason, actor string, expiresAt time.Time) (Request, error) {
	if id == "" || tenant == "" || subject == "" || reason == "" || actor == "" || !expiresAt.After(time.Now()) {
		return Request{}, errors.New("invalid break-glass request")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.requests[id]; ok {
		return Request{}, fmt.Errorf("request %s already exists", id)
	}
	r := Request{ID: id, TenantID: tenant, Subject: subject, Reason: reason, RequestedBy: actor, ExpiresAt: expiresAt, Status: Pending, CreatedAt: time.Now()}
	s.requests[id] = r
	s.record(id, "requested", actor, reason)
	return r, nil
}

func (s *Store) Approve(id, actor string) (Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[id]
	if !ok {
		return Request{}, errors.New("break-glass request not found")
	}
	if !r.ExpiresAt.After(time.Now()) {
		r.Status = Expired
		s.requests[id] = r
		return r, ErrExpired
	}
	if actor == "" || actor == r.RequestedBy {
		return r, ErrNeedsSecondApprover
	}
	for _, a := range r.Approvers {
		if a == actor {
			return r, errors.New("approver already recorded")
		}
	}
	r.Approvers = append(r.Approvers, actor)
	if len(r.Approvers) < 2 {
		s.requests[id] = r
		s.record(id, "approved", actor, "awaiting second approver")
		return r, ErrNeedsSecondApprover
	}
	r.Status = Active
	s.requests[id] = r
	s.record(id, "activated", actor, "dual approval complete")
	return r, nil
}

func (s *Store) Revoke(id, actor, detail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[id]
	if !ok {
		return errors.New("break-glass request not found")
	}
	r.Status = Revoked
	s.requests[id] = r
	s.record(id, "revoked", actor, detail)
	return nil
}
func (s *Store) Get(id string) (Request, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[id]
	return r, ok
}
func (s *Store) Audit(id string) []AuditEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []AuditEvent{}
	for _, e := range s.audit {
		if e.RequestID == id {
			out = append(out, e)
		}
	}
	return out
}
func (s *Store) record(id, action, actor, detail string) {
	s.audit = append(s.audit, AuditEvent{RequestID: id, Action: action, Actor: actor, Detail: detail, At: time.Now()})
}
