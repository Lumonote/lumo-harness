// Package provisioner installs registry plans on a node.
//
// The installer is deliberately small and boring: plan first, download by
// digest, verify again, then rename into place and publish an install-state
// manifest. A partial download is never visible as an installed artifact.
package provisioner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/registry/internal/bundle"
	"github.com/lumo-harness/platform/registry/internal/jsonlzstd"
	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/plan"
)

const installStateFile = "install-state.jsonl.zst"

var skillNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

type Installer struct {
	RegistryURL       string
	InstallDir        string
	NodeID            string
	ControlPlaneToken string
	Client            *http.Client
	// Independently provisioned publisher keys. Desktop agents require this;
	// existing server installations may continue trusting their internal Registry.
	TrustFile string
	// Optional exact closure approved for this node, keyed by name@version.
	PinnedDigests map[string]string
}

// ResolveRollout reads a channel's desired version for one root artifact. It
// is deliberately not an install API: the returned value is only fed back into
// Reconcile, which fetches and verifies a fresh signed plan before any local
// state changes occur.
func (i *Installer) ResolveRollout(ctx context.Context, channel, name string) (string, error) {
	if i.RegistryURL == "" || channel == "" || name == "" {
		return "", errors.New("provisioner: registry、rollout 通道和制品名均为必填")
	}
	endpoint := i.RegistryURL + "/v1/rollouts/" + url.PathEscape(channel) + "/" + url.PathEscape(name)
	if i.NodeID != "" {
		endpoint += "?node_id=" + url.QueryEscape(i.NodeID)
	}
	res, err := i.do(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("provisioner: rollout 返回 HTTP %d", res.StatusCode)
	}
	var body struct {
		Rollout struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Percent int    `json:"percent"`
		} `json:"rollout"`
		Selection *struct {
			NodeID  string `json:"node_id"`
			Version string `json:"version"`
			Cohort  string `json:"cohort"`
		} `json:"selection"`
	}
	dec := json.NewDecoder(io.LimitReader(res.Body, 64<<10))
	if err := dec.Decode(&body); err != nil {
		return "", fmt.Errorf("provisioner: rollout 解析失败: %w", err)
	}
	if body.Rollout.Name != name || body.Rollout.Version == "" || body.Rollout.Percent < 0 || body.Rollout.Percent > 100 {
		return "", errors.New("provisioner: rollout 返回非法目标")
	}
	if body.Rollout.Percent < 100 {
		if i.NodeID == "" {
			return "", errors.New("provisioner: 部分 rollout 需要 PROVISIONER_NODE_ID")
		}
		if body.Selection == nil || body.Selection.NodeID != i.NodeID || body.Selection.Version == "" || (body.Selection.Cohort != "target" && body.Selection.Cohort != "holdback") {
			return "", errors.New("provisioner: rollout 未返回当前节点的有效目标")
		}
		return body.Selection.Version, nil
	}
	if body.Selection != nil && body.Selection.NodeID == i.NodeID && body.Selection.Version != "" {
		return body.Selection.Version, nil
	}
	return body.Rollout.Version, nil
}

type InstallState struct {
	Root        string    `json:"root"`
	Installed   []Item    `json:"installed"`
	InstalledAt time.Time `json:"installedAt"`
}

type Item struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	Digest        string `json:"digest"`
	PayloadDigest string `json:"payload_digest,omitempty"`
	Path          string `json:"path"`
}

type skillSnapshotEntry struct {
	Name           string `json:"name"`
	SHA256         string `json:"sha256"`
	Description    string `json:"description"`
	WhenToUse      string `json:"whenToUse,omitempty"`
	ModelInvocable *bool  `json:"modelInvocable,omitempty"`
	UserInvocable  *bool  `json:"userInvocable,omitempty"`
}

type skillFile struct {
	Name string
	Path string
	Data []byte
}

// Reconcile 将节点本地安装目录收敛到 registry 当前计划。
//
// 安装状态文件只能作为加速提示，真正的现状检查仍重新读取每个 manifest
// 并校验 sha256；这样手工删除、磁盘损坏或半成品都能在下一轮被修复。
// plan 失败会直接返回错误，不会把旧状态伪装成已收敛。
func (i *Installer) Reconcile(ctx context.Context, name, version string, shape plan.Shape) (*InstallState, bool, error) {
	p, err := i.fetchPlan(ctx, name, version, shape)
	if err != nil {
		return nil, false, err
	}
	if state, ok := i.readState(p); ok && i.matchesPlan(p, state) {
		return state, false, nil
	}
	state, err := i.Install(ctx, name, version, shape)
	if err != nil {
		return nil, false, err
	}
	return state, true, nil
}

