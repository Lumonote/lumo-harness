// Package release 是 §24.5「动作放行三档」落到控制面的**闭集词表与写入判据**，
// 也就是 §11 ③ 的 `action_reviews` 表的语义层。
//
// # 命名：release 指「动作放行」，与代码评审无关
//
// 与 TS 侧 `shared/seam-contracts/coordinator.ts` 的 `ReleaseBand` / `ReleaseDecision`
// 用同一套词。三档闭集与那两个闭集值在两种语言里是**同一个概念**，名字一致才能让人
// 一眼看出这对列是它的落库形态（本仓库已经为「同一个概念两种叫法」付过学费：
// 15 篇 addendum 的术语冲突）。
//
// # 这张表补的是审计缺失的那一半
//
// §24.5 的结论是「`approve` 可以由分类器行使，且行使记录必须可审计」。在那之前，
// **「分类器替人放了什么」在库里看不见**：被拒的路径有记录（`session_control_audit`
// 记下每条控制指令的结论，含被拒的那些），而**放行**的路径一条都没有。只记拒绝的
// 审计等于只回答「谁被拦住了」，答不出「谁被放过去了」——而事故复盘问的恰恰是后者。
// 本表就是缺的那一半。
//
// 两件事不要混淆：
//
//   - `session_control_audit` 记的是**会话级控制指令**（pause / approve / stop …），
//     粒度是「一条指令」，粒度粗但覆盖全部指令；
//   - 本表记的是**逐个动作的放行判定**（某次工具调用被判成 AUTO / REVIEW / DENY），
//     粒度细，且每次工具调用都会产生一行——所以它的读面**必须**带上限（见 internal/server）。
//
// 把两者合并（比如「approve 指令行上附带当时的档位」）会让高频的放行判定挤进低频的
// 指令时间线，而两者在控制台上是分开呈现的两件事。
//
// # 为什么闭集校验在 Go 侧（而不是只靠 TS）
//
// 列注释里的闭集（`AUTO | REVIEW | DENY`、`classifier | human | fallback`）在 PG 里
// **没有 CHECK 约束**——§11 的 DDL 已定稿，不去改它。于是唯一的执行点就是写入方，
// 而写入方有两个（Go 控制面 + 未来的 dsh 节点），两边各自解释等于没有闭集：
// 一个拼错的档位落库后，按档位聚合的查询会把它算成一个**新的**档，而没人会注意到。
// 未知值一律拒绝（fail-closed），不静默存下来——与§22.3 的「显式拒绝而非隐式迁移」
// 同一条纪律。
package release

import (
	"errors"
	"fmt"
	"strings"
)

// ErrInvalid 是「这个值不属于闭集/这个字段不合法」。调用方按请求错误处理（HTTP 400），
// 而不是按基础设施故障——它的处置是改请求，不是重试。
var ErrInvalid = errors.New("动作放行记录不合法")

// Band 是动作放行的三档（§24.5）。
//
// 三档而不是布尔：「进人审队列」与「拒绝」对操作者是完全不同的两件事——前者要人做决定，
// 后者不需要任何人再做任何事。合成一个 false 之后，控制台只能显示「不放行」，而运维
// 读不出「还需要我点什么吗」。
type Band string

const (
	// BandAuto 直接放行，事后审计（只读 + 已授权 seam + 无外部副作用）。
	BandAuto Band = "AUTO"
	// BandReview 进 `awaiting-approval`，等人（或人审队列的批量验收，§24.6）。
	BandReview Band = "REVIEW"
	// BandDeny 直接拒绝（不可逆 / 跨 realm / 触达凭证，§24.5 的判据）。
	BandDeny Band = "DENY"
)

// Decider 是「这个判定是谁做的」。三个值一个都不能少，理由见各自的注释。
type Decider string

