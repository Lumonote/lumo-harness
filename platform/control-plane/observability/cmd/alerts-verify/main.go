// Command alerts-verify 校验告警与记录规则里引用的指标名、标签键真的存在。
//
// 为什么需要它：一条引用了不存在指标（或不存在标签）的规则是**结构性死掉**的——
// 它永远不响，而文件看起来完全正常。本仓库已经出过两条这样的规则，两条都不是
// 笔误，是「看起来对」：
//
//	· lumo_service_up == 0                    该指标是写死的字面量 1，不可能为 0
//	· lumo_http_requests_total{status=~"5.."} 该计数器没有 status 标签，永远选不到序列
//
// 所以判定必须是机械的，而且必须能被证明「真的会红」。后者由
// platform/deploy/alerts-verify.sh 的反例实验负责：它把本程序指向一份被改坏的副本，
// 要求每一类失败都真的报出来。只检查「好的输入能过」的门禁，在它保护的检查被删掉
// 之后仍然是绿的。
//
// 用法：
//
//	go run ./cmd/alerts-verify -root <repo 根> [-alerts <path>] [-recording <path>]
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// metricContract 导出面的契约：每个指标名携带哪些标签键。
//
// 名字一侧是**自动核对**的（扫 Go 源码找写入点），标签一侧是**声明**的。声明会过时，
// 但过时的方向是安全的：漏声明会让一条本来合法的告警在这里失败（有人会来补），
// 多声明才会放过错的选择器——所以这份表要写紧，不要图省事放宽。
var metricContract = map[string][]string{
	// observability 包固定输出的那几条（metrics.go 的 Write）。
	"lumo_http_requests_total":                       nil,
	"lumo_http_errors_total":                         nil,
	"lumo_observability_metric_series_dropped_total": nil,
	"lumo_http_inflight":                             nil,
	"lumo_http_request_duration_seconds":             {"le"},
	// scheduler（internal/server/metrics.go 的常量）。
	"lumo_scheduler_pending_tasks":                nil,
	"lumo_scheduler_tasks":                        {"state", "cluster_id"},
	"lumo_scheduler_oldest_pending_seconds":       {"cluster_id"},
	"lumo_scheduler_nodes":                        {"cluster_id"},
	"lumo_scheduler_orphaned_active_tasks":        nil,
	"lumo_scheduler_leader":                       nil,
	"lumo_scheduler_catalog_ok":                   nil,
	"lumo_scheduler_catalog_snapshot_age_seconds": nil,
	// 联邦注册表（§7.4.1）：年龄、判定结果与「读没读到」。
	"lumo_scheduler_cluster_age_seconds": {"cluster_id"},
	"lumo_scheduler_cluster_state":       {"cluster_id", "state"},
	"lumo_scheduler_cluster_registry_ok": nil,
	// 跨集群任务漂移（§7.4.1：集群 down 后把任务漂回全局队列）。outcome 是
	// migrated / skipped 的闭集，**不按 cluster_id 下钻**（集群号是外部输入，
	// 按它下钻会让基数跟着部署规模长）。
	"lumo_scheduler_task_migrations_total":   {"outcome"},
	"lumo_scheduler_voided_dispatches_total": nil,
	// 版本一致性前置（§7.4.1「同一组件版本先完成全集群分发才允许全局调度」）。
	// 三条都**无标签**：它们说的是整个 fleet 的性质，按 cluster_id 下钻在这里没有
	// 意义（一致性本来就是集合级结论），而下钻只会让基数跟着部署规模长。
	//
	// 两条 gauge 只在闸门打开时导出，所以「序列存在」蕴含「闸门是开的」；
	// consistent 更进一步只在 declared > 0 时导出——declared==0 时它是一个空洞的真，
	// 导出 1 会把「闸门没有信息」画成「版本一致」。
	"lumo_scheduler_cluster_version_declared":        nil,
	"lumo_scheduler_cluster_version_consistent":      nil,
	"lumo_scheduler_placement_version_blocked_total": nil,
	// connector-gateway（internal/server/metrics.go 的常量）。
	"lumo_connector_breaker_open":      {"breaker"},
	"lumo_connector_breaker_half_open": {"breaker"},
	"lumo_connector_breakers_total":    nil,
	// llm-gateway（internal/server/metrics.go 的常量）。
	"lumo_budget_trees":        {"kind"},
	"lumo_budget_trees_denied": {"kind"},
	// session-control（internal/control/metrics.go 的常量）。
	//
	// 六个里只有两个有规则引用（forced_releases / realm_mismatch）。其余四个照样写进来：
	// 这张表是**导出面的契约**，不是「被引用过的名字」，漏声明会让一条本来合法的告警
	// 在这里失败（有人会来补），而多声明一条正确的标签集只是文档。
	//
	// `dispatch_failures_total` 刻意**没有**规则：下发（§8.1 suspend / agent.inject()）
	// 还没接线，这条序列在任何部署里都恒为 0。给它写一条永不响的规则，正是本文件开头
	// 记的 `lumo_service_up == 0` 那种结构性死规则。接线那一步再补规则。
	"lumo_session_control_commands":                {"outcome", "command"},
	"lumo_session_control_queue_inflight":          nil,
	"lumo_session_control_queue_waiting":           nil,
	"lumo_session_control_forced_releases_total":   nil,
	"lumo_session_control_dispatch_failures_total": nil,
	"lumo_session_control_realm_mismatch_total":    nil,
}