// Report publishes a node's latest reconcile fact after the installer has
// already performed all signature, plan, digest, and atomic-write checks. It
// deliberately reports only identity/digest facts, never local paths, payload
// bytes, or a raw error that could disclose node topology to a product surface.
func (i *Installer) Report(ctx context.Context, name, version string, shape plan.Shape, state *InstallState, reconcileErr error) error {
	if i.NodeID == "" {
		return errors.New("provisioner: PROVISIONER_NODE_ID 是节点安装状态回报的必填项")
	}
	root := name + "@" + version
	payload := struct {
		NodeID    string `json:"node_id"`
		State     string `json:"state"`
		Root      string `json:"root"`
		Installed []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Digest  string `json:"digest"`
		} `json:"installed"`
		Shape plan.Shape `json:"shape"`
	}{NodeID: i.NodeID, State: "failed", Root: root, Installed: []struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Digest  string `json:"digest"`
	}{}, Shape: shape}
	if reconcileErr == nil {
		if state == nil || state.Root == "" || len(state.Installed) == 0 {
			return errors.New("provisioner: 无法回报空的收敛安装状态")
		}
		payload.State, payload.Root = "converged", state.Root
		payload.Installed = make([]struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Digest  string `json:"digest"`
		}, 0, len(state.Installed))
		for _, item := range state.Installed {
			payload.Installed = append(payload.Installed, struct {
				Name    string `json:"name"`
				Version string `json:"version"`
				Digest  string `json:"digest"`
			}{Name: item.Name, Version: item.Version, Digest: item.Digest})
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("provisioner: 序列化安装状态回报失败: %w", err)
	}
	res, err := i.do(ctx, http.MethodPost, i.RegistryURL+"/v1/installations", strings.NewReader(string(raw)))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		return fmt.Errorf("provisioner: 安装状态回报返回 HTTP %d", res.StatusCode)
	}
	return nil
}

func (i *Installer) readState(p *plan.Plan) (*InstallState, bool) {
	raw, err := os.ReadFile(filepath.Join(i.InstallDir, installStateFile))
	if err != nil {
		return nil, false
	}
	state, err := decodeInstallState(raw)
	if err != nil || state.Root != p.Root || len(state.Installed) != len(p.Items) {
		return nil, false
	}
	return state, true
}

func (i *Installer) matchesPlan(p *plan.Plan, state *InstallState) bool {
	byKey := make(map[string]Item, len(state.Installed))
	for _, installed := range state.Installed {
		byKey[installed.Name+"\x00"+installed.Version] = installed
	}
	for _, desired := range p.Items {
		installed, ok := byKey[desired.Name+"\x00"+desired.Version]
		if !ok || installed.Digest != desired.Digest {
			return false
		}
		path := filepath.Join(i.InstallDir, desired.Name, desired.Version, "manifest.json")
		raw, err := os.ReadFile(path)
		if err != nil || digest(raw) != desired.Digest {
			return false
		}
		m, err := manifest.Parse(raw)
		if err != nil || m.Name != desired.Name || m.Version != desired.Version {
			return false
		}
		if m.PayloadDigest != installed.PayloadDigest {
			return false
		}
		if m.PayloadDigest != "" && !i.matchesPayload(filepath.Dir(path), m.PayloadDigest) {
			return false
		}
	}
	return i.matchesSkillSnapshot(p)
}

func New(registryURL, installDir string) *Installer {
	return &Installer{RegistryURL: strings.TrimRight(registryURL, "/"), InstallDir: installDir,
		Client: observability.ConfiguredHTTPClient(30 * time.Second)}
}

