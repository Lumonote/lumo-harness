package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"testing"
)

func TestWebAuthnConfigRequiresExactTrustedOrigin(t *testing.T) {
	if _, err := NewWebAuthnConfig("example.com", "Lumo", []string{"https://login.other.example"}, true); err == nil {
		t.Fatal("origin outside RPID accepted")
	}
	if _, err := NewWebAuthnConfig("example.com", "Lumo", []string{"http://app.example.com"}, true); err == nil {
		t.Fatal("non-local HTTP origin accepted")
	}
	config, err := NewWebAuthnConfig("example.com", "Lumo", []string{"https://app.example.com"}, true)
	if err != nil {
		t.Fatal(err)
	}
	clientData, _ := json.Marshal(map[string]string{"type": "webauthn.get", "challenge": "challenge", "origin": "https://app.example.com"})
	if err := VerifyClientData(clientData, "challenge", "webauthn.get", config); err != nil {
		t.Fatal(err)
	}
	clientData, _ = json.Marshal(map[string]string{"type": "webauthn.get", "challenge": "challenge", "origin": "https://evil.example"})
	if err := VerifyClientData(clientData, "challenge", "webauthn.get", config); err == nil {
		t.Fatal("untrusted origin accepted")
	}
}

func TestWebAuthnP256AssertionAndAuthenticatorBinding(t *testing.T) {
	config, err := NewWebAuthnConfig("example.com", "Lumo", []string{"https://app.example.com"}, true)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cose := coseP256(key)
	authenticatorData := make([]byte, 37)
	rpHash := sha256.Sum256([]byte(config.RPID))
	copy(authenticatorData, rpHash[:])
	authenticatorData[32] = webauthnUserPresent | webauthnUserVerified
	binary.BigEndian.PutUint32(authenticatorData[33:], 7)
	parsed, err := ParseAuthenticatorData(authenticatorData, config, false)
	if err != nil || parsed.SignCount != 7 {
		t.Fatalf("parse assertion data = %#v, %v", parsed, err)
	}
	clientData, _ := json.Marshal(map[string]string{"type": "webauthn.get", "challenge": "challenge", "origin": "https://app.example.com"})
	clientHash := sha256.Sum256(clientData)
	signed := append(append([]byte{}, authenticatorData...), clientHash[:]...)
	digest := sha256.Sum256(signed)
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyAssertion(cose, authenticatorData, clientData, signature); err != nil {
		t.Fatal(err)
	}
	authenticatorData[32] = webauthnUserPresent
	if _, err := ParseAuthenticatorData(authenticatorData, config, false); err == nil {
		t.Fatal("missing UV accepted")
	}
}

func TestWebAuthnRegistrationDataExtractsCredentialAndCOSE(t *testing.T) {
	config, err := NewWebAuthnConfig("example.com", "Lumo", []string{"https://app.example.com"}, true)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		t.Fatal(err)
	}
	raw := make([]byte, 55)
	rpHash := sha256.Sum256([]byte(config.RPID))
	copy(raw, rpHash[:])
	raw[32] = webauthnUserPresent | webauthnUserVerified | webauthnAttestedData
	binary.BigEndian.PutUint32(raw[33:], 1)
	binary.BigEndian.PutUint16(raw[53:], uint16(len(id)))
	raw = append(raw, id...)
	raw = append(raw, coseP256(key)...)
	data, err := ParseAuthenticatorData(raw, config, true)
	if err != nil {
		t.Fatal(err)
	}
	if string(data.CredentialID) != string(id) || string(data.PublicKeyCOSE) != string(coseP256(key)) {
		t.Fatalf("unexpected registration data: %#v", data)
	}
	// Extension output is a second CBOR item. It must be validated but never
	// become part of the stored COSE key, otherwise later signature verification
	// would reject a valid credential that requested a browser extension.
	raw[32] |= 0x80
	raw = append(raw, 0xa0) // empty extension map
	data, err = ParseAuthenticatorData(raw, config, true)
	if err != nil || string(data.PublicKeyCOSE) != string(coseP256(key)) {
		t.Fatalf("registration extensions must preserve COSE key: %#v, %v", data, err)
	}
}

func TestWebAuthnCBORRejectsDuplicateMapKeys(t *testing.T) {
	// {1: 2, 1: 3}; accepting it makes the semantic value dependent on the
	// decoder's duplicate-key policy at an authentication trust boundary.
	if _, _, err := decodeCBOR([]byte{0xa2, 0x01, 0x02, 0x01, 0x03}, 0, 0); err == nil {
		t.Fatal("duplicate CBOR map key accepted")
	}
}

func coseP256(key *ecdsa.PrivateKey) []byte {
	value := []byte{0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20}
	x := key.PublicKey.X.FillBytes(make([]byte, 32))
	y := key.PublicKey.Y.FillBytes(make([]byte, 32))
	value = append(value, x...)
	value = append(value, 0x22, 0x58, 0x20)
	return append(value, y...)
}
