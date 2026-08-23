// Package credentials 凭证兑换（§15：凭证在 Vault，绝不进 prompt）。
//
// 网关是**唯一**能把 credentialRef 兑换成明文的地方：manifest 存引用，
// 审计存引用，日志存引用，只有出站请求头里才出现明文，且随请求即弃。
//
// 形态替代（铁律 21）：Local-lite 从进程环境变量取；Standalone+ 换 Vault
// 实现同一 Store 接口，Gateway 代码不变。
package credentials

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Secret 明文凭证。刻意实现 String()/GoString() 返回掩码：
// 任何 %v/%s/日志/panic 栈打印都不会泄露真值，只有 Reveal() 会。
type Secret struct {
	value string
}

func NewSecret(v string) Secret { return Secret{value: v} }

// Reveal 取明文。调用点应当极少 —— 目前只有出站请求头组装一处。
func (s Secret) Reveal() string { return s.value }

func (s Secret) Empty() bool { return s.value == "" }

func (s Secret) String() string   { return "«redacted»" }
func (s Secret) GoString() string { return "«redacted»" }

// Store 凭证解析接口。
type Store interface {
	Resolve(ctx context.Context, ref string) (Secret, error)
}

// EnvStore Local-lite 实现：ref → 环境变量。
//
// 为什么不落 PG：凭证一旦静态落库就需要加密、轮换、审计三件套，
// 那正是 Vault 的活儿。本地形态直接读环境变量，**不做半吊子的自研密钥库**。
type EnvStore struct {
	prefix string
}

func NewEnvStore(prefix string) *EnvStore {
	if prefix == "" {
		prefix = "LUMO_CRED_"
	}
	return &EnvStore{prefix: prefix}
}

func (s *EnvStore) Resolve(_ context.Context, ref string) (Secret, error) {
	name := s.prefix + envSafe(ref)
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		// 响亮失败：凭证缺失就是配置错误，不能降级成「匿名调用上游」
		return Secret{}, fmt.Errorf("credentials: 环境变量 %s 未设置（ref=%s）", name, ref)
	}
	return Secret{value: v}, nil
}

// envSafe 把 Vault 风格路径（secret/data/jira#token）映射成合法环境变量名。
// 同一个 ref 在两种形态下写法一致，切 Vault 时 manifest 不用改。
func envSafe(ref string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(ref)) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

type cached struct {
	secret Secret
	at     time.Time
}

// CachingStore 给任意 Store 加短 TTL 缓存，避免每次外部调用都打一次 Vault。
// TTL 必须短：轮换后的凭证要能快速生效。
type CachingStore struct {
	inner Store
	ttl   time.Duration

	mu   sync.RWMutex
	seen map[string]cached
}

func NewCaching(inner Store, ttl time.Duration) *CachingStore {
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	return &CachingStore{inner: inner, ttl: ttl, seen: map[string]cached{}}
}

func (c *CachingStore) Resolve(ctx context.Context, ref string) (Secret, error) {
	c.mu.RLock()
	hit, ok := c.seen[ref]
	c.mu.RUnlock()
	if ok && time.Since(hit.at) < c.ttl {
		return hit.secret, nil
	}
	s, err := c.inner.Resolve(ctx, ref)
	if err != nil {
		return Secret{}, err
	}
	c.mu.Lock()
	c.seen[ref] = cached{secret: s, at: time.Now()}
	c.mu.Unlock()
	return s, nil
}
