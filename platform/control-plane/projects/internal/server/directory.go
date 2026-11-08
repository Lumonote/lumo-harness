package server

import (
	"net/http"
	"strconv"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

func (s *Server) directory(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	values := r.URL.Query()
	q := domain.ProjectDirectoryQuery{Query: values.Get("q"), Status: values.Get("status"), Role: values.Get("role"), Sort: values.Get("sort"), Limit: 20}
	for key, target := range map[string]*int{"limit": &q.Limit, "offset": &q.Offset} {
		if values.Has(key) {
			value, err := strconv.Atoi(values.Get(key))
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": key + " must be an integer"})
				return
			}
			*target = value
		}
	}
	q, err := q.Normalize()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.store.ProjectDirectory(r.Context(), c.realm, c.user, q)
	if err != nil {
		s.log.Error("读取项目目录失败", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}
