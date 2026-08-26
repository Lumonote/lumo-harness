// Package gateway 连接器网关的四道闸（§10.1）：
//
//	路由 → 鉴权(Vault 凭证 + OPA egress) → 限速 → 熔断 → 调用 → PII 脱敏 → 审计
//
// 三条结构性保证，写在这里是因为它们靠代码形状成立，不靠调用者自觉：
//  1. 上游 URL 由 manifest 拼装，调用方只能填已声明的占位符与白名单 query；
//  2. 连接时按真实 IP 复核内网禁令（DNS rebinding 在解析后才现形）；
//  3. 不跟随重定向 —— 一个 302 就能把 egress 白名单绕过去。
package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/connector-gateway/internal/credentials"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/policy"
	"github.com/lumo-harness/platform/connector-gateway/internal/ratelimit"
	"github.com/lumo-harness/platform/connector-gateway/internal/redact"
	"github.com/lumo-harness/platform/connector-gateway/internal/registry"
)

// Gateway 组合四道闸与出站客户端。
type Gateway struct {
	reg      registry.Registry
	creds    credentials.Store
	pol      policy.Policy
	limiter  *ratelimit.Limiter
	breakers *breaker.Group
	sink     audit.Sink
	log      *slog.Logger

	// 两套 client：是否允许内网是连接器级决策，而 Transport 的 Control 钩子
	// 在建连时才生效，无法按请求切换，所以按策略各建一套。
	strict     *http.Client
	permissive *http.Client

	// FailOpenOnLimiterError 限流器不可用时的取向。默认 false（拒绝）：
	// 宁可暂时不能调用外部系统，也不要在配额失控的情况下继续烧钱/触发上游封禁。
	FailOpenOnLimiterError bool

	// WebEgress 通用 web 出站配置（POST /web/fetch）。装配层通常经
	// server.Options.WebEgress 汇合下发（server.New 调 SetWebEgress），
	// 直接构造网关的调用方也可在 Options 里给。
	webEgress domain.WebEgress
}

type Options struct {
	Registry  registry.Registry
	Creds     credentials.Store
	Policy    policy.Policy
	Limiter   *ratelimit.Limiter
	Breakers  *breaker.Group
	Audit     audit.Sink
	Logger    *slog.Logger
	WebEgress domain.WebEgress
}

func New(o Options) *Gateway {
	return &Gateway{
		reg:        o.Registry,
		creds:      o.Creds,
		pol:        o.Policy,
		limiter:    o.Limiter,
		breakers:   o.Breakers,
		sink:       o.Audit,
		log:        o.Logger,
		strict:     newClient(false),
		permissive: newClient(true),
		webEgress:  o.WebEgress,
	}
}

// SetWebEgress 注入/覆写通用 web 出站配置。server 是配置汇合点：
// main.go 只把 WebEgress 交给 server，由 server.New 下发到这里。
func (g *Gateway) SetWebEgress(cfg domain.WebEgress) { g.webEgress = cfg }

func newClient(allowPrivate bool) *http.Client {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   guardDial(allowPrivate),
	}
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   8,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ForceAttemptHTTP2:     true,
		},
		// 重定向一律不跟随：目标已被 egress 白名单批准，跳转目标没有。
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// guardDial 在真实建连地址上复核内网禁令。放在 Control 而非解析前，
// 是因为「解析出公网 IP、建连时换成 127.0.0.1」正是 DNS rebinding 的手法。
func guardDial(allowPrivate bool) func(network, address string, c syscall.RawConn) error {
	return func(_, address string, _ syscall.RawConn) error {
		if allowPrivate {
			return nil
		}
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("%w: 无法解析连接地址 %q", domain.ErrEgressBlocked, address)
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("%w: 非法 IP %q", domain.ErrEgressBlocked, host)
		}
		if isInternal(ip) {
			return fmt.Errorf("%w: %s 属于内网/环回地址段", domain.ErrEgressBlocked, ip)
		}
		return nil
	}
}

