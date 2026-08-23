// Package redact PII 脱敏（§10.1 四道闸之一）。
//
// 两个方向都要脱：出站防内部 PII 漏给第三方，入站防外部 PII 被拖进 prompt 与日志。
// **审计记录无条件脱敏** —— 审计的价值是「谁在什么时候调了什么」，不是留存明文数据。
//
// 明确的能力边界：正则脱敏抓的是格式化标识符（邮箱/手机/身份证/银行卡/密钥），
// 抓不住自由文本里的姓名与住址。它是纵深防御的一层，不是数据分级的替代品。
package redact

import (
	"regexp"
	"strings"
)

type rule struct {
	name string
	re   *regexp.Regexp
	mask string
}

// 顺序有意义：先长后短，避免银行卡被手机号规则先啃掉一段。
var rules = []rule{
	{"credential", regexp.MustCompile(`(?i)\b(bearer\s+[a-z0-9._\-]+|sk-[a-z0-9]{16,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9\-]{10,})`), "«cred»"},
	{"private-key", regexp.MustCompile(`(?s)-----BEGIN[^-]*PRIVATE KEY-----.*?-----END[^-]*PRIVATE KEY-----`), "«private-key»"},
	{"idcard-cn", regexp.MustCompile(`\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b`), "«id»"},
	{"bankcard", regexp.MustCompile(`\b\d{16,19}\b`), "«card»"},
	{"email", regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`), "«email»"},
	{"phone-cn", regexp.MustCompile(`\b1[3-9]\d{9}\b`), "«phone»"},
	{"ipv4", regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`), "«ip»"},
}

// Report 脱敏统计（进审计，用于观察哪个连接器在漏 PII）。
type Report struct {
	Hits map[string]int
}

func (r Report) Any() bool { return len(r.Hits) > 0 }

// Bytes 脱敏一段载荷，返回新切片与命中统计。原切片不被修改。
func Bytes(in []byte) ([]byte, Report) {
	if len(in) == 0 {
		return in, Report{}
	}
	out := string(in)
	rep := Report{Hits: map[string]int{}}
	for _, ru := range rules {
		n := len(ru.re.FindAllStringIndex(out, -1))
		if n == 0 {
			continue
		}
		rep.Hits[ru.name] += n
		out = ru.re.ReplaceAllString(out, ru.mask)
	}
	if len(rep.Hits) == 0 {
		return in, Report{}
	}
	return []byte(out), rep
}

// String 便捷包装。
func String(in string) (string, Report) {
	b, rep := Bytes([]byte(in))
	return string(b), rep
}

// 这些头即便在「未开启脱敏」的连接器上也绝不落审计：它们按定义就是凭证。
var alwaysMaskedHeaders = map[string]bool{
	"authorization":       true,
	"proxy-authorization": true,
	"cookie":              true,
	"set-cookie":          true,
	"x-api-key":           true,
	"x-auth-token":        true,
	"api-key":             true,
}

// Headers 返回可安全落审计的头副本。凭证类头整体替换，其余值走正则脱敏。
func Headers(h map[string]string) map[string]string {
	if len(h) == 0 {
		return nil
	}
	out := make(map[string]string, len(h))
	for k, v := range h {
		if alwaysMaskedHeaders[strings.ToLower(k)] {
			out[k] = "«redacted»"
			continue
		}
		masked, _ := String(v)
		out[k] = masked
	}
	return out
}
