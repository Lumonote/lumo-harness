package server

import (
	"crypto/rand"
	"encoding/hex"
)

// newProjectID 服务侧生成（proj_ + 16 hex）。ID 是引用键不是调用方的自由文本——
// 客户端自带 ID 会让「谁能造什么形状的键」变成治理问题。
func newProjectID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "proj_" + hex.EncodeToString(b), nil
}
