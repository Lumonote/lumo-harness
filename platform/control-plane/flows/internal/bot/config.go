// Package bot adapts signed channel events to the existing durable TriggerBus.
package bot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

type Channel struct {
	ID             string `json:"id"`
	Realm          string `json:"realm"`
	Event          string `json:"event"`
	SecretEnv      string `json:"secret_env"`
	RequireSubject bool   `json:"require_subject,omitempty"`
	secret         []byte
}

var channelID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var messageID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,200}$`)

// ParseConfig resolves secrets only from environment variables, never from the
// incoming event. Neither the binding nor any sender-supplied role is trusted.
func ParseConfig(data []byte, getenv func(string) string) ([]Channel, error) {
	var channels []Channel
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&channels); err != nil {
		return nil, fmt.Errorf("invalid bot channel configuration")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("trailing bot configuration")
	}
	seen := map[string]bool{}
	for i := range channels {
		c := &channels[i]
		if !channelID.MatchString(c.ID) || seen[c.ID] || strings.TrimSpace(c.Realm) == "" || c.Realm != strings.TrimSpace(c.Realm) || strings.TrimSpace(c.Event) == "" || c.Event != strings.TrimSpace(c.Event) || c.Event == "*" || len(c.Event) > 128 || c.SecretEnv == "" {
			return nil, fmt.Errorf("invalid or duplicate bot channel at index %d", i)
		}
		c.secret = []byte(getenv(c.SecretEnv))
		if len(c.secret) < 32 {
			return nil, fmt.Errorf("bot channel %s requires a secret of at least 32 bytes", c.ID)
		}
		seen[c.ID] = true
	}
	return channels, nil
}
