package server

// provider 注册表的管理面 HTTP 面（E8）。
//
// 为什么放在这个包里而不是新起一个 admin 包：writeErr / 日志约定 / 装配点都在这里，
// 新包要么复制这三样、要么反向依赖本包。管理面与数据面共用同一个 mux、同一层
// 控制面令牌鉴权（cmd/llm-gateway 把整个 mux 包在 RequireControlPlaneToken 里），
// 所以这里不需要任何鉴权代码——**也不要**给这些路由单独加豁免，那会开出一个
// 无鉴权的配置写入口。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
)

// maxProviderBody 配置体的读取上限。配置是小对象，给 1MB 只是为了让「有人拿它当
// 上传口」时早失败，而不是先吃满内存再报错。
const maxProviderBody = 1 << 20

// providerRegistry 管理面需要的存储能力（*store.Store 实现）。
//
// 收成接口是为了让 handler 的契约（状态码、错误码、JSON 形状、路径参数）能在**没有
// 数据库**的情况下被测——本机没有 PG 也不该成为「HTTP 面没测过」的理由。SQL 本身的
// 语义由 store 的活库用例覆盖。
type providerRegistry interface {
	Providers(ctx context.Context) ([]domain.ProviderConfig, error)
	ProviderConfig(ctx context.Context, model string) (*domain.ProviderConfig, error)
	UpsertProvider(ctx context.Context, model string, up domain.ProviderUpsert) (*domain.ProviderConfig, error)
	DeleteProvider(ctx context.Context, model string) error
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// providerModel 取路径里的模型名并校验。
//
// 用 {model...} 而不是 {model}：模型名本身可以带斜杠（`openai/gpt-4`），单段通配符
// 会把它截断成 404。多段通配符还有个副作用——`/v1/providers/`（空模型）会落到同一个
// handler 上，于是得到一条「model 不能为空」的 400，而不是 mux 的 404。对配置面来说
// 「你给的模型名不合法」比「没有这个接口」准确得多。
func (s *Server) providerModel(w http.ResponseWriter, r *http.Request) (string, bool) {
	model := r.PathValue("model")
	if err := domain.ValidateModel(model); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_model", err.Error())
		return "", false
	}
	return model, true
}

// storeFailure 把存储层错误映射成状态码。domain.ErrProviderNotFound 由调用方各自
// 处理（列表接口不会遇到它），domain.ErrInvalidProvider 会被 store 用来报告
// 「只有库才能判定的」非法输入（例如新建行省略了 upstreamBaseUrl）。
func (s *Server) storeFailure(w http.ResponseWriter, what string, err error) {
	if errors.Is(err, domain.ErrInvalidProvider) {
		writeErr(w, http.StatusBadRequest, "invalid_provider", err.Error())
		return
	}
	s.log.Error(what, "err", err)
	writeErr(w, http.StatusInternalServerError, "internal", what)
}

// GET /v1/providers —— 列出全部 provider，**含已停用行**。
//
// 管理面必须看得见停用行：看不见就没人能把它重新启用。停用与否是响应里的一个字段
// （enabled），不是一个过滤条件。
func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	list, err := s.providers.Providers(r.Context())
	if err != nil {
		s.storeFailure(w, "读取 provider 列表失败", err)
		return
	}
	// 空列表必须是 `[]` 而不是 `null`：nil 切片编出来是 null，客户端 `providers.map`
	// 会当场抛。存储层已经保证返回非 nil，这里再兜一次——这是响应体的边界，
	// 而「没人配置过 provider」是完全正常的初始状态，不该让客户端崩。
	if list == nil {
		list = []domain.ProviderConfig{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": list})
}

// GET /v1/providers/{model...}
func (s *Server) getProvider(w http.ResponseWriter, r *http.Request) {
	model, ok := s.providerModel(w, r)
	if !ok {
		return
	}
	cfg, err := s.providers.ProviderConfig(r.Context(), model)
	if errors.Is(err, domain.ErrProviderNotFound) {
		writeErr(w, http.StatusNotFound, "provider_not_found", model)
		return
	}
	if err != nil {
		s.storeFailure(w, "读取 provider 失败", err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// PUT /v1/providers/{model...} —— 建或改，body 里除 model 外全部可选（省略 = 保持）。
//
// 一律回 200（不区分 201）：PUT 是幂等的，而「新建还是覆盖」需要额外一条查询去判，
// 判完就过期——并发 PUT 时那个返回码本身就不确定。想知道行是不是新的，看响应里的
// createdAt。客户端不该依赖 201 做任何事，所以不给它这个不可靠的信号。
func (s *Server) putProvider(w http.ResponseWriter, r *http.Request) {
	model, ok := s.providerModel(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxProviderBody))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body", "请求体读取失败")
		return
	}
	var up domain.ProviderUpsert
	// 空体（或全空白）等价于 `{}`：一个「什么都不改」的 PUT 是合法的幂等请求，
	// 让它落到 Validate 里报出真正的原因，而不是先报一个含糊的 JSON 语法错。
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &up); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_body", "请求体不是合法 JSON")
			return
		}
	}
	// 路径是模型名的权威来源：body 里若也给了 model，必须与路径一致（Validate 校验），
	// 但**落库用路径那个**——路径决定了这次写的是哪一行。
	up, err = up.Validate(model)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_provider", err.Error())
		return
	}
	cfg, err := s.providers.UpsertProvider(r.Context(), model, up)
	if err != nil {
		s.storeFailure(w, "写入 provider 失败", err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// DELETE /v1/providers/{model...} —— 物理删除，回 204。
//
// 不把「删一个本来就不存在的行」当成功：那会让一个拼错的模型名静默通过，
// 而运维以为自己已经把它摘掉了。
func (s *Server) deleteProvider(w http.ResponseWriter, r *http.Request) {
	model, ok := s.providerModel(w, r)
	if !ok {
		return
	}
	err := s.providers.DeleteProvider(r.Context(), model)
	if errors.Is(err, domain.ErrProviderNotFound) {
		writeErr(w, http.StatusNotFound, "provider_not_found", model)
		return
	}
	if err != nil {
		s.storeFailure(w, "删除 provider 失败", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