// histogramSuffixes 直方图的派生序列后缀：它们与基础名共享同一份契约。
var histogramSuffixes = []string{"_bucket", "_sum", "_count"}

// syntheticLabels 由 Prometheus 或抓取配置附加，不出现在应用代码里。
//
// `le` 不在这里——它是直方图分桶自带的，已经写在上面那条契约里；放进合成标签会让
// 「随便哪个指标都能带 le」通过检查。
var syntheticLabels = map[string]bool{
	"job": true, "instance": true, "service": true,
}

// specClasses §7.4.2 明确点名的六类告警。规范用「等」收尾，所以多出别的类不算错，
// 但这六类少一个就是覆盖缺口。
var specClasses = []string{
	"task_lost", "node_down", "queue_backlog", "budget_overrun", "gateway_5xx", "seam_circuit_open",
}

// allowedRuleKeys Prometheus 规则文件里合法的规则级键。多一个键（例如把 class 写在
// 规则级而不是 labels 里）会让 promtool 直接拒绝整个文件，而"文件能被 yaml 解析"
// 完全看不出来。
var allowedRuleKeys = map[string]bool{
	"alert": true, "record": true, "expr": true, "for": true,
	"keep_firing_for": true, "labels": true, "annotations": true,
}

// tierSeverity 处置分级与 Alertmanager 路由用的 severity 的对应。路由按 severity、
// 排班按 tier，两者不一致时半夜被叫醒的人和处理级别会对不上。
var tierSeverity = map[string]string{"P1": "critical", "P2": "warning", "P3": "info"}

type problem struct {
	where string
	what  string
}

func (p problem) String() string { return p.where + ": " + p.what }

// rule 一条规则（告警或记录）。
type rule struct {
	name     string
	kind     string // alert | record
	line     int
	exprs    []string
	exprLine int
	labels   map[string]string
	keys     []string // 规则级键，用于校验是否合法
}

// expression 一段待检查的表达式及其位置。
type expression struct {
	where string
	line  int
	text  string
}

func main() {
	root := flag.String("root", "", "仓库根目录（默认从当前目录向上找）")
	alerts := flag.String("alerts", "", "告警规则文件（默认 <root>/platform/deploy/prometheus-alerts.yml）")
	recording := flag.String("recording", "", "记录规则文件（默认 Helm 模板里的 observability-config.yaml）")
	flag.Parse()

	if err := run(*root, *alerts, *recording); err != nil {
		fmt.Fprintf(os.Stderr, "\n❌ 告警引用完整性门禁失败\n\n%v", err)
		os.Exit(1)
	}
	fmt.Println("✅ 告警引用完整性门禁通过")
}

