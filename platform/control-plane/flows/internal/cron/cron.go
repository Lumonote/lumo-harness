// Package cron 提供集群定时自动化所需的 5 字段 cron 解析与「下次触发时刻」计算。
//
// 为什么不引第三方库：flows 模块当前除 pgx 外没有第三方依赖，而调度语义里最
// 容易出错的两块——夏令时边界、day-of-month 与 day-of-week 的「或」语义——必须
// 自己说清楚、自己测到，不适合藏进一个语义不可见的黑盒里。
//
// # 时区
//
// 表达式可以自带 TZ= / CRON_TZ= 前缀（如 "CRON_TZ=Asia/Shanghai 0 9 * * *"）；
// 没有前缀时用调用方传入的默认时区，默认时区为 nil 时按 UTC 处理。
//
// 本包 import 了 time/tzdata：运行镜像（alpine:3.20）默认**不带**
// /usr/share/zoneinfo，不内嵌 tzdata 的话 LoadLocation 会直接失败。内嵌的代价是
// 二进制大约 +450KB，换来的是「任何环境下的时区解析结果一致」。
//
// # 夏令时策略（按实测行为固定，不是猜的）
//
//   - 春季前跳时「不存在」的本地钟点直接跳过。time.Date 会把它归一成别的时刻
//     （实测 America/New_York 2026-03-08 02:30 读回 01:30），本包用读回值校验，
//     对不上就丢弃。因此 0 2 * * * 在前跳那天不触发，下一次是次日 02:00。
//
//     注意这意味着「前跳当天的那一次」在**调度时间线上根本不存在**：Next 从不产出
//     它，生产者的游标也永远不会停在它上面，所以没有任何机制会把它补跑回来。
//     Vixie cron 会把落在被跳过区间的任务在跳变后立刻跑一次，本包刻意不这么做——
//     那需要把「跳变历史」喂进调度计算，对一个纯函数式的 Next 来说代价远大于收益，
//     而少跑一次是可解释的、可预测的。停机造成的漏跑另有追赶逻辑（见 Due）。
//
//   - 秋季回拨时「重复」的本地钟点只在第一次出现时触发一次，不会重复触发
//     （实测 time.Date 对歧义时刻固定取第一次出现，即 2026-11-01 01:30 取 EDT）。
//
//   - 日期推进一律走 UTC 日历运算。有真实存在的时区在**午夜**做 DST 跳变，实测
//     America/Santiago 2026-09-06 00:00 会被归一成 2026-09-05 23:00、America/Havana
//     2026-03-08 00:00 归一成 2026-03-07 23:00 —— 用本地 00:00 当日期锚点会让日期
//     倒退一天，所以本包既不用本地 00:00 推日期，也不用它取星期。
package cron

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // 见包注释「时区」一节
)

// maxScanDays 是 Next 的搜索上界。
//
// 取 8 年而不是 4 年：闰年间隔通常 4 年，但跨「百年非闰」会拉到 8 年
// （1896-02-29 -> 1904-02-29；同理 2096 -> 2104）。所以 0 0 29 2 * 在 2097 年
// 求值需要向后看 7 年，4 年上界会误报「找不到触发时刻」。
const maxScanDays = 8 * 366

// maxCatchUpSteps 限制 Due 追赶时连续调用 Next 的次数，避免长时间停机后
// 逐分钟推进的循环过长（* * * * * 停一年就是 52 万次）。
const maxCatchUpSteps = 10000

var (
	// ErrNoFireTime 表示在搜索上界内找不到任何满足条件的时刻
	// （例如 0 0 30 2 *：2 月没有 30 日）。
	ErrNoFireTime = errors.New("cron: 在搜索上界内找不到触发时刻")
	// ErrNoReference 表示传入的参考时刻是零值。
	ErrNoReference = errors.New("cron: 参考时刻为零值")
)

// Schedule 是一个已解析的 cron 表达式。零值不可用，请用 Parse 构造。
type Schedule struct {
	expr string
	loc  *time.Location

	minute uint64 // bit 0..59
	hour   uint64 // bit 0..23
	dom    uint64 // bit 1..31
	month  uint64 // bit 1..12
	dow    uint64 // bit 0..6

	// 字段是否字面为 "*"。只影响 dom/dow 的或语义，*/2 这类受限集合不算 any。
	domAny bool
	dowAny bool
}

// macros 是 @ 开头的简写。键统一小写。
var macros = map[string]string{
	"@yearly":   "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly":  "0 0 1 * *",
	"@weekly":   "0 0 * * 0",
	"@daily":    "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly":   "0 * * * *",
}

