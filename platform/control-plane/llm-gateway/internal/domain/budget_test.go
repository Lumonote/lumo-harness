package domain

import "testing"

// 判据 6（语义镜像）：与 TS budget-policy.spec 同矩阵。改一侧不改另一侧 → 两侧红。
func TestBudgetState(t *testing.T) {
	cases := []struct {
		used int64
		lim  BudgetLimits
		want string
	}{
		// within：used < softLimit
		{used: 99, lim: BudgetLimits{Budget: 1000, SoftLimit: 100}, want: StateWithin},
		// soft：softLimit ≤ used < budget（左闭：恰好到软限额即 soft）
		{used: 100, lim: BudgetLimits{Budget: 1000, SoftLimit: 100}, want: StateSoft},
		{used: 999, lim: BudgetLimits{Budget: 1000, SoftLimit: 100}, want: StateSoft},
		// overdraft：budget ≤ used < budget+overdraft（左闭：恰好用完预算即 overdraft）
		{used: 1000, lim: BudgetLimits{Budget: 1000, SoftLimit: 100, Overdraft: 500}, want: StateOverdraft},
		{used: 1499, lim: BudgetLimits{Budget: 1000, SoftLimit: 100, Overdraft: 500}, want: StateOverdraft},
		// hard：used ≥ budget+overdraft
		{used: 1500, lim: BudgetLimits{Budget: 1000, SoftLimit: 100, Overdraft: 500}, want: StateHard},
		{used: 2000, lim: BudgetLimits{Budget: 1000, SoftLimit: 100, Overdraft: 500}, want: StateHard},
		// 无软限额档：softLimit=0 直接二分
		{used: 999, lim: BudgetLimits{Budget: 1000, Overdraft: 0}, want: StateSoft},
		{used: 1000, lim: BudgetLimits{Budget: 1000, Overdraft: 0}, want: StateHard},
	}
	for _, c := range cases {
		if got := BudgetState(c.used, c.lim); got != c.want {
			t.Fatalf("BudgetState(%d, %+v) = %s, want %s", c.used, c.lim, got, c.want)
		}
	}
}

func TestWorseOf(t *testing.T) {
	states := []string{StateWithin, StateSoft, StateOverdraft, StateHard}
	for _, a := range states {
		for _, b := range states {
			want := a
			if severity[b] > severity[a] {
				want = b
			}
			if got := WorseOf(a, b); got != want {
				t.Fatalf("WorseOf(%s,%s)=%s want %s", a, b, got, want)
			}
			// 交换律
			if WorseOf(a, b) != WorseOf(b, a) {
				t.Fatalf("WorseOf 不满足交换律: %s/%s", a, b)
			}
		}
	}
}

func TestStateOfTree(t *testing.T) {
	v := func(n int64) *int64 { return &n }
	// 行不存在 → hard
	if got := StateOfTree(nil, 1); got != StateHard {
		t.Fatalf("缺行应 hard, got %s", got)
	}
	// 旧模式：剩余 < need 即 hard；否则 within
	if got := StateOfTree(&TreeRow{Budget: v(5)}, 10); got != StateHard {
		t.Fatalf("旧模式不足应 hard, got %s", got)
	}
	if got := StateOfTree(&TreeRow{Budget: v(50)}, 10); got != StateWithin {
		t.Fatalf("旧模式足够应 within, got %s", got)
	}
	// 总额模式：used = total - remaining + need
	// total=1000 remaining=600 soft=500 od=200：used=400+need
	row := &TreeRow{Budget: v(600), BudgetTotal: v(1000), SoftLimit: v(500), Overdraft: v(200)}
	if got := StateOfTree(row, 50); got != StateWithin { // used=450 < 500
		t.Fatalf("used=450 应 within, got %s", got)
	}
	if got := StateOfTree(row, 150); got != StateSoft { // used=550
		t.Fatalf("used=550 应 soft, got %s", got)
	}
	if got := StateOfTree(row, 500); got != StateSoft { // used=900 < 1000
		t.Fatalf("used=900 应 soft, got %s", got)
	}
	// 精确过界：need=600 → used=1000 → overdraft（左闭）
	if got := StateOfTree(row, 600); got != StateOverdraft {
		t.Fatalf("used=1000 应 overdraft, got %s", got)
	}
	// need=800 → used=1200 ≥ 1000+200 → hard
	if got := StateOfTree(row, 800); got != StateHard {
		t.Fatalf("used=1200 应 hard, got %s", got)
	}
}
