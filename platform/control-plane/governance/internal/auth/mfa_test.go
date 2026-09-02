package auth

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestVerifyTOTPUsesRFC6238SixDigitProjection(t *testing.T) {
	// RFC 6238's ASCII "12345678901234567890" vector at 59 seconds is
	// 94287082 with eight digits, therefore 287082 in this six-digit profile.
	if !VerifyTOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", time.Unix(59, 0)) {
		t.Fatal("expected RFC 6238 TOTP code to verify")
	}
	if VerifyTOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287083", time.Unix(59, 0)) {
		t.Fatal("incorrect code must be rejected")
	}
}

func TestTOTPSecretEncryptionRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	parsed, err := DecodeMFAKey(encoded)
	if err != nil || len(parsed) != 32 {
		t.Fatalf("decode key: %v", err)
	}
	nonce, ciphertext, err := SealTOTPSecret(parsed, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	plain, err := OpenTOTPSecret(parsed, nonce, ciphertext)
	if err != nil || plain != "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" {
		t.Fatalf("open: %q, %v", plain, err)
	}
}
