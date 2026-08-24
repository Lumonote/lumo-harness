package objstore_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/objstore"
)

func TestDigestStable(t *testing.T) {
	d := objstore.Digest([]byte("hello"))
	const want = "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if d != want {
		t.Fatalf("digest 不稳定: 得 %s 期望 %s", d, want)
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	st := objstore.NewFileStore(t.TempDir())
	ctx := context.Background()
	raw := []byte(`{"a":1}`)
	d := objstore.Digest(raw)

	if err := st.Put(ctx, d, raw); err != nil {
		t.Fatalf("Put 失败: %v", err)
	}
	got, err := st.Get(ctx, d)
	if err != nil {
		t.Fatalf("Get 失败: %v", err)
	}
	if string(got) != string(raw) {
		t.Fatalf("取回字节不一致: %q", got)
	}
	ok, err := st.Has(ctx, d)
	if err != nil || !ok {
		t.Fatalf("Has 应为 true: %v %v", ok, err)
	}
}

// TestPutIdempotent 同 digest 重传必须幂等——CI 重跑、发布重试都会打到这里。
func TestPutIdempotent(t *testing.T) {
	st := objstore.NewFileStore(t.TempDir())
	ctx := context.Background()
	raw := []byte("same")
	d := objstore.Digest(raw)
	for i := 0; i < 3; i++ {
		if err := st.Put(ctx, d, raw); err != nil {
			t.Fatalf("第 %d 次 Put 应幂等成功: %v", i, err)
		}
	}
}

// TestPutRejectsWrongDigest 拒绝把字节存到不是它哈希的 key 下。
// 允许这么做等于亲手毁掉内容寻址的全部保证。
func TestPutRejectsWrongDigest(t *testing.T) {
	st := objstore.NewFileStore(t.TempDir())
	err := st.Put(context.Background(), objstore.Digest([]byte("A")), []byte("B"))
	if !errors.Is(err, objstore.ErrDigestMismatch) {
		t.Fatalf("应报 ErrDigestMismatch，实得: %v", err)
	}
}

// TestGetVerifiesOnRead 读路径重新校验哈希。
// 对象存储被篡改要在**取回时**就发现，不能等到验签——
// 验签只覆盖 manifest，而对象存储日后还要放 bundle 二进制。
func TestGetVerifiesOnRead(t *testing.T) {
	root := t.TempDir()
	st := objstore.NewFileStore(root)
	ctx := context.Background()
	raw := []byte("original")
	d := objstore.Digest(raw)
	if err := st.Put(ctx, d, raw); err != nil {
		t.Fatalf("Put 失败: %v", err)
	}

	// 绕过 Put 直接改盘上的字节，模拟对象存储被写穿
	var victim string
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			victim = p
		}
		return nil
	})
	if victim == "" {
		t.Fatal("没找到落盘文件")
	}
	if err := os.WriteFile(victim, []byte("tampered"), 0o644); err != nil {
		t.Fatalf("篡改失败: %v", err)
	}

	if _, err := st.Get(ctx, d); !errors.Is(err, objstore.ErrDigestMismatch) {
		t.Fatalf("被篡改的对象应在读时被发现，实得: %v", err)
	}
}

func TestGetMissing(t *testing.T) {
	st := objstore.NewFileStore(t.TempDir())
	_, err := st.Get(context.Background(), objstore.Digest([]byte("nope")))
	if !errors.Is(err, objstore.ErrNotFound) {
		t.Fatalf("应报 ErrNotFound，实得: %v", err)
	}
}

func TestRejectsMalformedDigest(t *testing.T) {
	st := objstore.NewFileStore(t.TempDir())
	ctx := context.Background()
	for _, bad := range []string{"", "deadbeef", "sha256:", "sha256:zz", "md5:abc", "sha256:../../etc/passwd"} {
		if err := st.Put(ctx, bad, []byte("x")); err == nil {
			t.Fatalf("非法 digest %q 应被拒", bad)
		}
	}
}
