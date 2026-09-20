package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

type RuntimeConfig struct {
	LLMURL       string
	ConnectorURL string
	KnowledgeURL string
	// ProjectsURL 是 projects 服务的基址，决策固化算子（§24.4 第 5 条）经它调那侧的
	// 固化读面。未配置时该算子登记为 unavailable：**默认关闭**是设计要的取向
	// （§16 R4 没有给频率默认值），而「关」的判据落在配置上，不落在某条默认 cron 上。
	ProjectsURL    string
	ControlToken   string
	IdentitySecret string
	Client         *http.Client
}

type identityKey struct{}
type nodeKey struct{}
type wakeTraceKey struct{}

func WithIdentity(ctx context.Context, identity observability.Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, identity)
}

// WithWakeTrace 标注本次执行由哪个唤醒事件触发（§24.9 第 1 条、§14 判据 10）。
//
// 取值由 domain.WakeTrace(triggerID) 生成，缺省（空串）表示「没有可归因的唤醒源」——
// 那时**不设置** X-Lumo-Trace 头，网关按它的既有缺省自行铸 trace。手工触发
// （POST /v1/flows/{id}/run）就走这一路：它不是被事件叫醒的，不该被算进「等事件的成本」。
func WithWakeTrace(ctx context.Context, trace string) context.Context {
	if trace == "" {
		return ctx
	}
	return context.WithValue(ctx, wakeTraceKey{}, trace)
}

func (e *Engine) registerRuntime(config RuntimeConfig) {
	if config.Client == nil {
		config.Client = observability.ConfiguredHTTPClient(60 * time.Second)
	}
	client := *config.Client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	config.Client = &client
	for _, spec := range []struct {
		names          []string
		endpoint, kind string
	}{
		{[]string{"llm.chat", "llm.answer"}, config.LLMURL, "llm"},
		{[]string{"connector.invoke", "tool.invoke"}, config.ConnectorURL, "connector"},
		{[]string{"knowledge.query", "kb.query"}, config.KnowledgeURL, "knowledge"},
		// 决策固化（§24.4 第 5 条）：本算子是**只读**执行体，它把固化任务接上既有
		// TriggerBus，而不新建任何调度机制——定时来自 project_automations 里的 cron
		// 自动化，走 cron 生产者 → outbox → 投递 worker → 进程内 Bus → 绑定 → 本引擎，
		// 与本文件其余算子完全同一条链路。频率因此是那条 cron 表达式；**没有任何默认
		// 频率**（§16 R4：给一个编出来的默认值比留空更糟），不建自动化即关闭。
		{[]string{"decisions.consolidate"}, config.ProjectsURL, "projects"},
	} {
		for _, name := range spec.names {
			e.Register(name, func(ctx context.Context, input any) (any, error) {
				return config.invoke(ctx, spec.kind, spec.endpoint, input)
			})
			base, err := url.Parse(spec.endpoint)
			switch {
			case spec.endpoint == "":
				e.unavailable[name] = "upstream is not configured"
			case err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "":
				e.unavailable[name] = "upstream URL is invalid"
			case config.ControlToken == "":
				e.unavailable[name] = "upstream authentication is not configured"
			case spec.kind == "knowledge" && len(config.IdentitySecret) < 32:
				e.unavailable[name] = "identity signing secret must contain at least 32 bytes"
			}
		}
	}
}

