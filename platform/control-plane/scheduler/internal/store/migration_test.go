package store

import "testing"

// TestAppendAvoidNode 反亲和名单的追加语义。
//
// 这张表是漂移防「放回原节点造成双执行」的唯一机制（见 MigrateTask 的注释），
// 所以它有两个方向都要钉住：**该加的必须加上**（否则防护等于没有），
// **已存在的不能重复加**（否则反复漂移会让这张表无界增长，而每一轮都要
// Unmarshal 它）。
func TestAppendAvoidNode(t *testing.T) {
	cases := []struct {
		name     string
		existing string
		nodeID   string
		want     string
	}{
		{"空名单追加", `[]`, "n1", `["n1"]`},
		{"已有其他节点", `["old"]`, "n1", `["old","n1"]`},
		{"已含该节点不重复", `["n1"]`, "n1", `["n1"]`},
		{"已含且还有其他", `["old","n1"]`, "n1", `["old","n1"]`},
		{"空节点原样规范化", `[]`, "", `[]`},
		// 列里存 null / 空串都得正常收敛到 `[]`：DDL 默认是 `'[]'`，但手工写的
		// 行未必是。nil slice 若被 Marshal 成 `null`，值会与本列默认形态不一致。
		{"null 收敛成空数组", `null`, "", `[]`},
		{"空串收敛成空数组", ``, "", `[]`},
		{"空串加节点", ``, "n1", `["n1"]`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := appendAvoidNode(c.existing, c.nodeID)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if got != c.want {
				t.Fatalf("appendAvoidNode(%q, %q) = %q, want %q", c.existing, c.nodeID, got, c.want)
			}
		})
	}
}

// TestAppendAvoidNodeRejectsMalformedJSON 坏 JSON 必须报错而不是当成空数组。
//
// 当成空数组的后果是**静默丢掉整份已有反亲和名单**——而漂移刚刚才依赖这张表
// 把原节点挡住。宁可让这一个任务的漂移停住并留下错误日志（下一轮还会被看到），
// 也不要写出一个看起来正常、实际上放宽了约束的结果。
func TestAppendAvoidNodeRejectsMalformedJSON(t *testing.T) {
	for _, bad := range []string{`{"a":1}`, `["n1"`, `n1`, `["n1",]`} {
		t.Run(bad, func(t *testing.T) {
			if _, err := appendAvoidNode(bad, "n2"); err == nil {
				t.Fatalf("坏 JSON %q 应被拒绝", bad)
			}
		})
	}
}
