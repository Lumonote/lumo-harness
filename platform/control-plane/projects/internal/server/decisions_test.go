package server_test

// 决策记忆 HTTP 面（§24.4）：两级读面（索引 / 正文）、append-only 取代、realm 作用域、
// 闭集与权限执法。全部需要活库（无 DSN 时整组跳过，见 testDSN）。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

func appendViaAPI(t *testing.T, ts *httptest.Server, projectID, user, realm, body string) string {
	t.Helper()
	resp, out := do(t, "POST", ts.URL+"/v1/projects/"+projectID+"/decisions", body, auth(user, realm))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("追加决策失败: %d %s", resp.StatusCode, out)
	}
	var created struct {
		ID           string `json:"id"`
		Realm        string `json:"realm"`
		SupersededBy string `json:"superseded_by"`
	}
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		t.Fatalf("解析创建结果: %v (%s)", err, out)
	}
	if !strings.HasPrefix(created.ID, "dec_") {
		t.Fatalf("ID 形态: %s", created.ID)
	}
	if created.Realm != realm {
		t.Fatalf("realm 必须来自身份头: %s", created.Realm)
	}
	return created.ID
}

func TestDecisionAPITwoTierRead(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "decisions")
	const body = "因为账单结算在周四跑完，只有周五之后发布才不会打断出账。"
	old := appendViaAPI(t, ts, id, "owner1", "r1",
		fmt.Sprintf(`{"kind":"decision","summary":"发布日期改到周五","body":%q,"evidence":[{"session_ref":"s1","seq":9}]}`, body))

	// 索引层：只有 summary，**没有正文**（膨胀索引的代价正是这一列）
	resp, out := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions", "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("索引读失败: %d %s", resp.StatusCode, out)
	}
	if !strings.Contains(out, "发布日期改到周五") {
		t.Fatalf("索引应含 summary: %s", out)
	}
	if strings.Contains(out, body) {
		t.Fatalf("索引层不得携带正文: %s", out)
	}
	if !strings.Contains(out, fmt.Sprintf(`"limit":%d`, 50)) {
		t.Fatalf("索引应回带生效后的 limit: %s", out)
	}

	// 正文层：按需读全文
	resp, out = do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions/"+old, "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusOK || !strings.Contains(out, body) {
		t.Fatalf("正文读失败: %d %s", resp.StatusCode, out)
	}
	if !strings.Contains(out, `"session_ref":"s1"`) || !strings.Contains(out, `"seq":9`) {
		t.Fatalf("证据坐标应原样返回: %s", out)
	}

	// 有界：limit=1 只回一行，且回带的 limit 说明被截断
	resp, out = do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions?limit=1", "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusOK || !strings.Contains(out, `"limit":1`) {
		t.Fatalf("limit 参数: %d %s", resp.StatusCode, out)
	}
	if strings.Count(out, `"summary":"发布日期改到周五"`) != 1 {
		t.Fatalf("limit=1 应只回一行: %s", out)
	}
}

func TestDecisionAPISupersedeIsExplicitAndOneShot(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "supersede")
	old := appendViaAPI(t, ts, id, "owner1", "r1",
		`{"kind":"decision","summary":"发布日期改到周五","body":"旧理由"}`)
	newer := appendViaAPI(t, ts, id, "owner1", "r1",
		fmt.Sprintf(`{"kind":"decision","summary":"发布日期改到下周三","body":"新理由","supersedes":%q}`, old))

	// 索引只剩新的（旧条目 superseded_by 非空即不 live）
	_, out := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions", "", auth("owner1", "r1"))
	if strings.Contains(out, "发布日期改到周五") || !strings.Contains(out, "发布日期改到下周三") {
		t.Fatalf("索引应只剩新条目: %s", out)
	}
	// 被取代的行仍然读得到，且反向指针在
	_, out = do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions/"+old, "", auth("owner1", "r1"))
	if !strings.Contains(out, fmt.Sprintf(`"superseded_by":%q`, newer)) {
		t.Fatalf("反向指针: %s", out)
	}

	// 二次取代同一行 → 409（append-only：不原地改，也不重复取代）
	resp, out := do(t, "POST", ts.URL+"/v1/projects/"+id+"/decisions",
		fmt.Sprintf(`{"kind":"decision","summary":"再改一次","body":"x","supersedes":%q}`, old), auth("owner1", "r1"))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("二次取代应 409: %d %s", resp.StatusCode, out)
	}
	// 取代不存在的条目 → 404
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/"+id+"/decisions",
		`{"kind":"decision","summary":"取代幻影","body":"x","supersedes":"dec_nope"}`, auth("owner1", "r1"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("取代不存在的条目应 404: %d", resp.StatusCode)
	}
}