func (i *Installer) Install(ctx context.Context, name, version string, shape plan.Shape) (*InstallState, error) {
	if i.RegistryURL == "" || i.InstallDir == "" || name == "" || version == "" {
		return nil, errors.New("provisioner: registry、安装目录、制品名和版本均为必填")
	}
	p, err := i.fetchPlan(ctx, name, version, shape)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(i.InstallDir, 0o755); err != nil {
		return nil, fmt.Errorf("provisioner: 创建安装目录失败: %w", err)
	}
	state := &InstallState{Root: p.Root, InstalledAt: time.Now().UTC(), Installed: make([]Item, 0, len(p.Items))}
	for _, item := range p.Items {
		raw, err := i.fetchBlob(ctx, item.Digest)
		if err != nil {
			return nil, fmt.Errorf("provisioner: 下载 %s@%s 失败: %w", item.Name, item.Version, err)
		}
		if got := digest(raw); got != item.Digest {
			return nil, fmt.Errorf("provisioner: %s@%s digest 不匹配，期望 %s，实际 %s", item.Name, item.Version, item.Digest, got)
		}
		m, err := manifest.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("provisioner: %s@%s manifest 非法: %w", item.Name, item.Version, err)
		}
		if m.Name != item.Name || m.Version != item.Version {
			return nil, fmt.Errorf("provisioner: plan 项目 %s@%s 与 manifest %s@%s 不一致", item.Name, item.Version, m.Name, m.Version)
		}
		dir := filepath.Join(i.InstallDir, item.Name, item.Version)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("provisioner: 创建 %s 失败: %w", item.Name, err)
		}
		if m.PayloadDigest != "" {
			payload, err := i.fetchBlob(ctx, m.PayloadDigest)
			if err != nil {
				return nil, fmt.Errorf("provisioner: 下载 %s@%s payload 失败: %w", item.Name, item.Version, err)
			}
			if got := digest(payload); got != m.PayloadDigest {
				return nil, fmt.Errorf("provisioner: %s@%s payload digest 不匹配，期望 %s，实际 %s", item.Name, item.Version, m.PayloadDigest, got)
			}
			parsed, err := bundle.Decode(payload)
			if err != nil {
				return nil, fmt.Errorf("provisioner: %s@%s payload 非法: %w", item.Name, item.Version, err)
			}
			if parsed.Header.Bundle != m.Name || parsed.Header.Version != m.Version {
				return nil, fmt.Errorf("provisioner: %s@%s payload header 不匹配", item.Name, item.Version)
			}
			if err := materializePayload(dir, payload, parsed); err != nil {
				return nil, fmt.Errorf("provisioner: 落盘 %s@%s payload 失败: %w", item.Name, item.Version, err)
			}
		} else if err := removePayload(dir); err != nil {
			return nil, fmt.Errorf("provisioner: 清理 %s@%s payload 失败: %w", item.Name, item.Version, err)
		}
		path := filepath.Join(dir, "manifest.json")
		if err := writeFileAtomic(path, raw); err != nil {
			return nil, fmt.Errorf("provisioner: 原子安装 %s@%s 失败: %w", item.Name, item.Version, err)
		}
		state.Installed = append(state.Installed, Item{Name: item.Name, Version: item.Version, Digest: item.Digest, PayloadDigest: m.PayloadDigest, Path: path})
	}
	if err := i.materializeSkillSnapshot(p); err != nil {
		return nil, err
	}
	stateRaw, err := encodeInstallState(state)
	if err != nil {
		return nil, err
	}
	statePath := filepath.Join(i.InstallDir, installStateFile)
	if err := writeFileAtomic(statePath, stateRaw); err != nil {
		return nil, fmt.Errorf("provisioner: 发布安装状态失败: %w", err)
	}
	return state, nil
}

type stateHeaderRecord struct {
	Type          string    `json:"type"`
	SchemaVersion int       `json:"schema_version"`
	Root          string    `json:"root"`
	InstalledAt   time.Time `json:"installed_at"`
}

type stateItemRecord struct {
	Type string `json:"type"`
	Item
}

type stateFooterRecord struct {
	Type           string `json:"type"`
	InstalledCount int    `json:"installed_count"`
}

// encodeInstallState keeps local state in the same bounded JSONL+zstd envelope
// as Bundle exports.  It is an optimization cache, not a trust root: each
// manifest is still digest-checked against a freshly fetched Registry plan.
func encodeInstallState(state *InstallState) ([]byte, error) {
	if state == nil || state.Root == "" {
		return nil, errors.New("provisioner: 安装状态为空")
	}
	records := make([]json.RawMessage, 0, len(state.Installed)+2)
	header, err := json.Marshal(stateHeaderRecord{Type: "install-state-header", SchemaVersion: 1, Root: state.Root, InstalledAt: state.InstalledAt})
	if err != nil {
		return nil, err
	}
	records = append(records, header)
	for _, item := range state.Installed {
		if item.Name == "" || item.Version == "" || item.Digest == "" || item.Path == "" {
			return nil, errors.New("provisioner: 安装状态含不完整项目")
		}
		raw, err := json.Marshal(stateItemRecord{Type: "installed", Item: item})
		if err != nil {
			return nil, err
		}
		records = append(records, raw)
	}
	footer, err := json.Marshal(stateFooterRecord{Type: "install-state-footer", InstalledCount: len(state.Installed)})
	if err != nil {
		return nil, err
	}
	records = append(records, footer)
	return jsonlzstd.Encode(records, jsonlzstd.Limits{})
}

