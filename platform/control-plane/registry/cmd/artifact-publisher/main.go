package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/lumo-harness/platform/registry/internal/publisher"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	registryURL := flag.String("registry", envOr("REGISTRY_URL", "http://127.0.0.1:8084"), "Registry base URL")
	manifestPath := flag.String("manifest", "", "raw manifest JSON file")
	bundlePath := flag.String("bundle", "", "verified .jsonl.zst Bundle file")
	signaturePath := flag.String("signature", "", "existing raw/base64 ed25519 signature file")
	privateKeyPath := flag.String("private-key", "", "raw/base64/PKCS#8 ed25519 private key file")
	timeout := flag.Duration("timeout", 60*time.Second, "publication timeout")
	flag.Parse()

	if *manifestPath == "" {
		return errors.New("artifact-publisher: -manifest 必填")
	}
	if (*signaturePath == "") == (*privateKeyPath == "") {
		return errors.New("artifact-publisher: -signature 与 -private-key 必须且只能提供一个")
	}
	manifestRaw, err := os.ReadFile(*manifestPath)
	if err != nil {
		return fmt.Errorf("artifact-publisher: 读取 manifest 失败: %w", err)
	}
	var bundleRaw []byte
	if *bundlePath != "" {
		bundleRaw, err = os.ReadFile(*bundlePath)
		if err != nil {
			return fmt.Errorf("artifact-publisher: 读取 bundle 失败: %w", err)
		}
	}
	var signature []byte
	if *signaturePath != "" {
		signature, err = readSignature(*signaturePath)
	} else {
		var key ed25519.PrivateKey
		key, err = readPrivateKey(*privateKeyPath)
		if err == nil {
			signature = ed25519.Sign(key, manifestRaw)
		}
	}
	if err != nil {
		return err
	}
	client, err := publisher.NewClient(*registryURL, os.Getenv("LUMO_CONTROL_PLANE_TOKEN"), nil)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	result, err := client.Publish(ctx, manifestRaw, signature, bundleRaw)
	if err != nil {
		return err
	}
	fmt.Println(string(result))
	return nil
}

func readSignature(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("artifact-publisher: 读取签名失败: %w", err)
	}
	decoded, err := rawOrBase64(raw, ed25519.SignatureSize)
	if err != nil {
		return nil, fmt.Errorf("artifact-publisher: 签名格式错误: %w", err)
	}
	return decoded, nil
}

func readPrivateKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("artifact-publisher: 读取私钥失败: %w", err)
	}
	key, err := publisher.ParsePrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("artifact-publisher: 私钥格式错误: %w", err)
	}
	return key, nil
}

func rawOrBase64(raw []byte, size int) ([]byte, error) {
	if len(raw) == size {
		return append([]byte(nil), raw...), nil
	}
	text := strings.TrimSpace(string(raw))
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		decoded, err := encoding.DecodeString(text)
		if err == nil && len(decoded) == size {
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("期望 %d 字节", size)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