func run(root, alertsPath, recordingPath string) error {
	var problems []problem

	resolved, err := resolveRoot(root)
	if err != nil {
		return err
	}
	if alertsPath == "" {
		alertsPath = filepath.Join(resolved, "platform/deploy/prometheus-alerts.yml")
	}
	if recordingPath == "" {
		recordingPath = filepath.Join(resolved, "platform/deploy/helm/lumo-platform/templates/observability-config.yaml")
	}

	emitted, emitProblems := loadEmitted(resolved)
	problems = append(problems, emitProblems...)

	rules, exprs, parseProblems := loadRules("告警", alertsPath)
	problems = append(problems, parseProblems...)

	recRules, recExprs, recProblems := loadRules("记录规则", recordingPath)
	problems = append(problems, recProblems...)

	problems = append(problems, checkRuleShape(append(append([]rule{}, rules...), recRules...))...)
	problems = append(problems, checkSpecClasses(rules)...)

	all := append(append([]expression{}, exprs...), recExprs...)
	defined := map[string]bool{}
	for _, r := range recRules {
		if r.kind == "record" {
			defined[r.name] = true
		}
	}
	problems = append(problems, checkReferences(all, emitted, defined)...)
	problems = append(problems, checkServiceMatchers(all, resolved)...)

	if len(problems) == 0 {
		fmt.Printf("检查了 %d 条规则、%d 段表达式，引用的指标全部有写入点\n", len(rules)+len(recRules), len(all))
		return nil
	}
	var sb strings.Builder
	for _, p := range problems {
		fmt.Fprintf(&sb, "  · %s\n", p)
	}
	return fmt.Errorf("发现 %d 处问题：\n%s", len(problems), sb.String())
}

// resolveRoot 从给定目录或当前目录向上找仓库根（以告警文件的存在为标志）。
func resolveRoot(root string) (string, error) {
	if root != "" {
		return root, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "platform/deploy/prometheus-alerts.yml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("向上找不到仓库根（未找到 platform/deploy/prometheus-alerts.yml）；请用 -root 指定")
		}
		dir = parent
	}
}

// ── 指标写入点 ────────────────────────────────────────────────────────────────

// emitFuncs 会产生序列的写入 API。名字必须与 observability 包导出的函数一致。
var emitFuncs = map[string]bool{
	"SetGauge": true, "SetGaugeWithLabels": true, "ReplaceGauges": true,
}

// typeLine 匹配 metrics.go 里固定打印的 `# TYPE <name>`——那几条不走写入 API。
var typeLine = regexp.MustCompile(`# TYPE ([a-zA-Z_][a-zA-Z0-9_]*)`)