func decodeInstallState(raw []byte) (*InstallState, error) {
	records, err := jsonlzstd.Decode(raw, jsonlzstd.Limits{})
	if err != nil {
		return nil, err
	}
	state := &InstallState{}
	phase := 0 // header, items, footer
	for _, rawRecord := range records {
		var envelope struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(rawRecord, &envelope); err != nil {
			return nil, fmt.Errorf("provisioner: install-state record type 解析失败: %w", err)
		}
		switch envelope.Type {
		case "install-state-header":
			if phase != 0 {
				return nil, errors.New("provisioner: install-state header 顺序非法")
			}
			var header stateHeaderRecord
			if err := decodeStateRecord(rawRecord, &header); err != nil {
				return nil, err
			}
			if header.SchemaVersion != 1 || header.Root == "" || header.InstalledAt.IsZero() {
				return nil, errors.New("provisioner: install-state header 非法")
			}
			state.Root, state.InstalledAt = header.Root, header.InstalledAt
			phase = 1
		case "installed":
			if phase != 1 {
				return nil, errors.New("provisioner: installed record 顺序非法")
			}
			var record stateItemRecord
			if err := decodeStateRecord(rawRecord, &record); err != nil {
				return nil, err
			}
			if record.Name == "" || record.Version == "" || record.Digest == "" || record.Path == "" {
				return nil, errors.New("provisioner: installed record 不完整")
			}
			state.Installed = append(state.Installed, record.Item)
		case "install-state-footer":
			if phase != 1 {
				return nil, errors.New("provisioner: install-state footer 顺序非法")
			}
			var footer stateFooterRecord
			if err := decodeStateRecord(rawRecord, &footer); err != nil {
				return nil, err
			}
			if footer.InstalledCount != len(state.Installed) {
				return nil, errors.New("provisioner: install-state footer 项目计数不符")
			}
			phase = 2
		default:
			return nil, fmt.Errorf("provisioner: 未知 install-state record type %q", envelope.Type)
		}
	}
	if phase != 2 {
		return nil, errors.New("provisioner: install-state 缺 footer")
	}
	return state, nil
}

func decodeStateRecord(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("provisioner: install-state record 解析失败: %w", err)
	}
	return nil
}

func (i *Installer) fetchPlan(ctx context.Context, name, version string, shape plan.Shape) (*plan.Plan, error) {
	body, err := json.Marshal(struct {
		Name    string     `json:"name"`
		Version string     `json:"version"`
		Shape   plan.Shape `json:"shape"`
	}{name, version, shape})
	if err != nil {
		return nil, err
	}
	res, err := i.do(ctx, http.MethodPost, i.RegistryURL+"/v1/plan", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("provisioner: plan 返回 HTTP %d", res.StatusCode)
	}
	var p plan.Plan
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&p); err != nil {
		return nil, fmt.Errorf("provisioner: plan 解析失败: %w", err)
	}
	if i.TrustFile != "" {
		return i.verifyPlan(ctx, &p, name, version, shape)
	}
	return &p, nil
}