// cgnat 运营商级 NAT 段（100.64.0.0/10）：ip.IsPrivate() 不覆盖，但同样是内网。
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func isInternal(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() ||
		cgnat.Contains(ip)
}

// Invoke 跑完整条闸门链。任何一道闸拒绝都会落审计后再返回错误。
func (g *Gateway) Invoke(ctx context.Context, caller domain.Caller, inv domain.Invocation) (domain.Result, error) {
	rec := audit.Record{
		CorrelationID: inv.CorrelationID,
		Realm:         string(caller.Realm),
		ProjectID:     caller.ProjectID,
		SessionID:     caller.SessionID,
		UserID:        caller.UserID,
		ConnectorID:   inv.ConnectorID,
		Operation:     inv.Operation,
		RequestBytes:  int64(len(inv.Body)),
	}

	// ── 闸 1：路由 ──────────────────────────────────────────────
	conn, err := g.reg.Lookup(ctx, caller.Realm, inv.ConnectorID)
	if err != nil {
		return g.deny(ctx, rec, domain.ErrNotFound, err.Error())
	}
	op, ok := conn.Operations[inv.Operation]
	if !ok {
		return g.deny(ctx, rec, domain.ErrOperation,
			fmt.Sprintf("操作 %q 不在连接器 %s 的工具面内", inv.Operation, conn.ID))
	}
	rec.Method = strings.ToUpper(op.Method)

	target, err := buildURL(conn, op, inv)
	if err != nil {
		return g.deny(ctx, rec, domain.ErrOperation, err.Error())
	}
	rec.TargetHost = target.Hostname()

	// ── 闸 2：鉴权与出站策略 ────────────────────────────────────
	dec, err := g.pol.Evaluate(ctx, policy.Request{
		Caller: caller, Connector: conn, Operation: op, Host: target.Host,
	})
	if err != nil {
		return g.deny(ctx, rec, domain.ErrForbidden, "策略点评估失败: "+err.Error())
	}
	if !dec.Allow {
		return g.deny(ctx, rec, domain.ErrForbidden, dec.Reason)
	}
	if dec.RequireApproval {
		// 不是失败，是「等人」：审计里与拒绝分开可查，前端据此弹审批
		return g.deny(ctx, rec, domain.ErrApproval, dec.Reason)
	}

	if conn.Limits.MaxRequestBytes > 0 && int64(len(inv.Body)) > conn.Limits.MaxRequestBytes {
		return g.deny(ctx, rec, domain.ErrTooLarge,
			fmt.Sprintf("请求体 %d 字节超过上限 %d", len(inv.Body), conn.Limits.MaxRequestBytes))
	}

	// ── 闸 3：限速 ─────────────────────────────────────────────
	verdict, err := g.limiter.Allow(ctx,
		ratelimit.Key(string(caller.Realm), conn.ID, caller.UserID),
		conn.Limits.RequestsPerMinute, conn.Limits.Burst)
	switch {
	case err != nil && !g.FailOpenOnLimiterError:
		return g.deny(ctx, rec, domain.ErrRateLimited, "限流器不可用，保守拒绝: "+err.Error())
	case err != nil:
		g.log.Warn("限流器不可用，按 fail-open 放行", "connector", conn.ID, "err", err)
	case !verdict.Allowed:
		return g.deny(ctx, rec, domain.ErrRateLimited,
			fmt.Sprintf("超出 %d 次/分钟；%dms 后重试",
				conn.Limits.RequestsPerMinute, verdict.RetryAfter.Milliseconds()))
	}

	// ── 闸 4：熔断 ─────────────────────────────────────────────
	br := g.breakers.Get(conn.Realm.String() + "/" + conn.ID)
	allowed, finish, state := br.Allow()
	rec.BreakerState = state.String()
	if !allowed {
		return g.deny(ctx, rec, domain.ErrCircuitOpen,
			fmt.Sprintf("连接器 %s 熔断器处于 %s", conn.ID, state))
	}

	// ── 出站调用 ───────────────────────────────────────────────
	result, callErr := g.call(ctx, conn, op, inv, target, &rec)
	// 4xx 是上游在正常表达「你请求得不对」，不该把熔断器推开；5xx 与传输错误才算故障。
	finish(callErr == nil && result.Status < 500)

	if callErr != nil {
		rec.Decision = audit.Allowed
		rec.DenyReason = "上游失败: " + callErr.Error()
		// 传输错误（响应缺失）：审计照记，计量不计（口径见 audit.MeterEvent）
		g.record(ctx, rec, nil)
		return domain.Result{}, fmt.Errorf("%w: %s", domain.ErrUpstream, callErr)
	}

	rec.Decision = audit.Allowed
	rec.Status = result.Status
	rec.Duration = time.Duration(result.DurationMS) * time.Millisecond
	rec.ResponseBytes = int64(len(result.Body))
	// 拿到上游响应（含 4xx）→ 计一次 connector.call，与审计同事务落库
	g.record(ctx, rec, g.buildMeter(caller, inv.CorrelationID, "connector.invoke"))
	return result, nil
}

