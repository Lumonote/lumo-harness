package auth

// This file contains the small, deliberately scoped WebAuthn verifier used by
// the governance service.  It accepts the standards-required "none"
// attestation conveyance and ES256 (P-256) assertions, which is the baseline
// offered by platform passkeys.  Attestation-root management and additional
// COSE algorithms are intentionally not guessed: deployments that require
// hardware attestation must put that policy in front of enrollment.

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
)

const (
	webauthnUserPresent  = byte(0x01)
	webauthnUserVerified = byte(0x04)
	webauthnAttestedData = byte(0x40)
	maxCBORBytes         = 64 << 10
)

// WebAuthnConfig contains only public relying-party settings.  The presence
// of a valid RPID enables passkeys; a partial configuration is rejected by the
// caller rather than silently falling back to an untrusted browser origin.
type WebAuthnConfig struct {
	RPID                    string
	RPName                  string
	Origins                 map[string]struct{}
	RequireUserVerification bool
}

func NewWebAuthnConfig(rpID, rpName string, origins []string, requireUV bool) (WebAuthnConfig, error) {
	rpID = strings.ToLower(strings.TrimSpace(rpID))
	rpName = strings.TrimSpace(rpName)
	if rpID == "" && rpName == "" && len(origins) == 0 {
		return WebAuthnConfig{}, nil
	}
	if !validRPID(rpID) || rpName == "" || len(origins) == 0 {
		return WebAuthnConfig{}, errors.New("WebAuthn requires a DNS RPID, RP name, and at least one exact trusted origin")
	}
	trusted := make(map[string]struct{}, len(origins))
	for _, raw := range origins {
		origin, err := trustedOrigin(raw, rpID)
		if err != nil {
			return WebAuthnConfig{}, err
		}
		trusted[origin] = struct{}{}
	}
	return WebAuthnConfig{RPID: rpID, RPName: rpName, Origins: trusted, RequireUserVerification: requireUV}, nil
}

func (c WebAuthnConfig) Enabled() bool { return c.RPID != "" }

func validRPID(value string) bool {
	if len(value) < 1 || len(value) > 253 || strings.ContainsAny(value, "/:@?# ") || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return false
			}
		}
	}
	return true
}

func trustedOrigin(raw, rpID string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return "", fmt.Errorf("invalid WebAuthn origin %q", raw)
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || strings.HasPrefix(u.Hostname(), "127."))) {
		return "", fmt.Errorf("WebAuthn origin %q must use HTTPS", raw)
	}
	host := strings.ToLower(u.Hostname())
	if host != rpID && !strings.HasSuffix(host, "."+rpID) {
		return "", fmt.Errorf("WebAuthn origin host %q is outside RPID %q", host, rpID)
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host), nil
}

type clientData struct {
	Type      string `json:"type"`
	Challenge string `json:"challenge"`
	Origin    string `json:"origin"`
}

// VerifyClientData validates the browser's JSON binding before any database
// mutation.  challenge is the raw URL-safe challenge issued by the server.
func VerifyClientData(raw []byte, expectedChallenge, expectedType string, cfg WebAuthnConfig) error {
	if !cfg.Enabled() || len(raw) == 0 || len(raw) > 16<<10 {
		return errors.New("invalid WebAuthn client data")
	}
	var got clientData
	if err := json.Unmarshal(raw, &got); err != nil {
		return fmt.Errorf("decode WebAuthn client data: %w", err)
	}
	if got.Type != expectedType || strings.TrimSpace(got.Challenge) != expectedChallenge {
		return errors.New("WebAuthn client data does not bind the issued challenge")
	}
	origin, err := trustedOrigin(got.Origin, cfg.RPID)
	if err != nil {
		return err
	}
	if _, ok := cfg.Origins[origin]; !ok {
		return fmt.Errorf("WebAuthn origin %q is not trusted", origin)
	}
	return nil
}

type AuthenticatorData struct {
	Raw           []byte
	Flags         byte
	SignCount     uint32
	CredentialID  []byte
	PublicKeyCOSE []byte
}

