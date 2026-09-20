// §14 判据 12「契约双实现」的实质：与 TS 权威实现**同矩阵逐行对照**。
//
// 矩阵文件 `shared/seam-contracts/__tests__/fixtures/release-matrix.json` 由 TS 侧生成
// （`release-matrix.spec.ts`）：它带着**输入**与 TS 算出的**期望结论**。本文件读同一份
// 文件，用 Go 的实现重算一遍，逐行断言同值。于是「加一条规则只改一侧」不可能通过：
//
//   - 只改 TS → TS 侧那份 spec 红（矩阵没重新生成）；重新生成而不改 Go → 本文件红；
//   - 只改 Go → 本文件红（与矩阵不一致）。
//
// 为什么是「TS 生成、Go 消费」而不是「两侧各自生成」：期望值只能有一个来源，那个来源
// 必须是权威实现（TS，§12）。让 Go 自己生成一份期望值，对照就退化成「Go 与自己一致」；
// 让两侧各自生成输入矩阵，则多出一条「两份生成器有没有漂移」的、无人看守的耦合——
// 而 Go 读 TS 生成的输入，两侧在输入上根本不存在漂移的空间。
package release

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"
)

// matrixPath 是矩阵文件相对本包的位置（`internal/release` → `platform/`）。
//
// 这个相对路径是**唯一**的耦合点，且它有意跨出了 Go 模块的边界：矩阵住在 TS 契约的
// 测试目录里，因为生成它的代码（权威实现）在那里。把它拷贝一份到 Go 侧会立刻失去
// 「同一份输入」这条性质。
const matrixPath = "../../../../shared/seam-contracts/__tests__/fixtures/release-matrix.json"

type classifyMatrixRow struct {
	Facts  ActionFacts `json:"facts"`
	Band   string      `json:"band"`
	Reason string      `json:"reason"`
}

type fallbackMatrixRow struct {
	DeniedStreak int     `json:"deniedStreak"`
	DeniedTotal  int     `json:"deniedTotal"`
	Verdict      *string `json:"verdict"`
	Error        bool    `json:"error"`
}

type releaseMatrix struct {
	Source   string              `json:"source"`
	Classify []classifyMatrixRow `json:"classify"`
	Fallback []fallbackMatrixRow `json:"fallback"`
}

// loadMatrix 读矩阵。**缺失即失败，不跳过**：这份文件是跨语言对照的唯一真值源，
// 跳过它等于把「两侧一致」降级成「Go 侧自说自话」，而退出码上两者完全一样。
// 这与本仓库对「没 DSN 就跳过」的既有处置同训（跳过不等于通过）。
func loadMatrix(t *testing.T) releaseMatrix {
	t.Helper()
	raw, err := os.ReadFile(matrixPath)
	if err != nil {
		t.Fatalf("读不到跨语言矩阵 %s：%v\n"+
			"它是 TS 侧生成的（UPDATE_RELEASE_MATRIX=1 npx vitest run shared/seam-contracts/__tests__/release-matrix.spec.ts），"+
			"不该手工创建，也不该被 .gitignore 掉", matrixPath, err)
	}
	var matrix releaseMatrix
	if err := json.Unmarshal(raw, &matrix); err != nil {
		t.Fatalf("矩阵 %s 解析失败：%v（字段名对不上时不能当成空矩阵——空矩阵会让对照静默通过）",
			matrixPath, err)
	}
	if matrix.Source == "" {
		t.Fatalf("矩阵 %s 少了 source 字段：这一行是「我读对了文件」的唯一凭据", matrixPath)
	}
	return matrix
}

// factsKey 把一行输入编码成集合键。七个字段全在里面：少一个字段就会让两条不同的输入
// 折叠成同一个键，于是「矩阵覆盖整个输入域」的断言会因为折叠而误判为通过。
func factsKey(f ActionFacts) string {
	return fmt.Sprintf("%t|%t|%t|%t|%t|%t|%s",
		f.SideEffect, f.Reversible, f.CrossRealm, f.TouchesCredentials,
		f.OpaAllowed, f.ClassifierAvailable, f.ClassifierVerdict)
}

