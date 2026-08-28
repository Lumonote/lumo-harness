package policy

// OPAClient 是 Standalone/Cluster 的策略实现。
// RuleSet 与 OPAClient 都实现 Policy，Gateway 不感知策略来源。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type OPAClient struct {
	baseURL string
	path    string
	client  *http.Client
}

func NewOPAClient(baseURL, policyPath string) *OPAClient {
	if policyPath == "" {
		policyPath = "lumo/egress"
	}
	return &OPAClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		path:    strings.Trim(policyPath, "/"),
		client:  &http.Client{Timeout: 5 * time.Second},
	}
}

func (o *OPAClient) Evaluate(ctx context.Context, req Request) (Decision, error) {
	var out Decision
	if err := o.evaluate(ctx, req, &out); err != nil {
		return Decision{}, err
	}
	return out, nil
}

func (o *OPAClient) EvaluateWeb(ctx context.Context, req WebPolicyRequest) (Decision, error) {
	var out Decision
	if err := o.evaluate(ctx, req, &out); err != nil {
		return Decision{}, err
	}
	return out, nil
}

func (o *OPAClient) evaluate(ctx context.Context, input any, out *Decision) error {
	if o.baseURL == "" {
		return fmt.Errorf("policy: OPA 地址未配置")
	}
	body, err := json.Marshal(map[string]any{"input": input})
	if err != nil {
		return fmt.Errorf("policy: OPA 输入序列化失败: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/v1/data/"+o.path, strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("policy: 创建 OPA 请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := o.client.Do(req)
	if err != nil {
		return fmt.Errorf("policy: OPA 请求失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("policy: OPA 返回 HTTP %d", res.StatusCode)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&envelope); err != nil {
		return fmt.Errorf("policy: OPA 响应解析失败: %w", err)
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return fmt.Errorf("policy: OPA 缺少 result")
	}
	if err := json.Unmarshal(envelope.Result, out); err != nil {
		return fmt.Errorf("policy: OPA result 形状非法: %w", err)
	}
	return nil
}
