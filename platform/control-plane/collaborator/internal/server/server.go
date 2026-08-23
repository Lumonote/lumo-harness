// Package server 暴露协作服务的 WS 与 HTTP 接口（§5.4.7.2）。
//
// 授权：每个入口都过空间级权限（read/edit/comment/publish 独立，§5.4.7.1）；
// realm 由服务端从文档元数据解析，**不接受客户端传参**（防越权）。
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/hub"
	"github.com/lumo-harness/platform/collaborator/internal/ownership"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// Identity 已认证的调用者（由边缘/终端网关注入，服务端不自行签发）。
type Identity struct {
	UserID  string
	Display string
	Realm   domain.RealmID
}

// Authenticator 从请求解析身份；生产实现校验网关签名/JWT。
type Authenticator interface {
	Authenticate(r *http.Request) (Identity, error)
}

// Server 组合 hub、store 与归属环。
type Server struct {
	hub      *hub.Hub
	store    *store.Store
	ring     *ownership.Ring
	auth     Authenticator
	log      *slog.Logger
	upgrader websocket.Upgrader
}

func New(h *hub.Hub, st *store.Store, ring *ownership.Ring, auth Authenticator, log *slog.Logger) *Server {
	return &Server{
		hub:   h,
		store: st,
		ring:  ring,
		auth:  auth,
		log:   log,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			// 跨源校验由边缘网关负责；此处只接受网关转发的连接
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

// Routes 注册 HTTP 路由。
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /docs/{docID}/ws", s.handleWS)
	mux.HandleFunc("GET /docs/{docID}/snapshot", s.handleLatestSnapshot)
	mux.HandleFunc("GET /docs/{docID}/snapshot/{version}", s.handleSnapshotAt)
	mux.HandleFunc("POST /docs/{docID}/publish", s.handlePublish)
	mux.HandleFunc("GET /docs/{docID}/comments", s.handleComments)
	mux.HandleFunc("POST /docs/{docID}/comments", s.handleAddComment)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	docs, subs, draining := s.hub.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      map[bool]string{true: "draining", false: "ok"}[draining],
		"instance":    s.ring.Self(),
		"documents":   docs,
		"subscribers": subs,
	})
}

