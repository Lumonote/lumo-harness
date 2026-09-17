package crdt

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

func TestUpdateSetMergerConvergesAndDeduplicates(t *testing.T) {
	first := []domain.Update{{DocID: "d", Seq: 2, Actor: "b", Payload: []byte("two")}, {DocID: "d", Seq: 1, Actor: "a", Payload: []byte("one")}}
	second := []domain.Update{{DocID: "d", Seq: 1, Actor: "a", Payload: []byte("one")}, {DocID: "d", Seq: 2, Actor: "b", Payload: []byte("two")}, {DocID: "d", Seq: 2, Actor: "b", Payload: []byte("two")}}
	m := UpdateSetMerger{}
	a, err := m.Merge(nil, first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Merge(nil, second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("merge did not converge:\n%s\n%s", a, b)
	}
	var state updateSetState
	if err := json.Unmarshal(a, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Updates) != 2 || state.Updates[0].Seq != 1 || state.Updates[1].Seq != 2 {
		t.Fatalf("state = %+v", state)
	}
}

func TestUpdateSetMergerRejectsUnknownState(t *testing.T) {
	if _, err := (UpdateSetMerger{}).Merge([]byte(`{"version":99}`), nil); err == nil {
		t.Fatal("expected version error")
	}
}

// TestAppendOnlyMergerIsNotConvergent 把「AppendOnlyMerger 违反 Merger 的收敛性契约」
// 从一句注释变成一条会失败的断言。
//
// 为什么值得写：接口注释要求「相同增量集合无论顺序都产出等价状态」，而本类型按到达顺序
// 原样拼接 —— 换个顺序就是不同字节。这不是「旧」的问题，而是**语义上不成立**，所以它
// 不能当 fallback，也不能因为「反正只是个占位」而被重新装配进去。界面的三条边界
// （为什么保留 / 谁能用 / 什么时候删除）写在 merger.go 的类型注释里。
//
// 同一条用例里放一个**对照组**：同样的输入喂给 UpdateSetMerger 必须顺序无关。
// 没有对照组，「两者字节不同」既可能是内核差异，也可能是我把输入构造错了——
// 而这两种原因需要完全相反的处置。
func TestAppendOnlyMergerIsNotConvergent(t *testing.T) {
	forward := []domain.Update{
		{DocID: "d", Seq: 1, Actor: "a", Payload: []byte("first")},
		{DocID: "d", Seq: 2, Actor: "b", Payload: []byte("second")},
	}
	backward := []domain.Update{forward[1], forward[0]}

	ab, err := (AppendOnlyMerger{}).Merge(nil, forward)
	if err != nil {
		t.Fatal(err)
	}
	ba, err := (AppendOnlyMerger{}).Merge(nil, backward)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ab, ba) {
		t.Fatal("AppendOnlyMerger 竟然收敛了 —— 那它就不再是否定例，本用例与它的边界说明要一起重写")
	}

	setAB, err := (UpdateSetMerger{}).Merge(nil, forward)
	if err != nil {
		t.Fatal(err)
	}
	setBA, err := (UpdateSetMerger{}).Merge(nil, backward)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(setAB, setBA) {
		t.Fatalf("对照失效：UpdateSetMerger 对同一集合也应顺序无关\n%s\n%s", setAB, setBA)
	}
}

// TestAppendOnlyMergerNameStaysLabelledNonProduction 钉住那个**唯一的运行时信号**：
// 生产装配把 merger.Name() 打进启动日志（`cmd/collaborator/main.go:130`）。名称一旦被
// 改成看起来正常的样子，一次错误的装配就只剩「日志里写着某个内核名」这一条线索，而
// 它读起来完全合理。
func TestAppendOnlyMergerNameStaysLabelledNonProduction(t *testing.T) {
	name := (AppendOnlyMerger{}).Name()
	for _, want := range []string{"append-only", "非生产"} {
		if !strings.Contains(name, want) {
			t.Fatalf("Name() = %q，必须同时含 %q —— 它是误装配时唯一能看出来的信号", name, want)
		}
	}
}
