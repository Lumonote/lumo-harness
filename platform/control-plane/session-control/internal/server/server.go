// Package server 把裁决器、存储读面与队列现场装配成 HTTP 服务（§8.4.3 的 Session Console 后端）。
//
// # 三条面，刻意分开
//
//   - **写面** `POST /v1/sessions/{ref}/control`：一条控制指令。身份三件套必填，
//     结论按 control.Outcome 映射成不同的状态码（见 statusFor）。
//   - **读面** `GET /v1/sessions/{ref}/control` 与 `.../control/events`：控制台要的
//     「当前状态 + 每个按钮此刻可不可点 + 时间线」。读面**不写任何东西**。
//   - **动作放行面**（§24.5）`POST /v1/sessions/{ref}/action-reviews` 追加一条放行记录、
//     `GET .../action-reviews?realm=…` 读回来。它与控制指令面**并存而不是合并**：
//     控制指令是会话级的（一条指令一次），放行记录是动作级的（一次工具调用一行），
//     两者的增长速率差着数量级，混进一条时间线会让低频的那部分被淹没。
//
// 读面的可用性必须与写面同源：`available` 列表是 state.AvailableCommands(...) 的投影，
// 而写入路径的判据是同一个 state.Apply。两个面若各算一份，「按钮可点」与「提交后被拒」
// 就会漂移，而这是最难查的一类不一致。
//
// # 读面不伪造未知会话的状态
//
// 未登记的会话返回 `registered=false`、`state=null`，并单独给出 `base_state`
// （首条控制指令将以它为起点）。**不**把 state 直接填成 "running"：本服务没有会话
// 注册表，那个 running 是编出来的，而控制台会把它显示成一个我们从未观测过的事实。
// 这与终端网关「未接线事件源时返回 503 而不伪造空历史」是同一条规矩。
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/session-control/internal/control"
	"github.com/lumo-harness/platform/session-control/internal/queue"
	"github.com/lumo-harness/platform/session-control/internal/release"
	"github.com/lumo-harness/platform/session-control/internal/state"
	"github.com/lumo-harness/platform/session-control/internal/store"
)

// 时间线的分页夹紧值。上限存在的理由不是「防大查询」而是防**无界**：不夹紧时
// 一个 `limit=10000000` 就能让控制面的内存跟着会话历史走。
const (
	defaultTimelineLimit = 100
	maxTimelineLimit     = 500
)

// 动作放行读面的分页夹紧值。
//
// 与时间线**分开写**，虽然当前数字相同：两条读面的增长速率根本不同——时间线一条对应
// 一次控制指令（人点的），放行面一条对应一次工具调用（agent 自己跑的）。将来要收紧
// 上限时，需要改的是放行面这一对常量，而不是顺手把时间线也改了。
const (
	defaultActionReviewLimit = 100
	maxActionReviewLimit     = 500
)

// Options 装配服务。
type Options struct {
	// Execute 是裁决器（实现见 internal/control）。用函数而不是接口：写面只用到
	// 一个方法，而接口会让测试里也要造一个类型出来。
	Execute func(ctx context.Context, req control.Request) (control.Result, error)
	// Store 提供状态读面与时间线；必须非 nil。
	Store StateReader
	// Reviews 提供动作放行记录的读写面（§24.5）；nil 时 /action-reviews 两条面
	// 都诚实回 503，而不是接受写入后丢弃。
	Reviews ReviewStore
	// Queue 提供本实例的队列现场；nil 时读面里的 queue 为 null（诚实缺省）。
	Queue QueueView
	// Logger 用于服务端错误日志；nil 回落 slog.Default。
	Logger *slog.Logger
}

// StateReader 是读面依赖（消费方定义接口，实现见 internal/store）。
type StateReader interface {
	Load(ctx context.Context, sessionRef string) (store.Row, error)
	Timeline(ctx context.Context, sessionRef string, afterID int64, limit int) ([]store.AuditRow, error)
}

// ReviewStore 是动作放行记录面依赖（消费方定义接口，实现见 internal/store）。
//
// 与 StateReader 分开而不是合并成一个「大存储」接口：这两组方法服务的调用方不同
// （控制台 / 节点上报），合并之后每一个只为读控制台而写的测试替身都得实现写入方法。
// `Record` 的第二个返回值是「这次是否真的写入了」（重试识别），见 store 的注释。
type ReviewStore interface {
	RecordActionReview(ctx context.Context, in release.Record) (store.ActionReview, bool, error)
	ActionReviews(ctx context.Context, realm, sessionRef string, limit int) ([]store.ActionReview, error)
}