func (i *Installer) fetchBlob(ctx context.Context, digest string) ([]byte, error) {
	res, err := i.do(ctx, http.MethodGet, i.RegistryURL+"/v1/blobs/"+digest, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("blob 返回 HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 64<<20 {
		return nil, errors.New("blob 超过 64 MiB")
	}
	return raw, nil
}

func (i *Installer) do(ctx context.Context, method, endpoint string, body io.Reader) (*http.Response, error) {
	client := i.Client
	if client == nil {
		client = observability.ConfiguredHTTPClient(30 * time.Second)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if i.ControlPlaneToken != "" {
		req.Header.Set("Authorization", "Bearer "+i.ControlPlaneToken)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("provisioner: registry 请求失败: %w", err)
	}
	return res, nil
}

func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func materializePayload(dir string, raw []byte, parsed *bundle.Bundle) error {
	staging, err := os.MkdirTemp(dir, ".payload-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(staging) }()
	for _, entry := range parsed.Entries {
		payload, err := bundle.EntryBytes(entry)
		if err != nil {
			return err
		}
		target := filepath.Join(staging, filepath.FromSlash(entry.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, payload, 0o644); err != nil {
			return err
		}
	}
	if err := replaceDirectory(staging, filepath.Join(dir, "payload")); err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, "bundle.jsonl.zst"), raw); err != nil {
		return err
	}
	return nil
}

func removePayload(dir string) error {
	if err := os.RemoveAll(filepath.Join(dir, "payload")); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, "bundle.jsonl.zst")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func replaceDirectory(staging, target string) error {
	backup := target + ".previous"
	if err := os.RemoveAll(backup); err != nil {
		return err
	}
	hadTarget := false
	if _, err := os.Lstat(target); err == nil {
		hadTarget = true
		if err := os.Rename(target, backup); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(staging, target); err != nil {
		if hadTarget {
			_ = os.Rename(backup, target)
		}
		return err
	}
	if hadTarget {
		return os.RemoveAll(backup)
	}
	return nil
}

func writeFileAtomic(path string, raw []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err = tmp.Write(raw); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func (i *Installer) matchesPayload(dir, expectedDigest string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "bundle.jsonl.zst"))
	if err != nil || digest(raw) != expectedDigest {
		return false
	}
	parsed, err := bundle.Decode(raw)
	if err != nil {
		return false
	}
	for _, entry := range parsed.Entries {
		expected, err := bundle.EntryBytes(entry)
		if err != nil {
			return false
		}
		path := filepath.Join(dir, "payload", filepath.FromSlash(entry.Path))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(actual, expected) {
			return false
		}
	}
	return true
}

// matchesPayloadEntry binds a runtime entrypoint to one concrete, signed
// bundle entry. matchesPayload deliberately permits a bundle to contain many
// files; this narrower check prevents a manifest from selecting a path that
// the bundle never supplied.
func (i *Installer) matchesPayloadEntry(dir, expectedDigest, entryPath string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "bundle.jsonl.zst"))
	if err != nil || digest(raw) != expectedDigest {
		return false
	}
	parsed, err := bundle.Decode(raw)
	if err != nil {
		return false
	}
	for _, entry := range parsed.Entries {
		if entry.Path != entryPath {
			continue
		}
		expected, err := bundle.EntryBytes(entry)
		if err != nil {
			return false
		}
		path := filepath.Join(dir, "payload", filepath.FromSlash(entry.Path))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		actual, err := os.ReadFile(path)
		return err == nil && bytes.Equal(actual, expected)
	}
	return false
}

func (i *Installer) materializeSkillSnapshot(p *plan.Plan) error {
	files, entries, err := i.skillSnapshot(p)
	if err != nil {
		return err
	}
	staging, err := os.MkdirTemp(i.InstallDir, ".skills-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(staging) }()
	for _, file := range files {
		target := filepath.Join(staging, file.Name, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, file.Data, 0o644); err != nil {
			return err
		}
	}
	if err := replaceDirectory(staging, filepath.Join(i.InstallDir, "skills")); err != nil {
		return err
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(i.InstallDir, "skill-snapshot.json"), raw)
}

func (i *Installer) matchesSkillSnapshot(p *plan.Plan) bool {
	files, entries, err := i.skillSnapshot(p)
	if err != nil {
		return false
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		return false
	}
	actual, err := os.ReadFile(filepath.Join(i.InstallDir, "skill-snapshot.json"))
	if err != nil || !bytes.Equal(actual, raw) {
		return false
	}
	expectedNames := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		expectedNames[entry.Name] = struct{}{}
	}
	directories, err := os.ReadDir(filepath.Join(i.InstallDir, "skills"))
	if err != nil || len(directories) != len(expectedNames) {
		return false
	}
	for _, directory := range directories {
		if !directory.IsDir() {
			return false
		}
		if _, expected := expectedNames[directory.Name()]; !expected {
			return false
		}
	}
	for _, file := range files {
		path := filepath.Join(i.InstallDir, "skills", file.Name, filepath.FromSlash(file.Path))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(actual, file.Data) {
			return false
		}
	}
	return true
}

