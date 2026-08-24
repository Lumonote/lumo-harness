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
	"net/http"
	"strings"

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
	mux.HandleFunc("/v1/artifacts", a.artifacts)
	mux.HandleFunc("/v1/artifacts/", a.artifactPath)
	mux.HandleFunc("/v1/resolve", a.resolve)
	mux.HandleFunc("/v1/plan", a.plan)
	return mux
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

type publishEnvelope struct {
	ManifestB64 string `json:"manifest_b64"`
	SigB64      string `json:"sig_b64"`
}

func (a *api) artifacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
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
