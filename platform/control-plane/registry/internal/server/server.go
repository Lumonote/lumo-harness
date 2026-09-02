// Package server 是注册表的 HTTP 面。
//
// 一处刻意的接口设计：发布信封携带 **base64 的原始 manifest 字节**，
// 而不是把 manifest 作为 JSON 子对象嵌进来。后者会迫使服务端重新序列化
// 才能拿到被签名覆盖的字节，而重序列化正是本设计明令禁止的失配来源
// （发布端认为签的是 A、安装端认为验的是 B）。base64 是双射，解出来逐字节相同。
package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/resolve"
	"github.com/lumo-harness/platform/registry/internal/store"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

// advisory 挂在所有查询响应上。它不是免责声明式的礼貌用语——
// 查询响应里的 scopes/requires 来自 PG 索引，若有人写穿数据库，它们就是错的。
// 唯一可执法的来源是按 digest 取回的原始字节（见 /v1/plan）。
const advisory = "此响应来自 PG 索引，仅供查询与展示；执法请以 /v1/plan 生成的计划为准（其字段由原始签名字节重解析得出）"

type api struct {
	store *store.Store
	trust *trust.Store
	objs  objstore.Store
}

// New 装配路由。
func New(s *store.Store, ts *trust.Store, objs objstore.Store) http.Handler {
	a := &api{store: s, trust: ts, objs: objs}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", a.healthz)
	mux.HandleFunc("/metrics", metrics)
	mux.HandleFunc("/v1/artifacts", a.artifacts)
	mux.HandleFunc("/v1/artifacts/", a.artifactPath)
	mux.HandleFunc("/v1/blobs", a.blobs)
	mux.HandleFunc("/v1/blobs/", a.blob)
	mux.HandleFunc("/v1/resolve", a.resolve)
	mux.HandleFunc("/v1/plan", a.plan)
	mux.HandleFunc("/v1/installations", a.installations)
	mux.HandleFunc("/v1/rollouts/", a.rolloutPath)
	return mux
}

func (a *api) blobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "registry: 只支持 POST")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "registry: 读取 bundle 失败")
		return
	}
	if len(raw) > 64<<20 {
		writeErr(w, http.StatusRequestEntityTooLarge, "registry: bundle 超过 64 MiB")
		return
	}
	if _, err := bundle.Decode(raw); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	digest := objstore.Digest(raw)
	if err := a.objs.Put(r.Context(), digest, raw); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"digest": digest})
}

// blob 返回已经通过内容寻址校验的原始制品字节。
// Provisioner 只应从这里取 bytes，再按 /v1/plan 的 digest 二次校验后安装。
func (a *api) blob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "registry: 只支持 GET")
		return
	}
	digest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/blobs/"), "/")
	if !objstore.ValidDigest(digest) {
		writeErr(w, http.StatusBadRequest, "registry: digest 格式非法")
		return
	}
	raw, err := a.objs.Get(r.Context(), digest)
	if err != nil {
		if errors.Is(err, objstore.ErrNotFound) {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Digest", digest)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// fail 把领域错误映射成 HTTP 码。映射表是执法语义的一部分：
// 400 表示「你发的东西不对」，409 表示「与已有状态冲突」，
// 403 表示「你没这个权限」，422 表示「东西没错但装不上这里」。
func fail(w http.ResponseWriter, err error) {
	code := http.StatusBadRequest
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, resolve.ErrMissing):
		code = http.StatusNotFound
	case errors.Is(err, store.ErrVersionImmutable), errors.Is(err, resolve.ErrVersionConflict),
		errors.Is(err, resolve.ErrCycle):
		code = http.StatusConflict
	case errors.Is(err, trust.ErrUnknownPublisher), errors.Is(err, trust.ErrBadSignature),
		errors.Is(err, trust.ErrScopeEscalation), errors.Is(err, plan.ErrIdentityMismatch):
		code = http.StatusForbidden
	case errors.Is(err, plan.ErrShapeUnsatisfied):
		code = http.StatusUnprocessableEntity
	}
	writeErr(w, code, err.Error())
}

func (a *api) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func metrics(w http.ResponseWriter, _ *http.Request) {
	observability.Handler(w, nil)
}

type publishEnvelope struct {
	ManifestB64 string `json:"manifest_b64"`
	SigB64      string `json:"sig_b64"`
}

func (a *api) artifacts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.catalog(w, r)
		return
	case http.MethodPost:
		// Publication continues below.
	default:
		writeErr(w, http.StatusMethodNotAllowed, "registry: 只支持 POST")
		return
	}
	var env publishEnvelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		writeErr(w, http.StatusBadRequest, "registry: 信封解析失败")
		return
	}
	if env.ManifestB64 == "" || env.SigB64 == "" {
		writeErr(w, http.StatusBadRequest, "registry: manifest_b64 与 sig_b64 均为必填")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(env.ManifestB64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "registry: manifest_b64 不是合法 base64")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(env.SigB64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "registry: sig_b64 不是合法 base64")
		return
	}
	rec, err := a.store.Publish(r.Context(), raw, sig)
	if err != nil {
		fail(w, err)
		return
	}
	code := http.StatusCreated
	if rec.Idempotent {
		code = http.StatusOK
	}
	writeJSON(w, code, map[string]any{
		"name": rec.Name, "version": rec.Version, "kind": rec.Kind,
		"publisher": rec.Publisher, "digest": rec.Digest, "idempotent": rec.Idempotent,
	})
}