const (
	// DeciderClassifier 分类器代行——§24.5 新增的能力，也是本表存在的理由。
	DeciderClassifier Decider = "classifier"
	// DeciderHuman 人做的判定（人审通过、人审拒绝、或人工确认）。
	DeciderHuman Decider = "human"
	// DeciderFallback 兜底回落之后的判定（§24.5 第 3 条：连续 3 次 / 单 Run 累计 20 次
	// 被拒即整体回落全人工档）。
	//
	// **它不是 classifier 的同义词**：回落之后判定者已经不再是分类器了。把回落期的
	// 记录记成 classifier，会让「分类器撞墙多少次」这个运营问题失去证据——而兜底阈值
	// 该怎么校准，唯一的依据就是这些记录。
	DeciderFallback Decider = "fallback"
)

// Band 与 Decider 的闭集成员，供穷举（测试与将来的读面筛选用）。
var (
	Bands    = []Band{BandAuto, BandReview, BandDeny}
	Deciders = []Decider{DeciderClassifier, DeciderHuman, DeciderFallback}
)

// ParseBand 把外部输入（HTTP 请求体里的字符串）解析成一个闭集档位。
//
// **不接受大小写变体**：`auto` 与 `AUTO` 若都能存下来，按档位聚合的查询就得先做一次
// 归一化，而任何一条忘了归一化的查询会把同一档拆成两个数字。闭集的意义正是「只有一种
// 合法拼写」。回归在这里比落库后好：落库是 append-only 的，写错的一行**擦不掉**。
func ParseBand(raw string) (Band, error) {
	for _, b := range Bands {
		if string(b) == raw {
			return b, nil
		}
	}
	return "", fmt.Errorf("%w: 未知放行档 %q（闭集：%s）", ErrInvalid, raw, joinBands())
}

// ParseDecider 同 ParseBand，作用于判定者闭集。
func ParseDecider(raw string) (Decider, error) {
	for _, d := range Deciders {
		if string(d) == raw {
			return d, nil
		}
	}
	return "", fmt.Errorf("%w: 未知判定者 %q（闭集：%s）", ErrInvalid, raw, joinDeciders())
}

// Record 是一条待写入的放行记录，字段与 §11 ③ 的表列一一对应（`created_at` 由库生成，
// `id` 由调用方给出，理由见下）。
//
// # `id` 为什么由调用方给，而不是本服务生成
//
// §11 把主键定成了 `id TEXT PRIMARY KEY`（不是 `BIGSERIAL`）。这不是随手写的：放行判定
// 发生在会话执行面（dsh 节点上），那里**本来就有**这条判定的身份——一次具体的工具调用。
// 让调用方带上它，重试就天然幂等：网络抖动后重发同一条，库里仍只有一行。若换成这里
// 生成随机 id，同样的重试会变成**两行**，而两行都显示「分类器放行了它」——审计表里多
// 出来的这一行没有任何办法被识别为重复。
type Record struct {
	ID string
	// Realm 是租户边界。写入必填、读面必带：它是本表唯一的隔离手段（见 internal/store
	// 的 RealmRequired 段）。
	Realm      string
	SessionRef string
	// RunID 空表示「不属于任何 Run」（落库为 NULL）。§22.3 规则 2：NULL 是语义而不是缺失，
	// 因此空串在这里被归一成 NULL，而不是存一个与 NULL 读起来一样的空串——两者若并存，
	// 每条按 run_id 的查询都得同时处理两种「没有 Run」。
	RunID  string
	Action string
	Band   Band
	// Decider 与 Band 分开而不是合成一个枚举：同一个档位可以由不同的人做出来。
	// 「REVIEW 且 decider=classifier」意味着分类器把它推给人（它只收窄），而
	// 「REVIEW 且 decider=human」意味着人不同意分类器的 AUTO——两者的处置完全不同。
	Decider Decider
	// Reason 是判据（TS 侧 `ReleaseReason` 闭集的值，或人写的说明）。**必填**：一条
	// 没有理由的放行记录回答不了「当时为什么判它是 AUTO」，而这正是§24.5 要的「可审计」。
	// 值的集合由 TS 契约 `shared/seam-contracts/coordinator.ts` 拥有，Go 侧不复制一份
	// ——跨语言复制闭集会漂移（`cost_type` 的教训），而这里丢掉的是一个可以通过读那一份
	// 契约得到的约束。空的理由不属于「值不在闭集里」，它是本条记录自身不完整，所以拦。
	Reason string
	// DeniedStreak / DeniedTotal 是兜底判据的两个计数（§24.5 第 3 条），随判定的那一刻
	// 落库：它们是**当时的现场**（为什么选择了回落/继续），事后无法重建，因为后来的
	// 成功会把连续计数清零。
	DeniedStreak int
	DeniedTotal  int
}

