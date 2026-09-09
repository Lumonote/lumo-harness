package observability

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"
)

// Identity matches the signed assertion contract consumed by TypeScript hosts.
type Identity struct {
	Realm     string   `json:"realm"`
	UserID    string   `json:"userId"`
	Roles     []string `json:"roles"`
	ProjectID string   `json:"projectId,omitempty"`
	DeptID    string   `json:"deptId,omitempty"`
}

var identityID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var identityRole = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

func SignIdentityHeaders(identity Identity, audience, secret string) (http.Header, error) {
	if len(secret) < 32 || !identityID.MatchString(audience) || !identityID.MatchString(identity.Realm) ||
		!identityID.MatchString(identity.UserID) || len(identity.Roles) == 0 || len(identity.Roles) > 32 {
		return nil, fmt.Errorf("invalid runtime identity or signing configuration")
	}
	for _, value := range []string{identity.ProjectID, identity.DeptID} {
		if value != "" && !identityID.MatchString(value) {
			return nil, fmt.Errorf("invalid runtime identity scope")
		}
	}
	for _, role := range identity.Roles {
		if !identityRole.MatchString(role) {
			return nil, fmt.Errorf("invalid runtime identity role")
		}
	}
	payload, err := json.Marshal(struct {
		Identity
		Audience string `json:"aud"`
		Expires  int64  `json:"exp"`
	}{identity, audience, time.Now().Add(time.Minute).Unix()})
	if err != nil {
		return nil, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	if len(encoded) > 4096 {
		return nil, fmt.Errorf("runtime identity exceeds assertion limit")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encoded))
	headers := http.Header{}
	headers.Set("X-Lumo-Identity", encoded)
	headers.Set("X-Lumo-Identity-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	return headers, nil
}
