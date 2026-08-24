// Package objstore 内容寻址对象存储：key 就是内容的 sha256。
//
// 三条不变量：
//   - Put 校验 digest 与内容相符——否则内容寻址的保证当场失效
//   - Get 重新校验——被写穿的对象存储要在取回时发现，不能指望下游验签
//   - 同 digest 重传幂等——发布重试、CI 重跑都会打到这条
package objstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var (
	// ErrDigestMismatch 内容与 digest 不符（写入时参数错，或读取时对象被篡改）。
	ErrDigestMismatch = errors.New("registry: 内容与 digest 不符")
	// ErrNotFound 对象不存在。
	ErrNotFound = errors.New("registry: 对象不存在")
)

var digestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Digest 计算内容地址。
func Digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ValidDigest 校验 digest 字面格式。路径拼接前必须过这一关，
// 否则 "sha256:../.." 之类会变成目录穿越。
func ValidDigest(d string) bool { return digestRe.MatchString(d) }

// Store 内容寻址存储。
type Store interface {
	Put(ctx context.Context, digest string, raw []byte) error
	Get(ctx context.Context, digest string) ([]byte, error)
	Has(ctx context.Context, digest string) (bool, error)
}

// FileStore 本地文件实现：Local-lite 形态与全部单元测试用它。
type FileStore struct{ root string }

// NewFileStore 建本地存储，root 不存在时在首次写入时创建。
func NewFileStore(root string) *FileStore { return &FileStore{root: root} }

// path 把 digest 映射为两级目录，避免单目录下文件过多。
func (s *FileStore) path(digest string) (string, error) {
	if !ValidDigest(digest) {
		return "", fmt.Errorf("registry: digest %q 格式非法（应为 sha256:<64 位十六进制>）", digest)
	}
	hexPart := digest[len("sha256:"):]
	return filepath.Join(s.root, hexPart[:2], hexPart[2:]), nil
}

// Put 写入。digest 与内容不符直接拒；同 digest 重传幂等。
func (s *FileStore) Put(_ context.Context, digest string, raw []byte) error {
	p, err := s.path(digest)
	if err != nil {
		return err
	}
	if Digest(raw) != digest {
		return fmt.Errorf("%w: 声称 %s，实际 %s", ErrDigestMismatch, digest, Digest(raw))
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("registry: 建目录失败: %w", err)
	}
	// 内容寻址下同 key 必然同内容，已存在即幂等成功
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("registry: 写临时文件失败: %w", err)
	}
	if err := os.Rename(tmp, p); err != nil {
		return fmt.Errorf("registry: 落位失败: %w", err)
	}
	return nil
}

// Get 读取并**重新校验**内容与 digest 是否相符。
func (s *FileStore) Get(_ context.Context, digest string) ([]byte, error) {
	p, err := s.path(digest)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, digest)
	}
	if err != nil {
		return nil, fmt.Errorf("registry: 读对象失败: %w", err)
	}
	if got := Digest(raw); got != digest {
		return nil, fmt.Errorf("%w: 期望 %s，落盘内容实为 %s（对象存储被篡改）", ErrDigestMismatch, digest, got)
	}
	return raw, nil
}

// Has 探测对象是否存在。
func (s *FileStore) Has(_ context.Context, digest string) (bool, error) {
	p, err := s.path(digest)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("registry: 探测对象失败: %w", err)
	}
	return true, nil
}