// Parse 解析 5 字段 cron 表达式（分 时 日 月 周）。
//
// defaultLoc 为 nil 时按 UTC 处理；表达式自带 TZ= / CRON_TZ= 前缀时以前缀为准。
// 返回值里的 Schedule 是值类型，可安全并发读取。
func Parse(expr string, defaultLoc *time.Location) (Schedule, error) {
	original := strings.TrimSpace(expr)
	if original == "" {
		return Schedule{}, errors.New("cron: 表达式为空")
	}

	loc := defaultLoc
	if loc == nil {
		loc = time.UTC
	}

	rest := original
	// 前缀名大小写不敏感，但时区名本身大小写敏感，所以只对前缀做 ToUpper 比较、
	// 取值时仍从原始串切。
	upper := strings.ToUpper(rest)
	for _, prefix := range []string{"CRON_TZ=", "TZ="} {
		if !strings.HasPrefix(upper, prefix) {
			continue
		}
		raw, tail, _ := strings.Cut(rest[len(prefix):], " ")
		name := strings.TrimSpace(raw)
		if name == "" {
			return Schedule{}, fmt.Errorf("cron: %s 前缀缺少时区名", prefix)
		}
		loaded, err := time.LoadLocation(name)
		if err != nil {
			return Schedule{}, fmt.Errorf("cron: 未知时区 %q", name)
		}
		loc = loaded
		rest = strings.TrimSpace(tail)
		break
	}

	if strings.HasPrefix(rest, "@") {
		expanded, ok := macros[strings.ToLower(rest)]
		if !ok {
			return Schedule{}, fmt.Errorf("cron: 未知宏 %q", rest)
		}
		rest = expanded
	}

	fields := strings.Fields(rest)
	if len(fields) != 5 {
		return Schedule{}, fmt.Errorf("cron: 需要 5 个字段（分 时 日 月 周），实际 %d 个", len(fields))
	}

	s := Schedule{expr: original, loc: loc}
	var err error
	if s.minute, _, err = parseField(fields[0], fieldMinute); err != nil {
		return Schedule{}, fmt.Errorf("cron: 分钟字段 %q: %w", fields[0], err)
	}
	if s.hour, _, err = parseField(fields[1], fieldHour); err != nil {
		return Schedule{}, fmt.Errorf("cron: 小时字段 %q: %w", fields[1], err)
	}
	if s.dom, s.domAny, err = parseField(fields[2], fieldDayOfMonth); err != nil {
		return Schedule{}, fmt.Errorf("cron: 日期字段 %q: %w", fields[2], err)
	}
	if s.month, _, err = parseField(fields[3], fieldMonth); err != nil {
		return Schedule{}, fmt.Errorf("cron: 月份字段 %q: %w", fields[3], err)
	}
	if s.dow, s.dowAny, err = parseField(fields[4], fieldDayOfWeek); err != nil {
		return Schedule{}, fmt.Errorf("cron: 星期字段 %q: %w", fields[4], err)
	}
	return s, nil
}

// String 返回原始表达式（保留 TZ= 前缀与空白折叠后的形态）。
func (s Schedule) String() string { return s.expr }

// Location 返回表达式实际使用的时区。
func (s Schedule) Location() *time.Location { return s.loc }

// Matches 判断 t 所在的本地分钟是否命中该表达式。
//
// 它只看钟点字段，不看 t 与上一次触发的先后关系，因此
// Matches(Next(t)) 恒为 true，可用来交叉校验 Next 的结果。
func (s Schedule) Matches(t time.Time) bool {
	if t.IsZero() || s.loc == nil {
		return false
	}
	local := t.In(s.loc)
	if s.minute&(1<<uint(local.Minute())) == 0 {
		return false
	}
	if s.hour&(1<<uint(local.Hour())) == 0 {
		return false
	}
	return s.dateMatches(civilOf(local))
}

// Next 返回严格晚于 after 的第一个触发时刻（结果落在 s.Location() 时区）。
//
// after 为零值时返回 ErrNoReference；上界内找不到时返回 ErrNoFireTime。
func (s Schedule) Next(after time.Time) (time.Time, error) {
	if after.IsZero() || s.loc == nil {
		return time.Time{}, ErrNoReference
	}

	// cron 的触发粒度是分钟：先对齐到整分钟再 +1，保证「严格晚于 after」。
	//
	// 用绝对时间 Truncate 而不是本地秒清零：实测对整分钟偏移的时区（含 +05:30 的
	// Asia/Kolkata）两者等价；存在 :30 秒偏移的时区，但全部早于 1970，不影响未来时刻。
	base := after.In(s.loc).Truncate(time.Minute).Add(time.Minute)

	date := civilOf(base)
	for i := 0; i < maxScanDays; i++ {
		if s.dateMatches(date) {
			if fire, ok := s.firstInDay(date, after); ok {
				return fire, nil
			}
		}
		date = date.addDays(1)
	}
	return time.Time{}, ErrNoFireTime
}

