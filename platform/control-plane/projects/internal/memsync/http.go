package memsync

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
)

// Handler 路由：
//
//	GET  /v1/memory-sync/changes?workspace=<sha256hex>&since=<seq>&limit=<n>
//	POST /v1/memory-sync/push  {"workspace","device","changes":[Change...]}
//
// 身份只认 X-Lumo-User / X-Lumo-Realm（网关注入），缺失 401；不接受 body 自报 realm。
type Handler struct {
	B   Backend
	Log *slog.Logger
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/memory-sync/changes", h.changes)
	mux.HandleFunc("POST /v1/memory-sync/push", h.push)
}

func ident(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	u, realm := r.Header.Get("X-Lumo-User"), r.Header.Get("X-Lumo-Realm")
	if u == "" || realm == "" {
		fail(w, http.StatusUnauthorized, "missing identity headers")
		return "", "", false
	}
	return realm, u, true
}

func fail(w http.ResponseWriter, code int, msg string) { write(w, code, map[string]string{"error": msg}) }

func write(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *Handler) changes(w http.ResponseWriter, r *http.Request) {
	realm, user, ok := ident(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	ws := q.Get("workspace")
	since, err := strconv.ParseInt(q.Get("since"), 10, 64)
	if q.Get("since") == "" {
		since, err = 0, nil
	}
	limit := MaxPull
	if l := q.Get("limit"); l != "" {
		n, e := strconv.Atoi(l)
		if e != nil || n < 1 {
			err = e
			if err == nil {
				err = ErrInvalid
			}
		} else if n < limit {
			limit = n
		}
	}
	if err != nil || since < 0 || !ValidWorkspace(ws) {
		fail(w, http.StatusBadRequest, "invalid query")
		return
	}
	items, cursor, err := h.B.Pull(r.Context(), Scope{realm, user, ws}, since, limit)
	if err != nil {
		h.Log.Error("memory sync pull", "err", err)
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	write(w, http.StatusOK, map[string]any{"items": items, "cursor": cursor, "more": len(items) == limit})
}

type pushBody struct {
	Workspace string   `json:"workspace"`
	Device    string   `json:"device"`
	Changes   []Change `json:"changes"`
}

func (h *Handler) push(w http.ResponseWriter, r *http.Request) {
	realm, user, ok := ident(w, r)
	if !ok {
		return
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	dec.DisallowUnknownFields()
	var b pushBody
	if err := dec.Decode(&b); err != nil || dec.Decode(new(any)) != io.EOF {
		fail(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !ValidWorkspace(b.Workspace) || !ValidDevice(b.Device) || len(b.Changes) == 0 || len(b.Changes) > MaxBatch {
		fail(w, http.StatusBadRequest, "invalid push")
		return
	}
	seen := map[string]bool{}
	for _, c := range b.Changes {
		if c.Validate() != nil || seen[c.ID] {
			fail(w, http.StatusBadRequest, "invalid change")
			return
		}
		seen[c.ID] = true
	}
	res, err := h.B.Push(r.Context(), Scope{realm, user, b.Workspace}, b.Device, b.Changes)
	if err != nil {
		h.Log.Error("memory sync push", "err", err)
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	write(w, http.StatusOK, map[string]any{"results": res})
}
