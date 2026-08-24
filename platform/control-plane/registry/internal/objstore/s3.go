package objstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Store 是 Store 的 MinIO/S3 实现。
//
// 与 FileStore 遵守同样的三条不变量，其中「Get 时重新校验」在这里尤其要紧：
// 对象存储是运维可达的，网络中间人、误操作、版本回滚都可能让取回的字节
// 不是当初写进去的那份。内容寻址给了免费的校验手段，不用白不用。
type S3Store struct {
	cli    *minio.Client
	bucket string
}

// NewS3Store 建客户端并确保桶存在。
func NewS3Store(endpoint, accessKey, secretKey, bucket string, useSSL bool) (*S3Store, error) {
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("registry: 建对象存储客户端失败: %w", err)
	}
	ctx := context.Background()
	exists, err := cli.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("registry: 探测桶失败: %w", err)
	}
	if !exists {
		if err := cli.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("registry: 建桶失败: %w", err)
		}
	}
	return &S3Store{cli: cli, bucket: bucket}, nil
}

func (s *S3Store) key(digest string) (string, error) {
	if !ValidDigest(digest) {
		return "", fmt.Errorf("registry: digest %q 格式非法（应为 sha256:<64 位十六进制>）", digest)
	}
	h := digest[len("sha256:"):]
	return h[0:2] + "/" + h[2:4] + "/" + h, nil
}

// isNoSuchKey 判断错误是否为「对象不存在」。
// minio-go 返回值类型 ErrorResponse（非指针），errors.As 需按值取。
func isNoSuchKey(err error) bool {
	var resp minio.ErrorResponse
	if errors.As(err, &resp) {
		return resp.Code == "NoSuchKey" || resp.StatusCode == 404
	}
	return false
}

// Put 写入。digest 与内容不符直接拒；同 digest 重传幂等。
func (s *S3Store) Put(ctx context.Context, digest string, raw []byte) error {
	k, err := s.key(digest)
	if err != nil {
		return err
	}
	if Digest(raw) != digest {
		return fmt.Errorf("%w: 声称 %s，实际 %s", ErrDigestMismatch, digest, Digest(raw))
	}
	// 内容寻址下同 key 必然同内容，已存在就不必重写。
	if _, err := s.cli.StatObject(ctx, s.bucket, k, minio.StatObjectOptions{}); err == nil {
		return nil
	}
	if _, err := s.cli.PutObject(ctx, s.bucket, k, bytes.NewReader(raw), int64(len(raw)),
		minio.PutObjectOptions{ContentType: "application/json"}); err != nil {
		return fmt.Errorf("registry: 上传对象失败: %w", err)
	}
	return nil
}

// Get 读取并**重新校验**内容与 digest 是否相符。
func (s *S3Store) Get(ctx context.Context, digest string) ([]byte, error) {
	k, err := s.key(digest)
	if err != nil {
		return nil, err
	}
	obj, err := s.cli.GetObject(ctx, s.bucket, k, minio.GetObjectOptions{})
	if err != nil {
		if isNoSuchKey(err) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, digest)
		}
		return nil, fmt.Errorf("registry: 下载对象失败: %w", err)
	}
	defer func() { _ = obj.Close() }()

	// minio-go 的 GetObject 是惰性的：不存在的对象要到首次读才报错。
	raw, err := io.ReadAll(obj)
	if err != nil {
		if isNoSuchKey(err) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, digest)
		}
		return nil, fmt.Errorf("registry: 读对象失败: %w", err)
	}
	if got := Digest(raw); got != digest {
		return nil, fmt.Errorf("%w: 取回 %s，应为 %s（对象存储被篡改）", ErrDigestMismatch, got, digest)
	}
	return raw, nil
}

// Has 探测对象是否存在。
func (s *S3Store) Has(ctx context.Context, digest string) (bool, error) {
	k, err := s.key(digest)
	if err != nil {
		return false, err
	}
	if _, err := s.cli.StatObject(ctx, s.bucket, k, minio.StatObjectOptions{}); err != nil {
		if isNoSuchKey(err) {
			return false, nil
		}
		return false, fmt.Errorf("registry: 探测对象失败: %w", err)
	}
	return true, nil
}