func (g *Gateway) call(
	ctx context.Context,
	conn domain.Connector,
	op domain.Operation,
	inv domain.Invocation,
	target *url.URL,
	rec *audit.Record,
) (domain.Result, error) {
	timeout := time.Duration(conn.Limits.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body := []byte(inv.Body)
	redactions := map[string]int{}
	if conn.Redaction.Request {
		var rep redact.Report
		body, rep = redact.Bytes(body)
		mergeHits(redactions, "request", rep)
	}

	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(op.Method), target.String(), bytesReader(body))
	if err != nil {
		return domain.Result{}, err
	}
	applyHeaders(req, conn, op, inv)
	if err := g.applyAuth(ctx, req, conn); err != nil {
		return domain.Result{}, fmt.Errorf("%w: %s", domain.ErrCredential, err)
	}

	client := g.strict
	if conn.Egress.AllowPrivateNetwork {
		client = g.permissive
	}

	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		// 内网禁令是在 Control 钩子里触发的，错误会裹在 url.Error 里传回来
		if errors.Is(err, domain.ErrEgressBlocked) {
			return domain.Result{}, domain.ErrEgressBlocked
		}
		return domain.Result{}, err
	}
	defer resp.Body.Close()

	limit := conn.Limits.MaxResponseBytes
	if limit <= 0 {
		limit = 8 << 20 // 8 MiB 兜底：没有上限的响应体等于把网关内存交给上游
	}
	// 多读 1 字节用于判定「是否被截断」—— 截断必须显式报错，不能悄悄返回半个 JSON
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return domain.Result{}, err
	}
	if int64(len(raw)) > limit {
		return domain.Result{}, fmt.Errorf("%w: 响应体超过上限 %d 字节", domain.ErrTooLarge, limit)
	}

	out := domain.Result{
		Status:      resp.StatusCode,
		Headers:     redact.Headers(flattenHeaders(resp.Header)),
		ContentType: resp.Header.Get("Content-Type"),
		DurationMS:  time.Since(started).Milliseconds(),
	}
	if conn.Redaction.Response {
		var rep redact.Report
		raw, rep = redact.Bytes(raw)
		out.Redacted = rep.Any()
		mergeHits(redactions, "response", rep)
	}
	out.Body, out.Encoding = encodeBody(raw)
	rec.Redactions = redactions
	return out, nil
}

