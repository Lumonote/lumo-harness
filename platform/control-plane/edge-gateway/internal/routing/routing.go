// Package routing 实现边缘网关的「路由分发」（§12.1 四件事之二）。
//
// 路由表是声明式的（JSON 文件或 env 指定路径），在**加载时**完成全部校验，
// 因此非法配置会在启动/重载那一刻被拒绝，而不是在请求时才炸——边界网关的
// 职责是「门」，门的形状必须在营业前就确定。
package routing

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
)

// RouteTable 是声明式路由表。
type RouteTable struct {
	// Whitelist 是允许作为上游主机的显式白名单（"host:port"）。边界隔离的
	// 硬要求：任何路由指向未在白名单内的上游都必须在加载时被拒，绝不能等
	// 请求到来才去连一个不该连的主机。
	Whitelist []string `json:"whitelist"`
	Routes    []Route  `json:"routes"`
}

// Route 单条路由规则。
type Route struct {
	// Prefix 是路径前缀匹配，必须以 "/" 开头。
	Prefix string `json:"prefix"`
	// Host 可选：额外要求请求的 Host 头与之相等；为空表示任意 Host。
	Host string `json:"host,omitempty"`
	// Upstream 主上游 base URL（含 scheme://host）。
	Upstream string `json:"upstream"`
	// RateLimitRPM 该路由每秒每客户端的配额（0 = 不限流）。
	RateLimitRPM int `json:"rate_limit_rpm,omitempty"`
	// Canary 灰度分流配置；为空表示无灰度。
	Canary *Canary `json:"canary,omitempty"`
}

// Canary 灰度分流：同一路由在两个上游之间按 header 或权重分流。
type Canary struct {
	// Header 命中该请求头（且匹配 HeaderValue，若设置）则 100% 走 canary 上游。
	// 用于「带 sticky 标头的人工灰度」——运维/测试用固定 header 切流，确定性最强。
	Header string `json:"header,omitempty"`
	// HeaderValue 仅当 Header 设置时生效；为空表示「只要该头存在即命中」。
	HeaderValue string `json:"header_value,omitempty"`
	// Upstream canary 上游 base URL。
	Upstream string `json:"upstream"`
	// Weight canary 权重（0..100），表示「没有命中 header 余下流量中分给 canary
	// 的百分比」。要求 1..99：0 或 100 都不是「分流」而是「全量」，属配置错误。
	Weight int `json:"weight"`
}

// Parse 解码路由表，并拒绝任何未知字段（DisallowUnknownFields 递归作用于
// 嵌套结构）。未知字段通常是拼写错误或旧字段残留，静默忽略会让人误以为配置
// 生效了，所以这里选择直接报错。
func Parse(data []byte) (*RouteTable, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	var rt RouteTable
	if err := dec.Decode(&rt); err != nil {
		return nil, fmt.Errorf("routing: 解析路由表失败: %w", err)
	}
	return &rt, nil
}

// LoadPath 从文件读取并解析路由表。
func LoadPath(path string) (*RouteTable, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("routing: 读取路由表 %s 失败: %w", path, err)
	}
	return Parse(data)
}

// Validate 在加载时校验整张表，返回第一个（以及收集到的全部）错误。
func (rt *RouteTable) Validate() error {
	var errs []error

	// 空表是**配置错误**而不是「什么都不代理」这种合法取舍：网关的全部价值就是
	// 那张表，0 条路由意味着所有南北请求都 404，而它的症状（全站 404）与
	// 「一次坏合并把 routes 删空了」完全一样。本仓库在 CI 上反复吃过「0 个执行
	// 用例 = 没有证据，但看起来像通过」的亏，这里是同一类守卫。
	if len(rt.Routes) == 0 {
		errs = append(errs, errors.New("routing: 路由表里没有任何路由（网关将拒绝所有请求）"))
	}

	wl := make(map[string]bool, len(rt.Whitelist))
	for _, h := range rt.Whitelist {
		if h == "" {
			errs = append(errs, errors.New("routing: 白名单含空主机"))
			continue
		}
		if wl[h] {
			errs = append(errs, fmt.Errorf("routing: 白名单重复主机 %q", h))
			continue
		}
		wl[h] = true
	}

	for i, r := range rt.Routes {
		tag := fmt.Sprintf("routes[%d]", i)
		if !strings.HasPrefix(r.Prefix, "/") {
			errs = append(errs, fmt.Errorf("%s: prefix 必须以 / 开头, 得到 %q", tag, r.Prefix))
		}
		if r.Upstream == "" {
			errs = append(errs, fmt.Errorf("%s: upstream 为空", tag))
		} else if host := hostOf(r.Upstream); host == "" || !wl[host] {
			// 边界隔离：上游主机不在白名单 → 加载时拒绝，而不是请求时才连。
			errs = append(errs, fmt.Errorf("%s: upstream 主机 %q 不在白名单内", tag, host))
		}
		if r.Canary != nil {
			c := r.Canary
			if c.Upstream == "" {
				errs = append(errs, fmt.Errorf("%s.canary: upstream 为空", tag))
			} else if host := hostOf(c.Upstream); host == "" || !wl[host] {
				errs = append(errs, fmt.Errorf("%s.canary: upstream 主机 %q 不在白名单内", tag, host))
			}
			// 灰度权重必须显式给出且落在 (0,100)：缺权重或和为 100 不成立都是错。
			if c.Weight <= 0 || c.Weight >= 100 {
				errs = append(errs, fmt.Errorf("%s.canary: weight 必须落在 (0,100), 得到 %d", tag, c.Weight))
			}
		}
	}

	// 重复 / 重叠路由：两条同 Host 的路由，若其一前缀是另一条前缀的前缀，则
	// 匹配会歧义（我们是前缀匹配且拒绝重叠，因此不允许）。同前缀同 Host 视为
	// 重复（也是一种重叠）。
	for i := 0; i < len(rt.Routes); i++ {
		for j := i + 1; j < len(rt.Routes); j++ {
			a, b := rt.Routes[i], rt.Routes[j]
			if a.Host != b.Host {
				continue
			}
			if a.Prefix == b.Prefix {
				errs = append(errs, fmt.Errorf("routes[%d] 与 routes[%d] 重复 (prefix=%q host=%q)", i, j, a.Prefix, a.Host))
				continue
			}
			if strings.HasPrefix(b.Prefix, a.Prefix) || strings.HasPrefix(a.Prefix, b.Prefix) {
				errs = append(errs, fmt.Errorf("routes[%d](%q) 与 routes[%d](%q) 前缀重叠 (host=%q)", i, a.Prefix, j, b.Prefix, a.Host))
			}
		}
	}

	if len(errs) == 1 {
		return errs[0]
	}
	if len(errs) > 1 {
		return fmt.Errorf("routing: 路由表校验失败:\n  %s", joinErrs(errs))
	}
	return nil
}

