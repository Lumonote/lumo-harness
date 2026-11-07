package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func (s *Server) storageQuota(w http.ResponseWriter, r *http.Request) {
	if !s.requireCluster(w) {
		return
	}
	c, ok := s.caller(w, r)
	if !ok || !requireRealmAdmin(w, c) {
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, 400, "bad_request", "invalid quota query")
		return
	}
	for key, values := range query {
		if key != "project_id" || len(values) != 1 {
			writeError(w, 400, "bad_request", "only one project_id is allowed")
			return
		}
	}
	project := query.Get("project_id")
	if strings.TrimSpace(project) != project || len(project) > 256 {
		writeError(w, 400, "bad_request", "invalid project_id")
		return
	}
	var expected *int64
	var limit *int64
	if r.Method == http.MethodPut {
		var req struct {
			ExpectedRevision *int64          `json:"expected_revision"`
			LimitBytes       json.RawMessage `json:"limit_bytes"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			writeError(w, 400, "bad_request", "invalid quota request")
			return
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			writeError(w, 400, "bad_request", "exactly one quota request required")
			return
		}
		if req.ExpectedRevision == nil || len(req.LimitBytes) == 0 || json.Unmarshal(req.LimitBytes, &limit) != nil {
			writeError(w, 400, "bad_request", "expected_revision and limit_bytes (integer or null) required")
			return
		}
		expected = req.ExpectedRevision
		// The management client transports byte limits as JSON numbers. Reject
		// values that cannot survive that round trip without losing precision.
		const maxSafeInteger int64 = 1<<53 - 1
		if *expected > maxSafeInteger || (limit != nil && *limit > maxSafeInteger) {
			writeError(w, 400, "bad_request", "quota values exceed the exact integer range")
			return
		}
	}
	out, err := s.store.StorageQuota(r.Context(), c.realm, project, c.userID, expected, limit)
	if err != nil {
		s.respondStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"quota": out, "accounting": "retained-logical-reference-bytes", "coverage": []string{"session-attachment", "run-file", "task-artifact", "knowledge-file"}, "excluded": []string{"session-log", "spill", "backup", "unregistered-legacy-content"}, "physical_gc_authorized": false})
}
