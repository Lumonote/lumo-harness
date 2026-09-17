package cron

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func mustLoad(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("加载时区 %q 失败: %v", name, err)
	}
	return loc
}

// mustParseSchedule 解析表达式，失败即 Fatal。
func mustParseSchedule(t *testing.T, expr string, loc *time.Location) Schedule {
	t.Helper()
	s, err := Parse(expr, loc)
	if err != nil {
		t.Fatalf("Parse(%q) 失败: %v", expr, err)
	}
	return s
}

func mustParseTime(t *testing.T, value string, loc *time.Location) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation(time.RFC3339, value, loc)
	if err != nil {
		t.Fatalf("解析测试时间 %q 失败: %v", value, err)
	}
	return parsed
}

func TestParseRejectsInvalidExpressions(t *testing.T) {
	cases := []struct {
		name string
		expr string
		want string // 期望错误信息里出现的片段
	}{
		{"空表达式", "   ", "表达式为空"},
		{"字段太少", "0 9 * *", "需要 5 个字段"},
		{"字段太多", "0 9 * * * *", "需要 5 个字段"},
		{"分钟超上界", "60 * * * *", "超出范围 0-59"},
		{"分钟为负号被当作残缺区间", "-1 * * * *", "缺少端点"},
		{"小时超上界", "* 24 * * *", "超出范围 0-23"},
		{"日期为 0", "* * 0 * *", "超出范围 1-31"},
		{"日期超上界", "* * 32 * *", "超出范围 1-31"},
		{"月份为 0", "* * * 0 *", "超出范围 1-12"},
		{"月份超上界", "* * * 13 *", "超出范围 1-12"},
		{"星期超上界", "* * * * 8", "超出范围 0-7"},
		{"步长为 0", "*/0 * * * *", "不是正整数"},
		{"步长为负", "*/-2 * * * *", "不是正整数"},
		{"步长非数字", "*/x * * * *", "不是正整数"},
		{"不支持 N/S", "5/15 * * * *", "步长只能跟在 * 或 A-B 之后"},
		{"区间倒置", "10-5 * * * *", "起点大于终点"},
		{"区间缺右端", "10- * * * *", "缺少端点"},
		{"逗号空项", "*/2, * * * *", "空项"},
		{"未知宏", "@reboot", "未知宏"},
		{"every 语法不支持", "@every 1h", "未知宏"},
		{"未知时区", "TZ=Not/AZone 0 9 * * *", "未知时区"},
		{"缺时区名", "CRON_TZ= 0 9 * * *", "缺少时区名"},
		{"分钟非数字", "abc * * * *", "不是数字"},
		{"月份不支持名字以外的词", "* * * FOO *", "未知的月份名"},
		{"星期未知名", "* * * * FOO", "未知的星期名"},
		{"小时字段用名字", "* MON * * *", "小时字段不支持名字"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(tc.expr, time.UTC)
			if err == nil {
				t.Fatalf("Parse(%q) 期望报错，实际成功", tc.expr)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Parse(%q) 错误信息 = %q，期望包含 %q", tc.expr, err.Error(), tc.want)
			}
		})
	}
}

func TestParseAcceptsValidExpressions(t *testing.T) {
	exprs := []string{
		"* * * * *",
		"0 9 * * *",
		"*/15 * * * *",
		"0,30 8-18 * * 1-5",
		"0 0 1 * *",
		"0 0 1 JAN *",
		"0 12 * * MON",
		"0 12 * * mon",
		"0 0 * * 7",
		"0 0 * * 0",
		"0 0 29 2 *",
		"@hourly", "@daily", "@midnight", "@weekly", "@monthly", "@yearly", "@annually",
		"CRON_TZ=Asia/Shanghai 0 9 * * *",
		"TZ=UTC 0 9 * * *",
		"cron_tz=Asia/Shanghai 0 9 * * *",
		"0 0 1-31/2 * *",
	}
	for _, expr := range exprs {
		t.Run(expr, func(t *testing.T) {
			s, err := Parse(expr, time.UTC)
			if err != nil {
				t.Fatalf("Parse(%q) 期望成功，实际报错: %v", expr, err)
			}
			if s.String() != strings.TrimSpace(expr) {
				t.Fatalf("String() = %q，期望保留原始表达式 %q", s.String(), expr)
			}
			if s.Location() == nil {
				t.Fatal("Location() 返回 nil")
			}
		})
	}
}

