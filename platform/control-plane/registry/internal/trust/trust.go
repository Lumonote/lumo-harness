// Package trust 签名校验与发布者信任表。
//
// 信任根**从配置文件加载，不从数据库读**。设计说明 §2 的论证是
// 「PG 是索引不是真相源」；若把公钥表也放 PG，那么写穿数据库
// = 换掉信任根 = 之前所有关于「篡改元数据无效」的论证全部作废。
// 公钥应随部署配置或 Vault 下发，与制品数据分属不同的失陷域。
package trust

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

var (
	// ErrUnknownPublisher 发布者不在信任表内。
	ErrUnknownPublisher = errors.New("registry: 发布者不在信任表内")
	// ErrBadSignature 签名校验失败。
	ErrBadSignature = errors.New("registry: 签名校验失败")
	// ErrScopeEscalation 制品申请的 scope 超出发布者自身上限。
	ErrScopeEscalation = errors.New("registry: scope 超出发布者上限")
)

// Publisher 一个发布者的公钥与其可授予的 scope 上限。
type Publisher struct {
	ID        string
	PublicKey ed25519.PublicKey
	MaxScopes []string
}

// Store 信任表。构造后只读，无需加锁。
type Store struct{ byID map[string]Publisher }

// NewStore 从内存构造，供测试与装配层使用。
func NewStore(pubs []Publisher) *Store {
	m := make(map[string]Publisher, len(pubs))
	for _, p := range pubs {
		m[p.ID] = p
	}
	return &Store{byID: m}
}

type fileFormat struct {
	Publishers []struct {
		ID        string   `json:"id"`
		PublicKey string   `json:"public_key"`
		MaxScopes []string `json:"max_scopes"`
	} `json:"publishers"`
}

// LoadFile 从 JSON 配置加载信任表。
func LoadFile(path string) (*Store, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("registry: 读信任表 %s 失败: %w", path, err)
	}
	var doc fileFormat
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("registry: 信任表不是合法 JSON: %w", err)
	}
	pubs := make([]Publisher, 0, len(doc.Publishers))
	for _, p := range doc.Publishers {
		key, err := base64.StdEncoding.DecodeString(p.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("registry: 发布者 %q 的公钥不是合法 base64: %w", p.ID, err)
		}
		if len(key) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("registry: 发布者 %q 的公钥长度 %d，ed25519 要求 %d", p.ID, len(key), ed25519.PublicKeySize)
		}
		pubs = append(pubs, Publisher{ID: p.ID, PublicKey: ed25519.PublicKey(key), MaxScopes: p.MaxScopes})
	}
	return NewStore(pubs), nil
}

// Lookup 查发布者。
func (s *Store) Lookup(id string) (*Publisher, bool) {
	p, ok := s.byID[id]
	if !ok {
		return nil, false
	}
	return &p, true
}

// Verify 用发布者公钥校验对 raw 的签名。raw 必须是**上传时的原始字节**，
// 不得是重序列化的产物。
func (s *Store) Verify(publisherID string, raw, sig []byte) error {
	p, ok := s.Lookup(publisherID)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownPublisher, publisherID)
	}
	if !ed25519.Verify(p.PublicKey, raw, sig) {
		return fmt.Errorf("%w: 发布者 %q", ErrBadSignature, publisherID)
	}
	return nil
}

// ScopesWithin 检查 granted 是否都被 max 覆盖，返回第一个越权项。
// 通配只支持末段 "*"，且**不跨冒号段**：data:read:* 覆盖 data:read:warehouse，
// 但不覆盖 data:write:warehouse。跨段通配会让 "*" 变成静默的全权授予。
func ScopesWithin(granted, max []string) (string, bool) {
	for _, g := range granted {
		if !coveredBy(g, max) {
			return g, false
		}
	}
	return "", true
}

func coveredBy(scope string, max []string) bool {
	gs := strings.Split(scope, ":")
	for _, m := range max {
		ms := strings.Split(m, ":")
		if len(ms) != len(gs) {
			continue
		}
		match := true
		for i := range ms {
			if ms[i] == "*" || ms[i] == gs[i] {
				continue
			}
			match = false
			break
		}
		if match {
			return true
		}
	}
	return false
}
