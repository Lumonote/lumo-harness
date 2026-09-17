package presence

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/terminal-gateway/internal/capability"
)

// fakeClock 是可被测试推进的时钟，避免真实 sleep。
type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time          { return c.now }
func (c *fakeClock) advance(d time.Duration) { c.now = c.now.Add(d) }

func newStore(ttl time.Duration) (*Store, *fakeClock) {
	clk := &fakeClock{now: time.Unix(1000, 0)}
	return NewStore(ttl, clk.Now), clk
}

func TestSnapshot_ActiveAndExpired(t *testing.T) {
	s, clk := newStore(30 * time.Second)
	s.Touch(Entry{SessionRef: "s1", TerminalID: "a", Kind: capability.KindWeb})

	// a 先上线，然后把时钟推进到超过 TTL，再让 b 上线：a 应过期、b 仍在线。
	clk.advance(31 * time.Second)
	s.Touch(Entry{SessionRef: "s1", TerminalID: "b", Kind: capability.KindCLI})

	if got := s.Snapshot("s1"); len(got) != 1 || got[0].TerminalID != "b" {
		t.Fatalf("过期收敛错误，得到 %+v", got)
	}
}

// 反例（重要）：进程被 kill，断开回调永远不到。只要真实时间推进超过 TTL，
// 条目必须被自然收敛掉——不能依赖任何清理回调。这里不调用 Leave，纯靠时间。
func TestExpiry_ConvergesAfterKill(t *testing.T) {
	s, clk := newStore(10 * time.Second)
	s.Touch(Entry{SessionRef: "s1", TerminalID: "ghost", Kind: capability.KindMobile})

	// 模拟进程被杀：既不停心跳、也不调用 Leave。时间照常流逝。
	clk.advance(11 * time.Second)
	if got := s.Snapshot("s1"); len(got) != 0 {
		t.Fatalf("被杀终端应已收敛，却仍在线: %+v", got)
	}
}

func TestTouch_OverwritesSameTerminal(t *testing.T) {
	s, _ := newStore(30 * time.Second)
	s.Touch(Entry{SessionRef: "s1", TerminalID: "a", Kind: capability.KindWeb})
	s.Touch(Entry{SessionRef: "s1", TerminalID: "a", Kind: capability.KindMobile})
	got := s.Snapshot("s1")
	if len(got) != 1 || got[0].Kind != capability.KindMobile {
		t.Fatalf("同一终端应被覆盖为最新能力，得到 %+v", got)
	}
}

// 用 ReplaceGauges 导出：某会话在线 2 人 → 指标出现且值为 2；全员离线后整体替换
// 必须让该 session_ref 的序列**消失**（维度消失可被表达）。
func TestPublishMetrics_DimensionDisappears(t *testing.T) {
	s, clk := newStore(30 * time.Second)
	s.Touch(Entry{SessionRef: "s1", TerminalID: "a", Kind: capability.KindWeb})
	s.Touch(Entry{SessionRef: "s1", TerminalID: "b", Kind: capability.KindCLI})
	s.PublishMetrics()

	if !metricsHasPresence("s1", 2) {
		t.Fatalf("应导出 s1 在线 2 人")
	}

	// 全员离线（时间推进超过 TTL，不调用 Leave）。整体替换必须移除该序列。
	clk.advance(31 * time.Second)
	s.PublishMetrics()
	if metricsHasPresence("s1", 0) || metricsHasAnySession("s1") {
		t.Fatalf("s1 全员离线后，该维度应从指标中消失")
	}
}

func metricsText() string {
	rec := &recorder{}
	observability.Default.Write(rec)
	return rec.String()
}

func metricsHasPresence(session string, n int) bool {
	return strings.Contains(metricsText(), `lumo_terminal_presence_count{session_ref="`+session+`"} `+itoa(n))
}

func metricsHasAnySession(session string) bool {
	return strings.Contains(metricsText(), `lumo_terminal_presence_count{session_ref="`+session+`"`)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for n > 0 {
		pos--
		b[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(b[pos:])
}

// recorder 是满足 http.ResponseWriter 的最小实现，供 observability 写出指标文本。
type recorder struct{ bytes.Buffer }

func (r *recorder) Header() http.Header { return http.Header{} }
func (r *recorder) WriteHeader(int)     {}