// loadEmitted 扫 Go 源码，找出「真的有人写」的指标名。
//
// 判定是「作为 SetGauge / SetGaugeWithLabels / ReplaceGauges 的第一个实参出现，或是
// metrics.go 里固定打印的 TYPE 行」。刻意不做「文件里出现过这个字符串就算」——
// 那样写在注释、文档字符串或死代码里的名字也能过关，而告警依然不会响。
//
// 走 go/parser 而不是正则：注释不是语法树节点，用正则扫会把注释里举的例子
// （例如本仓库注释里那句 `lumo_service_up == 0`）当成真的写入点。
//
// 实参既不是字面量也不是可解析的常量时**报错而不是放过**：那意味着门禁核对不了这条
// 调用，静默跳过等于给检查开一个后门。
func loadEmitted(root string) (map[string]bool, []problem) {
	var problems []problem
	var files []string

	scanRoot := filepath.Join(root, "platform/control-plane")
	_ = filepath.WalkDir(scanRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", "target", "dist", ".git", "vendor":
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			files = append(files, path)
		}
		return nil
	})
	if len(files) == 0 {
		return nil, []problem{{where: scanRoot, what: "一个 Go 源文件都没扫到——路径或过滤条件写错了，门禁会因此永远通过"}}
	}
	sort.Strings(files)

	fset := token.NewFileSet()
	consts := map[string]string{}
	var parsed []*ast.File

	// 第一遍：解析 + 建立「标识符 → 指标名」常量表（常量可能定义在使用之后）。
	for _, path := range files {
		rel, _ := filepath.Rel(root, path)
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			problems = append(problems, problem{where: rel, what: "解析失败，门禁无法核对: " + err.Error()})
			continue
		}
		parsed = append(parsed, file)
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || (gen.Tok != token.CONST && gen.Tok != token.VAR) {
				continue
			}
			for _, spec := range gen.Specs {
				value, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, ident := range value.Names {
					if i >= len(value.Values) {
						continue
					}
					literal, ok := value.Values[i].(*ast.BasicLit)
					if !ok || literal.Kind != token.STRING {
						continue
					}
					text, err := strconv.Unquote(literal.Value)
					if err == nil && strings.HasPrefix(text, "lumo_") {
						consts[ident.Name] = text
					}
				}
			}
		}
	}

	// 第二遍：写入点。只看带包/接收者限定的调用（`observability.SetGauge(...)`）：
	// 包内那些把参数原样转发的调用（SetGauge 转调 SetGaugeWithLabels）不是写入点，
	// 把它们算进来会把「参数名」误判成指标名。
	emitted := map[string]bool{}
	for _, file := range parsed {
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !emitFuncs[selector.Sel.Name] {
				return true
			}
			name, ok := resolveMetricName(call.Args[0], consts)
			if !ok {
				problems = append(problems, problem{
					where: fset.Position(call.Pos()).String(),
					what:  fmt.Sprintf("%s 的第一个实参不是字符串字面量也不是可解析的常量，门禁无法核对；请用具名常量", selector.Sel.Name),
				})
				return true
			}
			emitted[name] = true
			return true
		})
		if file.Name.Name != "observability" {
			continue
		}
		// metrics.go 的 Write 用 Fprintf 直接打印固定序列，不经写入 API。
		ast.Inspect(file, func(n ast.Node) bool {
			literal, ok := n.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			text, err := strconv.Unquote(literal.Value)
			if err != nil {
				return true
			}
			for _, m := range typeLine.FindAllStringSubmatch(text, -1) {
				emitted[m[1]] = true
			}
			return true
		})
	}
	return emitted, problems
}

func resolveMetricName(expr ast.Expr, consts map[string]string) (string, bool) {
	switch node := expr.(type) {
	case *ast.BasicLit:
		if node.Kind != token.STRING {
			return "", false
		}
		text, err := strconv.Unquote(node.Value)
		if err != nil || !strings.HasPrefix(text, "lumo_") {
			return "", false
		}
		return text, true
	case *ast.Ident:
		name, ok := consts[node.Name]
		return name, ok
	default:
		return "", false
	}
}

// ── 规则文件解析 ──────────────────────────────────────────────────────────────

var (
	ruleStart   = regexp.MustCompile(`^(\s*)- (alert|record):\s*(\S+)\s*$`)
	keyLine     = regexp.MustCompile(`^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$`)
	templateDir = regexp.MustCompile(`^\s*\{\{.*\}\}\s*$`)
	blockScalar = regexp.MustCompile(`^[|>][+-]?\d*\s*$`)
)