// TestCrossLanguageMatrixClassify 逐行对照 `ClassifyAction`，并断言矩阵**覆盖整个输入域**。
//
// 覆盖性检查和逐行对照一样重要：只有逐行对照时，一份被悄悄缩水的矩阵（比如只剩 8 行）
// 会让对照全绿，而它证明的东西已经少了一个数量级。因此矩阵里多了本实现不认识的输入
// （两侧的维度定义分叉）与少了应有的输入（矩阵缩水）都会报错。
func TestCrossLanguageMatrixClassify(t *testing.T) {
	matrix := loadMatrix(t)
	if len(matrix.Classify) == 0 {
		t.Fatalf("矩阵里一行 classify 都没有——这是生成器坏了，不是「没有要对照的输入」")
	}

	// 本实现的输入域：6 个布尔 × 3 种「分类器说了什么」。数量由这里**推导**而不是抄
	// 一个常数，改了维度两侧就会同时红（TS 侧那条 `2 ** 6 * 3` 同理）。
	missing := map[string]bool{}
	for mask := 0; mask < 1<<6; mask++ {
		for _, verdict := range []ClassifierVerdict{ClassifierAllow, ClassifierReview, ""} {
			missing[factsKey(ActionFacts{
				SideEffect:          mask&1 != 0,
				Reversible:          mask&2 != 0,
				CrossRealm:          mask&4 != 0,
				TouchesCredentials:  mask&8 != 0,
				OpaAllowed:          mask&16 != 0,
				ClassifierAvailable: mask&32 != 0,
				ClassifierVerdict:   verdict,
			})] = true
		}
	}

	for i, row := range matrix.Classify {
		key := factsKey(row.Facts)
		if !missing[key] {
			t.Errorf("矩阵第 %d 行的输入(%s)不在本实现的输入域里：说明矩阵多了一个维度，"+
				"而本实现没有——两侧对「输入是什么」的理解已经分叉", i, key)
			continue
		}
		delete(missing, key)

		got := ClassifyAction(row.Facts)
		if string(got.Band) != row.Band || string(got.Reason) != row.Reason {
			t.Errorf("矩阵第 %d 行两侧不同值：\n  facts = %+v\n  TS  = %s / %s\n  Go  = %s / %s",
				i, row.Facts, row.Band, row.Reason, got.Band, got.Reason)
		}
	}

	if len(missing) > 0 {
		keys := make([]string, 0, len(missing))
		for k := range missing {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		show := keys
		if len(show) > 5 {
			show = show[:5]
		}
		t.Errorf("矩阵缺 %d 行输入（例如 %v）：矩阵被缩水了，对照证明的东西随之变少", len(missing), show)
	}
}

// TestCrossLanguageMatrixFallback 对照兜底回落。
//
// 这里没有「整个输入域」可穷举（任意非负整数对），所以矩阵取的是阈值两侧的格子；
// 因此本用例额外**钉住几格必须在场**——矩阵缩水时（例如阈值格被删掉）这里先红。
func TestCrossLanguageMatrixFallback(t *testing.T) {
	matrix := loadMatrix(t)
	if len(matrix.Fallback) == 0 {
		t.Fatalf("矩阵里一行 fallback 都没有——生成器坏了")
	}

	present := map[[2]int]bool{}
	for i, row := range matrix.Fallback {
		present[[2]int{row.DeniedStreak, row.DeniedTotal}] = true

		got, err := FallbackVerdict(row.DeniedStreak, row.DeniedTotal)
		if row.Error {
			// 负数：两侧都必须**拒绝**这条输入。TS 抛 invalid、Go 返回 ErrInvalid。
			if err == nil {
				t.Errorf("矩阵第 %d 行（%d/%d）：TS 拒绝这条输入，Go 却判成 %q —— "+
					"静默放行负计数会让兜底失效（负值永远达不到阈值）",
					i, row.DeniedStreak, row.DeniedTotal, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("矩阵第 %d 行（%d/%d）：TS 给出了判定，Go 却报错 %v",
				i, row.DeniedStreak, row.DeniedTotal, err)
			continue
		}
		if row.Verdict == nil {
			t.Errorf("矩阵第 %d 行（%d/%d）没有 verdict——生成器漏写了", i, row.DeniedStreak, row.DeniedTotal)
			continue
		}
		if string(got) != *row.Verdict {
			t.Errorf("矩阵第 %d 行两侧不同值：%d/%d → TS %s，Go %s",
				i, row.DeniedStreak, row.DeniedTotal, *row.Verdict, got)
		}
	}

	// 必须在场的那几格：两个阈值的两侧 + 一条负数。少了任何一格，「阈值改成 4」
	// 或「负数不再拒绝」这类改动就可能整个从矩阵里滑出去。
	for _, pair := range [][2]int{
		{DeniedStreakLimit - 1, 0}, {DeniedStreakLimit, 0},
		{0, DeniedTotalLimit - 1}, {0, DeniedTotalLimit},
		{-1, 0}, {0, -1},
	} {
		if !present[pair] {
			t.Errorf("矩阵缺少 %v 这一格：它是阈值（或负数拒绝）的边界值，"+
				"删掉它等于把这处判据移出对照范围", pair)
		}
	}
}
