// Package manifest 定义五类制品的 manifest 类型与严格解析。
//
// 本包是 Go 侧执法的唯一依据：安装计划从**原始字节**重新 Parse，
// 再从解析结果读 scope/requires/deps。PG 里的同名字段只供查询，
// 不得进入任何判断——见 specs/2026-08-24-registry-design.md §2。
package manifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// APIVersion 五类制品共用一个 apiVersion，kind 区分类别。
const APIVersion = "lumo.artifact/v1"

// Kind 制品类别。判定树见 architecture.md §4.3：
// 只塑造模型行为→Skill；需要写新代码→Component（另一端是外部系统→Connector）；
// 只连接既有件→Flow；Agent 是引用集合，不与前四类同层。
type Kind string

const (
	KindComponent Kind = "Component"
	KindSkill     Kind = "Skill"
	KindAgent     Kind = "Agent"
	KindConnector Kind = "Connector"
	KindFlow      Kind = "Flow"
)

func (k Kind) valid() bool {
	switch k {
	case KindComponent, KindSkill, KindAgent, KindConnector, KindFlow:
		return true
	}
	return false
}

// Dep 一条依赖：必须锁定确切版本，不接受范围表达式。
// 范围会让「装了什么」在不同时刻得出不同答案，而制品带 scope 权限。
type Dep struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// Requires 部署形态要求（§13.2.3）。不满足时在 plan 阶段拒绝，
// 不允许装上去等运行时 seam 返回 CapabilityUnavailable。
type Requires struct {
	OLAP   bool `json:"olap,omitempty"`
	Graph  bool `json:"graph,omitempty"`
	Vector bool `json:"vector,omitempty"`
	Object bool `json:"object,omitempty"`
	GPU    bool `json:"gpu,omitempty"`
}

// Manifest 制品清单。
type Manifest struct {
	APIVersion    string   `json:"apiVersion"`
	Kind          Kind     `json:"kind"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Publisher     string   `json:"publisher"`
	Scopes        []string `json:"scopes"`
	Requires      Requires `json:"requires,omitempty"`
	Deps          []Dep    `json:"deps,omitempty"`
	PayloadDigest string   `json:"payload_digest,omitempty"`
}

var (
	nameRe    = regexp.MustCompile(`^[a-z][a-z0-9-]{2,63}$`)
	versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	scopeRe   = regexp.MustCompile(`^[a-z][a-z0-9-]*(:[a-z0-9*-]+){1,2}$`)
	digestRe  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// RequiredFields 各类的必填字段名，供与 JSON Schema 的一致性用例比对。
// 五类当前必填集相同；参数留着是因为将来某一类加必填字段时，
// 调用方不必改签名，只需在这里分支。
func RequiredFields(_ Kind) []string {
	return []string{"apiVersion", "kind", "name", "version", "publisher", "scopes"}
}

// Parse 严格解析原始字节。不改写入参，不做规范化重序列化——
// 签名覆盖的对象必须与执法依据的对象逐字节同一。
func Parse(raw []byte) (*Manifest, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fmt.Errorf("registry: manifest 为空字节")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("registry: manifest 解析失败: %w", err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

func (m *Manifest) validate() error {
	if m.APIVersion != APIVersion {
		return fmt.Errorf("registry: apiVersion 必须是 %q，实得 %q", APIVersion, m.APIVersion)
	}
	if !m.Kind.valid() {
		return fmt.Errorf("registry: kind %q 不是五类制品之一", m.Kind)
	}
	if !nameRe.MatchString(m.Name) {
		return fmt.Errorf("registry: name %q 非法（小写字母开头，3-64 位小写字母/数字/连字符）", m.Name)
	}
	if !versionRe.MatchString(m.Version) {
		return fmt.Errorf("registry: version %q 非法（须为 x.y.z 三段数字）", m.Version)
	}
	if strings.TrimSpace(m.Publisher) == "" {
		return fmt.Errorf("registry: publisher 不得为空")
	}
	if len(m.Scopes) == 0 {
		return fmt.Errorf("registry: scopes 不得为空（无声明权限的制品无法做子集检查）")
	}
	if m.PayloadDigest != "" && !digestRe.MatchString(m.PayloadDigest) {
		return fmt.Errorf("registry: payload_digest %q 非法（应为 sha256:<64 位十六进制>）", m.PayloadDigest)
	}
	for _, s := range m.Scopes {
		if !scopeRe.MatchString(s) {
			return fmt.Errorf("registry: scopes 中 %q 格式非法（应形如 kb:query 或 data:read:warehouse）", s)
		}
	}
	seen := map[string]bool{}
	for _, d := range m.Deps {
		if !nameRe.MatchString(d.Name) {
			return fmt.Errorf("registry: deps 中依赖名 %q 非法", d.Name)
		}
		if !versionRe.MatchString(d.Version) {
			return fmt.Errorf("registry: deps 中 %q 的版本 %q 非法（须为 x.y.z，不接受范围）", d.Name, d.Version)
		}
		if d.Name == m.Name {
			return fmt.Errorf("registry: %q 自依赖", m.Name)
		}
		if seen[d.Name] {
			return fmt.Errorf("registry: deps 中 %q 重复声明", d.Name)
		}
		seen[d.Name] = true
	}
	return nil
}