func TestParseTimezonePrefixAndDefault(t *testing.T) {
	shanghai := mustLoad(t, "Asia/Shanghai")

	t.Run("前缀优先于默认时区", func(t *testing.T) {
		s := mustParseSchedule(t, "CRON_TZ=Asia/Shanghai 0 9 * * *", time.UTC)
		if got := s.Location().String(); got != "Asia/Shanghai" {
			t.Fatalf("Location() = %q，期望 Asia/Shanghai", got)
		}
	})

	t.Run("无前缀时用默认时区", func(t *testing.T) {
		s := mustParseSchedule(t, "0 9 * * *", shanghai)
		if got := s.Location().String(); got != "Asia/Shanghai" {
			t.Fatalf("Location() = %q，期望 Asia/Shanghai", got)
		}
	})

	t.Run("默认时区为 nil 时按 UTC", func(t *testing.T) {
		s := mustParseSchedule(t, "0 9 * * *", nil)
		if got := s.Location().String(); got != "UTC" {
			t.Fatalf("Location() = %q，期望 UTC", got)
		}
	})

	t.Run("大小写不敏感的前缀名", func(t *testing.T) {
		s := mustParseSchedule(t, "cron_tz=Asia/Shanghai 0 9 * * *", time.UTC)
		if got := s.Location().String(); got != "Asia/Shanghai" {
			t.Fatalf("Location() = %q，期望 Asia/Shanghai", got)
		}
	})
}

