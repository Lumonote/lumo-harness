package ledger

import (
	"strings"
	"testing"
)

// 合法事件夹具：与 TS 侧 sink.spec 的 eventOf 同形状。
func validEvent(costType string, over ...func(*Event)) Event {
	tokens := int64(12)
	e := Event{
		Context: Attribution{
			UserID: "u1", DeptID: "d1", Role: "viewer", ProjectID: "p1",
			AgentID: "a1", ComponentID: "c1", Feature: "kb:qa", SessionRef: "s1",
		},
		CostType: costType,
		Qty:      12,
		TraceID:  "tr-1",
		Emitter:  "emitter:test",
		CostUSD:  0.5,
	}
	switch costType {
	case "llm.tokens":
		e.Unit = "tokens"
		e.Tokens = &tokens
		e.Model = "deepseek"
	case "connector.call":
		e.Unit = "call"
	case "seam.query":
		e.Unit = "rows"
	case "job.compute":
		e.Unit = "second"
	case "storage.bytes":
		e.Unit = "byte-day"
	case "inference.gpu":
		e.Unit = "second"
	}
	for _, f := range over {
		f(&e)
	}
	return e
}

func TestValidateSixTypesOK(t *testing.T) {
	for _, ct := range []string{"llm.tokens", "connector.call", "seam.query", "job.compute", "storage.bytes", "inference.gpu"} {
		if err := ValidateEvent(validEvent(ct)); err != nil {
			t.Fatalf("%s 应合法: %v", ct, err)
		}
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Event)
		want string
	}{
		{"闭集外类型", func(e *Event) { e.CostType = "made.up" }, "未知成本类型"},
		{"单位不符", func(e *Event) { e.Unit = "rows" }, "单位必须是"},
		{"负 qty", func(e *Event) { e.Qty = -1 }, "有限非负"},
		{"NaN qty", func(e *Event) { e.Qty = nan() }, "有限非负"},
		{"负 costUsd", func(e *Event) { e.CostUSD = -0.1 }, "有限非负"},
		{"缺 traceId", func(e *Event) { e.TraceID = "" }, "缺 traceId"},
		{"缺 emitter", func(e *Event) { e.Emitter = "" }, "缺 emitter"},
		{"缺归因", func(e *Event) { e.Context.UserID = "" }, "归因上下文不完整"},
		{"llm 缺 tokens", func(e *Event) { e.Tokens = nil }, "必须带 tokens"},
		{"llm qty≠tokens", func(e *Event) { e.Qty = 13 }, "必须等于 tokens"},
		{"非 llm 带 tokens", func(e *Event) {
			tk := int64(3)
			e.CostType = "job.compute"
			e.Unit = "second"
			e.Tokens = &tk
			e.Model = ""
		}, "不得带 tokens"},
	}
	for _, c := range cases {
		e := validEvent("llm.tokens")
		c.mut(&e)
		err := ValidateEvent(e)
		if err == nil {
			t.Fatalf("%s: 应拒绝却通过", c.name)
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: 错误信息缺 %q: %v", c.name, c.want, err)
		}
	}
}

func TestInsertSQLShape(t *testing.T) {
	sql, err := InsertSQL(2)
	if err != nil {
		t.Fatalf("生成失败: %v", err)
	}
	// 18 列 × 2 行 = 36 占位符：列清单变了这里自动失配
	for i := 1; i <= 36; i++ {
		if !strings.Contains(sql, "$"+itoa(i)+",") && !strings.Contains(sql, "$"+itoa(i)+")") {
			t.Fatalf("缺占位符 $%d", i)
		}
	}
	if !strings.Contains(sql, "ON CONFLICT (event_key) DO NOTHING") {
		t.Fatalf("缺幂等子句: %s", sql)
	}
	if strings.Contains(sql, "(id,") || strings.Contains(sql, " id ") && strings.Contains(sql, "INSERT") {
		// 只查列清单开头：id 不得进 INSERT 列
		head := sql[strings.Index(sql, "(")+1 : strings.Index(sql, ")")]
		if strings.Contains(head, "id") {
			t.Fatalf("INSERT 列含自增主键: %s", head)
		}
	}
	if _, err := InsertSQL(0); err == nil {
		t.Fatalf("0 行应拒绝")
	}
}

func nan() float64 {
	var zero float64
	return zero / zero * -1 // NaN（规避 math 导入仅为测试夹具）
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