func ParseAuthenticatorData(raw []byte, cfg WebAuthnConfig, requireAttested bool) (AuthenticatorData, error) {
	if !cfg.Enabled() || len(raw) < 37 || len(raw) > maxCBORBytes {
		return AuthenticatorData{}, errors.New("invalid WebAuthn authenticator data")
	}
	rpHash := sha256.Sum256([]byte(cfg.RPID))
	if !bytes.Equal(raw[:32], rpHash[:]) {
		return AuthenticatorData{}, errors.New("WebAuthn authenticator data has an unexpected RPID hash")
	}
	flags := raw[32]
	if flags&webauthnUserPresent == 0 || (cfg.RequireUserVerification && flags&webauthnUserVerified == 0) {
		return AuthenticatorData{}, errors.New("WebAuthn user presence or verification requirement not met")
	}
	data := AuthenticatorData{Raw: append([]byte(nil), raw...), Flags: flags, SignCount: binary.BigEndian.Uint32(raw[33:37])}
	if !requireAttested {
		return data, nil
	}
	if flags&webauthnAttestedData == 0 || len(raw) < 55 {
		return AuthenticatorData{}, errors.New("WebAuthn registration response has no attested credential data")
	}
	idLen := int(binary.BigEndian.Uint16(raw[53:55]))
	if idLen < 16 || idLen > 1023 || len(raw) < 55+idLen+1 {
		return AuthenticatorData{}, errors.New("invalid WebAuthn credential identifier")
	}
	data.CredentialID = append([]byte(nil), raw[55:55+idLen]...)
	keyStart := 55 + idLen
	_, coseEnd, err := decodeCBOR(raw, keyStart, 0)
	if err != nil {
		return AuthenticatorData{}, errors.New("invalid WebAuthn COSE public key")
	}
	next := coseEnd
	if flags&0x80 != 0 { // ED: a second CBOR item contains extension outputs.
		_, next, err = decodeCBOR(raw, next, 0)
	}
	if err != nil || next != len(raw) {
		return AuthenticatorData{}, errors.New("invalid WebAuthn authenticator extensions")
	}
	data.PublicKeyCOSE = append([]byte(nil), raw[keyStart:coseEnd]...)
	return data, nil
}

func ParseNoneAttestation(raw []byte) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maxCBORBytes {
		return nil, errors.New("invalid WebAuthn attestation object")
	}
	value, next, err := decodeCBOR(raw, 0, 0)
	if err != nil || next != len(raw) {
		return nil, errors.New("invalid WebAuthn attestation object")
	}
	m, ok := value.(map[any]any)
	if !ok {
		return nil, errors.New("invalid WebAuthn attestation object")
	}
	fmtValue, fmtOK := m["fmt"].(string)
	authData, dataOK := m["authData"].([]byte)
	if !fmtOK || !dataOK || fmtValue != "none" {
		return nil, errors.New("only WebAuthn none attestation is accepted")
	}
	return authData, nil
}

func VerifyAssertion(publicKeyCOSE, authenticatorData, clientDataJSON, signature []byte) error {
	if len(signature) == 0 || len(signature) > 8<<10 {
		return errors.New("invalid WebAuthn assertion signature")
	}
	key, err := parseCOSEP256(publicKeyCOSE)
	if err != nil {
		return err
	}
	clientHash := sha256.Sum256(clientDataJSON)
	signed := make([]byte, 0, len(authenticatorData)+len(clientHash))
	signed = append(signed, authenticatorData...)
	signed = append(signed, clientHash[:]...)
	digest := sha256.Sum256(signed)
	if !ecdsa.VerifyASN1(key, digest[:], signature) {
		return errors.New("invalid WebAuthn assertion signature")
	}
	return nil
}

func CredentialID(rawID string) ([]byte, error) {
	if len(rawID) < 1 || len(rawID) > 2048 {
		return nil, errors.New("invalid WebAuthn credential id")
	}
	value, err := base64.RawURLEncoding.DecodeString(rawID)
	if err != nil || len(value) < 16 || len(value) > 1023 {
		return nil, errors.New("invalid WebAuthn credential id")
	}
	return value, nil
}

func Challenge() (string, error) { return RandomToken(32) }