func (config RuntimeConfig) invoke(ctx context.Context, kind, endpoint string, input any) (any, error) {
	if endpoint == "" {
		return nil, fmt.Errorf("%s operator upstream is not configured", kind)
	}
	base, err := url.Parse(endpoint)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("invalid %s operator upstream", kind)
	}
	identity, ok := ctx.Value(identityKey{}).(observability.Identity)
	if !ok || identity.UserID == "" || identity.Realm == "" || len(identity.Roles) == 0 {
		return nil, fmt.Errorf("flow execution identity is required")
	}
	node, _ := ctx.Value(nodeKey{}).(domain.FlowNode)
	args := map[string]any{}
	if values, ok := input.(map[string]any); ok {
		for key, value := range values {
			args[key] = value
		}
	}
	for key, value := range node.Config {
		args[key] = value
	}
	var path string
	var body any
	method := http.MethodPost
	switch kind {
	case "llm":
		if model, ok := args["model"].(string); !ok || strings.TrimSpace(model) == "" {
			return nil, fmt.Errorf("llm operator requires model")
		}
		if args["messages"] == nil {
			prompt, ok := input.(string)
			if !ok {
				raw, err := json.Marshal(input)
				if err != nil {
					return nil, err
				}
				prompt = string(raw)
			}
			args["messages"] = []map[string]string{{"role": "user", "content": prompt}}
		}
		args["stream"] = false
		path, body = "/v1/chat/completions", args
	case "connector":
		connector, _ := args["connectorId"].(string)
		operation, _ := args["operation"].(string)
		if connector == "" || operation == "" {
			return nil, fmt.Errorf("connector/tool operator requires connectorId and operation")
		}
		if args["body"] == nil {
			args["body"] = input
		}
		delete(args, "connectorId")
		path, body = "/connectors/"+url.PathEscape(connector)+"/invoke", args
	case "knowledge":
		text, _ := args["text"].(string)
		if text == "" {
			text, _ = input.(string)
		}
		if text == "" {
			return nil, fmt.Errorf("knowledge operator requires text")
		}
		topK := args["topK"]
		if topK == nil {
			topK = 5
		}
		body = map[string]any{"seam": "knowledge", "method": "query", "args": []any{map[string]any{
			"realm": identity.Realm, "roles": identity.Roles, "text": text, "topK": topK, "scope": "published",
		}}}
		path = "/seam/knowledge/query"
	case "projects":
		// 决策固化报告（§24.4 第 5 条）。三条取舍：
		//
		//  1. **只读**。它调的是 projects 的固化读面（一个纯计算，没有表、没有写路径），
		//     所以「固化任务绝不删除、绝不取代、绝不裁决」这条硬约束在算子里也不可能被
		//     破坏——这里根本没有写通道。
		//  2. **项目 id 只从节点配置读**（node.Config.projectId），不从节点输入读。输入是
		//     触发负载，事件入口送什么由外部决定；用它挑目标等于让事件自己选一个项目去读。
		//     配置是流程定义的一部分，要过发布审核，这才是可审计的来源。
		//  3. **不传 limit**。索引上限（多少行算「超出索引」）是 projects 侧的口径，
		//     在这里再写一个数字就是复制常量，两侧迟早漂移；不传即由那侧套自己的缺省。
		projectID, _ := node.Config["projectId"].(string)
		if strings.TrimSpace(projectID) == "" {
			// fail-closed：缺它就不知道该固化哪个项目的记忆，绝不猜一个。
			return nil, fmt.Errorf("decisions.consolidate 需要节点配置 projectId")
		}
		method = http.MethodGet
		path = "/v1/projects/" + url.PathEscape(projectID) + "/decisions/consolidation-report"
	}
	var payload []byte
	if body != nil {
		if payload, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	if len(payload) > 4<<20 {
		return nil, fmt.Errorf("flow operator request exceeds 4 MiB")
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(endpoint, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+config.ControlToken)
	req.Header.Set("X-Lumo-Realm", identity.Realm)
	req.Header.Set("X-Lumo-User", identity.UserID)
	req.Header.Set("X-Lumo-Roles", strings.Join(identity.Roles, ","))
	req.Header.Set("X-Lumo-Role", identity.Roles[0])
	req.Header.Set("X-Lumo-Dept", identity.DeptID)
	req.Header.Set("X-Lumo-Project", identity.ProjectID)
	req.Header.Set("X-Lumo-Component", "flows")
	// 唤醒归因（§24.9 第 1 条）：被事件叫醒的那次执行，把唤醒源的键一路带到截面处。
	// 网关按这个头写 usage_ledger.trace_id（llm-gateway / connector-gateway 的既有行为），
	// 「这次花费是哪次唤醒造成的」因此可查。没有唤醒源时不设置——让网关铸它自己的
	// trace，台账里就留下一行明确不可归因的记录，而不是一行假归因。
	if trace, ok := ctx.Value(wakeTraceKey{}).(string); ok {
		req.Header.Set("X-Lumo-Trace", trace)
	}
	if kind == "knowledge" {
		headers, err := observability.SignIdentityHeaders(identity, "lumo-seam-host", config.IdentitySecret)
		if err != nil {
			return nil, err
		}
		for key, values := range headers {
			req.Header[key] = values
		}
		req.Header.Set("X-Lumo-Seam-Token", config.ControlToken)
	}
	res, err := config.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, (8<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 8<<20 {
		return nil, fmt.Errorf("flow operator response exceeds 8 MiB")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s operator upstream returned HTTP %d", kind, res.StatusCode)
	}
	var result any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	if kind == "knowledge" {
		envelope, ok := result.(map[string]any)
		if !ok || envelope["ok"] != true {
			return nil, fmt.Errorf("knowledge operator failed")
		}
		return envelope["value"], nil
	}
	return result, nil
}
