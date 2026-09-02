// Package gateway 模型访问面的转发核心：OpenAI 兼容上游的流式/非流式代理。
//
// 计量截面在此（设计说明 §4 生命周期 ④-⑦）：流式逐 chunk 转发（首 chunk 不因
// 计量延迟——TTFT 预算 §21.1），usage 从流中扫描（有界缓冲，禁止无界）；
// 非流式收全量再转发。网关给上游注入 stream_options.include_usage——计量完整性
// 不能依赖调用方的善意。
package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

// Upstream 一次调用的上游句柄（由 store.Provider 提供）。
type Upstream struct {
	BaseURL string
	APIKey  string
}

// MeterFn 计量落账回调（server 装配 store.Commit）。
type MeterFn func(ctx context.Context, usage *domain.Usage, model string)

// Gateway 转发器。meter 按调用传入（闭包携带本次请求的归因/费率——构造期挂
// 全局回调会把请求态泄漏进服务态）。
type Gateway struct {
	client *http.Client
	onWarn func(format string, args ...any)
}

func New(client *http.Client, onWarn func(string, ...any)) *Gateway {
	if client == nil {
		client = observability.ConfiguredHTTPClient(30 * time.Second)
	}
	if onWarn == nil {
		onWarn = func(string, ...any) {}
	}
	return &Gateway{client: client, onWarn: onWarn}
}

// forward 转发一次 chat completion。body 是客户端原始 JSON（已过归因/reserve/路由）。
// respHeaders 回传上游 Content-Type（SSE vs JSON 由上游声明）。
func (g *Gateway) forward(ctx context.Context, up Upstream, body []byte, stream bool) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST",
		strings.TrimRight(up.BaseURL, "/")+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if up.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+up.APIKey)
	}
	return g.client.Do(req)
}

// Chat 非流式：收全量 → 计量 → 原样回给调用方。
func (g *Gateway) Chat(ctx context.Context, up Upstream, body []byte, w http.ResponseWriter, meter MeterFn) error {
	resp, err := g.forward(ctx, up, body, false)
	if err != nil {
		return fmt.Errorf("上游不可达: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("读上游响应失败: %w", err)
	}
	// 计量：从响应 JSON 提 usage（上游错误响应没有 usage——计 0 告警）
	var parsed struct {
		Model string        `json:"model"`
		Usage *domain.Usage `json:"usage"`
	}
	usage := (*domain.Usage)(nil)
	if json.Unmarshal(raw, &parsed) == nil && parsed.Usage != nil {
		usage = parsed.Usage
	}
	if meter != nil {
		meter(ctx, usage, parsed.Model)
	}
	if usage == nil {
		g.onWarn("上游响应缺 usage（计 0——可见缺口，不静默跳过）: status=%d", resp.StatusCode)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(raw)
	return nil
}

// ChatStream 流式：逐 chunk 转发 + 末尾 usage 扫描。转发循环里每个 SSE 事件读一行
// data: 即刻写给客户端——usage 只在旁路缓冲里累计，不阻塞转发路径（背压 = HTTP
// 写阻塞自然反压上游读，无中间队列）。
func (g *Gateway) ChatStream(ctx context.Context, up Upstream, body []byte, w http.ResponseWriter, meter MeterFn) error {
	resp, err := g.forward(ctx, up, body, true)
	if err != nil {
		return fmt.Errorf("上游不可达: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// 错误响应通常是非流式 JSON：整体透传
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		if meter != nil {
			meter(ctx, nil, "") // 无 usage——commit 计 0 + 告警
		}
		g.onWarn("上游流式错误响应（计 0）: status=%d", resp.StatusCode)
		return nil
	}

	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	var usage *domain.Usage
	var model string
	scanner := bufio.NewScanner(resp.Body)
	// 有界缓冲：单行上限 1MB（一个 chunk 的合法上限远小于此；超限 = 上游异常，宁可断流不放无界内存）
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		// SSE 行透传（含空行——事件分隔符）
		_, _ = w.Write(line)
		_, _ = w.Write([]byte("\n"))
		if flusher != nil {
			flusher.Flush()
		}
		// 旁路：data: 行里找 usage / model（只解析，不持有转发）
		if data, ok := bytes.CutPrefix(line, []byte("data: ")); ok {
			if string(data) == "[DONE]" {
				continue
			}
			var chunk struct {
				Model string        `json:"model"`
				Usage *domain.Usage `json:"usage"`
			}
			if json.Unmarshal(data, &chunk) == nil {
				if chunk.Usage != nil {
					usage = chunk.Usage
				}
				if chunk.Model != "" {
					model = chunk.Model
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		// 断流：已转发的部分留在客户端；usage 若已见则照计（部分输出的钱也是钱）
		if usage == nil {
			g.onWarn("上游断流且未见 usage（计 0）: %v", err)
		}
		if meter != nil {
			meter(ctx, usage, model)
		}
		return err
	}
	if meter != nil {
		meter(ctx, usage, model)
	}
	if usage == nil {
		g.onWarn("流结束但未见 usage（计 0——检查上游是否支持 stream_options.include_usage）")
	}
	return nil
}
