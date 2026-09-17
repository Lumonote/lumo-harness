package server

import (
	"errors"
	"net/http"

	"github.com/lumo-harness/platform/flows/internal/store"
)

// listCronCursors 项目内的 cron 调度巡检面。
//
// 存在的理由：project_automations.trigger_spec 在 projects 侧是不透明字符串，
// flows 只在自己的调度循环里解析它，写错了不会被写入路径拦下。如果这里不暴露，
// 用户看到的只有「自动化不触发」，没有任何线索——stalled 计数与 last_error 就是
// 那条线索。
func (s *Server) listCronCursors(w http.ResponseWriter, r *http.Request) {
	c, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	pid := r.PathValue("pid")
	// viewer 也可看：这是只读巡检面，不含流程内容。
	if _, err := s.store.ProjectRole(r.Context(), pid, c.realm, c.user); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, `{"error":"project not found"}`, http.StatusNotFound)
			return
		}
		s.log.Error("查项目成员失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	cursors, err := s.store.ListCronCursors(r.Context(), c.realm, pid)
	if err != nil {
		s.log.Error("列 cron 游标失败", "err", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	stalled := 0
	for _, cursor := range cursors {
		if cursor.LastError != "" {
			stalled++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"cursors": cursors, "stalled": stalled})
}