// loadRules 解析一个 Prometheus 规则文件。
//
// 只认本仓库实际使用的形态（块状映射、`- alert:` / `- record:` 列表项）。刻意不引入
// YAML 依赖：这个程序要在任何有 Go 的地方跑起来。代价是形态有限，所以解析完会自检
// 「规则数与表达式数是否合理」，避免格式一变就静默扫出零条规则、门禁变空转。
//
// Helm 模板里的纯指令行（整行只有 {{ ... }}）先被剔除，剩下的部分是普通 YAML。
func loadRules(label, path string) ([]rule, []expression, []problem) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, []problem{{where: path, what: "读取失败: " + err.Error()}}
	}
	lines := strings.Split(string(raw), "\n")

	var rules []rule
	var exprs []expression
	var problems []problem
	index := -1
	ruleIndent := -1

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if templateDir.MatchString(line) {
			continue
		}
		if m := ruleStart.FindStringSubmatch(line); m != nil {
			rules = append(rules, rule{name: m[3], kind: m[2], line: i + 1, labels: map[string]string{}})
			index = len(rules) - 1
			ruleIndent = len(m[1]) + 2
			continue
		}
		if index < 0 {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if strings.TrimSpace(line) == "" {
			continue
		}
		// 缩进退回规则级或更浅 = 本条规则结束。
		if indent < ruleIndent {
			index = -1
			ruleIndent = -1
			continue
		}
		m := keyLine.FindStringSubmatch(line)
		if m == nil || indent != ruleIndent {
			continue
		}
		key, value := m[2], strings.TrimSpace(m[3])
		rules[index].keys = append(rules[index].keys, key)
		switch key {
		case "expr":
			where := fmt.Sprintf("%s %s(%s:%d)", label, rules[index].name, filepath.Base(path), i+1)
			text, consumed := scalarValue(lines, i, indent, value)
			exprs = append(exprs, expression{where: where, line: i + 1, text: text})
			i += consumed
		case "labels":
			for j := i + 1; j < len(lines); j++ {
				if templateDir.MatchString(lines[j]) {
					continue
				}
				if strings.TrimSpace(lines[j]) == "" {
					continue
				}
				inner := len(lines[j]) - len(strings.TrimLeft(lines[j], " "))
				if inner <= indent {
					break
				}
				if lm := keyLine.FindStringSubmatch(lines[j]); lm != nil {
					rules[index].labels[lm[2]] = strings.Trim(strings.TrimSpace(lm[3]), `"'`)
				}
			}
		}
	}

	if len(rules) == 0 {
		problems = append(problems, problem{where: path, what: "没解析出任何规则——文件格式变了，门禁会因此永远通过"})
	}
	if len(exprs) == 0 {
		problems = append(problems, problem{where: path, what: "没解析出任何 expr——门禁会因此永远通过"})
	}
	for _, r := range rules {
		if len(r.exprs) == 0 && !hasKey(r.keys, "expr") {
			problems = append(problems, problem{
				where: fmt.Sprintf("%s %s(%s:%d)", label, r.name, filepath.Base(path), r.line),
				what:  "规则没有 expr",
			})
		}
	}
	return rules, exprs, problems
}

// scalarValue 取一个标量的值；`|` / `>` 之类的块标量则把后续更深缩进的行收进来。
// 返回消费掉的行数。
func scalarValue(lines []string, at, indent int, value string) (string, int) {
	if !blockScalar.MatchString(value) {
		return value, 0
	}
	var parts []string
	consumed := 0
	for j := at + 1; j < len(lines); j++ {
		line := lines[j]
		if strings.TrimSpace(line) == "" {
			consumed++
			continue
		}
		if templateDir.MatchString(line) {
			consumed++
			continue
		}
		inner := len(line) - len(strings.TrimLeft(line, " "))
		if inner <= indent {
			break
		}
		parts = append(parts, strings.TrimSpace(line))
		consumed++
	}
	return strings.Join(parts, " "), consumed
}

func hasKey(keys []string, want string) bool {
	for _, key := range keys {
		if key == want {
			return true
		}
	}
	return false
}

// ── 检查 ──────────────────────────────────────────────────────────────────────