func TestDecisionAPIRejectsContractDrift(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "reject")

	cases := []struct {
		name, body string
		want       int
	}{
		{"闭集外 kind", `{"kind":"note","summary":"s","body":"b"}`, http.StatusBadRequest},
		{"缺 kind", `{"summary":"s","body":"b"}`, http.StatusBadRequest},
		{"空 summary", `{"kind":"trap","summary":"  ","body":"b"}`, http.StatusBadRequest},
		{"空 body", `{"kind":"trap","summary":"s","body":""}`, http.StatusBadRequest},
		// supersedes 拼错会被严格解码逮住：松解码会把它当成没写，于是一次取代
		// 静默退化成又一次并存——多写者冲突里最贵的一种失误。
		{"未知字段", `{"kind":"trap","summary":"s","body":"b","supersede_id":"dec_1"}`, http.StatusBadRequest},
		{"坏证据坐标", `{"kind":"trap","summary":"s","body":"b","evidence":[{"seq":1}]}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		resp, out := do(t, "POST", ts.URL+"/v1/projects/"+id+"/decisions", c.body, auth("owner1", "r1"))
		if resp.StatusCode != c.want {
			t.Fatalf("%s 应 %d, got %d %s", c.name, c.want, resp.StatusCode, out)
		}
	}
	// 闭集外的 kind 在**查询**上同样是 400（不是「查不到就空」）
	resp, _ := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions?kind=note", "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("查询闭集外 kind 应 400: %d", resp.StatusCode)
	}
	// limit 非法值不静默回落到缺省
	resp, _ = do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions?limit=abc", "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法 limit 应 400: %d", resp.StatusCode)
	}
	// 自取代：写进去会一出生就不 live，必须拒
	resp, _ = do(t, "POST", ts.URL+"/v1/projects/"+id+"/decisions",
		`{"kind":"trap","summary":"s","body":"b","supersedes":"dec_self"}`, auth("owner1", "r1"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("取代不存在的条目（含自取代未命中）应 404: %d", resp.StatusCode)
	}
}

func TestDecisionAPIScopeAndPermissions(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "scope")
	decID := appendViaAPI(t, ts, id, "owner1", "r1",
		`{"kind":"ownership","summary":"账单服务归张工","body":"正文"}`)
	if resp, _ := do(t, "POST", ts.URL+"/v1/projects/"+id+"/members",
		`{"userId":"vw1","role":"viewer"}`, auth("owner1", "r1")); resp.StatusCode != http.StatusCreated {
		t.Fatalf("加 viewer 失败")
	}

	// 跨 realm：项目在本 realm 外不存在（404），决策读面根本到不了 SQL
	for _, path := range []string{"/decisions", "/decisions/" + decID, "/decisions/consolidation-report"} {
		resp, out := do(t, "GET", ts.URL+"/v1/projects/"+id+path, "", auth("owner1", "other-realm"))
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("跨 realm 读 %s 应 404（不是空集——存在性不可泄露到 realm 之外）: %d %s", path, resp.StatusCode, out)
		}
	}
	// 非成员同样 404
	if resp, _ := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions", "", auth("stranger", "r1")); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("非成员应 404: %d", resp.StatusCode)
	}
	// viewer：读得到，写不了（project.edit 才可追加）
	if resp, out := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions", "", auth("vw1", "r1")); resp.StatusCode != http.StatusOK || !strings.Contains(out, "账单服务归张工") {
		t.Fatalf("viewer 读索引应 200: %d %s", resp.StatusCode, out)
	}
	if resp, _ := do(t, "POST", ts.URL+"/v1/projects/"+id+"/decisions",
		`{"kind":"decision","summary":"s","body":"b"}`, auth("vw1", "r1")); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer 追加应 403: %d", resp.StatusCode)
	}
	// 缺身份头 401
	if resp, _ := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions", "", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("缺身份头应 401: %d", resp.StatusCode)
	}
}

func TestDecisionAPIConsolidationReportIsFlagOnly(t *testing.T) {
	ts := newTestServer(t)
	id := createProject(t, ts, "owner1", "r1", "consolidate")
	appendViaAPI(t, ts, id, "owner1", "r1", `{"kind":"decision","summary":"发布日期改到周五","body":"A"}`)
	appendViaAPI(t, ts, id, "owner1", "r1", `{"kind":"decision","summary":"发布日期改到下周三","body":"B"}`)

	resp, out := do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions/consolidation-report", "", auth("owner1", "r1"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("固化报告读取失败: %d %s", resp.StatusCode, out)
	}
	var report struct {
		Policy string `json:"policy"`
		Flags  []struct {
			Left, Right, Action string
		} `json:"flags"`
		Examined int `json:"examined"`
		// 频率说明（§16 R4）：定时触发默认关闭，频率由运营定——读报告的人要能从
		// 报告本身看出「跑得勤不勤不在这份报告里」。
		FrequencyNote string `json:"frequency_note"`
	}
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatalf("解析报告: %v (%s)", err, out)
	}
	if report.Policy != "flag-only" || report.Examined != 2 || len(report.Flags) == 0 {
		t.Fatalf("报告形状: %s", out)
	}
	if report.FrequencyNote != domain.DecisionFrequencyNote {
		t.Fatalf("报告缺频率说明: %s", out)
	}
	// 报告不得改动任何东西：跑完索引仍是两条 live
	_, out = do(t, "GET", ts.URL+"/v1/projects/"+id+"/decisions", "", auth("owner1", "r1"))
	if strings.Count(out, `"id":"dec_`) != 2 {
		t.Fatalf("固化任务不得取代任何条目: %s", out)
	}
}