// QueueView 是队列现场读面。
type QueueView interface {
	Snapshot(sessionRef string) queue.Snapshot
}

// Server 暴露路由，无内部状态。
type Server struct {
	opts Options
	log  *slog.Logger
}

// New 构造服务。
func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Server{opts: opts, log: opts.Logger}
}

// Routes 注册路由。
func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/metrics", observability.Handler)
	mux.HandleFunc("/v1/sessions/", s.handleSession)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
	rest = strings.Trim(rest, "/")
	if rest == "" {
		writeError(w, http.StatusNotFound, "not_found", "缺少 sessionRef")
		return
	}
	if tail, ok := strings.CutSuffix(rest, "/control/events"); ok {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "时间线是只读面")
			return
		}
		s.handleTimeline(w, r, unescape(tail))
		return
	}
	if tail, ok := strings.CutSuffix(rest, "/control"); ok {
		sessionRef := unescape(tail)
		switch r.Method {
		case http.MethodPost:
			s.handleControl(w, r, sessionRef)
		case http.MethodGet:
			s.handleConsole(w, r, sessionRef)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "控制面只接受 GET / POST")
		}
		return
	}
	if tail, ok := strings.CutSuffix(rest, "/action-reviews"); ok {
		sessionRef := unescape(tail)
		switch r.Method {
		case http.MethodPost:
			s.handleRecordActionReview(w, r, sessionRef)
		case http.MethodGet:
			s.handleActionReviews(w, r, sessionRef)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "动作放行面只接受 GET / POST")
		}
		return
	}
	writeError(w, http.StatusNotFound, "not_found",
		"未知路径；控制面是 /v1/sessions/{sessionRef}/control（GET 读面 / POST 写面）、"+
			".../control/events（时间线）与 .../action-reviews（动作放行记录，GET 读 / POST 追加）")
}

// actionReviewRequest 是放行记录的请求体。
//
// 没有 `session_ref` 字段：会话从**路径**取（与写面一致）。两处都能给就会出现两个来源，
// 而「哪个赢」是一个没人会记得的约定——路径赢则请求体里那个被静默忽略，体赢则路径成了
// 装饰。少一个字段就少一种不一致。
type actionReviewRequest struct {
	// ID 由调用方给出（它是重试幂等的依据，见 internal/release 的 Record 注释）。
	ID     string `json:"id"`
	Realm  string `json:"realm"`
	RunID  string `json:"run_id"`
	Action string `json:"action"`
	Band   string `json:"band"`
	// Decider 与 Band 都是闭集，非法值在这里就被拒（400），不会到存储层。
	Decider      string `json:"decider"`
	Reason       string `json:"reason"`
	DeniedStreak int    `json:"denied_streak"`
	DeniedTotal  int    `json:"denied_total"`
}

// handleRecordActionReview 追加一条动作放行记录（§24.5：分类器代行 `approve` 的行使记录）。
//
// 为什么不用 200 一律回成功而是 201 / 200 分开：同 id 同内容的重试**没有**新建行，
// 审计对账需要这个区别——否则「写了两条」与「重试了一次」在响应上长得一样。
func (s *Server) handleRecordActionReview(w http.ResponseWriter, r *http.Request, sessionRef string) {
	if s.opts.Reviews == nil {
		// 没装配写面就诚实回 503：接受写入再丢掉，会让调用方以为「放行记录已审计」。
		writeError(w, http.StatusServiceUnavailable, "no_store", "控制面未装配动作放行记录的写面")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "body_unreadable", err.Error())
		return
	}
	var in actionReviewRequest
	if err := json.Unmarshal(body, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}

	// 闭集解析在**入口**做：先把裸字符串变成闭集类型，再交给存储层。非法值到这里就结束，
	// 不会在库里留下一行「档位是 ALLOW」的记录——本表 append-only，写错擦不掉。
	band, err := release.ParseBand(in.Band)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_band", err.Error())
		return
	}
	decider, err := release.ParseDecider(in.Decider)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_decider", err.Error())
		return
	}
	rec := release.Record{
		ID: in.ID, Realm: in.Realm, SessionRef: sessionRef, RunID: in.RunID,
		Action: in.Action, Band: band, Decider: decider, Reason: in.Reason,
		DeniedStreak: in.DeniedStreak, DeniedTotal: in.DeniedTotal,
	}
	if err := rec.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	stored, created, err := s.opts.Reviews.RecordActionReview(r.Context(), rec)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrReviewIDConflict):
		// 同 id 不同内容：两个判定抢一个身份。409 而不是 400 —— 请求本身是完整的，
		// 冲突在于**服务端已有的那一行**，调用方需要换一个 id 或先读回既有记录。
		writeError(w, http.StatusConflict, "review_id_conflict", err.Error())
		return
	case errors.Is(err, release.ErrInvalid):
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	default:
		s.log.Error("写入动作放行记录失败", "session", sessionRef, "id", rec.ID, "err", err)
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", err.Error())
		return
	}

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"created": created, "review": stored})
}