// applyAuth 明文凭证的唯一出现点。注意顺序：先 applyHeaders 后 applyAuth，
// 保证调用方无法用透传头覆盖掉认证头。
func (g *Gateway) applyAuth(ctx context.Context, req *http.Request, conn domain.Connector) error {
	if conn.Auth.Kind == domain.AuthNone || conn.Auth.Kind == "" {
		return nil
	}
	secret, err := g.creds.Resolve(ctx, conn.Auth.CredentialRef)
	if err != nil {
		return err
	}
	if secret.Empty() {
		return fmt.Errorf("凭证 %s 为空", conn.Auth.CredentialRef)
	}
	switch conn.Auth.Kind {
	case domain.AuthBearer:
		req.Header.Set("Authorization", "Bearer "+secret.Reveal())
	case domain.AuthHeader:
		req.Header.Set(conn.Auth.HeaderName, secret.Reveal())
	case domain.AuthBasic:
		user, pass, ok := strings.Cut(secret.Reveal(), ":")
		if !ok {
			return fmt.Errorf("basic 凭证格式应为 user:pass")
		}
		req.SetBasicAuth(user, pass)
	default:
		return fmt.Errorf("未知 auth.kind %q", conn.Auth.Kind)
	}
	return nil
}

func (g *Gateway) deny(ctx context.Context, rec audit.Record, sentinel error, reason string) (domain.Result, error) {
	rec.Decision = audit.Denied
	rec.DenyReason = reason
	// denied 一律不计计量（审计已记）
	g.record(ctx, rec, nil)
	return domain.Result{}, fmt.Errorf("%w: %s", sentinel, reason)
}

// record 落审计（meter 非 nil 时同事务落计量）。写失败只告警不阻断调用结果 ——
// 但必须留下痕迹，因为「审计静默失效」比调用失败更危险。
func (g *Gateway) record(ctx context.Context, rec audit.Record, meter *audit.MeterEvent) {
	// 用独立超时：调用侧 ctx 可能已被取消，审计仍要落库
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := g.sink.Write(wctx, rec, meter); err != nil {
		g.log.Error("审计写入失败",
			"connector", rec.ConnectorID, "operation", rec.Operation,
			"decision", rec.Decision, "metered", meter != nil, "err", err)
	}
}

