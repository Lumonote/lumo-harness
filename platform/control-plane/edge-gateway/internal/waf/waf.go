// Package waf 实现边缘网关的「基础 WAF」（§12.2 基础 WAF：路径/参数校验）。
//
// 这是一组刻意保守的检查：只拦明确恶意或会撑爆后端的东西（路径穿越、控制字符、
// 超长路径/查询），不做内容语义级规则引擎——后者属于 OPA/业务层的事。边缘
// 网关的职责是门，不是应用防火墙全家桶。
package waf

import (
	"net/http"
	"net/url"
	"strings"
)

// Rules 一组 WAF 规则参数，全部可配，缺省见 DefaultRules。
type Rules struct {
	// MaxPathLen 路径最大字节数；超过即拒（防超长 path 打爆路由/日志）。
	MaxPathLen int
	// MaxQueryLen 查询串最大字节数。
	MaxQueryLen int
}

// DefaultRules 缺省阈值。选自常见反向代理/网关的保守上限，足以挡住畸形请求，
// 又不至于误伤正常长 URL。
func DefaultRules() Rules {
	return Rules{MaxPathLen: 2048, MaxQueryLen: 4096}
}

// hasControlByte 检测是否含控制字符（除常见空白 \t \n \r 外的 0x00-0x1F、及 0x7F）。
// 这些字符在 HTTP 路径/查询里没有合法用途，多是走私/注入的前奏。
func hasControlByte(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		if c < 0x20 || c == 0x7F {
			return true
		}
	}
	return false
}

// Middleware 返回一个 WAF 中间件。命中任一规则返回 400，不向下游转发。
func Middleware(rules Rules) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			query := r.URL.RawQuery

			if rules.MaxPathLen > 0 && len(path) > rules.MaxPathLen {
				http.Error(w, "path too long", http.StatusBadRequest)
				return
			}
			if rules.MaxQueryLen > 0 && len(query) > rules.MaxQueryLen {
				http.Error(w, "query too long", http.StatusBadRequest)
				return
			}
			// 路径穿越：规范路径里不应出现 ".." 段。注意先 Decode 再判，否则
			// 攻击者用 %2e%2e 即可绕过未解码的检查。
			decoded := path
			if unescaped, err := unescape(path); err == nil {
				decoded = unescaped
			}
			if strings.Contains(decoded, "..") {
				http.Error(w, "invalid path", http.StatusBadRequest)
				return
			}
			if hasControlByte(path) || hasControlByte(query) {
				http.Error(w, "invalid characters", http.StatusBadRequest)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// unescape 是 url.PathUnescape 的薄封装，便于将来替换/隔离。
func unescape(s string) (string, error) {
	return url.PathUnescape(s)
}
