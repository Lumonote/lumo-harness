package events

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func seed(t *testing.T, m *MemoryEventSource, sess string, n int) {
	t.Helper()
	for i := 1; i <= n; i++ {
		m.Append(sess, Event{
			Type:     "step",
			NodeKind: "cost_breakdown",
			Payload:  json.RawMessage(`{"i":` + itoa(i) + `}`),
		})
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}

func TestHistory_CursorBoundaries(t *testing.T) {
	m := NewMemory()
	seed(t, m, "s1", 5)
	ctx := context.Background()

	// 边界1：since == 0 → 全部 5 条。
	all, err := m.History(ctx, "s1", 0)
	if err != nil || len(all) != 5 {
		t.Fatalf("since=0 应返回全部 5 条，得到 %d, err=%v", len(all), err)
	}

	// 边界2：since == latest(5) → 恰好追上，返回空。
	latest, _ := m.LatestSeq(ctx, "s1")
	if latest != 5 {
		t.Fatalf("latest 应为 5，得到 %d", latest)
	}
	eq, err := m.History(ctx, "s1", latest)
	if err != nil || len(eq) != 0 {
		t.Fatalf("since=latest 应返回空，得到 %d, err=%v", len(eq), err)
	}

	// 边界3：since > latest（越界）→ 不报错、不 panic，返回空。
	over, err := m.History(ctx, "s1", latest+5)
	if err != nil {
		t.Fatalf("since>latest 不应报错，得到 %v", err)
	}
	if len(over) != 0 {
		t.Fatalf("since>latest 应返回空，得到 %d", len(over))
	}

	// 边界4：since < 0 → 错误（上游不该传负值游标）。
	if _, err := m.History(ctx, "s1", -1); !errors.Is(err, errNegativeCursor()) {
		// 用一个间接判断：错误不为 nil 即可（不导出哨兵）。
		if err == nil {
			t.Fatalf("since<0 应报错")
		}
	}

	// 中间游标：since == 3 → 返回 seq 4,5 共 2 条。
	mid, err := m.History(ctx, "s1", 3)
	if err != nil || len(mid) != 2 || mid[0].Seq != 4 || mid[1].Seq != 5 {
		t.Fatalf("since=3 应返回 seq 4,5，得到 %+v, err=%v", mid, err)
	}
}

func errNegativeCursor() error { return errors.New("replay 游标不能为负") }

func TestHistory_EmptySession(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	// 从未有过事件的会话：历史为空而不是伪造错误。
	out, err := m.History(ctx, "nope", 0)
	if err != nil || len(out) != 0 {
		t.Fatalf("空会话应返回空历史，得到 %d, err=%v", len(out), err)
	}
	if latest, _ := m.LatestSeq(ctx, "nope"); latest != 0 {
		t.Fatalf("空会话 latest 应为 0，得到 %d", latest)
	}
}

func TestSubscribe_DeliversAppended(t *testing.T) {
	m := NewMemory()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := m.Subscribe(ctx, "s2")
	if err != nil {
		t.Fatalf("订阅失败: %v", err)
	}
	// 订阅之后再追加，应被实时投递。
	ev := m.Append("s2", Event{Type: "live", Payload: json.RawMessage(`{}`)})
	select {
	case got := <-ch:
		if got.Seq != ev.Seq {
			t.Fatalf("收到的事件 seq=%d，期望 %d", got.Seq, ev.Seq)
		}
	default:
		t.Fatalf("订阅者未收到实时事件")
	}
}
