package credentials

// VaultStore 是 Standalone/Cluster 形态的凭证 Provider。
// 仅在网关进程内把 Vault 的单个字段兑换为 Secret；ref、token 和响应正文不进入业务日志。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

type VaultStore struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewVaultStore(baseURL, token string) *VaultStore {
	client := observability.ConfiguredHTTPClient(10 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &VaultStore{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client:  client,
	}
}

func (s *VaultStore) Resolve(ctx context.Context, ref string) (Secret, error) {
	if s.baseURL == "" || s.token == "" {
		return Secret{}, fmt.Errorf("credentials: Vault 地址或 token 未配置")
	}
	path, field := splitVaultRef(ref)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.baseURL+"/v1/"+strings.TrimLeft(path, "/"), nil)
	if err != nil {
		return Secret{}, fmt.Errorf("credentials: 创建 Vault 请求失败: %w", err)
	}
	req.Header.Set("X-Vault-Token", s.token)
	res, err := s.client.Do(req)
	if err != nil {
		return Secret{}, fmt.Errorf("credentials: Vault 请求失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return Secret{}, fmt.Errorf("credentials: Vault 返回 HTTP %d", res.StatusCode)
	}
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&envelope); err != nil {
		return Secret{}, fmt.Errorf("credentials: Vault 响应解析失败: %w", err)
	}
	if nested, exists := envelope.Data["data"]; exists && envelope.Data["metadata"] != nil {
		if err := json.Unmarshal(nested, &envelope.Data); err != nil {
			return Secret{}, fmt.Errorf("credentials: invalid Vault KV v2 data")
		}
	}
	raw, ok := envelope.Data[field]
	if !ok {
		return Secret{}, fmt.Errorf("credentials: Vault 字段 %q 不存在", field)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return Secret{}, fmt.Errorf("credentials: Vault 字段 %q 不是字符串", field)
	}
	if value == "" {
		return Secret{}, fmt.Errorf("credentials: Vault 字段 %q 为空", field)
	}
	return NewSecret(value), nil
}

// KV2 reads and writes only operator-selected KV v2 locations. Callers must
// construct keys from server-owned identifiers, never from browser paths.
func (s *VaultStore) KV2(ctx context.Context, method, mount, key string, value any) ([]byte, error) {
	if s.baseURL == "" || s.token == "" {
		return nil, fmt.Errorf("credentials: Vault is not configured")
	}
	for _, path := range []string{mount, key} {
		if path == "" || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
			return nil, fmt.Errorf("credentials: invalid Vault path")
		}
		for _, segment := range strings.Split(path, "/") {
			if segment == "" || segment == "." || segment == ".." || strings.ContainsAny(segment, "?#%\\\r\n") {
				return nil, fmt.Errorf("credentials: invalid Vault path")
			}
		}
	}
	var body []byte
	if value != nil {
		var err error
		body, err = json.Marshal(map[string]any{"data": value, "options": map[string]int{"cas": 0}})
		if err != nil {
			return nil, fmt.Errorf("credentials: invalid Vault payload")
		}
	}
	section := "data"
	if method == http.MethodDelete {
		section = "metadata"
	}
	req, err := http.NewRequestWithContext(ctx, method, s.baseURL+"/v1/"+mount+"/"+section+"/"+key, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("credentials: invalid Vault request")
	}
	req.Header.Set("X-Vault-Token", s.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("credentials: Vault request failed")
	}
	defer res.Body.Close()
	if method == http.MethodDelete && res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("credentials: Vault HTTP %d", res.StatusCode)
	}
	if method != http.MethodGet {
		return nil, nil
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return nil, fmt.Errorf("credentials: invalid Vault response")
	}
	var envelope struct {
		Data struct {
			Data json.RawMessage `json:"data"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &envelope) != nil || len(envelope.Data.Data) == 0 {
		return nil, fmt.Errorf("credentials: invalid Vault KV v2 response")
	}
	return envelope.Data.Data, nil
}

func splitVaultRef(ref string) (path, field string) {
	parts := strings.SplitN(strings.TrimSpace(ref), "#", 2)
	if len(parts) == 1 || parts[1] == "" {
		return parts[0], "value"
	}
	return parts[0], parts[1]
}