// Due 返回 (cursor, now] 区间内**最后一个**触发时刻，用于生产者追赶停机漏跑。
//
// ok=false 表示 cursor 尚未到期（区间内没有触发时刻）。调用方应当把游标推进到
// 返回的时刻（而不是 now），这样停机期间落后多次时只补最近一次，不会把落后的
// 每一次都补一遍。
//
// 它**不会**补跑被夏令时前跳跳过的钟点：那些时刻不在 Next 的产出里，也就不在
// 本函数的搜索区间里（策略见包注释）。
func (s Schedule) Due(cursor, now time.Time) (time.Time, bool, error) {
	if cursor.IsZero() || now.IsZero() || s.loc == nil {
		return time.Time{}, false, ErrNoReference
	}
	if !now.After(cursor) {
		return time.Time{}, false, nil
	}

	latest := time.Time{}
	t := cursor
	for steps := 0; ; steps++ {
		switch {
		case steps == maxCatchUpSteps:
			// 步数用尽（长时间停机 + 高频表达式）：跳到 now 前一分钟只再收最后一次，
			// 避免为了找「最后一次」逐格推进几十万次。
			t = now.Truncate(time.Minute).Add(-time.Minute)
		case steps > maxCatchUpSteps:
			return latest, !latest.IsZero(), nil
		}
		next, err := s.Next(t)
		if err != nil {
			return time.Time{}, false, err
		}
		if next.After(now) {
			return latest, !latest.IsZero(), nil
		}
		latest = next
		t = next
	}
}

// dateMatches 判断某一天是否命中「月 + 日 + 星期」。
func (s Schedule) dateMatches(d civilDate) bool {
	if s.month&(1<<uint(d.month)) == 0 {
		return false
	}
	domHit := s.dom&(1<<uint(d.day)) != 0
	dowHit := s.dow&(1<<uint(d.weekday(s.loc))) != 0

	switch {
	case s.domAny && s.dowAny:
		return true
	case s.domAny:
		return dowHit
	case s.dowAny:
		return domHit
	default:
		// POSIX：日与星期**都受限**时取「或」而不是「与」。
		// 所以 0 0 1 * 1 = 每月 1 号**或**每周一。
		return domHit || dowHit
	}
}

// firstInDay 在指定日期内找第一个严格晚于 after 的命中钟点。
func (s Schedule) firstInDay(date civilDate, after time.Time) (time.Time, bool) {
	for hour := 0; hour <= 23; hour++ {
		if s.hour&(1<<uint(hour)) == 0 {
			continue
		}
		for minute := 0; minute <= 59; minute++ {
			if s.minute&(1<<uint(minute)) == 0 {
				continue
			}
			fire := date.at(hour, minute, s.loc)
			if !fire.After(after) {
				continue
			}
			// 春季前跳：不存在的本地钟点会被 time.Date 归一成别的时刻，读回对不上
			// 就丢弃（策略见包注释）。
			if fire.Hour() != hour || fire.Minute() != minute {
				continue
			}
			return fire, true
		}
	}
	return time.Time{}, false
}

// civilDate 是一个不带时区的日历日期。
type civilDate struct {
	year  int
	month time.Month
	day   int
}

func civilOf(t time.Time) civilDate {
	y, m, d := t.Date()
	return civilDate{year: y, month: m, day: d}
}

// addDays 走 UTC 的日历加法后再提取日期。
//
// 不能用本地 00:00 当锚点：有真实存在的时区在午夜做 DST 跳变（见包注释），
// 本地 00:00 会被归一成前一天 23:00，日期直接倒退一天。
func (c civilDate) addDays(n int) civilDate {
	y, m, d := time.Date(c.year, c.month, c.day+n, 12, 0, 0, 0, time.UTC).Date()
	return civilDate{year: y, month: m, day: d}
}

// at 把本地钟点落到具体时刻。不存在的本地钟点会被 time.Date 归一，
// 调用方需要用读回值自行校验（见 firstInDay）。
func (c civilDate) at(hour, minute int, loc *time.Location) time.Time {
	return time.Date(c.year, c.month, c.day, hour, minute, 0, 0, loc)
}

// weekday 用本地正午做锚点：正午在任何现代时区都不会被 DST 跳过。
func (c civilDate) weekday(loc *time.Location) time.Weekday {
	return c.at(12, 0, loc).Weekday()
}

// fieldKind 标识 cron 的五个字段，用于决定取值范围与允许的名字。
type fieldKind int