func checkRuleShape(rules []rule) []problem {
	var problems []problem
	for _, r := range rules {
		for _, key := range r.keys {
			if !allowedRuleKeys[key] {
				problems = append(problems, problem{
					where: fmt.Sprintf("规则 %s(第 %d 行)", r.name, r.line),
					what: fmt.Sprintf("规则级键 %q 不是 Prometheus 认识的键（合法键：alert/record/expr/for/keep_firing_for/labels/annotations）。"+
						"Prometheus 严格解析规则文件，多一个键会让**整个文件**加载失败，而 yaml 解析成功完全看不出来", key),
				})
			}
		}
		if r.kind != "alert" {
			continue
		}
		for _, want := range []string{"class", "tier", "severity"} {
			if r.labels[want] == "" {
				problems = append(problems, problem{
					where: fmt.Sprintf("告警 %s(第 %d 行)", r.name, r.line),
					what:  fmt.Sprintf("labels 里缺 %q——处置分级必须能从文件里读出来", want),
				})
			}
		}
		if tier, want := r.labels["tier"], tierSeverity[r.labels["tier"]]; want != "" && r.labels["severity"] != want {
			problems = append(problems, problem{
				where: fmt.Sprintf("告警 %s(第 %d 行)", r.name, r.line),
				what:  fmt.Sprintf("tier=%s 应对应 severity=%s，实际 %s（路由按 severity、排班按 tier，不一致时半夜被叫醒的人和处理级别会对不上）", tier, want, r.labels["severity"]),
			})
		}
		if r.labels["tier"] != "" && tierSeverity[r.labels["tier"]] == "" {
			problems = append(problems, problem{
				where: fmt.Sprintf("告警 %s(第 %d 行)", r.name, r.line),
				what:  fmt.Sprintf("tier=%q 不是 P1/P2/P3", r.labels["tier"]),
			})
		}
	}
	return problems
}