func TestNext(t *testing.T) {
	utc := time.UTC
	shanghai := mustLoad(t, "Asia/Shanghai")

	cases := []struct {
		name  string
		expr  string
		loc   *time.Location
		after string
		want  string
	}{
		{
			name: "每分钟：秒被进位到下一分钟",
			expr: "* * * * *", loc: utc,
			after: "2026-09-14T09:07:30Z",
			want:  "2026-09-14T09:08:00Z",
		},
		{
			name: "每分钟：整分钟参考也要严格往后",
			expr: "* * * * *", loc: utc,
			after: "2026-09-14T09:07:00Z",
			want:  "2026-09-14T09:08:00Z",
		},
		{
			name: "每 15 分钟对齐到刻度",
			expr: "*/15 * * * *", loc: utc,
			after: "2026-09-14T09:07:00Z",
			want:  "2026-09-14T09:15:00Z",
		},
		{
			name: "每日固定钟点：当天已过则顺延到次日",
			expr: "0 9 * * *", loc: utc,
			after: "2026-09-14T09:00:00Z",
			want:  "2026-09-15T09:00:00Z",
		},
		{
			name: "每日固定钟点：当天未到",
			expr: "0 9 * * *", loc: utc,
			after: "2026-09-14T08:59:59Z",
			want:  "2026-09-14T09:00:00Z",
		},
		{
			name: "跨年",
			expr: "@daily", loc: utc,
			after: "2026-12-31T23:59:00Z",
			want:  "2027-01-01T00:00:00Z",
		},
		{
			name: "跨月",
			expr: "@monthly", loc: utc,
			after: "2026-09-14T00:00:00Z",
			want:  "2026-10-01T00:00:00Z",
		},
		{
			name: "跨年（@yearly）",
			expr: "@yearly", loc: utc,
			after: "2026-09-14T00:00:00Z",
			want:  "2027-01-01T00:00:00Z",
		},
		{
			name: "每周（2026-09-14 是周一，下一个周日是 09-20）",
			expr: "@weekly", loc: utc,
			after: "2026-09-14T00:00:00Z",
			want:  "2026-09-20T00:00:00Z",
		},
		{
			name: "星期 7 等价于 0（周日）",
			expr: "0 0 * * 7", loc: utc,
			after: "2026-09-14T00:00:00Z",
			want:  "2026-09-20T00:00:00Z",
		},
		{
			name: "日与星期都受限时取或：09-01 是周二且是 1 号，下一个命中的是周一 09-07",
			expr: "0 0 1 * 1", loc: utc,
			after: "2026-09-01T00:00:00Z",
			want:  "2026-09-07T00:00:00Z",
		},
		{
			name: "日受限、星期为 * 时只看日：下一个 1 号",
			expr: "0 0 1 * *", loc: utc,
			after: "2026-09-01T00:00:00Z",
			want:  "2026-10-01T00:00:00Z",
		},
		{
			name: "日不受限、星期受限时只看星期",
			expr: "0 12 * * MON", loc: utc,
			after: "2026-09-14T12:00:00Z",
			want:  "2026-09-21T12:00:00Z",
		},
		{
			name: "星期名大小写不敏感",
			expr: "0 12 * * mon", loc: utc,
			after: "2026-09-14T12:00:00Z",
			want:  "2026-09-21T12:00:00Z",
		},
		{
			name: "月份名",
			expr: "0 0 1 JAN *", loc: utc,
			after: "2026-06-01T00:00:00Z",
			want:  "2027-01-01T00:00:00Z",
		},
		{
			name: "整月跳过：1 月 31 日之后 2 月没有 31 日",
			expr: "0 0 31 * *", loc: utc,
			after: "2026-01-31T00:00:00Z",
			want:  "2026-03-31T00:00:00Z",
		},
		{
			name: "闰日：下一个 2 月 29 日是 2028",
			expr: "0 0 29 2 *", loc: utc,
			after: "2026-09-14T00:00:00Z",
			want:  "2028-02-29T00:00:00Z",
		},
		{
			name: "闰日：跨过 2100 这个非闰百年，需要看 7 年",
			expr: "0 0 29 2 *", loc: utc,
			after: "2097-03-01T00:00:00Z",
			want:  "2104-02-29T00:00:00Z",
		},
		{
			name: "小时区间 + 分钟步长",
			expr: "*/20 3-5 * * *", loc: utc,
			after: "2026-09-14T02:00:00Z",
			want:  "2026-09-14T03:00:00Z",
		},
		{
			name: "列表 + 区间 + 星期（工作日 8:00/8:30）",
			expr: "0,30 8-18 * * 1-5", loc: utc,
			after: "2026-09-19T00:00:00Z", // 周六
			want:  "2026-09-21T08:00:00Z", // 下周一
		},
		{
			name: "时区前缀：结果落在表达式所在时区（上海 09:00）",
			expr: "CRON_TZ=Asia/Shanghai 0 9 * * *", loc: utc,
			after: "2026-09-14T00:00:00Z",
			// Next 返回的时刻在 s.Location() 里，所以是 +08:00 的 09:00，
			// 与 UTC 01:00 是同一瞬间。
			want: "2026-09-14T09:00:00+08:00",
		},
		{
			name: "默认时区：结果落在默认时区（上海 09:00）",
			expr: "0 9 * * *", loc: shanghai,
			after: "2026-09-14T00:00:00Z",
			want:  "2026-09-14T09:00:00+08:00",
		},
		{
			name: "时区前缀：UTC 前缀时结果落在 UTC",
			expr: "TZ=UTC 0 9 * * *", loc: shanghai,
			after: "2026-09-14T00:00:00Z",
			want:  "2026-09-14T09:00:00Z",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := mustParseSchedule(t, tc.expr, tc.loc)
			after := mustParseTime(t, tc.after, tc.loc)
			got, err := s.Next(after)
			if err != nil {
				t.Fatalf("Next(%s) 报错: %v", tc.after, err)
			}
			if formatted := got.Format(time.RFC3339); formatted != tc.want {
				t.Fatalf("Next(%s) = %s，期望 %s", tc.after, formatted, tc.want)
			}
		})
	}
}

