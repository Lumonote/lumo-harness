package server

import (
	"crypto/rand"
	"encoding/hex"
)

// newFlowID 服务侧生成（flow_ + 16 hex）。同 projects：ID 是引用键不是自由文本。
func newFlowID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "flow_" + hex.EncodeToString(b), nil
}
