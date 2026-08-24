package objstore_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/objstore"
)

func s3FromEnv(t *testing.T) *objstore.S3Store {
	t.Helper()
	ep := os.Getenv("LUMO_TEST_S3_ENDPOINT")
	if ep == "" {
		t.Skip("LUMO_TEST_S3_ENDPOINT 未设置，跳过活对象存储测试")
	}
	s, err := objstore.NewS3Store(ep,
		os.Getenv("LUMO_TEST_S3_ACCESS_KEY"),
		os.Getenv("LUMO_TEST_S3_SECRET_KEY"),
		"lumo-registry-test", false)
	if err != nil {
		t.Fatalf("连对象存储失败: %v", err)
	}
	return s
}

func TestS3RoundTrip(t *testing.T) {
	ctx := context.Background()
	s := s3FromEnv(t)
	raw := []byte(`{"hello":"世界"}`)
	d := objstore.Digest(raw)

	if err := s.Put(ctx, d, raw); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	// 同 digest 重传必须幂等。
	if err := s.Put(ctx, d, raw); err != nil {
		t.Fatalf("重传应幂等: %v", err)
	}
	got, err := s.Get(ctx, d)
	if err != nil {
		t.Fatalf("下载失败: %v", err)
	}
	if string(got) != string(raw) {
		t.Fatal("取回字节不一致")
	}
	ok, err := s.Has(ctx, d)
	if err != nil || !ok {
		t.Fatalf("Has 应为 true: %v %v", ok, err)
	}
}

func TestS3PutRejectsDigestMismatch(t *testing.T) {
	ctx := context.Background()
	s := s3FromEnv(t)
	err := s.Put(ctx, objstore.Digest([]byte("a")), []byte("b"))
	if !errors.Is(err, objstore.ErrDigestMismatch) {
		t.Fatalf("digest 与内容不符必须被拒，得到: %v", err)
	}
}

func TestS3GetNotFound(t *testing.T) {
	ctx := context.Background()
	s := s3FromEnv(t)
	// 一个格式合法但必然不存在的 digest。
	_, err := s.Get(ctx, "sha256:"+strings.Repeat("f", 64))
	if !errors.Is(err, objstore.ErrNotFound) {
		t.Fatalf("不存在的对象应返回 ErrNotFound，得到: %v", err)
	}
}

func TestS3HasFalseForMissing(t *testing.T) {
	ctx := context.Background()
	s := s3FromEnv(t)
	ok, err := s.Has(ctx, "sha256:"+strings.Repeat("e", 64))
	if err != nil {
		t.Fatalf("Has 对不存在的对象不应报错: %v", err)
	}
	if ok {
		t.Fatal("Has 应为 false")
	}
}
