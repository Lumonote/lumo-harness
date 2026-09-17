package lineage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// GraphAdapter 是把血缘边投影到图引擎的最小接口。Nebula 只是其中一种实现；
// 单测用 fake 即可，无需真 Nebula（零新增第三方依赖）。
type GraphAdapter interface {
	UpsertLineageEdge(ctx context.Context, edge Edge) error
}

// HTTPAdapter 通过项目约定的 graph adapter HTTP 接口投影血缘边（nGQL over HTTP 的
// 适配层）。它复刻 dsh-plugins/knowledge 的 NebulaGraphProvider 契约：POST
// /v1/graph/edges:upsert，body 为 { "edges": [ GraphEdge, ... ] }——这是本仓库
// 「graphd adapter」的标准形状，新增实现照此对接即可。
type HTTPAdapter struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewHTTPAdapter 构造一个 Nebula graph adapter 客户端。apiKey 为空时不带鉴权头
// （本地/测试部署可能不校验）。
func NewHTTPAdapter(baseURL, apiKey string) *HTTPAdapter {
	return &HTTPAdapter{
		baseURL: baseURL,
		apiKey:  apiKey,
		// 比默认更短超时：投影失败应快速进入退避，而不是长时间挂住占用 outbox 行。
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

// nodeID 把血缘节点映射成稳定的图节点 id：带 flow/version 前缀，使「跨版本 node id
// 相同」落成不同的图节点（requirement #5 边界），不会把 v1 与 v2 的同一算子名混为一个。
func nodeID(flowID string, version int, nodeID string) string {
	return fmt.Sprintf("flow:%s:v%d:%s", flowID, version, nodeID)
}

type graphEdgePayload struct {
	From       string            `json:"from"`
	To         string            `json:"to"`
	Kind       string            `json:"kind"`
	Realm      string            `json:"realm"`
	Properties map[string]string `json:"properties"`
}

type edgesUpsertBody struct {
	Edges []graphEdgePayload `json:"edges"`
}

// UpsertLineageEdge 把一条血缘边 upsert 到图引擎。Nebula 是呈现层，投影失败由投影器
// 负责退避重试——这里只负责把错误原样返回，绝不静默。
func (a *HTTPAdapter) UpsertLineageEdge(ctx context.Context, edge Edge) error {
	body, err := json.Marshal(edgesUpsertBody{Edges: []graphEdgePayload{{
		From:  nodeID(edge.FlowID, edge.Version, edge.FromNode),
		To:    nodeID(edge.FlowID, edge.Version, edge.ToNode),
		Kind:  edge.EdgeType,
		Realm: edge.Realm,
		Properties: map[string]string{
			"flow_id":       edge.FlowID,
			"version":       fmt.Sprintf("%d", edge.Version),
			"from_operator": edge.FromOperator,
			"to_operator":   edge.ToOperator,
			"edge_type":     edge.EdgeType,
		},
	}}})
	if err != nil {
		return fmt.Errorf("序列化血缘边失败: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/v1/graph/edges:upsert", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("构造血缘投影请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if a.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.apiKey)
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("血缘投影请求失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("血缘投影返回 %d", resp.StatusCode)
	}
	return nil
}