func joinErrs(errs []error) string {
	parts := make([]string, len(errs))
	for i, e := range errs {
		parts[i] = e.Error()
	}
	return strings.Join(parts, "\n  ")
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Host
}

// CompiledRoute 是校验通过并已解析 URL 的路由，供运行时匹配与转发使用。
type CompiledRoute struct {
	Raw     Route
	Prefix  string
	Host    string
	Primary *url.URL
	Canary  *compiledCanary
}

type compiledCanary struct {
	Header string
	Value  string
	URL    *url.URL
	Weight int
}

// Compiled 是加载、校验、编译后的可运行路由表。
type Compiled struct {
	Whitelist []string
	Routes    []*CompiledRoute
}

// Compile 把 RouteTable 编译成运行时结构。调用前应已通过 Validate；这里仍然
// 解析上游 URL，失败即返回错误（理论上 Validate 已保证白名单/非空，但 URL
// 解析是编译步骤，独立成错更易定位）。
func (rt *RouteTable) Compile() (*Compiled, error) {
	c := &Compiled{Whitelist: append([]string(nil), rt.Whitelist...)}
	for i, r := range rt.Routes {
		pu, err := url.Parse(r.Upstream)
		if err != nil {
			return nil, fmt.Errorf("routes[%d]: 解析 upstream 失败: %w", i, err)
		}
		cr := &CompiledRoute{Raw: r, Prefix: r.Prefix, Host: r.Host, Primary: pu}
		if r.Canary != nil {
			cu, err := url.Parse(r.Canary.Upstream)
			if err != nil {
				return nil, fmt.Errorf("routes[%d].canary: 解析 upstream 失败: %w", i, err)
			}
			cr.Canary = &compiledCanary{Header: r.Canary.Header, Value: r.Canary.HeaderValue, URL: cu, Weight: r.Canary.Weight}
		}
		c.Routes = append(c.Routes, cr)
	}
	return c, nil
}

// Match 按请求路径与 Host 选择路由。前缀匹配 + Host 约束，取最长前缀（重叠已
// 在加载时被拒，因此最长匹配是唯一的）。未命中返回 nil。
func (c *Compiled) Match(path, host string) *CompiledRoute {
	var best *CompiledRoute
	for _, r := range c.Routes {
		if r.Host != "" && r.Host != host {
			continue
		}
		if !strings.HasPrefix(path, r.Prefix) {
			continue
		}
		if best == nil || len(r.Prefix) > len(best.Prefix) {
			best = r
		}
	}
	return best
}

// SelectUpstream 返回该请求应转发到的上游 URL（已考虑灰度分流）。
//
// 确定性：基于 X-Lumo-Correlation-Id 做稳定哈希（若该头缺失则用客户端地址 +
// 方法 + 路径兜底），同一相关 id 永远命中同一上游——这使得灰度分流可重现、可
// 测试（测试里只需固定该头）。权重分流用 hash % 100 < weight 判定，大批请求
// 下分布收敛到 weight%。header 命中则强制走 canary（sticky 灰度）。
func (cr *CompiledRoute) SelectUpstream(r *http.Request) *url.URL {
	if cr.Canary != nil {
		if cr.Canary.matchesHeader(r) {
			return cr.Canary.URL
		}
		if hashMod100(canarySeed(r)) < cr.Canary.Weight {
			return cr.Canary.URL
		}
	}
	return cr.Primary
}

func (cc *compiledCanary) matchesHeader(r *http.Request) bool {
	if cc.Header == "" {
		return false
	}
	v := r.Header.Get(cc.Header)
	if cc.Value == "" {
		return v != ""
	}
	return v == cc.Value
}

// canarySeed 返回用于灰度判定的稳定种子串。
func canarySeed(r *http.Request) string {
	if id := r.Header.Get("X-Lumo-Correlation-Id"); id != "" {
		return id
	}
	return r.RemoteAddr + " " + r.Method + " " + r.URL.Path
}

// hashMod100 用 FNV-1a 把种子映射到 [0,100)。选 FNV 是因为它快、无外部依赖、
// 且对短字符串分布足够均匀，足以支撑灰度权重分布。
func hashMod100(seed string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(seed))
	return int(h.Sum32() % 100)
}

// SortByPrefix 让路由表按 (host, prefix) 稳定排序，仅用于日志/自省展示。
func (c *Compiled) SortByPrefix() {
	sort.SliceStable(c.Routes, func(i, j int) bool {
		if c.Routes[i].Host != c.Routes[j].Host {
			return c.Routes[i].Host < c.Routes[j].Host
		}
		return c.Routes[i].Prefix < c.Routes[j].Prefix
	})
}