// WebFetch 通用 URL 出站（POST /web/fetch）。与 Invoke 共享同一条闸门链
// （策略 → 限速 → 熔断 → 调用 → 脱敏 → 审计），差异点：
//   - 无 manifest 路由：路由闸被「全局黑名单 + 仅公网 + guardDial 建连复核」取代；
//   - 请求头只透传 allowlist（content-type/accept）—— 任意头透传是把 PII/凭证带出网关的洞；
//   - 响应脱敏默认开（web 内容直接进模型上下文）；
//   - 非 2xx 不是错误：Result 如实带回 status（302/404 都是「资源的状态」）。
//
// 计量口径见 buildMeter 与 audit.MeterEvent：拿到上游响应才计一次，
// 传输错误/超时（响应缺失）不计，denied 不计。
func (g *Gateway) WebFetch(ctx context.Context, caller domain.Caller, spec domain.WebFetchSpec) (domain.Result, error) {
	// server 已过 domain.ValidateWebFetch，这里只取结构
	u, err := url.Parse(spec.URL)
	if err != nil {
		return domain.Result{}, fmt.Errorf("%w: URL 非法: %s", domain.ErrOperation, err)
	}
	rec := audit.Record{
		Realm:       string(caller.Realm),
		ProjectID:   caller.ProjectID,
		SessionID:   caller.SessionID,
		UserID:      caller.UserID,
		ConnectorID: "web",
		Operation:   "fetch",
		Method:      http.MethodGet,
		TargetHost:  u.Host,
	}

	// ── 闸 1：全局黑名单（web 无 realm/roles 闸 —— 理由见 policy.EvaluateWeb）
	dec, err := g.pol.EvaluateWeb(ctx, policy.WebPolicyRequest{Caller: caller, Host: u.Host})
	if err != nil {
		return g.deny(ctx, rec, domain.ErrForbidden, "策略点评估失败: "+err.Error())
	}
	if !dec.Allow {
		return g.deny(ctx, rec, domain.ErrForbidden, dec.Reason)
	}

	// ── 闸 2：限速（键 realm/web/user，配额来自 WebEgress）
	verdict, err := g.limiter.Allow(ctx,
		ratelimit.Key(string(caller.Realm), "web", caller.UserID),
		g.webEgress.RequestsPerMinute, g.webEgress.Burst)
	switch {
	case err != nil && !g.FailOpenOnLimiterError:
		return g.deny(ctx, rec, domain.ErrRateLimited, "限流器不可用，保守拒绝: "+err.Error())
	case err != nil:
		g.log.Warn("限流器不可用，按 fail-open 放行", "path", "web/fetch", "err", err)
	case !verdict.Allowed:
		return g.deny(ctx, rec, domain.ErrRateLimited,
			fmt.Sprintf("超出 %d 次/分钟；%dms 后重试",
				g.webEgress.RequestsPerMinute, verdict.RetryAfter.Milliseconds()))
	}

	// ── 闸 3：熔断（键 realm/web —— web 是每 realm 一个聚合上游面）
	br := g.breakers.Get(caller.Realm.String() + "/web")
	allowed, finish, state := br.Allow()
	rec.BreakerState = state.String()
	if !allowed {
		return g.deny(ctx, rec, domain.ErrCircuitOpen,
			fmt.Sprintf("web 出站熔断器处于 %s", state))
	}

	// ── 出站调用 ───────────────────────────────────────────────
	result, callErr := g.webCall(ctx, u, spec, &rec)
	finish(callErr == nil && result.Status < 500)

	if callErr != nil {
		rec.Decision = audit.Allowed
		rec.DenyReason = "上游失败: " + callErr.Error()
		// 传输错误/超时/截断（响应缺失或无法安全取回）：审计照记，计量不计
		g.record(ctx, rec, nil)
		return domain.Result{}, fmt.Errorf("%w: %s", domain.ErrUpstream, callErr)
	}

	rec.Decision = audit.Allowed
	rec.Status = result.Status
	rec.Duration = time.Duration(result.DurationMS) * time.Millisecond
	rec.ResponseBytes = int64(len(result.Body))
	g.record(ctx, rec, g.buildMeter(caller, "", "connector.call"))
	return result, nil
}

// webCall 通用 URL 出站的传输段。与 Invoke 的 call 同构，差异：
//   - GET + 网关注入产品 UA；调用方头只透传 allowlist（content-type/accept）；
//   - 客户端按 WebEgress.AllowPrivateNetwork 选 strict/permissive（默认 strict=仅公网）；
//   - 响应上限取 min(服务端 MaxResponseBytes, 请求 MaxBytes)，+1 字节探测截断，
//     截断必须显式报错（ErrTooLarge），不能悄悄返回半个页面。
func (g *Gateway) webCall(ctx context.Context, u *url.URL, spec domain.WebFetchSpec, rec *audit.Record) (domain.Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return domain.Result{}, err
	}
	// 产品 UA：让上游能识别流量来源；不带用户身份（那是平台内部信息）
	req.Header.Set("User-Agent", "lumo-connector-gateway/1.0 (web)")
	// 透传头只放 allowlist —— 与 Invoke 的 forbiddenPassthroughHeaders 叠加取交
	for k, v := range spec.Headers {
		lk := strings.ToLower(k)
		if !webPassthroughHeaders[lk] || forbiddenPassthroughHeaders[lk] {
			continue
		}
		req.Header.Set(k, v)
	}

	client := g.strict
	if g.webEgress.AllowPrivateNetwork {
		client = g.permissive
	}

	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		// 内网禁令在 Control 钩子触发，错误裹在 url.Error 里传回来
		if errors.Is(err, domain.ErrEgressBlocked) {
			return domain.Result{}, domain.ErrEgressBlocked
		}
		return domain.Result{}, err
	}
	defer resp.Body.Close()

	limit := g.webEgress.MaxResponseBytes
	if limit <= 0 {
		limit = 8 << 20 // 8 MiB 兜底
	}
	// 请求级 MaxBytes 只能向下收紧
	if spec.MaxBytes > 0 && spec.MaxBytes < limit {
		limit = spec.MaxBytes
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return domain.Result{}, err
	}
	if int64(len(raw)) > limit {
		return domain.Result{}, fmt.Errorf("%w: 响应体超过上限 %d 字节", domain.ErrTooLarge, limit)
	}

	out := domain.Result{
		Status:      resp.StatusCode,
		Headers:     redact.Headers(flattenHeaders(resp.Header)),
		ContentType: resp.Header.Get("Content-Type"),
		DurationMS:  time.Since(started).Milliseconds(),
	}
	redactions := map[string]int{}
	if g.webEgress.RedactResponse {
		var rep redact.Report
		raw, rep = redact.Bytes(raw)
		out.Redacted = rep.Any()
		mergeHits(redactions, "response", rep)
	}
	out.Body, out.Encoding = encodeBody(raw)
	rec.Redactions = redactions
	return out, nil
}