func (i *Installer) skillSnapshot(p *plan.Plan) ([]skillFile, []skillSnapshotEntry, error) {
	files := []skillFile{}
	entries := []skillSnapshotEntry{}
	seenFiles := map[string]struct{}{}
	seenSkills := map[string]struct{}{}
	skillFiles := map[string]bool{}
	for _, item := range p.Items {
		dir := filepath.Join(i.InstallDir, item.Name, item.Version)
		manifestRaw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err != nil {
			return nil, nil, err
		}
		m, err := manifest.Parse(manifestRaw)
		if err != nil {
			return nil, nil, err
		}
		if m.PayloadDigest == "" {
			continue
		}
		bundleRaw, err := os.ReadFile(filepath.Join(dir, "bundle.jsonl.zst"))
		if err != nil || digest(bundleRaw) != m.PayloadDigest {
			return nil, nil, fmt.Errorf("provisioner: %s@%s payload 缺失或损坏", item.Name, item.Version)
		}
		parsed, err := bundle.Decode(bundleRaw)
		if err != nil {
			return nil, nil, err
		}
		for _, entry := range parsed.Entries {
			parts := strings.Split(entry.Path, "/")
			if len(parts) < 3 || parts[0] != "skills" {
				continue
			}
			name := parts[1]
			if !skillNameRe.MatchString(name) {
				return nil, nil, fmt.Errorf("provisioner: skill 名 %q 非法", name)
			}
			payload, err := bundle.EntryBytes(entry)
			if err != nil {
				return nil, nil, err
			}
			relative := strings.Join(parts[2:], "/")
			key := name + "\x00" + relative
			if _, exists := seenFiles[key]; exists {
				return nil, nil, fmt.Errorf("provisioner: skill 文件 %s/%s 重复", name, relative)
			}
			seenFiles[key] = struct{}{}
			files = append(files, skillFile{Name: name, Path: relative, Data: payload})
			if relative != "SKILL.md" {
				continue
			}
			if _, exists := seenSkills[name]; exists {
				return nil, nil, fmt.Errorf("provisioner: skill %q 在闭包中重复", name)
			}
			entry, err := parseSkillSnapshotEntry(name, bundle.Entry{Path: entry.Path, Encoding: entry.Encoding, SHA256: entry.SHA256, Data: entry.Data}, payload)
			if err != nil {
				return nil, nil, err
			}
			seenSkills[name] = struct{}{}
			skillFiles[name] = true
			entries = append(entries, entry)
		}
	}
	for _, file := range files {
		if !skillFiles[file.Name] {
			return nil, nil, fmt.Errorf("provisioner: skill %q 缺少 SKILL.md", file.Name)
		}
	}
	sort.Slice(files, func(left, right int) bool {
		return files[left].Name+"\x00"+files[left].Path < files[right].Name+"\x00"+files[right].Path
	})
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name < entries[right].Name })
	return files, entries, nil
}

func parseSkillSnapshotEntry(name string, bundleEntry bundle.Entry, payload []byte) (skillSnapshotEntry, error) {
	text := string(payload)
	if !strings.HasPrefix(text, "---\n") {
		return skillSnapshotEntry{}, fmt.Errorf("provisioner: skill %q 缺少 frontmatter", name)
	}
	closing := strings.Index(text[4:], "\n---\n")
	if closing < 0 {
		return skillSnapshotEntry{}, fmt.Errorf("provisioner: skill %q frontmatter 未闭合", name)
	}
	header := text[4 : closing+4]
	frontmatter := map[string]string{}
	for _, line := range strings.Split(header, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			frontmatter[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	if frontmatter["name"] != name {
		return skillSnapshotEntry{}, fmt.Errorf("provisioner: skill %q frontmatter name 不匹配", name)
	}
	description := strings.TrimSpace(frontmatter["description"])
	if description == "" {
		return skillSnapshotEntry{}, fmt.Errorf("provisioner: skill %q 缺少 description", name)
	}
	entry := skillSnapshotEntry{Name: name, SHA256: bundleEntry.SHA256, Description: description, WhenToUse: frontmatter["when_to_use"]}
	for key, target := range map[string]**bool{"model_invocable": &entry.ModelInvocable, "user_invocable": &entry.UserInvocable} {
		if value, exists := frontmatter[key]; exists {
			parsed, err := parseBool(value)
			if err != nil {
				return skillSnapshotEntry{}, fmt.Errorf("provisioner: skill %q %s 非法: %w", name, key, err)
			}
			*target = &parsed
		}
	}
	return entry, nil
}

func parseBool(value string) (bool, error) {
	switch value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("应为 true 或 false")
	}
}
