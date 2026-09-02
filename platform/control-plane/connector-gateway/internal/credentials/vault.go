package credentials

// VaultStore 是 Standalone/Cluster 形态的凭证 Provider。
// 仅在网关进程内把 Vault 的单个字段兑换为 Secret；ref、token 和响应正文不进入业务日志。

import (
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
	return &VaultStore{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client:  observability.ConfiguredHTTPClient(10 * time.Second),
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

func splitVaultRef(ref string) (path, field string) {
	parts := strings.SplitN(strings.TrimSpace(ref), "#", 2)
	if len(parts) == 1 || parts[1] == "" {
		return parts[0], "value"
	}
	return parts[0], parts[1]
}
