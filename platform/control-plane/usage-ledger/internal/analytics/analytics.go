// Package analytics 是用量台账的查询面（A5 的 query integration）。
//
// **只读 PG 台账，不引入第二个数据引擎。** 台账本身是 append-only 且带 event_key 幂等键
// 的权威表（见 ledger 包），日粒度聚合直接在上面分组即可。原先设想的那条
// 「PG → 列存 cube → 查询」链路被移除：它要求额外组件、要求一个投影 worker 与位点、
// 还引入了一类只能靠约定维持的一致性（重放不得双计），而换来的只是把一次分组下推。
// 在台账规模到达 PG 真的撑不住之前，那条链路的复杂度没有对应的收益。
//
// 于是本包的全部职责就只剩一件：**把台账按 (day, project, user, cost_type) 分组，
// 以稳定顺序返回**。查询面在这里，不在任何派生存储里。
package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// ReportingLocation 是日维度的**报告时区**。
//
// 固定 UTC 而不是服务器本地时区：day 是分组键，SQL 侧（`timezone($1, ts)`）与 Go 侧
// （DayBounds 给出的区间上下界）必须对「这条记录属于哪一天」给出逐字相同的答案。
// 用本地时区会让答案取决于部署机器，那是不可复现的。
var ReportingLocation = time.UTC

// DayBounds 返回某个 day 的 [start, end) 时刻区间。
//
// 与 SQL 里的 `timezone(ReportingLocation, ts)` 同源：这样「分组出的 day」与
// 「过滤用的时间窗」不可能分叉。两者分叉的表现是「某些分组的值总是偏小」，
// 从报表上极难发现。
func DayBounds(day string) (time.Time, time.Time, error) {
	start, err := time.ParseInLocation("2006-01-02", day, ReportingLocation)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("day %q 不是 YYYY-MM-DD", day)
	}
	return start, start.AddDate(0, 0, 1), nil
}

// MaxSpanDays 单次查询允许的最大天数跨度。
//
// 上限存在的意义是让「查询被滥用」变成 400 而不是一次全表扫描：台账 append-only 且无分区，
// 无界区间等于允许任何人把库拖慢。
const MaxSpanDays = 366

// Row 一个 (day, project, user, cost_type) 分组的聚合值。
type Row struct {
	Day       string  `json:"day"`
	UserID    string  `json:"user_id"`
	ProjectID string  `json:"project_id"`
	CostType  string  `json:"cost_type"`
	Qty       float64 `json:"qty"`
	CostUSD   float64 `json:"cost_usd"`
	Tokens    int64   `json:"tokens"`
}

// Totals 区间合计（服务端算好，省掉每个调用方各写一遍）。
type Totals struct {
	Qty     float64 `json:"qty"`
	CostUSD float64 `json:"cost_usd"`
	Tokens  int64   `json:"tokens"`
}

// Response 查询响应。
type Response struct {
	From      string `json:"from"`
	To        string `json:"to"`
	ProjectID string `json:"project_id,omitempty"`
	Rows      []Row  `json:"rows"`
	Totals    Totals `json:"totals"`
}

// Source 一次查询的执行者。
//
// 只有一个实现（PgSource）时接口仍然值得存在，理由很具体：HTTP 层要在**没有数据库**
// 的环境里可测（本机与 CI 都没有 PG，见仓库惯例），而接口正是注入测试替身的那个点。
type Source interface {
	// Aggregate 返回 [fromDay, toDay] 闭区间（按天）的聚合行。
	Aggregate(ctx context.Context, fromDay, toDay, projectID string) ([]Row, error)
}

// Service 是查询服务。
type Service struct {
	source Source
}

// NewService 构造查询服务。
func NewService(source Source) (*Service, error) {
	if source == nil {
		return nil, fmt.Errorf("analytics: 未提供查询源")
	}
	return &Service{source: source}, nil
}

// Aggregate 执行一次查询。
func (s *Service) Aggregate(ctx context.Context, fromDay, toDay, projectID string) (Response, error) {
	if err := validateRange(fromDay, toDay); err != nil {
		return Response{}, err
	}
	rows, err := s.source.Aggregate(ctx, fromDay, toDay, projectID)
	if err != nil {
		return Response{}, err
	}
	SortRows(rows)
	if rows == nil {
		// 空区间返回空数组而不是 null：调用方少一个分支，也少一次「null 还是 []」的争论。
		rows = []Row{}
	}
	response := Response{From: fromDay, To: toDay, ProjectID: projectID, Rows: rows}
	for _, r := range rows {
		response.Totals.Qty += r.Qty
		response.Totals.CostUSD += r.CostUSD
		response.Totals.Tokens += r.Tokens
	}
	return response, nil
}

// AggregateHandler 暴露 `GET /v1/usage/aggregate?from=&to=&project_id=`。
//
// 参数非法一律 400 并说明原因：用量查询是给报表和运维用的，猜一个默认区间
// （比如「最近 30 天」）会让调用方以为拿到的是自己想要的区间。
//
// 400 与 500 必须分开：把数据库故障报成 400 会让调用方以为是自己参数写错了，
// 于是不去看告警——这是把运维故障伪装成用户错误。
func (s *Service) AggregateHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		from, to := query.Get("from"), query.Get("to")
		if from == "" || to == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "from 与 to 必填，格式 YYYY-MM-DD"})
			return
		}
		response, err := s.Aggregate(r.Context(), from, to, query.Get("project_id"))
		if err != nil {
			if errors.Is(err, ErrInvalidRange) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "用量查询失败"})
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

// SortRows 按 (day, project, user, cost_type) 排序。
//
// 顺序不影响正确性（分组键唯一），但稳定顺序让接口可对比、可快照测试：没有它，
// 同一份数据两次查询的 JSON 可能不同，任何基于 diff 的验证都会变成噪声。
func SortRows(rows []Row) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.Day != b.Day {
			return a.Day < b.Day
		}
		if a.ProjectID != b.ProjectID {
			return a.ProjectID < b.ProjectID
		}
		if a.UserID != b.UserID {
			return a.UserID < b.UserID
		}
		return a.CostType < b.CostType
	})
}

// ErrInvalidRange 查询区间非法（调用方的问题，映射 HTTP 400）。
var ErrInvalidRange = errors.New("analytics: 查询区间非法")

// validateRange 校验区间：格式、先后、跨度上限。
func validateRange(fromDay, toDay string) error {
	from, err := time.ParseInLocation("2006-01-02", fromDay, ReportingLocation)
	if err != nil {
		return fmt.Errorf("%w: from %q 不是 YYYY-MM-DD", ErrInvalidRange, fromDay)
	}
	to, err := time.ParseInLocation("2006-01-02", toDay, ReportingLocation)
	if err != nil {
		return fmt.Errorf("%w: to %q 不是 YYYY-MM-DD", ErrInvalidRange, toDay)
	}
	if to.Before(from) {
		return fmt.Errorf("%w: to(%s) 早于 from(%s)", ErrInvalidRange, toDay, fromDay)
	}
	if days := int(to.Sub(from).Hours()/24) + 1; days > MaxSpanDays {
		return fmt.Errorf("%w: 区间跨 %d 天，超过上限 %d 天", ErrInvalidRange, days, MaxSpanDays)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
