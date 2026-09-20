package domain

import (
	"strings"
	"testing"
)

// 写侧：键的形状与 fail-closed 的空值。
func TestWakeTraceShapes(t *testing.T) {
	if got := WakeTrace(7); got != "flow-trigger-7" {
		t.Fatalf("WakeTrace(7) = %q", got)
	}
	if got := WakeTrace(0); got != "" {
		t.Fatalf("未知唤醒源必须不铸键（否则台账里会出现「第 0 号事件唤醒了它」的假归因）: %q", got)
	}
	// 键要进 HTTP 头（X-Lumo-Trace），所以它必须是合法头值：可见 ASCII、无空格无控制字符。
	// 这条不是形式主义——一旦有人在键里塞进项目名或事件名，头会被 net/http 拒绝，
	// 表现成「唤醒执行的算子全部失败」，而失败原因看起来与归因毫无关系。
	key := WakeTrace(18446744073709551615)
	if key == "" || strings.ContainsAny(key, " \t\r\n") {
		t.Fatalf("归因键不是合法头值: %q", key)
	}
	for i := 0; i < len(key); i++ {
		if key[i] <= 0x20 || key[i] >= 0x7f {
			t.Fatalf("归因键含非可见 ASCII 字节 0x%02x: %q", key[i], key)
		}
	}
}

// 读侧：往返 + 三种必须被拒的形状。
func TestParseWakeTraceRoundTripAndRejections(t *testing.T) {
	id, ok := ParseWakeTrace(WakeTrace(42))
	if !ok || id != 42 {
		t.Fatalf("往返失败: id=%d ok=%v", id, ok)
	}
	if _, ok := ParseWakeTrace(WakeTrace(18446744073709551615)); !ok {
		t.Fatal("uint64 上界应能往返")
	}

	for _, tc := range []struct {
		trace  string
		reason string
	}{
		{"", "空串不是唤醒键"},
		{"gw-1a2b3c", "网关自铸的 trace 明确不可归因"},
		{"flow-trigger-", "前缀对但无值"},
		{"flow-trigger-0", "0 不是唤醒源（表主键从 1 起）"},
		{"flow-trigger-007", "前导零会让同一事件有两个键，聚合静默裂成两行"},
		{"flow-trigger-+7", "非规范写法"},
		{"flow-trigger-7 ", "尾随空白不算同一个键"},
		{"flow-trigger-7x", "解析失败"},
		{"flow-trigger--7", "负号不是无符号 id"},
		{"flow-trigger-18446744073709551616", "越界"},
		{"FLOW-TRIGGER-7", "前缀区分大小写——放宽会让两套键都合法"},
	} {
		if parsed, ok := ParseWakeTrace(tc.trace); ok {
			t.Fatalf("ParseWakeTrace(%q) 应被拒（%s），实际解出 %d", tc.trace, tc.reason, parsed)
		}
	}
}
