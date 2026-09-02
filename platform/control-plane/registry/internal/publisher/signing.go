package publisher

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// ParsePrivateKey accepts the same deliberately narrow formats as the
// artifact-publisher CLI: a raw/base64 Ed25519 seed or private key, or a
// PKCS#8 PEM private key. Callers receive a fresh key slice and should keep it
// only long enough to sign the immutable manifest bytes.
func ParsePrivateKey(raw []byte) (ed25519.PrivateKey, error) {
	if block, _ := pem.Decode(raw); block != nil {
		value, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("PKCS#8 private key: %w", err)
		}
		key, ok := value.(ed25519.PrivateKey)
		if !ok {
			return nil, errors.New("PKCS#8 private key is not ed25519")
		}
		return append(ed25519.PrivateKey(nil), key...), nil
	}
	if key, err := decodeExact(raw, ed25519.PrivateKeySize); err == nil {
		return ed25519.PrivateKey(key), nil
	}
	seed, err := decodeExact(raw, ed25519.SeedSize)
	if err != nil {
		return nil, errors.New("private key must be a 32-byte seed, 64-byte private key, or PKCS#8 PEM; base64 is accepted")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func decodeExact(raw []byte, size int) ([]byte, error) {
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
	return nil, fmt.Errorf("expected %d bytes", size)
}