const (
	fieldMinute fieldKind = iota
	fieldHour
	fieldDayOfMonth
	fieldMonth
	fieldDayOfWeek
)

func (k fieldKind) bounds() (int, int) {
	switch k {
	case fieldMinute:
		return 0, 59
	case fieldHour:
		return 0, 23
	case fieldDayOfMonth:
		return 1, 31
	case fieldMonth:
		return 1, 12
	default:
		// 星期取 0-7，其中 7 是 0（周日）的别名。
		return 0, 7
	}
}

func (k fieldKind) label() string {
	switch k {
	case fieldMinute:
		return "分钟"
	case fieldHour:
		return "小时"
	case fieldDayOfMonth:
		return "日期"
	case fieldMonth:
		return "月份"
	default:
		return "星期"
	}
}

var monthNames = map[string]int{
	"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
	"JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

var dowNames = map[string]int{
	"SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6,
}

// parseField 解析一个字段，返回位图以及该字段是否字面为 "*"。
//
// 支持：* | N | A-B | */S | A-B/S，以及逗号列表和 3 字母名字（月份、星期）。
// 不支持 N/S 与 A-B/S 以外的步长写法，也不支持 A>B 的环绕区间——两者都容易
// 让调用方以为写对了，直接报错比猜语义更安全。
func parseField(spec string, kind fieldKind) (uint64, bool, error) {
	lo, hi := kind.bounds()
	if spec == "" {
		return 0, false, fmt.Errorf("%s字段为空", kind.label())
	}
	if spec == "*" {
		var bits uint64
		for v := lo; v <= hi; v++ {
			bits |= valueBit(v, kind)
		}
		return bits, true, nil
	}

	var bits uint64
	for _, rawTerm := range strings.Split(spec, ",") {
		term := strings.TrimSpace(rawTerm)
		if term == "" {
			return 0, false, errors.New("逗号列表里存在空项")
		}

		step := 1
		body := term
		if idx := strings.Index(term, "/"); idx >= 0 {
			body = term[:idx]
			rawStep := term[idx+1:]
			n, err := strconv.Atoi(rawStep)
			if err != nil || n < 1 {
				return 0, false, fmt.Errorf("步长 %q 不是正整数", rawStep)
			}
			step = n
		}

		var from, to int
		switch {
		case body == "*":
			from, to = lo, hi
		case strings.HasPrefix(body, "-") || strings.HasSuffix(body, "-"):
			// 例如 "-1" / "10-"：前者是写错的正数，后者是残缺区间。
			// 单独判一下，免得报成含混的「取值缺失」。
			return 0, false, fmt.Errorf("区间 %q 缺少端点", term)
		case strings.Contains(body, "-"):
			left, right, _ := strings.Cut(body, "-")
			fromValue, err := parseValue(strings.TrimSpace(left), kind)
			if err != nil {
				return 0, false, err
			}
			toValue, err := parseValue(strings.TrimSpace(right), kind)
			if err != nil {
				return 0, false, err
			}
			if fromValue > toValue {
				return 0, false, fmt.Errorf("区间 %q 的起点大于终点（不支持环绕）", body)
			}
			from, to = fromValue, toValue
		default:
			value, err := parseValue(body, kind)
			if err != nil {
				return 0, false, err
			}
			if step != 1 {
				return 0, false, fmt.Errorf("步长只能跟在 * 或 A-B 之后，不支持 %q", term)
			}
			from, to = value, value
		}

		for v := from; v <= to; v += step {
			bits |= valueBit(v, kind)
		}
	}
	return bits, false, nil
}

// parseValue 解析单个取值，支持十进制与月份/星期的 3 字母名字。
func parseValue(token string, kind fieldKind) (int, error) {
	lo, hi := kind.bounds()
	if token == "" {
		return 0, errors.New("取值缺失")
	}
	if n, err := strconv.Atoi(token); err == nil {
		if n < lo || n > hi {
			return 0, fmt.Errorf("取值 %d 超出范围 %d-%d", n, lo, hi)
		}
		return n, nil
	}

	var table map[string]int
	switch kind {
	case fieldMonth:
		table = monthNames
	case fieldDayOfWeek:
		table = dowNames
	default:
		return 0, fmt.Errorf("取值 %q 不是数字（%s字段不支持名字）", token, kind.label())
	}
	if v, ok := table[strings.ToUpper(token)]; ok {
		return v, nil
	}
	return 0, fmt.Errorf("未知的%s名 %q", kind.label(), token)
}

// valueBit 把取值折成位图。星期的 7 折到 0。
func valueBit(v int, kind fieldKind) uint64 {
	if kind == fieldDayOfWeek {
		v %= 7
	}
	return 1 << uint(v)
}
