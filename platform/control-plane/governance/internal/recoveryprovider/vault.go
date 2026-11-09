package recoveryprovider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

type VaultTarget struct {
	Endpoint string `json:"endpoint"`
	Mount    string `json:"mount"`
	Key      string `json:"key"`
}
type VaultObservation struct {
	Version                  string      `json:"version"`
	Target                   VaultTarget `json:"target"`
	ObservedAt               time.Time   `json:"observed_at"`
	Status                   string      `json:"status"`
	LatestVersion            int64       `json:"latest_version,omitempty"`
	MinimumDecryptionVersion int64       `json:"min_decryption_version,omitempty"`
	DeletionAllowed          bool        `json:"deletion_allowed"`
}

// ReadVaultKey is strictly GET-only. An absent key is an observation, never a
// destruction receipt, and cannot finish a Governance key_destroy workflow.
func ReadVaultKey(ctx context.Context, target VaultTarget, token string) (VaultObservation, error) {
	var result VaultObservation
	u, err := url.Parse(target.Endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || !identifier.MatchString(target.Mount) || !identifier.MatchString(target.Key) || len(token) < 16 || strings.TrimSpace(token) != token {
		return result, ErrRejected
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || ip == nil || !ip.IsLoopback() {
			return result, ErrRejected
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.Endpoint+"/v1/"+target.Mount+"/keys/"+target.Key, nil)
	if err != nil {
		return result, err
	}
	request.Header.Set("X-Vault-Token", token)
	client := observability.ConfiguredHTTPClient(5 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return result, errors.New("Vault readback unavailable")
	}
	defer response.Body.Close()
	result = VaultObservation{Version: "vault-transit-readback.v1", Target: target, ObservedAt: time.Now().UTC()}
	if response.StatusCode == http.StatusNotFound {
		result.Status = "absent"
		return result, nil
	}
	if response.StatusCode != http.StatusOK {
		return VaultObservation{}, errors.New("Vault readback unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return VaultObservation{}, ErrRejected
	}
	var data struct {
		Data struct {
			Name                     string `json:"name"`
			LatestVersion            int64  `json:"latest_version"`
			MinimumDecryptionVersion int64  `json:"min_decryption_version"`
			DeletionAllowed          bool   `json:"deletion_allowed"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Data.Name != target.Key || data.Data.LatestVersion < 1 || data.Data.MinimumDecryptionVersion < 0 || data.Data.MinimumDecryptionVersion > data.Data.LatestVersion {
		return VaultObservation{}, ErrRejected
	}
	result.Status = "present"
	result.LatestVersion = data.Data.LatestVersion
	result.MinimumDecryptionVersion = data.Data.MinimumDecryptionVersion
	result.DeletionAllowed = data.Data.DeletionAllowed
	return result, nil
}