// catalog returns the latest discoverable release for every artifact name.
// It deliberately exposes only registry-index state. An entry here is signed
// and published, but is not evidence that any provisioner installed or started
// it on a particular runtime.
func (a *api) catalog(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			writeErr(w, http.StatusBadRequest, "registry: limit 必须是 1–200 的整数")
			return
		}
		limit = parsed
	}
	recs, err := a.store.ListLatest(r.Context(), limit)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":    recs,
		"source":   "registry_index",
		"state":    "discoverable",
		"advisory": advisory,
	})
}

type installationReportRequest struct {
	NodeID    string                    `json:"node_id"`
	State     string                    `json:"state"`
	Root      string                    `json:"root"`
	Installed []store.InstalledArtifact `json:"installed"`
	Shape     plan.Shape                `json:"shape"`
}

// installations is the Provisioner fact channel. POST reports what a node has
// already verified and atomically installed; it is not a remote-install API.
// GET exposes the latest report per node so product surfaces can distinguish
// "not reported" from "reported installed".
func (a *api) installations(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listInstallations(w, r)
	case http.MethodPost:
		a.reportInstallation(w, r)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "registry: installations 只支持 GET 或 POST")
	}
}

func (a *api) listInstallations(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			writeErr(w, http.StatusBadRequest, "registry: limit 必须是 1–200 的整数")
			return
		}
		limit = parsed
	}
	reports, err := a.store.ListInstallations(r.Context(), limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": reports, "source": "provisioner_reports",
		"advisory": "节点回报只证明最近一次 Provisioner 对账结果；它不能证明制品进程已启用、健康或正在处理请求。",
	})
}

func (a *api) reportInstallation(w http.ResponseWriter, r *http.Request) {
	var req installationReportRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "registry: 节点安装回报解析失败")
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "registry: 节点安装回报只能包含一个 JSON 对象")
		return
	}
	if err := validateInstallationReport(req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	report, err := a.store.UpsertInstallation(r.Context(), store.InstallationReport{
		NodeID: req.NodeID, State: req.State, Root: req.Root, Installed: req.Installed, Shape: req.Shape,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, report)
}

func validateInstallationReport(req installationReportRequest) error {
	if !validNodeID(req.NodeID) {
		return errors.New("registry: node_id 格式非法")
	}
	if len(req.Root) == 0 || len(req.Root) > 256 {
		return errors.New("registry: root 必须是 1–256 字节")
	}
	if req.State != "converged" && req.State != "failed" {
		return errors.New("registry: state 必须是 converged 或 failed")
	}
	if req.State == "converged" && len(req.Installed) == 0 {
		return errors.New("registry: converged 回报必须包含已安装制品")
	}
	if req.State == "failed" && len(req.Installed) != 0 {
		return errors.New("registry: failed 回报不得把旧安装伪装成当前已收敛")
	}
	if len(req.Installed) > 200 {
		return errors.New("registry: 单次回报最多 200 个制品")
	}
	seen := make(map[string]struct{}, len(req.Installed))
	for _, item := range req.Installed {
		if item.Name == "" || item.Version == "" || !objstore.ValidDigest(item.Digest) {
			return errors.New("registry: 已安装制品回报不完整")
		}
		key := item.Name + "\x00" + item.Version
		if _, exists := seen[key]; exists {
			return errors.New("registry: 已安装制品回报存在重复版本")
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validNodeID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, ch := range value {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-' || ch == ':' {
			continue
		}
		return false
	}
	return true
}

func validRolloutSegment(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, ch := range value {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-' {
			continue
		}
		return false
	}
	return true
}

// requireRolloutAdmin relies on the same authenticated gateway assertions as
// the other control-plane services. The Registry still has no browser-facing
// listener: RequireControlPlaneToken protects it at process assembly and the
// Lumo UI proxy signs and validates identity before forwarding these headers.
func requireRolloutAdmin(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("X-Lumo-User") == "" || r.Header.Get("X-Lumo-Realm") == "" {
		writeErr(w, http.StatusUnauthorized, "registry: 修改期望状态需要已认证身份")
		return false
	}
	for _, role := range strings.Split(r.Header.Get("X-Lumo-Roles"), ",") {
		switch strings.TrimSpace(role) {
		case "platform_admin", "realm_admin", "admin":
			return true
		}
	}
	writeErr(w, http.StatusForbidden, "registry: 只有 realm_admin 可以修改期望状态")
	return false
}

type rolloutRequest struct {
	Version string `json:"version"`
	Percent *int   `json:"percent"`
}

// rolloutPath exposes one channel's desired versions. GET is safe for any
// authenticated control-plane consumer; PUT is an admin command. A GET with
// node_id receives the deterministic target/holdback selection that its
// Provisioner must reconcile; a normal GET exposes only desired state.
func (a *api) rolloutPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/rollouts/"), "/")
	parts := strings.Split(rest, "/")
	if rest == "" || (len(parts) != 1 && len(parts) != 2) || !validRolloutSegment(parts[0]) || (len(parts) == 2 && !validRolloutSegment(parts[1])) {
		writeErr(w, http.StatusBadRequest, "registry: rollout 路径非法")
		return
	}
	switch {
	case r.Method == http.MethodGet && len(parts) == 1:
		a.listRollouts(w, r, parts[0])
	case r.Method == http.MethodGet && len(parts) == 2:
		a.getRollout(w, r, parts[0], parts[1])
	case r.Method == http.MethodPut && len(parts) == 2:
		a.putRollout(w, r, parts[0], parts[1])
	default:
		writeErr(w, http.StatusMethodNotAllowed, "registry: rollouts 只支持 GET，或由管理员 PUT 指定制品")
	}
}