// handleActionReviews 读某会话的动作放行记录（最新在前）。
//
// `realm` 是**必填的查询参数**，缺了直接 400：本表跨租户共表，realm 是唯一的隔离边界，
// 「没给 realm」不能被解释成「不过滤」——那正是跨租户读。给了 realm 但该会话属于别的
// realm 时返回**空列表**（见 store 的注释：报 403/404 会泄露「别的 realm 里存在这个会话」）。
func (s *Server) handleActionReviews(w http.ResponseWriter, r *http.Request, sessionRef string) {
	if s.opts.Reviews == nil {
		writeError(w, http.StatusServiceUnavailable, "no_store", "控制面未装配动作放行记录的读面")
		return
	}
	realm := strings.TrimSpace(r.URL.Query().Get("realm"))
	if realm == "" {
		writeError(w, http.StatusBadRequest, "invalid_realm",
			"realm 必填：它是本表的租户边界，缺省不过滤等于跨 realm 读")
		return
	}
	limit := defaultActionReviewLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit 必须是正整数")
			return
		}
		limit = min(n, maxActionReviewLimit)
	}

	reviews, err := s.opts.Reviews.ActionReviews(r.Context(), realm, sessionRef, limit)
	if err != nil {
		s.log.Error("读动作放行记录失败", "session", sessionRef, "realm", realm, "err", err)
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_ref": sessionRef,
		"realm":       realm,
		"reviews":     reviews,
		"limit":       limit,
	})
}