// Validate 在写入前把关。未知/非法一律拒绝，绝不静默存下来。
//
// 它被两处调用：HTTP 层（把非法请求变成 400）与存储层（防止绕过 HTTP 的调用方写脏数据）。
// 重复调用是刻意的：判据只有一份，但**执行点必须在每一个能写库的入口上**。
func (r Record) Validate() error {
	switch {
	case strings.TrimSpace(r.ID) == "":
		// 没有 id 就没有幂等键：同一条判定的重试会变成两行重复的审计。
		return fmt.Errorf("%w: id 必填（它是重试幂等的依据）", ErrInvalid)
	case strings.TrimSpace(r.Realm) == "":
		return fmt.Errorf("%w: realm 必填（审计与隔离都依赖它）", ErrInvalid)
	case strings.TrimSpace(r.SessionRef) == "":
		return fmt.Errorf("%w: sessionRef 必填", ErrInvalid)
	case strings.TrimSpace(r.Action) == "":
		// 记录的是「哪个动作被放行」，没有动作名这行记录什么都不指。
		return fmt.Errorf("%w: action 必填", ErrInvalid)
	case r.Band == "":
		return fmt.Errorf("%w: band 必填（闭集：%s）", ErrInvalid, joinBands())
	case r.Decider == "":
		return fmt.Errorf("%w: decider 必填（闭集：%s）", ErrInvalid, joinDeciders())
	case strings.TrimSpace(r.Reason) == "":
		return fmt.Errorf("%w: reason 必填（没有判据的放行记录等于没有审计）", ErrInvalid)
	}
	if _, err := ParseBand(string(r.Band)); err != nil {
		return err
	}
	if _, err := ParseDecider(string(r.Decider)); err != nil {
		return err
	}
	// 计数必须非负。负数不是边界情况，是调用方把字段传错了，而放行它会让兜底**静默失效**：
	// 回落判据是 `>= 阈值`，一个负的计数永远达不到阈值，于是「分类器连续被拒」这件事
	// 再也不会触发回落——症状是「任务还在跑」而不是「任务失败了」，监控上看不出异常。
	// 与 TS 侧 `coordinator.ts` 的 `counter()` 是同一条判据（那里直接 throw）。
	if r.DeniedStreak < 0 || r.DeniedTotal < 0 {
		return fmt.Errorf("%w: deniedStreak / deniedTotal 不能为负（收到 %d / %d）",
			ErrInvalid, r.DeniedStreak, r.DeniedTotal)
	}
	// **刻意不校验** deniedStreak <= deniedTotal，虽然它看起来很合理：两个计数的窗口
	// 不同（连续是跨动作/跨 Run 的当下连续段，累计是单 Run 的），嵌套关系并不成立。
	// 把一个看起来很对、其实不成立的不变量写成校验，会让真实数据被拒——这是坏校验里
	// 最难被发现的一种（症状是「偶发 400」，而不是「一条明显的错数据」）。
	return nil
}

func joinBands() string {
	parts := make([]string, 0, len(Bands))
	for _, b := range Bands {
		parts = append(parts, string(b))
	}
	return strings.Join(parts, " | ")
}

func joinDeciders() string {
	parts := make([]string, 0, len(Deciders))
	for _, d := range Deciders {
		parts = append(parts, string(d))
	}
	return strings.Join(parts, " | ")
}
