// Command edge-gateway-check 是边缘网关的**配置自检入口**。
//
// 它在不连 PG、不连 Redis、不监听端口的情况下，把一张路由表按服务启动时的同一条路径
// 走一遍（LoadPath → Validate → Compile），并打印编译后的路由摘要。存在的理由是
// 部署门禁：`platform/deploy/edge-routes-verify.sh` 要在 CI 里验证被部署的那张表，
// 而直接跑 `edge-gateway` 本体需要数据库与监听端口——那会让「配置有问题」和
// 「环境没起来」变成同一种失败。
//
// 退出码与主程序一致：0 = 表可用，2 = 配置错误（这是配置问题，不是运行期故障）。
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/lumo-harness/platform/edge-gateway/internal/routing"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "用法: edge-gateway-check <routes.json>")
		os.Exit(2)
	}
	path := os.Args[1]

	table, err := routing.LoadPath(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "配置错误: %v\n", err)
		os.Exit(2)
	}
	if err := table.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "配置错误: %v\n", err)
		os.Exit(2)
	}
	// Compile 也必须走一遍：Validate 只看字段语义，URL 解析与灰度编译在这一步，
	// 只过 Validate 的表仍然可能在启动时 exit 2。
	compiled, err := table.Compile()
	if err != nil {
		fmt.Fprintf(os.Stderr, "配置错误: %v\n", err)
		os.Exit(2)
	}

	// 摘要按前缀排序输出，方便人工核对「门后到底代理了哪些面」，也让脚本可以
	// 对前缀集合做断言（顺序稳定才谈得上比对）。
	compiled.SortByPrefix()
	summary := make([]map[string]any, 0, len(compiled.Routes))
	for _, r := range compiled.Routes {
		row := map[string]any{"prefix": r.Prefix, "upstream": r.Primary.String()}
		if r.Canary != nil {
			row["canary"] = r.Canary.URL.String()
			row["canary_weight"] = r.Canary.Weight
		}
		summary = append(summary, row)
	}
	out, _ := json.MarshalIndent(map[string]any{
		"routes":    len(compiled.Routes),
		"whitelist": compiled.Whitelist,
		"table":     summary,
	}, "", "  ")
	fmt.Println(string(out))
}