func parseCOSEP256(raw []byte) (*ecdsa.PublicKey, error) {
	value, next, err := decodeCBOR(raw, 0, 0)
	if err != nil || next != len(raw) {
		return nil, errors.New("invalid WebAuthn COSE public key")
	}
	m, ok := value.(map[any]any)
	if !ok || cborInt(cborMapValue(m, 1)) != 2 || cborInt(cborMapValue(m, 3)) != -7 || cborInt(cborMapValue(m, -1)) != 1 {
		return nil, errors.New("unsupported WebAuthn COSE algorithm")
	}
	x, xOK := cborMapValue(m, -2).([]byte)
	y, yOK := cborMapValue(m, -3).([]byte)
	if !xOK || !yOK || len(x) != 32 || len(y) != 32 {
		return nil, errors.New("invalid WebAuthn P-256 public key")
	}
	curve := elliptic.P256()
	pub := &ecdsa.PublicKey{Curve: curve, X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	if !curve.IsOnCurve(pub.X, pub.Y) {
		return nil, errors.New("invalid WebAuthn P-256 public key")
	}
	return pub, nil
}

func cborInt(value any) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case uint64:
		if v <= uint64(^uint64(0)>>1) {
			return int64(v)
		}
	}
	return 0
}

func cborMapValue(values map[any]any, want int64) any {
	for key, value := range values {
		if cborInt(key) == want {
			return value
		}
	}
	return nil
}

// decodeCBOR is a bounded decoder for the definite-length CBOR types used by
// WebAuthn attestation and COSE_Key structures.  Rejecting indefinite-length
// items avoids allocation and parser-differential attacks at the trust edge.
func decodeCBOR(raw []byte, offset, depth int) (any, int, error) {
	if depth > 12 || offset >= len(raw) {
		return nil, offset, errors.New("invalid CBOR")
	}
	head := raw[offset]
	offset++
	major, ai := head>>5, head&0x1f
	length, next, err := cborLength(raw, offset, ai)
	if err != nil {
		return nil, offset, err
	}
	offset = next
	switch major {
	case 0:
		return length, offset, nil
	case 1:
		if length > uint64(^uint64(0)>>1) {
			return nil, offset, errors.New("CBOR negative integer overflow")
		}
		return -1 - int64(length), offset, nil
	case 2:
		if length > maxCBORBytes || length > uint64(len(raw)-offset) {
			return nil, offset, errors.New("invalid CBOR bytes")
		}
		end := offset + int(length)
		return append([]byte(nil), raw[offset:end]...), end, nil
	case 3:
		if length > maxCBORBytes || length > uint64(len(raw)-offset) {
			return nil, offset, errors.New("invalid CBOR text")
		}
		end := offset + int(length)
		return string(raw[offset:end]), end, nil
	case 4:
		if length > 128 {
			return nil, offset, errors.New("CBOR array too large")
		}
		values := make([]any, 0, int(length))
		for range length {
			value, end, err := decodeCBOR(raw, offset, depth+1)
			if err != nil {
				return nil, offset, err
			}
			values, offset = append(values, value), end
		}
		return values, offset, nil
	case 5:
		if length > 64 {
			return nil, offset, errors.New("CBOR map too large")
		}
		values := make(map[any]any, int(length))
		for range length {
			key, end, err := decodeCBOR(raw, offset, depth+1)
			if err != nil {
				return nil, offset, err
			}
			if _, ok := key.(string); !ok {
				if _, ok := key.(int64); !ok {
					if _, ok := key.(uint64); !ok {
						return nil, offset, errors.New("unsupported CBOR map key")
					}
				}
			}
			if _, exists := values[key]; exists {
				// COSE and attestation maps are security-bearing inputs. Accepting
				// duplicate keys would make their meaning depend on an implicit
				// last-write-wins rule and invites parser differentials.
				return nil, offset, errors.New("duplicate CBOR map key")
			}
			value, end, err := decodeCBOR(raw, end, depth+1)
			if err != nil {
				return nil, offset, err
			}
			values[key], offset = value, end
		}
		return values, offset, nil
	default:
		return nil, offset, errors.New("unsupported CBOR type")
	}
}

func cborLength(raw []byte, offset int, ai byte) (uint64, int, error) {
	if ai < 24 {
		return uint64(ai), offset, nil
	}
	need := 0
	switch ai {
	case 24:
		need = 1
	case 25:
		need = 2
	case 26:
		need = 4
	case 27:
		need = 8
	default:
		return 0, offset, errors.New("indefinite or reserved CBOR length")
	}
	if len(raw)-offset < need {
		return 0, offset, errors.New("truncated CBOR")
	}
	var value uint64
	for _, b := range raw[offset : offset+need] {
		value = value<<8 | uint64(b)
	}
	return value, offset + need, nil
}
