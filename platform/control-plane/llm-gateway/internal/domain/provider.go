package domain

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"
)

// ErrProviderNotFound 注册表里没有这一行（管理面 404）。与路由面的
// ErrUnknownModel 刻意分开：那个还包含「有这一行但被停用」，管理面必须能看见
// 停用行，否则运维无法重新启用它。
var ErrProviderNotFound = errors.New("provider 未注册")

// ErrInvalidProvider 写入请求不合法（管理面 400）。
var ErrInvalidProvider = errors.New("provider 配置不合法")

// maxModelLength 模型名的长度上限。仅作为防线：模型名会进日志与 URL 路径。
const maxModelLength = 200

// ProviderConfig 是 provider 注册表的**管理面**视图。
//
// 与 store.Provider（路由面视图）刻意分成两个类型：路由面必须携带 API Key 才能向上游
// 出示，管理面则必须**在结构上不可能**泄露它。分成两个类型之后，将来修改路由面结构
// 不会顺带放宽管理面的返回内容——类型系统替我们守住这条边界。
type ProviderConfig struct {
	Model           string `json:"model"`
	UpstreamBaseURL string `json:"upstreamBaseUrl"`
	// APIKeySet 只报告「是否存过密钥」。密钥本身永不返回：掩码形式同样会泄露一份
	// 只被比对、从不需要展示的凭据的片段。
	APIKeySet       bool      `json:"apiKeySet"`
	PriceInPerMtok  float64   `json:"priceInPerMtok"`
	PriceOutPerMtok float64   `json:"priceOutPerMtok"`
	Enabled         bool      `json:"enabled"`
	CreatedAt       time.Time `json:"createdAt"`
	// UpdatedAt 最后一次**写入**时刻（不是最后一次「值变了」——无变化的 PUT 也会推进它）。
	// 费率改错导致账目对不上时，第一个要问的就是「这行是什么时候被谁改的」。
	UpdatedAt time.Time `json:"updatedAt"`
}

// ProviderUpsert 是一次写入请求。
//
// 除 model 外**每个字段都是可选的，语义统一为「省略即保持原值」**（不是「省略即清
// 零」）。一条规则覆盖全部字段，是为了不出现第二种需要单独记忆的语义。
//
// 对 API Key 这是强制要求：密钥读不回来，任何「先 GET 再把读到的内容 PUT 回去」的
// 客户端都会把它清掉。对 upstreamBaseUrl 同样是必需品：最常用的改法就是
// `{"enabled": false}` 把模型摘出路由，若基址必填，这一步就退化成读改写。
//
// 省略 upstreamBaseUrl 只在**改**已有行时成立；新建行必须给出（列是 NOT NULL，
// 由库兜底，见 store.UpsertProvider）。
type ProviderUpsert struct {
	Model           string   `json:"model"`
	UpstreamBaseURL *string  `json:"upstreamBaseUrl"`
	APIKey          *string  `json:"apiKey"`
	PriceInPerMtok  *float64 `json:"priceInPerMtok"`
	PriceOutPerMtok *float64 `json:"priceOutPerMtok"`
	Enabled         *bool    `json:"enabled"`
}

// SetAPIKey 报告本次请求是否要改写密钥（省略 = 保持）。
//
// 写库用它决定 ON CONFLICT 时是否采用新值，而不是先读再写——读改写会把并发 PUT
// 变成丢失更新。
func (u ProviderUpsert) SetAPIKey() bool { return u.APIKey != nil }

// APIKeyValue 返回要写入的密钥（仅在 SetAPIKey 为真时有意义）。
// 空串是合法输入，表示显式清除。
func (u ProviderUpsert) APIKeyValue() string {
	if u.APIKey == nil {
		return ""
	}
	return *u.APIKey
}

// ValidateModel 校验模型名。model 同时是主键、URL 路径段和日志字段，所以这里挡掉
// 控制字符与超长值，而不是让它们污染日志或路径。
func ValidateModel(model string) error {
	trimmed := strings.TrimSpace(model)
	if trimmed == "" {
		return fmt.Errorf("%w: model 不能为空", ErrInvalidProvider)
	}
	if trimmed != model {
		return fmt.Errorf("%w: model 首尾不得有空白", ErrInvalidProvider)
	}
	if len(model) > maxModelLength {
		return fmt.Errorf("%w: model 超过 %d 字节", ErrInvalidProvider, maxModelLength)
	}
	for _, r := range model {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: model 不得包含控制字符", ErrInvalidProvider)
		}
	}
	return nil
}

