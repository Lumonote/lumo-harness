package publisher

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

func TestParsePrivateKeyAcceptsSeedAndPrivateKey(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	want := ed25519.NewKeyFromSeed(seed)
	for _, raw := range [][]byte{seed, []byte(base64.StdEncoding.EncodeToString(seed)), want} {
		got, err := ParsePrivateKey(raw)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("parsed key differs from expected private key")
		}
	}
}