// 通用 web 出站允许透传的请求头。只放这两个：content-type 描述请求体格式，
// accept 表达客户端想要什么 —— 其余（尤其认证类）与 Invoke 同规一律不放。
var webPassthroughHeaders = map[string]bool{
	"content-type": true,
	"accept":       true,
}

// buildMeter 组装计量事件（拿到上游响应后调用，qty=1 一次出向调用）。
//
// 归因头**缺省而非 400**：既有 TS 客户端今天只发 User/Realm/Roles/Project
// 已在跑 —— 把归因头改成必填会立刻打破现有链路；缺省+告警把「归因不全」
// 显式化（入账 dept='unknown' 等），而不是静默伪造归属。消费侧 assertCostEvent
// 要求 context 八维全非空，这里用缺省值保证每一行都能入账。
func (g *Gateway) buildMeter(caller domain.Caller, correlationID, featureDefault string) *audit.MeterEvent {
	def := func(header, v, d string) string {
		if v != "" {
			return v
		}
		g.log.Warn("计量归因头缺失，按缺省入账", "header", header, "default", d)
		return d
	}
	role := caller.Role
	if role == "" && len(caller.Roles) > 0 {
		role = caller.Roles[0]
	}
	ctxMap := map[string]string{
		"userId":      caller.UserID,
		"deptId":      def("X-Lumo-Dept", caller.DeptID, "unknown"),
		"role":        def("X-Lumo-Role", role, "unknown"),
		"projectId":   def("X-Lumo-Project", caller.ProjectID, "unknown"),
		"agentId":     def("X-Lumo-Agent", caller.AgentID, "system"),
		"componentId": def("X-Lumo-Component", caller.ComponentID, "connector-gateway"),
		"feature":     def("X-Lumo-Feature", caller.Feature, featureDefault),
		"sessionRef":  def("X-Lumo-Session", caller.SessionID, "system"),
	}
	return &audit.MeterEvent{
		CostType: "connector.call",
		Qty:      1,
		Unit:     "call",
		TraceID:  g.meterTrace(caller, correlationID),
		Emitter:  "connector-gateway",
		CostUSD:  0, // 无费率表 —— 费率/汇率/折扣属计费系统
		Context:  ctxMap,
	}
}

// meterTrace 计量 trace：X-Lumo-Trace → correlationId → 网关铸（截面处的请求必须可追溯）。
func (g *Gateway) meterTrace(caller domain.Caller, correlationID string) string {
	if caller.TraceID != "" {
		return caller.TraceID
	}
	if correlationID != "" {
		return correlationID
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "gw-" + hex.EncodeToString(b)
}

func mergeHits(into map[string]int, prefix string, rep redact.Report) {
	for k, v := range rep.Hits {
		into[prefix+"."+k] += v
	}
}

func flattenHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out
}