func checkSpecClasses(rules []rule) []problem {
	present := map[string]bool{}
	for _, r := range rules {
		if r.kind == "alert" && r.labels["class"] != "" {
			present[r.labels["class"]] = true
		}
	}
	var missing []string
	for _, want := range specClasses {
		if !present[want] {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 {
		return []problem{{
			where: "告警覆盖度",
			what:  fmt.Sprintf("§7.4.2 点名的告警类里缺少 %s", strings.Join(missing, ", ")),
		}}
	}
	return nil
}

var (
	selector     = regexp.MustCompile(`([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{([^}]*)\}`)
	labelMatcher = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)`)
	metricToken  = regexp.MustCompile(`\b(lumo_[a-zA-Z0-9_]+)\b`)
	recordedName = regexp.MustCompile(`\b(lumo:[a-zA-Z0-9_]+)\b`)
	grouping     = regexp.MustCompile(`\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)`)
)

// checkReferences 校验表达式引用的指标名与标签键。
//
// 自检：表达式里 `{` 的个数必须等于解析出的选择器个数。PromQL 除了标签选择器没有
// 别的地方用花括号，所以两者不等就说明选择器正则漏掉了某种形态——那时标签检查会
// 静默少查一条，而门禁照样是绿的。宁可在这里报错。
func checkReferences(exprs []expression, emitted, defined map[string]bool) []problem {
	var problems []problem
	for _, e := range exprs {
		if braces, selectors := strings.Count(e.text, "{"), len(selector.FindAllString(e.text, -1)); braces != selectors {
			problems = append(problems, problem{
				where: e.where,
				what: fmt.Sprintf("自检失败：表达式里有 %d 个 '{' 但只解析出 %d 个选择器，选择器正则漏了形态，标签检查会少查",
					braces, selectors),
			})
		}

		known := map[string]bool{}
		for _, m := range metricToken.FindAllStringSubmatch(e.text, -1) {
			name := m[1]
			base := name
			for _, suffix := range histogramSuffixes {
				if strings.HasSuffix(name, suffix) {
					base = strings.TrimSuffix(name, suffix)
					break
				}
			}
			if !emitted[base] {
				problems = append(problems, problem{
					where: e.where,
					what:  fmt.Sprintf("引用了指标 %s，但全仓 Go 源码里没有任何写入点（基础名 %s）——这条规则永远不会产生序列", name, base),
				})
				continue
			}
			if labels, ok := metricContract[base]; ok {
				for _, label := range labels {
					known[label] = true
				}
			}
		}

		for _, m := range recordedName.FindAllStringSubmatch(e.text, -1) {
			if !defined[m[1]] {
				problems = append(problems, problem{
					where: e.where,
					what:  fmt.Sprintf("引用了记录规则 %s，但记录规则文件里没有定义它", m[1]),
				})
			}
		}

		// 标签选择器：逐个选择器核对，比合并成"全部标签之并"更严。
		for _, m := range selector.FindAllStringSubmatch(e.text, -1) {
			name := m[1]
			base := name
			for _, suffix := range histogramSuffixes {
				if strings.HasSuffix(name, suffix) {
					base = strings.TrimSuffix(name, suffix)
					break
				}
			}
			allowed := map[string]bool{}
			if labels, ok := metricContract[base]; ok {
				for _, label := range labels {
					allowed[label] = true
				}
			}
			for label := range syntheticLabels {
				allowed[label] = true
			}
			for _, lm := range labelMatcher.FindAllStringSubmatch(m[2], -1) {
				if !allowed[lm[1]] {
					problems = append(problems, problem{
						where: e.where,
						what: fmt.Sprintf("指标 %s 没有标签 %q（该指标的标签集：%s）。"+
							"不存在的标签选择器不会报错，它只会永远选不到序列——这正是 lumo_http_requests_total{status=~\"5..\"} 那条死规则的样子",
							name, lm[1], describeLabels(metricContract[base])),
					})
				}
			}
		}

		// 分组/匹配标签：多选择器时按各指标标签之并核对（无法确定归属，宁可宽一点，
		// 但仍能抓住拼错的名字）。合成标签一并允许。
		for _, m := range grouping.FindAllStringSubmatch(e.text, -1) {
			for _, raw := range strings.Split(m[1], ",") {
				label := strings.TrimSpace(raw)
				if label == "" || label == "le" {
					continue
				}
				if known[label] || syntheticLabels[label] {
					continue
				}
				problems = append(problems, problem{
					where: e.where,
					what: fmt.Sprintf("分组/匹配标签 %q 不在本表达式涉及的任何指标的标签集里（拼错的标签不会报错，"+
						"它只会把所有维度聚合掉，看起来像「一切正常」）", label),
				})
			}
		}
	}
	return problems
}

// ── service 维度名单：互斥性与可抓取性 ─────────────────────────────────────────

// serviceMatcherRe 抓 `service=~"..."` / `service!~"..."` 两类选择器。
// 两个操作符都要抓，因为要**分别**核对：它们必须用同一张名单。
var serviceMatcherRe = regexp.MustCompile(`service(=~|!~)"([^"]*)"`)

// scrapedServiceRe 从抓取配置的 `labels: {service: X}` 里取服务名。
var scrapedServiceRe = regexp.MustCompile(`labels:\s*\{\s*service:\s*([A-Za-z0-9_-]+)\s*\}`)

