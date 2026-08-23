package gateway

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

// buildURL 由 manifest 拼装上游地址。调用方**只能**填两样东西：
// 已声明占位符的值，与 allowedQuery 里的参数。这道拼装是防 SSRF 的地基，
// 所以每一步都拒绝而不是清洗 —— 清洗过的恶意输入仍然是恶意输入。
func buildURL(conn domain.Connector, op domain.Operation, inv domain.Invocation) (*url.URL, error) {
	base, err := url.Parse(conn.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("连接器 %s 的 baseUrl 非法: %w", conn.ID, err)
	}

	path, err := expandPath(op.Path, inv.PathParams)
	if err != nil {
		return nil, err
	}
	// ResolveReference 会按 RFC 3986 处理相对路径；先确保 path 不含 authority
	ref := &url.URL{Path: strings.TrimSuffix(base.Path, "/") + path}
	target := base.ResolveReference(ref)
	// 兜底断言：拼装后 host/scheme 必须与 manifest 一致，任何漂移都是 bug 或攻击
	if target.Host != base.Host || target.Scheme != base.Scheme {
		return nil, fmt.Errorf("%w: 拼装后的地址偏离 baseUrl", domain.ErrEgressBlocked)
	}

	q, err := buildQuery(op, inv.Query)
	if err != nil {
		return nil, err
	}
	target.RawQuery = q
	target.Fragment = ""
	return target, nil
}

// expandPath 替换 {name} 占位符。值整体做路径段转义，
// 因此调用方传 `../../admin` 只会变成一个字面段，穿不出去。
func expandPath(tmpl string, params map[string]string) (string, error) {
	var b strings.Builder
	rest := tmpl
	seen := map[string]bool{}

	for {
		open := strings.IndexByte(rest, '{')
		if open < 0 {
			b.WriteString(rest)
			break
		}
		end := strings.IndexByte(rest[open:], '}')
		if end < 0 {
			return "", fmt.Errorf("路径模板 %q 的占位符未闭合", tmpl)
		}
		end += open

		name := rest[open+1 : end]
		if name == "" {
			return "", fmt.Errorf("路径模板 %q 含空占位符", tmpl)
		}
		value, ok := params[name]
		if !ok || value == "" {
			return "", fmt.Errorf("缺少路径参数 %q", name)
		}
		b.WriteString(rest[:open])
		b.WriteString(url.PathEscape(value))
		seen[name] = true
		rest = rest[end+1:]
	}

	// 多余参数是契约不符的信号（写错了 operation，或在试探）—— 拒绝而不是忽略
	for name := range params {
		if !seen[name] {
			return "", fmt.Errorf("路径参数 %q 未在操作模板中声明", name)
		}
	}
	return b.String(), nil
}

func buildQuery(op domain.Operation, in map[string]string) (string, error) {
	if len(in) == 0 {
		return "", nil
	}
	allowed := make(map[string]struct{}, len(op.AllowedQuery))
	for _, k := range op.AllowedQuery {
		allowed[k] = struct{}{}
	}
	values := url.Values{}
	for k, v := range in {
		if _, ok := allowed[k]; !ok {
			return "", fmt.Errorf("query 参数 %q 不在操作的 allowedQuery 白名单内", k)
		}
		values.Set(k, v)
	}
	return values.Encode(), nil
}

// applyHeaders 透传调用方声明允许的请求头。
// 认证类头永不接受透传：它们由 applyAuth 独占，调用方不得干预。
func applyHeaders(req *http.Request, conn domain.Connector, op domain.Operation, inv domain.Invocation) {
	req.Header.Set("Accept", "application/json")
	if len(inv.Body) > 0 && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	// 让上游能识别流量来源；不带用户身份（那是平台内部信息）
	req.Header.Set("User-Agent", "lumo-connector-gateway/1.0 ("+conn.ID+")")

	allowed := make(map[string]struct{}, len(op.AllowedHeaders))
	for _, h := range op.AllowedHeaders {
		allowed[strings.ToLower(h)] = struct{}{}
	}
	for k, v := range inv.Headers {
		lk := strings.ToLower(k)
		if _, ok := allowed[lk]; !ok {
			continue
		}
		if forbiddenPassthroughHeaders[lk] {
			continue
		}
		req.Header.Set(k, v)
	}
}

// 即便 manifest 把它们写进 allowedHeaders 也不透传：
// 前四个会覆盖网关注入的凭证，后两个能改写路由目标。
var forbiddenPassthroughHeaders = map[string]bool{
	"authorization":       true,
	"proxy-authorization": true,
	"cookie":              true,
	"x-api-key":           true,
	"host":                true,
	"x-forwarded-host":    true,
}

func bytesReader(b []byte) io.Reader {
	if len(b) == 0 {
		return nil
	}
	return bytes.NewReader(b)
}

// encodeBody 把上游响应体包成**总是合法的 JSON**，并说明原样式。
//
// 上游不保证返回 JSON（XML、纯文本、图片都可能），而结果最终要塞进
// 一次工具调用的 JSON 响应里给模型看。与其让调用方去猜，不如显式标注编码。
func encodeBody(raw []byte) (json.RawMessage, domain.BodyEncoding) {
	if len(raw) == 0 {
		return nil, ""
	}
	if json.Valid(raw) {
		return json.RawMessage(raw), domain.EncodingJSON
	}
	if utf8.Valid(raw) {
		if quoted, err := json.Marshal(string(raw)); err == nil {
			return quoted, domain.EncodingText
		}
	}
	// 二进制：base64 后仍是合法 JSON 字符串，模型看得懂「这是二进制」
	if quoted, err := json.Marshal(base64.StdEncoding.EncodeToString(raw)); err == nil {
		return quoted, domain.EncodingBase64
	}
	return nil, ""
}
