package domain

import (
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// dnsHostPattern 广播地址里允许的主机名：点分标签，标签由字母、数字、`-`、`_` 组成且不以
// `-` 开头或结尾。下划线不在 RFC 1123 里，但 compose 的服务名/别名允许它，这里放行。
//
// 用白名单而不是「url.Parse 没报错就行」：`$`、`(`、`)` 是 URL 主机里合法的 sub-delims，
// 所以 `http://$(LUMO_POD_IP):8083`——K8s 没展开环境变量引用时原样落进进程的值——
// 能通过 url.Parse。
var dnsHostPattern = regexp.MustCompile(
	`^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$`)

// numericHostPattern 「看起来想写成 IPv4」的主机：全是数字和点。这类值必须真的是合法 IP，
// 否则 `10.0.0.300` 会被当成域名放过去。
var numericHostPattern = regexp.MustCompile(`^[0-9.]+$`)

// ValidateAdvertiseURL 校验并规范化 `LUMO_ADVERTISE_URL`（本实例对其他调度副本可达的地址）。
//
// # 为什么要在启动时校验
//
// 这个值的消费者不是本进程，而是**别的副本**：本实例当上 leader 时它随租约行落库，
// follower 读出来、在后面拼上请求路径、把放置请求转发过去。所以写错的后果有三个特点：
//
//   - 写的人看不见：本进程照常启动、照常当 leader、自己收到的请求照常处理；
//   - 坏在别处：只有落到 follower 的请求才失败；
//   - 失败长得像别的事：转发失败对调用方是 503 no-leader，与「正在换主」一模一样，
//     而换主是预期内的瞬态，没人会去查。
//
// 与本包其他启动期校验（ResolveClusterEnforcement 等）同一条判据：**配错与「一切正常」
// 在观测面上不可区分时，拒绝启动**，而不是静默回落。
//
// # 规则
//
// 留空（或只有空白）合法，返回空串：表示不广播，follower 不转发、照旧 503。
// 否则必须是 `http(s)://主机[:端口]`：
//
//   - 主机是合法 IP 或域名；IPv6 必须带方括号；
//   - 不能是通配地址（0.0.0.0 / ::）——那是监听地址，不是别人连得上的地址；
//   - 不能带路径、查询串、片段：转发端会在后面拼请求路径，带了路径等于拼两遍；
//   - 不能带凭据：这个值明文写进租约行，并出现在 follower 的转发日志里。
//
// 回环地址放行：单机起多个进程调试（各占一个端口）是正当用法，这里分辨不出它与
// 「多机部署里误写了 localhost」的区别。
//
// 返回值是规范形式 `scheme://host[:port]`（无尾斜杠），可直接在后面拼路径。
func ValidateAdvertiseURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	reject := func(reason string) (string, error) {
		return "", fmt.Errorf("LUMO_ADVERTISE_URL %s，当前 %q（应形如 http://主机:端口）", reason, raw)
	}

	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("LUMO_ADVERTISE_URL 不是合法 URL（应形如 http://主机:端口），当前 %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return reject("必须以 http:// 或 https:// 开头")
	}
	if u.User != nil {
		return reject("不能带凭据（它会明文写进租约行）")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return reject("不能带查询串")
	}
	if u.Fragment != "" {
		return reject("不能带片段")
	}
	if u.Path != "" && u.Path != "/" {
		return reject("不能带路径（转发端会在后面拼请求路径）")
	}

	host := u.Hostname()
	if host == "" {
		return reject("缺少主机")
	}
	bracketed := strings.HasPrefix(u.Host, "[")
	if strings.Contains(host, ":") && !bracketed {
		// `http://fd00::1:8083` 能通过 url.Parse（最后一段被当成端口），但拨号时会因
		// 「地址里冒号太多」失败。Helm 用 Pod IP 拼地址，IPv6 集群里拼出来的就是这个形状。
		return reject("里的 IPv6 主机必须带方括号（如 http://[fd00::1]:8083）")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if addr.IsUnspecified() {
			return reject("不能是通配地址（0.0.0.0 / :: 是监听地址，其他副本连不上）")
		}
	} else {
		name := strings.TrimSuffix(host, ".")
		if bracketed || len(name) > 253 || numericHostPattern.MatchString(name) || !dnsHostPattern.MatchString(name) {
			return reject("的主机不是合法的 IP 或域名（环境变量引用没被展开时也会落到这里）")
		}
	}

	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return reject("的端口必须在 1-65535 之间")
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return reject("的端口为空")
	}

	return u.Scheme + "://" + u.Host, nil
}

