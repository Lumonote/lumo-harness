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
	LLMURL         string
	ConnectorURL   string
	KnowledgeURL   string
	ControlToken   string
	IdentitySecret string
	Client         *http.Client
}

type identityKey struct{}
type nodeKey struct{}

func WithIdentity(ctx context.Context, identity observability.Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, identity)
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
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if len(payload) > 4<<20 {
		return nil, fmt.Errorf("flow operator request exceeds 4 MiB")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(endpoint, "/")+path, bytes.NewReader(payload))
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
