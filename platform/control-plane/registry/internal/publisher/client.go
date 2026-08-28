// Package publisher implements the CI-facing Registry publication sequence.
package publisher

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
)

const maxResponseBytes = 1 << 20

type Client struct {
	base  string
	token string
	http  *http.Client
}

func NewClient(baseURL, token string, client *http.Client) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("publisher: registry URL 必须是绝对 URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("publisher: registry URL 只支持 http(s)")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("publisher: registry URL 不得包含凭证、查询参数或片段")
	}
	if token == "" {
		return nil, fmt.Errorf("publisher: control-plane token 不能为空")
	}
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("publisher: Registry 重定向已禁用")
		}}
	}
	return &Client{base: strings.TrimRight(parsed.String(), "/"), token: token, http: client}, nil
}

func (c *Client) Publish(ctx context.Context, manifestRaw, signature, bundleRaw []byte) ([]byte, error) {
	parsedManifest, err := manifest.Parse(manifestRaw)
	if err != nil {
		return nil, err
	}
	if len(signature) != 64 {
		return nil, fmt.Errorf("publisher: ed25519 签名长度必须为 64 字节，收到 %d", len(signature))
	}
	if parsedManifest.PayloadDigest == "" {
		if len(bundleRaw) != 0 {
			return nil, fmt.Errorf("publisher: manifest 未声明 payload_digest，却提供了 bundle")
		}
	} else {
		if len(bundleRaw) == 0 {
			return nil, fmt.Errorf("publisher: manifest 声明 payload_digest 时必须提供 bundle")
		}
		parsedBundle, err := bundle.Decode(bundleRaw)
		if err != nil {
			return nil, err
		}
		digest := objstore.Digest(bundleRaw)
		if digest != parsedManifest.PayloadDigest {
			return nil, fmt.Errorf("publisher: bundle digest %s 与 manifest payload_digest %s 不一致", digest, parsedManifest.PayloadDigest)
		}
		if parsedBundle.Header.Bundle != parsedManifest.Name || parsedBundle.Header.Version != parsedManifest.Version {
			return nil, fmt.Errorf("publisher: bundle header %s@%s 与 manifest %s@%s 不一致",
				parsedBundle.Header.Bundle, parsedBundle.Header.Version, parsedManifest.Name, parsedManifest.Version)
		}
		response, err := c.post(ctx, "/v1/blobs", "application/octet-stream", bundleRaw)
		if err != nil {
			return nil, err
		}
		var uploaded struct {
			Digest string `json:"digest"`
		}
		if err := json.Unmarshal(response, &uploaded); err != nil || uploaded.Digest != digest {
			return nil, fmt.Errorf("publisher: Registry bundle 回执 digest 无效")
		}
	}

	envelope, err := json.Marshal(map[string]string{
		"manifest_b64": base64.StdEncoding.EncodeToString(manifestRaw),
		"sig_b64":      base64.StdEncoding.EncodeToString(signature),
	})
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "/v1/artifacts", "application/json", envelope)
}

func (c *Client) post(ctx context.Context, path, contentType string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", contentType)
	response, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("publisher: POST %s 失败: %w", path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("publisher: 读取 Registry 响应失败: %w", err)
	}
	if len(raw) > maxResponseBytes {
		return nil, fmt.Errorf("publisher: Registry 响应超过 1 MiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("publisher: POST %s 返回 %d: %s", path, response.StatusCode, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}
