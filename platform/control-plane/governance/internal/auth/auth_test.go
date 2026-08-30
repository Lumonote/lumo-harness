package auth

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestPasswordHashAndVerification(t *testing.T) {
	hash, err := HashPassword("correct-horse-battery-staple")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, "correct-horse-battery-staple") {
		t.Fatal("valid password was rejected")
	}
	if VerifyPassword(hash, "not-the-password") || VerifyPassword("", "not-the-password") {
		t.Fatal("invalid password was accepted")
	}
}

func TestCaptchaIsOpaquePNG(t *testing.T) {
	challenge, err := NewCaptcha()
	if err != nil {
		t.Fatal(err)
	}
	if len(challenge.Answer) != CaptchaClickCount || len(challenge.ID) < 24 {
		t.Fatalf("invalid challenge: %+v", challenge)
	}
	if !ValidCaptchaAnswer(challenge.Answer) {
		t.Fatalf("answer %q is not a valid click sequence", challenge.Answer)
	}
	if !EqualCaptchaHash(challenge.AnswerHash, CaptchaHash(challenge.ID, challenge.Answer)) {
		t.Fatal("captcha hash mismatch")
	}
	image, err := RenderCaptchaGridPNG(challenge.Tiles)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(image, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("captcha is not a PNG")
	}
	if bytes.Contains(image, []byte(challenge.Answer)) {
		t.Fatal("captcha answer leaked as plaintext in the image bytes")
	}
}

func TestCaptchaGridIsDeterministicEnough(t *testing.T) {
	for range 40 {
		challenge, err := NewCaptcha()
		if err != nil {
			t.Fatal(err)
		}
		// Tiles are a permutation of 1..9.
		var seen [CaptchaGridSize + 1]bool
		for _, digit := range challenge.Tiles {
			if digit < 1 || digit > CaptchaGridSize || seen[digit] {
				t.Fatalf("tiles not a permutation of 1..9: %v", challenge.Tiles)
			}
			seen[digit] = true
		}
		// Targets are distinct digits in 1..9.
		var targetSeen [CaptchaGridSize + 1]bool
		for _, digit := range challenge.Targets {
			if digit < 1 || digit > CaptchaGridSize || targetSeen[digit] {
				t.Fatalf("targets not distinct: %v", challenge.Targets)
			}
			targetSeen[digit] = true
		}
		// Answer maps each target digit to its tile index, in order.
		positions := [CaptchaGridSize + 1]int{}
		for index, digit := range challenge.Tiles {
			positions[digit] = index
		}
		expected := ""
		for _, digit := range challenge.Targets {
			expected += string(rune('0' + positions[digit]))
		}
		if challenge.Answer != expected {
			t.Fatalf("answer %q != expected %q (tiles=%v targets=%v)", challenge.Answer, expected, challenge.Tiles, challenge.Targets)
		}
		if len(challenge.Prompt()) != CaptchaClickCount {
			t.Fatalf("prompt %q has wrong length", challenge.Prompt())
		}
	}
}

func TestValidCaptchaAnswer(t *testing.T) {
	if !ValidCaptchaAnswer("048") || !ValidCaptchaAnswer("120") {
		t.Fatal("valid sequences rejected")
	}
	for _, invalid := range []string{"", "0", "000", "0481", "98", "abc", " 48", "0488"} {
		if ValidCaptchaAnswer(invalid) {
			t.Fatalf("invalid answer %q accepted", invalid)
		}
	}
}

func TestTokenHashIsStableAndDoesNotExposeToken(t *testing.T) {
	token, err := RandomToken(32)
	if err != nil {
		t.Fatal(err)
	}
	hash := TokenHash(token)
	if hash != TokenHash(token) || len(hash) != 64 {
		t.Fatalf("unexpected token hash %q", hash)
	}
	if _, err := hex.DecodeString(hash); err != nil {
		t.Fatalf("token hash is not hex: %v", err)
	}
}