func (a *api) listRollouts(w http.ResponseWriter, r *http.Request, channel string) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			writeErr(w, http.StatusBadRequest, "registry: limit 必须是 1–200 的整数")
			return
		}
		limit = parsed
	}
	rollouts, err := a.store.ListRollouts(r.Context(), channel, limit)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": rollouts, "channel": channel, "source": "desired_state",
		"advisory": "期望状态只选择已发布版本；它不证明节点已安装、启用或健康。部分发布使用稳定 node_id 确定性分桶，未命中节点保留上一版本。",
	})
}

func (a *api) getRollout(w http.ResponseWriter, r *http.Request, channel, name string) {
	rollout, err := a.store.GetRollout(r.Context(), channel, name)
	if err != nil {
		fail(w, err)
		return
	}
	body := map[string]any{
		"rollout": rollout, "source": "desired_state",
		"advisory": "Provisioner 只将版本作为查询提示，随后仍从原始签名字节重建 /v1/plan。部分发布按 node_id 稳定分桶；提高 percent 不会把已命中的节点移回 holdback。",
	}
	if nodeID := strings.TrimSpace(r.URL.Query().Get("node_id")); nodeID != "" {
		version, cohort, err := store.SelectRolloutVersion(rollout, nodeID)
		if err != nil {
			fail(w, err)
			return
		}
		body["selection"] = map[string]string{"node_id": nodeID, "version": version, "cohort": cohort}
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *api) putRollout(w http.ResponseWriter, r *http.Request, channel, name string) {
	if !requireRolloutAdmin(w, r) {
		return
	}
	var req rolloutRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "registry: 期望状态解析失败")
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "registry: 期望状态只能包含一个 JSON 对象")
		return
	}
	if req.Version == "" || req.Percent == nil || *req.Percent < 0 || *req.Percent > 100 {
		writeErr(w, http.StatusBadRequest, "registry: version 必填，percent 必须是 0–100 的整数")
		return
	}
	rollout, err := a.store.UpsertRollout(r.Context(), store.Rollout{Channel: channel, Name: name, Version: req.Version, Percent: *req.Percent})
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rollout": rollout, "source": "desired_state",
		"advisory": "已更新期望版本；节点会在下一次 Provisioner 周期中按稳定 node_id 选择目标或 holdback，并重新验证签名计划后收敛。",
	})
}

// artifactPath 处理 /v1/artifacts/{name} 与 /v1/artifacts/{name}/{version}。
func (a *api) artifactPath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "registry: 只支持 GET")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/artifacts/"), "/")
	if rest == "" {
		writeErr(w, http.StatusNotFound, "registry: 路径不存在")
		return
	}
	parts := strings.Split(rest, "/")
	switch len(parts) {
	case 1:
		recs, err := a.store.List(r.Context(), parts[0])
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": recs, "advisory": advisory})
	case 2:
		rec, err := a.store.Get(r.Context(), parts[0], parts[1])
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"artifact": rec, "advisory": advisory})
	default:
		writeErr(w, http.StatusNotFound, "registry: 路径不存在")
	}
}

type ref struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (a *api) resolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "registry: 只支持 POST")
		return
	}
	var in ref
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "registry: 请求体解析失败")
		return
	}
	nodes, err := resolve.Closure(r.Context(),
		manifest.Dep{Name: in.Name, Version: in.Version}, a.store.LookupNode)
	if err != nil {
		fail(w, err)
		return
	}
	out := make([]ref, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, ref{Name: n.Name, Version: n.Version})
	}
	writeJSON(w, http.StatusOK, map[string]any{"closure": out})
}

type planRequest struct {
	Name    string     `json:"name"`
	Version string     `json:"version"`
	Shape   plan.Shape `json:"shape"`
}

func (a *api) plan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "registry: 只支持 POST")
		return
	}
	var in planRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "registry: 请求体解析失败")
		return
	}
	nodes, err := resolve.Closure(r.Context(),
		manifest.Dep{Name: in.Name, Version: in.Version}, a.store.LookupNode)
	if err != nil {
		fail(w, err)
		return
	}
	p, err := plan.Build(r.Context(), nodes, in.Shape, a.objs, a.trust)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}