// controlRequest 是写面的请求体。
//
// realm / role / actor 是**必填**且必须由调用方声明：本服务只认控制面共享令牌
// （observability.RequireControlPlaneToken），没有把身份注入请求的能力，因此身份是
// 「调用方主张 + OPA 判定」而不是「强认证」。这一点写在响应与文档里，不假装更强。
type controlRequest struct {
	Command       string `json:"command"`
	Realm         string `json:"realm"`
	Role          string `json:"role"`
	Actor         string `json:"actor"`
	Reason        string `json:"reason"`
	CorrelationID string `json:"correlation_id"`
}

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request, sessionRef string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "body_unreadable", err.Error())
		return
	}
	var in controlRequest
	if err := json.Unmarshal(body, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if s.opts.Execute == nil {
		// 裁决器没装配 = 服务没接线，不能回「已生效」。
		writeError(w, http.StatusServiceUnavailable, "no_executor", "控制面未装配裁决器")
		return
	}

	res, err := s.opts.Execute(r.Context(), control.Request{
		SessionRef: sessionRef, Command: state.Command(in.Command),
		Realm: in.Realm, Role: in.Role, Actor: in.Actor,
		Reason: in.Reason, CorrelationID: in.CorrelationID,
	})
	if err != nil {
		if errors.Is(err, control.ErrInvalidRequest) {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		// 基础设施失败：**没有结论**。503 而不是 500 —— 它的处置是「稍后重试」，
		// 而且要让调用方知道这不是一条被拒的指令。
		s.log.Error("控制指令执行失败", "session", sessionRef, "err", err)
		writeError(w, http.StatusServiceUnavailable, "control_unavailable", err.Error())
		return
	}

	status, retryAfter := statusFor(res.Outcome)
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	writeJSON(w, status, res)
}

// statusFor 把裁决结论映射成 HTTP 状态码。
//
// 这张表是本服务对外最重要的语义面：调用方**只**靠它决定「重试 / 求权限 / 读状态 /
// 改代码」。合成一个 403 会让四种完全不同的处置变成同一种。
func statusFor(outcome control.Outcome) (status int, retryAfterSeconds int) {
	switch outcome {
	case control.OutcomeApplied, control.OutcomeNoOp:
		return http.StatusOK, 0
	case control.OutcomePolicyDenied, control.OutcomeRealmMismatch:
		// 永久性：要找授权（或弄清楚该会话归属哪个 realm），重试没有意义。
		return http.StatusForbidden, 0
	case control.OutcomeStateRejected:
		return http.StatusConflict, 0
	case control.OutcomeConflict:
		// 前提过期：调用方应重读状态再决定，属于「可重试但必须先读」。
		return http.StatusConflict, 0
	case control.OutcomePolicyUnavailable:
		// 临时性：去看 OPA。给 Retry-After 是为了让调用方**不要**立刻打回一堵墙。
		return http.StatusServiceUnavailable, 5
	case control.OutcomeBusy:
		return http.StatusServiceUnavailable, 1
	}
	// 未知结论按「服务器内部异常」返回，而不是猜一个语义。这样新加一种 Outcome 而
	// 忘了在这张表里登记时，症状是 500 而不是一个错误的 200。
	return http.StatusInternalServerError, 0
}

// consoleView 是读面的响应（§8.4.3 的状态 + 权限可见的控制操作）。
type consoleView struct {
	SessionRef string `json:"session_ref"`
	// Registered 为 false 表示控制面**没有**这个会话的状态行（state 为 null）。
	Registered bool `json:"registered"`
	// State 是已裁决的当前状态；未登记时为 null（不是 "running"）。
	State *state.State `json:"state"`
	// BaseState 是「下一条控制指令的起点」：已登记时等于 state，未登记时是首次
	// 指令的初始化状态。可用性就是按它算的——控制台因此不必自己知道默认值。
	BaseState   state.State  `json:"base_state"`
	Revision    int64        `json:"revision"`
	UpdatedAt   *time.Time   `json:"updated_at,omitempty"`
	LastControl *lastControl `json:"last_control,omitempty"`
	// Available 是每个指令此刻是否可点（**复用写入路径的同一份判据**）。
	Available []state.Available `json:"available"`
	Queue     *queue.Snapshot   `json:"queue"`
}

type lastControl struct {
	Command       string     `json:"command,omitempty"`
	Actor         string     `json:"actor,omitempty"`
	Reason        string     `json:"reason,omitempty"`
	CorrelationID string     `json:"correlation_id,omitempty"`
	UpdatedAt     *time.Time `json:"updated_at,omitempty"`
}

func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request, sessionRef string) {
	if s.opts.Store == nil {
		writeError(w, http.StatusServiceUnavailable, "no_store", "控制面未装配存储读面")
		return
	}
	view := consoleView{SessionRef: sessionRef, BaseState: control.InitialState}

	row, err := s.opts.Store.Load(r.Context(), sessionRef)
	switch {
	case err == nil:
		st := row.State
		at := row.UpdatedAt
		view.Registered = true
		view.State = &st
		view.BaseState = row.State
		view.Revision = row.Revision
		view.UpdatedAt = &at
		view.LastControl = &lastControl{
			Command: string(row.LastCommand), Actor: row.LastActor,
			Reason: row.LastReason, CorrelationID: row.CorrelationID, UpdatedAt: &at,
		}
	case errors.Is(err, store.ErrNotFound):
		// 未登记是正常查询结果，不是错误。
	default:
		s.log.Error("读控制台视图失败", "session", sessionRef, "err", err)
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", err.Error())
		return
	}

	view.Available = state.AvailableCommands(view.BaseState)
	if s.opts.Queue != nil {
		snapshot := s.opts.Queue.Snapshot(sessionRef)
		view.Queue = &snapshot
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request, sessionRef string) {
	if s.opts.Store == nil {
		writeError(w, http.StatusServiceUnavailable, "no_store", "控制面未装配存储读面")
		return
	}
	after, err := parseNonNegative(r.URL.Query().Get("after"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_cursor", "after 必须是非负整数")
		return
	}
	limit := defaultTimelineLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit 必须是正整数")
			return
		}
		limit = min(n, maxTimelineLimit)
	}
	events, err := s.opts.Store.Timeline(r.Context(), sessionRef, after, limit)
	if err != nil {
		s.log.Error("读控制时间线失败", "session", sessionRef, "err", err)
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", err.Error())
		return
	}
	// next_after 只在读满一页时给出：它是「继续翻」的游标，读不满说明已经到底。
	var nextAfter int64
	if len(events) > 0 {
		nextAfter = events[len(events)-1].ID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_ref": sessionRef,
		"events":      events,
		"next_after":  nextAfter,
		"limit":       limit,
	})
}

func parseNonNegative(raw string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, errors.New("必须是非负整数")
	}
	return n, nil
}

func unescape(segment string) string {
	if decoded, err := url.PathUnescape(segment); err == nil {
		return decoded
	}
	return segment
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
