package domain

import (
	"strings"
	"testing"
)

// TestValidateAdvertiseURLAccepts 钉住各部署档位实际写出来的广播地址都能通过，
// 并且返回值是转发端直接可拼路径的规范形式（无尾斜杠）。
func TestValidateAdvertiseURLAccepts(t *testing.T) {
	cases := []struct {
		name, raw, want string
	}{
		{"留空=不广播（follower 不转发，照旧 503）", "", ""},
		{"只有空白等同留空", "  \t", ""},
		{"compose 网络别名", "http://scheduler-0:8083", "http://scheduler-0:8083"},
		{"compose 第二副本的独立端口", "http://scheduler-1:8184", "http://scheduler-1:8184"},
		{"集群本地调度器别名", "http://scheduler-cluster-a:8083", "http://scheduler-cluster-a:8083"},
		{"Helm：Pod IP", "http://10.0.0.3:8083", "http://10.0.0.3:8083"},
		{"Helm：IPv6 Pod IP 必须带方括号", "http://[fd00::1]:8083", "http://[fd00::1]:8083"},
		{"https", "https://scheduler.internal:8443", "https://scheduler.internal:8443"},
		{"不带端口（走协议默认端口）", "http://scheduler-0", "http://scheduler-0"},
		{"K8s 全限定名", "http://lumo-scheduler-0.lumo-scheduler-peers.lumo.svc.cluster.local:8083",
			"http://lumo-scheduler-0.lumo-scheduler-peers.lumo.svc.cluster.local:8083"},
		{"尾斜杠被规范掉", "http://scheduler-0:8083/", "http://scheduler-0:8083"},
		{"首尾空白被裁掉", "  http://scheduler-0:8083\n", "http://scheduler-0:8083"},
		{"单机多进程调试用回环地址", "http://127.0.0.1:8083", "http://127.0.0.1:8083"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateAdvertiseURL(tc.raw)
			if err != nil {
				t.Fatalf("ValidateAdvertiseURL(%q) 不应报错: %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("ValidateAdvertiseURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestValidateAdvertiseURLRejects 钉住「写进租约行之后才会坏」的那些取值必须在启动时
// 就被拒绝。
//
// 这些值的共同点：进程照常启动、照常当上 leader、照常把地址落库，只有 follower
// 转发时才失败——而转发失败对调用方的表现是 503 no-leader，与「正在换主」一模一样。
func TestValidateAdvertiseURLRejects(t *testing.T) {
	cases := []struct {
		name, raw, wantInErr string
	}{
		{"没有协议（最常见的手误）", "scheduler-0:8083", "http"},
		{"只有主机名", "scheduler-0", "http"},
		{"非 http(s) 协议", "tcp://scheduler-0:8083", "http"},
		{"grpc 协议", "grpc://scheduler-0:8083", "http"},
		{"没有主机", "http://:8083", "主机"},
		{"K8s 变量未展开（$(VAR) 原样进了进程）", "http://$(LUMO_POD_IP):8083", "主机"},
		{"shell 变量未展开", "http://${POD_IP}:8083", "主机"},
		{"监听通配地址不是可达地址（IPv4）", "http://0.0.0.0:8083", "通配"},
		{"监听通配地址不是可达地址（IPv6）", "http://[::]:8083", "通配"},
		{"IPv6 没带方括号", "http://fd00::1:8083", ""},
		{"端口为 0", "http://scheduler-0:0", "端口"},
		{"端口越界", "http://scheduler-0:70000", "端口"},
		{"端口非数字", "http://scheduler-0:http", ""},
		{"带了接口路径（转发端会在后面再拼一遍请求路径）", "http://scheduler-0:8083/v1/placements", "路径"},
		{"带查询串", "http://scheduler-0:8083?x=1", "查询"},
		{"带片段", "http://scheduler-0:8083#x", "片段"},
		{"带凭据（会随租约行明文落库）", "http://user:pass@scheduler-0:8083", "凭据"},
		{"主机名含下划线以外的非法字符", "http://sched uler:8083", ""},
		{"主机名以连字符开头", "http://-scheduler:8083", "主机"},
		{"越界的 IPv4 不能被当成域名放过", "http://10.0.0.300:8083", "主机"},
		{"方括号里不是 IPv6", "http://[scheduler-0]:8083", "主机"},
		{"冒号后面没有端口", "http://scheduler-0:", "端口"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateAdvertiseURL(tc.raw)
			if err == nil {
				t.Fatalf("ValidateAdvertiseURL(%q) 应当报错，却返回 %q", tc.raw, got)
			}
			if got != "" {
				t.Fatalf("报错时不得返回可用地址，got %q", got)
			}
			if !strings.Contains(err.Error(), "LUMO_ADVERTISE_URL") {
				t.Fatalf("错误信息必须点名配置项，got %q", err.Error())
			}
			if tc.wantInErr != "" && !strings.Contains(err.Error(), tc.wantInErr) {
				t.Fatalf("错误信息应说明原因（含 %q），got %q", tc.wantInErr, err.Error())
			}
		})
	}
}

// TestResolveAdvertiseURLFromHostAndPort 钉住「主机与端口分开给」这条入口。
//
// 它存在的理由是 K8s：chart 只能拿到 Pod IP（status.podIP），而环境变量展开
// 做不了「是 IPv6 就加方括号」。让 chart 拼 URL，IPv6 单栈集群里拼出来的就是
// `http://fd00::1:8083`——非法。所以拼接必须在进程里做。
func TestResolveAdvertiseURLFromHostAndPort(t *testing.T) {
	cases := []struct {
		name, url, host, port, listen, want string
	}{
		{"IPv4 Pod IP", "", "10.0.0.3", "8083", ":8083", "http://10.0.0.3:8083"},
		{"IPv6 Pod IP 自动加方括号", "", "fd00::1", "8083", ":8083", "http://[fd00::1]:8083"},
		{"已带方括号的 IPv6 不重复加", "", "[fd00::1]", "8083", ":8083", "http://[fd00::1]:8083"},
		{"主机名", "", "scheduler-0", "8083", ":8083", "http://scheduler-0:8083"},
		{"端口留空时取监听端口", "", "10.0.0.3", "", ":8184", "http://10.0.0.3:8184"},
		{"监听地址带主机时仍取其端口", "", "fd00::1", "", "[::]:8083", "http://[fd00::1]:8083"},
		{"显式端口优先于监听端口", "", "10.0.0.3", "9000", ":8083", "http://10.0.0.3:9000"},
		{"只给 URL：原有入口不变", "http://scheduler-0:8083/", "", "", ":8083", "http://scheduler-0:8083"},
		{"什么都不给：不广播", "", "", "", ":8083", ""},
		{"主机首尾空白被裁掉", "", " 10.0.0.3 ", "8083", ":8083", "http://10.0.0.3:8083"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveAdvertiseURL(tc.url, tc.host, tc.port, tc.listen)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveAdvertiseURLRejects(t *testing.T) {
	cases := []struct {
		name, url, host, port, listen, wantInErr string
	}{
		{"URL 与主机同时给（两个来源，不猜哪个算数）", "http://scheduler-0:8083", "10.0.0.3", "", ":8083", "LUMO_ADVERTISE_HOST"},
		{"只给端口不给主机", "", "", "8083", ":8083", "LUMO_ADVERTISE_HOST"},
		{"主机是通配地址", "", "0.0.0.0", "8083", ":8083", "通配"},
		{"主机是未展开的变量引用", "", "$(POD_IP)", "8083", ":8083", "主机"},
		{"主机里带了端口", "", "10.0.0.3:8083", "8083", ":8083", ""},
		{"主机里带了协议", "", "http://10.0.0.3", "8083", ":8083", ""},
		{"端口非法", "", "10.0.0.3", "http", ":8083", "端口"},
		{"端口留空且监听地址没有端口", "", "10.0.0.3", "", "", "端口"},
		{"URL 本身非法仍被拒", "scheduler-0:8083", "", "", ":8083", "LUMO_ADVERTISE_URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveAdvertiseURL(tc.url, tc.host, tc.port, tc.listen)
			if err == nil {
				t.Fatalf("应当报错，却返回 %q", got)
			}
			if got != "" {
				t.Fatalf("报错时不得返回可用地址，got %q", got)
			}
			if tc.wantInErr != "" && !strings.Contains(err.Error(), tc.wantInErr) {
				t.Fatalf("错误信息应含 %q，got %q", tc.wantInErr, err.Error())
			}
		})
	}
}