// checkServiceMatchers 校验 service 维度的名单：① 正负两张名单逐字一致
// ② 名单里点到的每个服务都真的被某个抓取配置抓取。
//
// 为什么值得一条门禁：这两件事**只在跨文件对照时才错**，而且错法是静默的。
//
//	· 正负名单漂移：新增一个网关时只改 `=~` 那张，它就同时命中 LumoGateway5xx（P2）
//	  与 LumoService5xxRateHigh（P3/info）——同一次故障报两遍、级别还自相矛盾；
//	  只改 `!~` 那张则两条都不覆盖，那个网关 5xx 完全没人管。
//	· 名单里有没人抓取的服务：规则语法合法、Prometheus 接受、面板上也看不出异常，
//	  只是那条序列永远不存在、规则永远不响——与本文件开头记的 lumo_service_up
//	  那条死规则同源。
//
// 「两张名单逐字一致」这条不变量是有代价的：它不允许「一张名单是另一张的真子集」。
// 若将来确实需要（比如某个网关只想进 P2 那一档），应当把它改成「正负集合互为补集」
// 并补上对应反例，而不是删掉这条检查。
func checkServiceMatchers(exprs []expression, root string) []problem {
	var problems []problem

	positive := map[string][]string{} // 名单 -> 出现位置（用于报错定位）
	negative := map[string][]string{}
	for _, e := range exprs {
		found := serviceMatcherRe.FindAllStringSubmatch(e.text, -1)
		// 自检：正则抓到的条数必须与文本里字面出现的次数一致。写成 `service =~ "…"`
		// 这类带空格的形态时正则抓不到，门禁会因此变成空转——静默失效比不检查更坏。
		want := strings.Count(e.text, `service=~"`) + strings.Count(e.text, `service!~"`)
		if len(found) != want {
			problems = append(problems, problem{where: e.where, what: fmt.Sprintf(
				"自检失败：表达式里有 %d 处 service 名单选择器，却只解析出 %d 处；门禁会因此静默失效",
				want, len(found))})
		}
		for _, m := range found {
			target := positive
			if m[1] == "!~" {
				target = negative
			}
			target[m[2]] = append(target[m[2]], e.where)
		}
	}
	if len(positive) == 0 && len(negative) == 0 {
		problems = append(problems, problem{where: "告警规则", what: "没有任何 service 名单选择器——门禁会因此永远通过"})
		return problems
	}

	for list, wheres := range positive {
		if _, ok := negative[list]; !ok {
			problems = append(problems, problem{where: wheres[0], what: fmt.Sprintf(
				"service=~%q 在 service!~ 侧没有同一张名单：两者必须互为补集，"+
					"否则这张名单里的服务要么被两条 5xx 规则同时命中（重复告警、级别矛盾），要么两边都漏（盲区）", list)})
		}
	}
	for list, wheres := range negative {
		if _, ok := positive[list]; !ok {
			problems = append(problems, problem{where: wheres[0], what: fmt.Sprintf(
				"service!~%q 在 service=~ 侧没有同一张名单：两者必须互为补集", list)})
		}
	}

	scraped := loadScrapedServices(root)
	if len(scraped) == 0 {
		// 计数守卫：一条都没解析出来说明抓取配置的形态变了，下面的核对会全部空转。
		problems = append(problems, problem{where: "抓取配置", what: "没解析出任何抓取目标——service 名单的可抓取性核对会因此永远通过"})
		return problems
	}
	for list, wheres := range positive {
		for _, name := range strings.Split(list, "|") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if !scraped[name] {
				problems = append(problems, problem{where: wheres[0], what: fmt.Sprintf(
					"service 名单里的 %q 不在任何抓取配置里（prometheus.yml / prometheus-standalone.yml）——规则对该服务永远不响", name)})
			}
		}
	}
	return problems
}

// loadScrapedServices 从两份抓取配置里读出被标注的服务名集合。
func loadScrapedServices(root string) map[string]bool {
	out := map[string]bool{}
	for _, name := range []string{"prometheus.yml", "prometheus-standalone.yml"} {
		raw, err := os.ReadFile(filepath.Join(root, "platform/deploy", name))
		if err != nil {
			continue
		}
		for _, m := range scrapedServiceRe.FindAllStringSubmatch(string(raw), -1) {
			out[m[1]] = true
		}
	}
	return out
}

func describeLabels(labels []string) string {
	if len(labels) == 0 {
		return "无（只有 job/instance/service 这类抓取期标签）"
	}
	return strings.Join(labels, ", ")
}