// Validate 校验一次写入，并返回**规范化后可直接写库**的副本。
//
// 返回副本而不是只报错，是为了让「校验接受的形态」与「落库的形态」逐字节一致：
// 若只报错、由调用方各自 trim，校验通过的值与真正写下去的值就会分叉——配置面上最难
// 查的一类 bug（读回来的 URL 与写进去的不一样，网关拼出来的地址就少一段）。调用方
// 必须使用返回的副本，不要再读原值。
//
// body 里若出现 model，必须与路径一致。否则「路径说 A、body 说 B」会被静默按其中一个
// 执行——这类歧义在配置面上不可接受，宁可 400。
func (u ProviderUpsert) Validate(model string) (ProviderUpsert, error) {
	if err := ValidateModel(model); err != nil {
		return ProviderUpsert{}, err
	}
	if u.Model != "" && u.Model != model {
		return ProviderUpsert{}, fmt.Errorf("%w: body 中的 model %q 与路径 %q 不一致", ErrInvalidProvider, u.Model, model)
	}
	if u.UpstreamBaseURL != nil {
		base, err := NormalizeUpstreamBaseURL(*u.UpstreamBaseURL)
		if err != nil {
			return ProviderUpsert{}, err
		}
		// 指向新字符串而不是改原值：Validate 不该就地修改接收者（调用方可能还要用原值）
		u.UpstreamBaseURL = &base
	}
	for _, price := range []struct {
		name  string
		value *float64
	}{
		{"priceInPerMtok", u.PriceInPerMtok},
		{"priceOutPerMtok", u.PriceOutPerMtok},
	} {
		if price.value == nil {
			continue
		}
		// NaN 必须显式挡掉：JSON 解析不出 NaN，但 Go 侧调用方可以传进来，而
		// NUMERIC 列存不下 NaN 与 ±Inf（写库会失败在更晚、更难查的地方）。
		if math.IsNaN(*price.value) || math.IsInf(*price.value, 0) || *price.value < 0 {
			return ProviderUpsert{}, fmt.Errorf("%w: %s 必须是有限非负数", ErrInvalidProvider, price.name)
		}
	}
	return u, nil
}

// NormalizeUpstreamBaseURL 校验上游基址并返回应写库的形态。
//
// 与 flows 的算子上游、dsh-node 的 seam endpoint 同一套判据：必须是 http/https，且
// 不得带 userinfo / query / fragment。带 userinfo 的地址会把凭据写进日志与错误信息；
// 带 query 或 fragment 的地址说明作者把它当成了完整 URL 而不是基址——网关是在它后面
// 拼 `/v1/chat/completions` 的，错位会静默丢掉那段查询串。
//
// 只 trim 首尾空白，不做别的归一：拼接处在 gateway.forward 里已经
// `TrimRight(BaseURL, "/")` 再补 `/v1/chat/completions`，尾斜杠怎么写都对；而
// `/v1` 这类路径前缀是**运维的上游真实形态**，替他裁掉或改写都会改出错误地址。
// 原样保存 → 读回来的值 = 运维写进去的值，diff 得动、解释得清。
func NormalizeUpstreamBaseURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("%w: upstreamBaseUrl 不能为空", ErrInvalidProvider)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("%w: upstreamBaseUrl 不是合法 URL", ErrInvalidProvider)
	}
	switch {
	case parsed.Scheme != "http" && parsed.Scheme != "https":
		// 同时挡住 `localhost:11434` 这类漏写协议的写法：url.Parse 会把
		// "localhost" 当 scheme、把端口当 opaque，看起来「解析成功」。
		return "", fmt.Errorf("%w: upstreamBaseUrl 必须是 http 或 https", ErrInvalidProvider)
	case parsed.Host == "":
		return "", fmt.Errorf("%w: upstreamBaseUrl 缺少主机名", ErrInvalidProvider)
	case parsed.User != nil:
		return "", fmt.Errorf("%w: upstreamBaseUrl 不得包含用户名或密码", ErrInvalidProvider)
	case parsed.RawQuery != "" || parsed.Fragment != "":
		return "", fmt.Errorf("%w: upstreamBaseUrl 必须是基址，不得带查询串或片段", ErrInvalidProvider)
	}
	return trimmed, nil
}

// ValidateUpstreamBaseURL 只要结论不要值的调用方用这个。
func ValidateUpstreamBaseURL(raw string) error {
	_, err := NormalizeUpstreamBaseURL(raw)
	return err
}