// wsMessage WS 帧：客户端发 update，服务端回 ack 与广播。
type wsMessage struct {
	Type    string `json:"type"` // "update" | "ack" | "presence" | "error"
	Seq     int64  `json:"seq,omitempty"`
	Actor   string `json:"actor,omitempty"`
	Payload []byte `json:"payload,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	docID := domain.DocumentID(r.PathValue("docID"))
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// 归属校验：非本实例持有则让客户端改连正确实例（终端网关据此路由）
	if !s.ring.IsMine(docID) {
		writeJSON(w, http.StatusMisdirectedRequest, map[string]any{
			"error": "document owned by another instance",
			"owner": s.ring.OwnerOf(docID),
		})
		return
	}

	meta, perms, err := s.resolve(r.Context(), docID, ident)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has(perms, domain.PermRead) {
		writeErr(w, &domain.ErrForbidden{Detail: "无文档读取权限"})
		return
	}
	canEdit := has(perms, domain.PermEdit)

	if _, err := s.hub.Open(r.Context(), meta); err != nil {
		writeErr(w, err)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()

	// 非阻塞发送：慢消费者直接断开，不拖垮广播
	out := make(chan domain.Update, 64)
	unsubscribe, err := s.hub.Subscribe(docID, &hub.Subscriber{
		UserID: ident.UserID,
		Send: func(u domain.Update) error {
			select {
			case out <- u:
				return nil
			default:
				return errors.New("slow consumer")
			}
		},
	})
	if err != nil {
		_ = conn.WriteJSON(wsMessage{Type: "error", Detail: err.Error()})
		return
	}
	defer unsubscribe()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case u := <-out:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteJSON(wsMessage{
					Type: "update", Seq: u.Seq, Actor: u.Actor, Payload: u.Payload,
				}); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	for {
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Type != "update" {
			continue
		}
		if !canEdit {
			_ = conn.WriteJSON(wsMessage{Type: "error", Detail: "无编辑权限"})
			continue
		}
		seq, err := s.hub.Apply(ctx, docID, ident.UserID, msg.Payload)
		if err != nil {
			_ = conn.WriteJSON(wsMessage{Type: "error", Detail: err.Error()})
			continue
		}
		// ack 在 WAL 落盘之后 —— 客户端据此认定"已保存"（RPO 0）
		_ = conn.WriteJSON(wsMessage{Type: "ack", Seq: seq})
	}
}

func (s *Server) handleLatestSnapshot(w http.ResponseWriter, r *http.Request) {
	docID := domain.DocumentID(r.PathValue("docID"))
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, perms, err := s.resolve(r.Context(), docID, ident)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has(perms, domain.PermRead) {
		writeErr(w, &domain.ErrForbidden{Detail: "无文档读取权限"})
		return
	}
	snap, err := s.store.LatestSnapshot(r.Context(), docID)
	if err != nil {
		writeErr(w, err)
		return
	}
	if snap == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "尚无发布版本"})
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleSnapshotAt(w http.ResponseWriter, r *http.Request) {
	docID := domain.DocumentID(r.PathValue("docID"))
	var version int
	if _, err := fmt.Sscanf(r.PathValue("version"), "%d", &version); err != nil {
		http.Error(w, "bad version", http.StatusBadRequest)
		return
	}
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, perms, err := s.resolve(r.Context(), docID, ident)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has(perms, domain.PermRead) {
		writeErr(w, &domain.ErrForbidden{Detail: "无文档读取权限"})
		return
	}
	snap, err := s.store.SnapshotAt(r.Context(), docID, version)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// handlePublish 发布：快照 + outbox 同事务（§5.4.3 的一致性入口）。
//
// **agent 无 publish 权限**（铁律 17）：授权表不给 agent 主体 publish，
// 此处只做统一校验，不为 agent 开后门。
func (s *Server) handlePublish(w http.ResponseWriter, r *http.Request) {
	docID := domain.DocumentID(r.PathValue("docID"))
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	meta, perms, err := s.resolve(r.Context(), docID, ident)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has(perms, domain.PermPublish) {
		writeErr(w, &domain.ErrForbidden{Detail: "无发布权限"})
		return
	}

	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	version, err := s.store.Publish(r.Context(), meta, ident.UserID, body.Content)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.log.Info("发布快照", "doc", docID, "version", version, "publisher", ident.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"docId": docID, "version": version})
}

func (s *Server) handleComments(w http.ResponseWriter, r *http.Request) {
	docID := domain.DocumentID(r.PathValue("docID"))
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, perms, err := s.resolve(r.Context(), docID, ident)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has(perms, domain.PermRead) {
		writeErr(w, &domain.ErrForbidden{Detail: "无文档读取权限"})
		return
	}
	list, err := s.store.Comments(r.Context(), docID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAddComment(w http.ResponseWriter, r *http.Request) {
	docID := domain.DocumentID(r.PathValue("docID"))
	ident, err := s.auth.Authenticate(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, perms, err := s.resolve(r.Context(), docID, ident)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has(perms, domain.PermComment) {
		writeErr(w, &domain.ErrForbidden{Detail: "无评论权限"})
		return
	}

	var body struct {
		ID     string `json:"id"`
		Anchor string `json:"anchor"`
		Body   string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	c := domain.Comment{
		ID: body.ID, DocID: docID, Anchor: body.Anchor,
		Author: ident.UserID, Body: body.Body,
	}
	if err := s.store.AddComment(r.Context(), c); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

// resolve 取文档元数据与调用者在其空间上的权限。
func (s *Server) resolve(ctx context.Context, id domain.DocumentID, ident Identity) (domain.Document, []domain.Permission, error) {
	// 文档元数据由服务端解析：realm/space 不接受客户端传参（防越权）
	meta := domain.Document{ID: id, Realm: ident.Realm}
	snap, err := s.store.LatestSnapshot(ctx, id)
	if err != nil {
		return meta, nil, err
	}
	if snap != nil {
		meta.PublishedVersion = snap.Version
	}
	perms, err := s.store.Permissions(ctx, meta.Space, ident.UserID)
	if err != nil {
		return meta, nil, err
	}
	return meta, perms, nil
}

func has(perms []domain.Permission, want domain.Permission) bool {
	for _, p := range perms {
		if p == want {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var forbidden *domain.ErrForbidden
	var capacity *domain.ErrCapacity
	switch {
	case errors.As(err, &forbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.As(err, &capacity):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}