// ResolveAdvertiseURL 从两种互斥的入口得出广播地址：
//
//   - `LUMO_ADVERTISE_URL`：完整地址，compose 这类「主机名事先就知道」的部署用它；
//   - `LUMO_ADVERTISE_HOST`（+ 可选的 `LUMO_ADVERTISE_PORT`）：只给主机，由这里拼。
//
// # 为什么要有第二种入口
//
// K8s 里副本的可达地址是 Pod IP，chart 只能通过 downward API 拿到裸 IP，而环境变量
// 展开做不了「是 IPv6 就加方括号」。让 chart 拼 URL，IPv4 集群里是
// `http://10.0.0.3:8083`，IPv6 单栈集群里就成了 `http://fd00::1:8083`——非法地址。
// 拼接放在进程里，同一份 chart 在两种集群里都对。
//
// 端口留空时取监听端口（listen 形如 `:8083`）：副本对外可达的端口默认就是它监听的
// 那个，少一处要保持一致的配置。
//
// 两种入口同时给出时**拒绝启动**，不定优先级：两个来源说的可能不是同一个地址，
// 而选错的后果（转发到错误副本 / 503）只在别的副本上可见。
func ResolveAdvertiseURL(rawURL, rawHost, rawPort, listen string) (string, error) {
	host, port := strings.TrimSpace(rawHost), strings.TrimSpace(rawPort)
	if host == "" {
		if port != "" {
			return "", fmt.Errorf("LUMO_ADVERTISE_PORT 必须与 LUMO_ADVERTISE_HOST 一起使用，当前只设了端口 %q", rawPort)
		}
		return ValidateAdvertiseURL(rawURL)
	}
	if strings.TrimSpace(rawURL) != "" {
		return "", fmt.Errorf("LUMO_ADVERTISE_URL 与 LUMO_ADVERTISE_HOST 只能设一个，当前分别是 %q 与 %q", rawURL, rawHost)
	}

	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if addr.Zone() != "" {
			return "", fmt.Errorf("LUMO_ADVERTISE_HOST 不能是带 zone 的链路本地地址（其他副本连不上），当前 %q", rawHost)
		}
	} else if numericHostPattern.MatchString(host) || !dnsHostPattern.MatchString(host) {
		return "", fmt.Errorf("LUMO_ADVERTISE_HOST 的主机不是合法的 IP 或域名（只写主机，不带协议和端口；环境变量引用没被展开时也会落到这里），当前 %q", rawHost)
	}

	if port == "" {
		_, listenPort, err := net.SplitHostPort(strings.TrimSpace(listen))
		if err != nil || listenPort == "" {
			return "", fmt.Errorf("未设 LUMO_ADVERTISE_PORT，且无法从监听地址 %q 取出端口", listen)
		}
		port = listenPort
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("广播地址的端口必须在 1-65535 之间（LUMO_ADVERTISE_PORT 或监听端口），当前 %q", port)
	}

	// 拼好之后再过一遍完整校验：通配地址等规则只写在一处。
	resolved, err := ValidateAdvertiseURL("http://" + net.JoinHostPort(host, port))
	if err != nil {
		return "", fmt.Errorf("由 LUMO_ADVERTISE_HOST=%q 拼出的广播地址非法: %w", rawHost, err)
	}
	return resolved, nil
}
