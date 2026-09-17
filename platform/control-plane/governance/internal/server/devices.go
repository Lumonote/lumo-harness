package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/lumo-harness/platform/governance/internal/device"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func (s *Server) deviceCaller(w http.ResponseWriter, r *http.Request) (caller, store.DeviceConnection, bool) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.requireCluster(w) {
		return caller{}, store.DeviceConnection{}, false
	}
	c, ok := s.caller(w, r)
	if !ok {
		return c, store.DeviceConnection{}, false
	}
	if s.cfg.DeviceGateway == nil {
		writeError(w, http.StatusServiceUnavailable, "device_gateway_unavailable", "设备接入网关未配置")
		return c, store.DeviceConnection{}, false
	}
	d, err := s.store.Device(r.Context(), c.realm, r.PathValue("nodeID"))
	if err != nil {
		s.respondStoreError(w, err)
		return c, d, false
	}
	if c.userID != d.Owner && !isRealmAdmin(c) {
		s.respondStoreError(w, store.ErrForbidden)
		return c, d, false
	}
	return c, d, true
}

func (s *Server) deviceStatus(w http.ResponseWriter, r *http.Request) {
	c, d, ok := s.deviceCaller(w, r)
	if !ok {
		return
	}
	connected := d.Status != "REVOKED" && d.ConnectionID != "" && d.ConnectionExpires != nil && d.ConnectionExpires.After(time.Now()) && d.CertificateExpires != nil && d.CertificateExpires.After(time.Now())
	if !connected && d.Status == "ONLINE" {
		d.Status = "OFFLINE"
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": d, "gateway_url": s.cfg.DeviceGateway.PublicURL(), "process_runtime": s.cfg.DeviceGateway.ProcessRuntimeEnabled(), "connected": connected,
		"permissions": map[string]bool{"manage_policy": isRealmAdmin(c), "enroll": d.Status == "PENDING_ACTIVATION" && d.Revision > 0, "command": d.Status != "REVOKED", "start": c.userID == d.Owner && s.cfg.DeviceGateway.ProcessRuntimeEnabled()}})
}

func (s *Server) devicePolicy(w http.ResponseWriter, r *http.Request) {
	c, d, ok := s.deviceCaller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	var input device.PolicyRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	policy, err := s.cfg.DeviceGateway.PreparePolicy(r.Context(), input)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	out, err := s.store.SetDevicePolicy(r.Context(), d.Realm, d.NodeID, c.userID, input.Revision, policy)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) deviceEnrollment(w http.ResponseWriter, r *http.Request) {
	c, d, ok := s.deviceCaller(w, r)
	if !ok {
		return
	}
	code, err := s.store.IssueDeviceEnrollment(r.Context(), d.Realm, d.NodeID, c.userID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"code": code, "expires_in": 300, "realm": d.Realm, "node_id": d.NodeID, "gateway_url": s.cfg.DeviceGateway.PublicURL()})
}

func (s *Server) deviceCommands(w http.ResponseWriter, r *http.Request) {
	_, d, ok := s.deviceCaller(w, r)
	if !ok {
		return
	}
	commands, err := s.store.DeviceCommands(r.Context(), d.Realm, d.NodeID)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": commands})
}

func (s *Server) deviceCommand(w http.ResponseWriter, r *http.Request) {
	c, d, ok := s.deviceCaller(w, r)
	if !ok {
		return
	}
	var input struct {
		Revision *int64 `json:"revision"`
		Action   string `json:"action"`
		Name     string `json:"name"`
		Version  string `json:"version"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Revision == nil {
		s.respondStoreError(w, store.ErrBadRequest)
		return
	}
	if *input.Revision != d.Revision {
		s.respondStoreError(w, store.ErrConflict)
		return
	}
	if input.Action != "reconcile" && input.Action != "start" && input.Action != "stop" {
		s.respondStoreError(w, store.ErrBadRequest)
		return
	}
	if input.Action == "start" {
		if err := s.cfg.DeviceGateway.AuthorizeRuntime(r.Context(), d, c.userID, input.Name, input.Version); err != nil {
			s.respondStoreError(w, err)
			return
		}
	}
	if input.Action != "reconcile" {
		found := false
		for _, item := range d.Policy.Artifacts {
			if item.Name == input.Name && item.Version == input.Version {
				found = true
			}
		}
		if !found {
			s.respondStoreError(w, store.ErrBadRequest)
			return
		}
	}
	body, _ := json.Marshal(map[string]string{"name": input.Name, "version": input.Version})
	command, err := s.store.QueueDeviceCommand(r.Context(), d.Realm, d.NodeID, c.userID, input.Action, *input.Revision, body)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, command)
}
