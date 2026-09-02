package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" // #nosec G505 -- TOTP interoperability is defined over HMAC-SHA-1.
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	TOTPPeriod = 30 * time.Second
	TOTPDigits = 6
)

// DecodeMFAKey accepts exactly a base64-encoded 32-byte key. Reusing a
// control-plane token or silently generating a process-local key would make
// enrolled factors unrecoverable or weak, so configuration errors fail closed.
func DecodeMFAKey(value string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil || len(key) != 32 {
		return nil, errors.New("MFA key must be a base64-encoded 32-byte value")
	}
	return key, nil
}

func NewTOTPSecret() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate TOTP secret: %w", err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw), nil
}

func SealTOTPSecret(key []byte, secret string) (nonce, ciphertext []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, fmt.Errorf("create MFA cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, fmt.Errorf("create MFA cipher mode: %w", err)
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, fmt.Errorf("generate MFA nonce: %w", err)
	}
	return nonce, gcm.Seal(nil, nonce, []byte(secret), nil), nil
}

func OpenTOTPSecret(key, nonce, ciphertext []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create MFA cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create MFA cipher mode: %w", err)
	}
	if len(nonce) != gcm.NonceSize() {
		return "", errors.New("invalid MFA nonce")
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", errors.New("unable to decrypt MFA secret")
	}
	return string(plain), nil
}

// VerifyTOTP allows one adjacent time window for normal clock skew. It never
// normalizes non-numeric input, avoiding acceptance of visually similar codes.
func VerifyTOTP(secret, code string, now time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != TOTPDigits {
		return false
	}
	if _, err := strconv.Atoi(code); err != nil {
		return false
	}
	for offset := int64(-1); offset <= 1; offset++ {
		if hmac.Equal([]byte(code), []byte(totpCode(secret, now.Unix()/int64(TOTPPeriod/time.Second)+offset))) {
			return true
		}
	}
	return false
}

func totpCode(secret string, counter int64) string {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return ""
	}
	var message [8]byte
	binary.BigEndian.PutUint64(message[:], uint64(counter))
	mac := hmac.New(sha1.New, key) // #nosec G401 -- RFC 6238 compatibility.
	_, _ = mac.Write(message[:])
	sum := mac.Sum(nil)
	offset := int(sum[len(sum)-1] & 0x0f)
	value := (int(sum[offset])&0x7f)<<24 | int(sum[offset+1])<<16 | int(sum[offset+2])<<8 | int(sum[offset+3])
	return fmt.Sprintf("%06d", value%1_000_000)
}