// TestNextDST 固定本包对夏令时的策略。这些期望值来自对 Go time 包实际行为的
// 实测（见包注释），不是照抄某个 cron 实现。
func TestNextDST(t *testing.T) {
	ny := mustLoad(t, "America/New_York")

	cases := []struct {
		name  string
		expr  string
		after string
		want  string
	}{
		{
			name:  "春季前跳：不存在的 02:30 被跳过，落到次日",
			expr:  "30 2 * * *",
			after: "2026-03-07T12:00:00-05:00",
			// 2026-03-08 02:30 不存在（02:00 -> 03:00），time.Date 会归一成 01:30-05:00，
			// 读回对不上所以丢弃；下一次是 03-09 02:30 EDT。
			want: "2026-03-09T02:30:00-04:00",
		},
		{
			name:  "春季前跳：整点同理",
			expr:  "0 2 * * *",
			after: "2026-03-07T12:00:00-05:00",
			want:  "2026-03-09T02:00:00-04:00",
		},
		{
			name:  "春季前跳当天的其他钟点不受影响",
			expr:  "0 3 * * *",
			after: "2026-03-07T12:00:00-05:00",
			// 03:00 EDT 是跳变后的第一个整点，正常存在。
			want: "2026-03-08T03:00:00-04:00",
		},
		{
			name:  "秋季回拨：歧义的 01:30 只在第一次出现（EDT）触发一次",
			expr:  "30 1 * * *",
			after: "2026-11-01T00:00:00-04:00",
			want:  "2026-11-01T01:30:00-04:00",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := mustParseSchedule(t, tc.expr, ny)
			after := mustParseTime(t, tc.after, ny)
			got, err := s.Next(after)
			if err != nil {
				t.Fatalf("Next(%s) 报错: %v", tc.after, err)
			}
			if formatted := got.Format(time.RFC3339); formatted != tc.want {
				t.Fatalf("Next(%s) = %s，期望 %s", tc.after, formatted, tc.want)
			}
		})
	}
}

// TestNextNoDoubleFireOnFallBack 秋季回拨不会把同一个本地钟点触发两次。
func TestNextNoDoubleFireOnFallBack(t *testing.T) {
	ny := mustLoad(t, "America/New_York")
	s := mustParseSchedule(t, "30 1 * * *", ny)

	first := mustParseTime(t, "2026-11-01T01:30:00-04:00", ny)
	second, err := s.Next(first)
	if err != nil {
		t.Fatalf("Next 报错: %v", err)
	}
	if formatted := second.Format(time.RFC3339); formatted != "2026-11-02T01:30:00-05:00" {
		t.Fatalf("回拨日的下一次 = %s，期望直接到次日 2026-11-02T01:30:00-05:00", formatted)
	}

	// 从回拨后的第二次 01:30（EST）往后看，也不能再吐出 11-01 的第三次。
	third, err := s.Next(mustParseTime(t, "2026-11-01T01:30:00-05:00", ny))
	if err != nil {
		t.Fatalf("Next 报错: %v", err)
	}
	if formatted := third.Format(time.RFC3339); formatted != "2026-11-02T01:30:00-05:00" {
		t.Fatalf("从 EST 的 01:30 往后 = %s，期望 2026-11-02T01:30:00-05:00", formatted)
	}
}

// TestNextDatesStayConsecutiveAcrossMidnightDST 覆盖「午夜做 DST 跳变」的时区。
//
// 实测 America/Santiago 2026-09-06 00:00 不存在（前跳到 01:00），America/Havana
// 2026-03-08 00:00 会被归一成 03-07 23:00（日期倒退）。如果实现用本地 00:00 当日期
// 锚点，日期会算错甚至原地打转，这里逐日断言日期严格递增且不重复。
func TestNextDatesStayConsecutiveAcrossMidnightDST(t *testing.T) {
	cases := []struct {
		zone  string
		expr  string
		start string
		want  []string
	}{
		{
			zone: "America/Santiago", expr: "0 12 * * *",
			start: "2026-09-03T12:00:00-04:00",
			want: []string{
				"2026-09-04T12:00:00-04:00",
				"2026-09-05T12:00:00-04:00",
				"2026-09-06T12:00:00-03:00", // 当天 00:00 被前跳吃掉，12:00 照常
				"2026-09-07T12:00:00-03:00",
			},
		},
		{
			zone: "America/Havana", expr: "0 12 * * *",
			start: "2026-03-06T12:00:00-05:00",
			want: []string{
				"2026-03-07T12:00:00-05:00",
				"2026-03-08T12:00:00-04:00", // 当天 00:00 被前跳吃掉
				"2026-03-09T12:00:00-04:00",
				"2026-03-10T12:00:00-04:00",
			},
		},
		{
			zone: "America/Santiago", expr: "0 0 * * *",
			start: "2026-09-04T00:00:00-04:00",
			// 09-06 的 00:00 不存在，直接跳到 09-07；关键是日期不会倒退或卡住。
			want: []string{
				"2026-09-05T00:00:00-04:00",
				"2026-09-07T00:00:00-03:00",
				"2026-09-08T00:00:00-03:00",
				"2026-09-09T00:00:00-03:00",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.zone+"/"+tc.expr, func(t *testing.T) {
			loc := mustLoad(t, tc.zone)
			s := mustParseSchedule(t, tc.expr, loc)
			cursor := mustParseTime(t, tc.start, loc)
			for i, want := range tc.want {
				got, err := s.Next(cursor)
				if err != nil {
					t.Fatalf("第 %d 次 Next 报错: %v", i, err)
				}
				if formatted := got.Format(time.RFC3339); formatted != want {
					t.Fatalf("第 %d 次 Next = %s，期望 %s", i, formatted, want)
				}
				if !got.After(cursor) {
					t.Fatalf("第 %d 次 Next = %s 没有严格晚于上一次 %s", i, got.Format(time.RFC3339), cursor.Format(time.RFC3339))
				}
				cursor = got
			}
		})
	}
}

// TestNextIsMonotone 连续调用必须严格递增，且结果本身命中表达式。
func TestNextIsMonotone(t *testing.T) {
	exprs := []string{
		"* * * * *", "*/7 * * * *", "0 9 * * *", "0,30 8-18 * * 1-5",
		"0 0 1 * *", "0 0 29 2 *", "30 2 * * *", "@weekly", "@monthly",
	}
	for _, expr := range exprs {
		t.Run(expr, func(t *testing.T) {
			loc := mustLoad(t, "America/New_York")
			s := mustParseSchedule(t, expr, loc)
			cursor := mustParseTime(t, "2026-03-01T00:00:00-05:00", loc)
			for i := 0; i < 60; i++ {
				next, err := s.Next(cursor)
				if err != nil {
					t.Fatalf("第 %d 次 Next 报错: %v", i, err)
				}
				if !next.After(cursor) {
					t.Fatalf("第 %d 次 Next = %s 没有严格晚于 %s", i, next.Format(time.RFC3339), cursor.Format(time.RFC3339))
				}
				if !s.Matches(next) {
					t.Fatalf("第 %d 次 Next = %s 却不被 Matches 命中", i, next.Format(time.RFC3339))
				}
				cursor = next
			}
		})
	}
}

// TestNextIsTheFirstMatch 逐分钟扫描，确认 Next 返回的确实是第一个命中时刻。
func TestNextIsTheFirstMatch(t *testing.T) {
	exprs := []string{"*/15 * * * *", "0 9 * * *", "0 0 1 * 1", "0,30 8-18 * * 1-5", "0 2 * * *"}
	for _, expr := range exprs {
		t.Run(expr, func(t *testing.T) {
			loc := mustLoad(t, "America/New_York")
			s := mustParseSchedule(t, expr, loc)
			after := mustParseTime(t, "2026-03-06T00:00:00-05:00", loc)
			next, err := s.Next(after)
			if err != nil {
				t.Fatalf("Next 报错: %v", err)
			}

			// 逐分钟走一遍 (after, next)，中间任何一分钟都不应命中。
			for probe := after.In(loc).Truncate(time.Minute).Add(time.Minute); probe.Before(next); probe = probe.Add(time.Minute) {
				if s.Matches(probe) {
					t.Fatalf("Next 返回 %s，但中间时刻 %s 也命中", next.Format(time.RFC3339), probe.Format(time.RFC3339))
				}
			}
			if !s.Matches(next) {
				t.Fatalf("Next 返回的 %s 不被 Matches 命中", next.Format(time.RFC3339))
			}
		})
	}
}

func TestNextRejectsZeroReference(t *testing.T) {
	s := mustParseSchedule(t, "* * * * *", time.UTC)
	if _, err := s.Next(time.Time{}); !errors.Is(err, ErrNoReference) {
		t.Fatalf("Next(零值) 错误 = %v，期望 ErrNoReference", err)
	}
}

func TestNextReportsUnreachableExpression(t *testing.T) {
	// 2 月没有 30 日：解析合法，但上界内找不到触发时刻。
	s := mustParseSchedule(t, "0 0 30 2 *", time.UTC)
	_, err := s.Next(mustParseTime(t, "2026-09-14T00:00:00Z", time.UTC))
	if !errors.Is(err, ErrNoFireTime) {
		t.Fatalf("Next 错误 = %v，期望 ErrNoFireTime", err)
	}
}

func TestMatches(t *testing.T) {
	utc := time.UTC
	s := mustParseSchedule(t, "30 9 * * 1", utc) // 周一 09:30

	hit := mustParseTime(t, "2026-09-14T09:30:00Z", utc) // 周一
	if !s.Matches(hit) {
		t.Fatalf("Matches(%s) = false，期望 true", hit.Format(time.RFC3339))
	}

	misses := []string{
		"2026-09-14T09:29:00Z", // 分钟不符
		"2026-09-14T10:30:00Z", // 小时不符
		"2026-09-15T09:30:00Z", // 周二
	}
	for _, value := range misses {
		at := mustParseTime(t, value, utc)
		if s.Matches(at) {
			t.Fatalf("Matches(%s) = true，期望 false", value)
		}
	}

	if s.Matches(time.Time{}) {
		t.Fatal("Matches(零值) = true，期望 false")
	}

	// Matches 会先把时刻换算到表达式所在时区。
	shanghai := mustLoad(t, "Asia/Shanghai")
	sh := mustParseSchedule(t, "0 9 * * *", shanghai)
	if !sh.Matches(mustParseTime(t, "2026-09-14T01:00:00Z", utc)) {
		t.Fatal("上海 09:00 应命中 UTC 01:00")
	}
}

func TestDueCoalescesMissedFires(t *testing.T) {
	utc := time.UTC

	t.Run("游标未到期", func(t *testing.T) {
		s := mustParseSchedule(t, "0 * * * *", utc)
		got, ok, err := s.Due(
			mustParseTime(t, "2026-09-14T05:00:00Z", utc),
			mustParseTime(t, "2026-09-14T05:30:00Z", utc),
		)
		if err != nil {
			t.Fatalf("Due 报错: %v", err)
		}
		if ok {
			t.Fatalf("Due 返回 ok=true（%s），期望 false", got.Format(time.RFC3339))
		}
	})

	t.Run("落后 5 小时只补最近一次", func(t *testing.T) {
		s := mustParseSchedule(t, "0 * * * *", utc)
		got, ok, err := s.Due(
			mustParseTime(t, "2026-09-14T00:00:00Z", utc),
			mustParseTime(t, "2026-09-14T05:30:00Z", utc),
		)
		if err != nil {
			t.Fatalf("Due 报错: %v", err)
		}
		if !ok {
			t.Fatal("Due 返回 ok=false，期望 true")
		}
		if formatted := got.Format(time.RFC3339); formatted != "2026-09-14T05:00:00Z" {
			t.Fatalf("Due = %s，期望只补最近一次 2026-09-14T05:00:00Z", formatted)
		}
	})

	t.Run("恰好到期（now 等于触发时刻）", func(t *testing.T) {
		s := mustParseSchedule(t, "0 * * * *", utc)
		got, ok, err := s.Due(
			mustParseTime(t, "2026-09-14T04:00:00Z", utc),
			mustParseTime(t, "2026-09-14T05:00:00Z", utc),
		)
		if err != nil {
			t.Fatalf("Due 报错: %v", err)
		}
		if !ok || got.Format(time.RFC3339) != "2026-09-14T05:00:00Z" {
			t.Fatalf("Due = (%s, %v)，期望 (2026-09-14T05:00:00Z, true)", got.Format(time.RFC3339), ok)
		}
	})

	t.Run("追赶步数用尽时仍给出最近一次（每分钟表达式停 19 天）", func(t *testing.T) {
		s := mustParseSchedule(t, "* * * * *", utc)
		got, ok, err := s.Due(
			mustParseTime(t, "2026-01-01T00:00:00Z", utc),
			mustParseTime(t, "2026-01-20T00:00:00Z", utc),
		)
		if err != nil {
			t.Fatalf("Due 报错: %v", err)
		}
		if !ok {
			t.Fatal("Due 返回 ok=false，期望 true")
		}
		if formatted := got.Format(time.RFC3339); formatted != "2026-01-20T00:00:00Z" {
			t.Fatalf("Due = %s，期望 2026-01-20T00:00:00Z", formatted)
		}
	})

	t.Run("零值参考时刻", func(t *testing.T) {
		s := mustParseSchedule(t, "0 * * * *", utc)
		if _, _, err := s.Due(time.Time{}, mustParseTime(t, "2026-09-14T05:30:00Z", utc)); !errors.Is(err, ErrNoReference) {
			t.Fatalf("Due 错误 = %v，期望 ErrNoReference", err)
		}
	})
}

// TestSpringForwardGapIsNotResurrected 把「前跳当天不触发」这个策略钉死。
//
// 这不是缺陷而是选择：被跳过的钟点不在 Next 的产出里，所以生产者的游标永远不会
// 停在它上面，Due 也不会把它补回来。将来若改成 Vixie 那种「跳变后立即补跑」，
// 这个用例会先红，提醒改动者必须同时处理跳变历史。
func TestSpringForwardGapIsNotResurrected(t *testing.T) {
	ny := mustLoad(t, "America/New_York")
	s := mustParseSchedule(t, "0 2 * * *", ny)

	before := mustParseTime(t, "2026-03-07T02:00:00-05:00", ny)
	after, err := s.Next(before)
	if err != nil {
		t.Fatalf("Next 报错: %v", err)
	}
	if formatted := after.Format(time.RFC3339); formatted != "2026-03-09T02:00:00-04:00" {
		t.Fatalf("Next(03-07 02:00) = %s，期望直接跨过 03-08 到 2026-03-09T02:00:00-04:00", formatted)
	}

	// 跳变之后回头看，03-08 那一整天都不在调度时间线上。
	due, ok, err := s.Due(before, mustParseTime(t, "2026-03-08T23:00:00-04:00", ny))
	if err != nil {
		t.Fatalf("Due 报错: %v", err)
	}
	if ok {
		t.Fatalf("Due 返回 ok=true（%s），期望 03-08 无触发可补", due.Format(time.RFC3339))
	}
}

// TestDueCatchesUpAfterDowntimeAcrossDST 停机跨越夏令时跳变时，只补最近一次，
// 且补的是「真实存在的最后一个触发时刻」。
func TestDueCatchesUpAfterDowntimeAcrossDST(t *testing.T) {
	ny := mustLoad(t, "America/New_York")
	s := mustParseSchedule(t, "0 2 * * *", ny)

	// 停机：03-06 02:00 之后一直没跑，03-10 00:00（EDT）才恢复。
	// 期间应触发的是 03-06、03-07、03-09（03-08 不存在），最近一次是 03-09。
	got, ok, err := s.Due(
		mustParseTime(t, "2026-03-06T02:00:00-05:00", ny),
		mustParseTime(t, "2026-03-10T00:00:00-04:00", ny),
	)
	if err != nil {
		t.Fatalf("Due 报错: %v", err)
	}
	if !ok {
		t.Fatal("Due 返回 ok=false，期望补跑 03-09 的 02:00")
	}
	if formatted := got.Format(time.RFC3339); formatted != "2026-03-09T02:00:00-04:00" {
		t.Fatalf("Due = %s，期望只补最近一次 2026-03-09T02:00:00-04:00", formatted)
	}

	// 从补跑时刻往后，游标回到正常节奏。
	next, err := s.Next(got)
	if err != nil {
		t.Fatalf("Next 报错: %v", err)
	}
	if formatted := next.Format(time.RFC3339); formatted != "2026-03-10T02:00:00-04:00" {
		t.Fatalf("补跑后的下一次 = %s，期望 2026-03-10T02:00:00-04:00", formatted)
	}
}

func TestStringKeepsOriginalExpression(t *testing.T) {
	const expr = "CRON_TZ=Asia/Shanghai 0 9 * * 1-5"
	s := mustParseSchedule(t, expr, time.UTC)
	if s.String() != expr {
		t.Fatalf("String() = %q，期望 %q", s.String(), expr)
	}
}
