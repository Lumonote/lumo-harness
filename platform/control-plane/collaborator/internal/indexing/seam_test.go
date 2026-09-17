package indexing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef" // 恰好 32 字节，host 的下限

func testEntry(realm string) Ingest {
	return Ingest{
		Doc: Doc{
			DocID: "doc-1", Realm: realm, Space: "s1", Title: "标题",
			SourceVersion: 7, EmbeddingModel: "tei-bge-m3",
		},
		Chunks: ChunkContent("第一段。\n\n第二段。", DefaultChunkOptions()),
	}
}

func newTestIndexer(t *testing.T, baseURL string) *SeamIndexer {
	t.Helper()
	indexer, err := NewSeamIndexer(SeamConfig{
		BaseURL: baseURL, ControlToken: "control-token", IdentitySecret: testSecret,
		UserID: "collaborator-indexer", Roles: []string{"system"}, Component: "collaborator",
		Client: &http.Client{Timeout: 5 * time.Second},
	})
	if err != nil {
		t.Fatalf("构造 seam 适配器失败: %v", err)
	}
	return indexer
}

// TestSeamIndexerSendsHostCompatibleRequest 用独立实现的校验逻辑复刻 seam host 的
// 入口检查（server.ts + dispatch.ts）。刻意不调用被测代码来验签，否则是自证。
func TestSeamIndexerSendsHostCompatibleRequest(t *testing.T) {
	var (
		gotBody    map[string]any
		gotRealm   string
		gotToken   string
		gotAssert  map[string]any
		gotCompone string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/seam/knowledge/ingest" {
			t.Errorf("路径应为 /seam/knowledge/ingest，实得 %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("方法应为 POST，实得 %s", r.Method)
		}
		gotRealm = r.Header.Get("X-Lumo-Realm")
		gotToken = r.Header.Get("X-Lumo-Seam-Token")
		gotCompone = r.Header.Get("X-Lumo-Component")

		// 1) 断言签名必须能被独立验过（host 侧 verifyIdentityAssertion 的等价实现）。
		encoded := r.Header.Get("X-Lumo-Identity")
		signature := r.Header.Get("X-Lumo-Identity-Signature")
		if encoded == "" || signature == "" {
			t.Errorf("必须同时带 X-Lumo-Identity 与 X-Lumo-Identity-Signature")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mac := hmac.New(sha256.New, []byte(testSecret))
		mac.Write([]byte(encoded))
		if want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil)); want != signature {
			t.Errorf("断言签名不匹配")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		raw, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			t.Errorf("断言不是合法 base64url: %v", err)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if err := json.Unmarshal(raw, &gotAssert); err != nil {
			t.Errorf("断言不是合法 JSON: %v", err)
		}

		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &gotBody); err != nil {
			t.Errorf("请求体不是合法 JSON: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	if err := newTestIndexer(t, server.URL).Ingest(context.Background(), testEntry("r1")); err != nil {
		t.Fatalf("投影应成功: %v", err)
	}

	// 2) 信封形状：seam/method 进 body，参数是位置参数数组（arity 严格校验）。
	if gotBody["seam"] != "knowledge" || gotBody["method"] != "ingest" {
		t.Fatalf("信封 seam/method 不对: %#v", gotBody)
	}
	args, ok := gotBody["args"].([]any)
	if !ok || len(args) != 1 {
		t.Fatalf("args 必须是长度 1 的位置参数数组: %#v", gotBody["args"])
	}
	entry := args[0].(map[string]any)
	doc := entry["doc"].(map[string]any)

	// 3) 逐个字段对齐 KnowledgeDoc，且都是 host 要求的非空字符串。
	for _, field := range []string{"docId", "realm", "space", "title", "embeddingModel"} {
		value, ok := doc[field].(string)
		if !ok || value == "" {
			t.Fatalf("doc.%s 必须是非空字符串（host 的 asString 会直接 400），实得 %#v", field, doc[field])
		}
	}
	if doc["sourceVersion"] != float64(7) {
		t.Fatalf("doc.sourceVersion 应为数字 7，实得 %#v", doc["sourceVersion"])
	}
	chunks, ok := entry["chunks"].([]any)
	if !ok || len(chunks) == 0 {
		t.Fatalf("chunks 必须是非空数组: %#v", entry["chunks"])
	}
	for i, c := range chunks {
		chunk := c.(map[string]any)
		if text, ok := chunk["text"].(string); !ok || text == "" {
			t.Fatalf("chunks[%d].text 必须是非空字符串", i)
		}
		if _, ok := chunk["metadata"].(map[string]any); !ok {
			t.Fatalf("chunks[%d].metadata 必须是对象", i)
		}
	}

	// 4) 身份断言绑定 realm，且是短时的（host 拒绝过期或超 300s 的断言）。
	if gotAssert["aud"] != "lumo-seam-host" {
		t.Fatalf("断言受众必须逐字等于 lumo-seam-host，实得 %#v", gotAssert["aud"])
	}
	if gotAssert["realm"] != "r1" {
		t.Fatalf("断言 realm 必须是被投影文档的 realm，实得 %#v", gotAssert["realm"])
	}
	if gotAssert["userId"] != "collaborator-indexer" {
		t.Fatalf("断言 userId 不对: %#v", gotAssert["userId"])
	}
	exp, ok := gotAssert["exp"].(float64)
	if !ok {
		t.Fatalf("断言缺少 exp: %#v", gotAssert)
	}
	now := time.Now().Unix()
	if int64(exp) <= now || int64(exp) > now+300 {
		t.Fatalf("断言有效期必须落在 (now, now+300]，实得 exp-now=%d", int64(exp)-now)
	}

	// 5) host 的越权闸门逐字比对载荷 realm 与身份 realm；两者必须一致。
	if gotRealm != "r1" || doc["realm"] != "r1" {
		t.Fatalf("X-Lumo-Realm(%q) 与载荷 realm(%v) 必须一致", gotRealm, doc["realm"])
	}
	if gotToken != "control-token" {
		t.Fatalf("X-Lumo-Seam-Token 不对: %q", gotToken)
	}
	if gotCompone != "collaborator" {
		t.Fatalf("X-Lumo-Component 不对: %q", gotCompone)
	}
}

func TestSeamIndexerSignsPerRealmIdentity(t *testing.T) {
	// 绝不能复用一个「服务身份」写所有租户：host 会按断言 realm 判定越权。
	var realms []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Lumo-Identity"))
		var assert map[string]any
		_ = json.Unmarshal(raw, &assert)
		realms = append(realms, assert["realm"].(string))
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	indexer := newTestIndexer(t, server.URL)
	for _, realm := range []string{"realm-a", "realm-b"} {
		if err := indexer.Ingest(context.Background(), testEntry(realm)); err != nil {
			t.Fatalf("投影 realm=%s 失败: %v", realm, err)
		}
	}
	if len(realms) != 2 || realms[0] != "realm-a" || realms[1] != "realm-b" {
		t.Fatalf("每次投影必须各自签发绑定该 realm 的断言，实得 %#v", realms)
	}
}

func TestSeamIndexerRejectsUnsignableRealmAsTerminal(t *testing.T) {
	// realm 含 host 不接受的字符时断言签不出来。这是该行载荷的属性，不是节点故障，
	// 所以必须是终态（重试同一行永远失败），否则会白烧 attempts 轮。
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("断言签发失败时不应发起网络调用")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	err := newTestIndexer(t, server.URL).Ingest(context.Background(), testEntry("bad realm"))
	if !IsRejected(err) {
		t.Fatalf("应判为终态拒绝，实得 %v", err)
	}
}

func TestSeamIndexerRejectsOversizedBodyAsTerminal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("超限载荷不应发起网络调用")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	indexer, err := NewSeamIndexer(SeamConfig{
		BaseURL: server.URL, IdentitySecret: testSecret, UserID: "u", Roles: []string{"system"},
		MaxBodyBytes: 16,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if err := indexer.Ingest(context.Background(), testEntry("r1")); !IsRejected(err) {
		t.Fatalf("超过上限的载荷是确定性的终态失败，实得 %v", err)
	}
}

func TestSeamIndexerClassifiesFailures(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		terminal bool
	}{
		{"400 参数非法", http.StatusBadRequest, `{"ok":false,"code":"invalid","message":"ingest.entry.doc.title 必须是非空字符串"}`, true},
		{"invalid 码配非 400 状态", http.StatusInternalServerError, `{"ok":false,"code":"invalid","message":"x"}`, true},
		{"403 越权可重试", http.StatusForbidden, `{"ok":false,"code":"forbidden","message":"realm 不符"}`, false},
		{"500 内部错误可重试", http.StatusInternalServerError, `{"ok":false,"code":"internal","message":"boom"}`, false},
		{"501 能力缺失可重试", http.StatusNotImplemented, `{"ok":false,"code":"capability_unavailable","message":"未挂载 Provider"}`, false},
		{"503 不可用可重试", http.StatusServiceUnavailable, `{"ok":false,"code":"unavailable","message":"稍后再试"}`, false},
		{"504 超时可重试", http.StatusGatewayTimeout, `{"ok":false,"code":"timeout","message":"超时"}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer server.Close()

			err := newTestIndexer(t, server.URL).Ingest(context.Background(), testEntry("r1"))
			if err == nil {
				t.Fatal("非 200 必须返回错误")
			}
			if got := IsRejected(err); got != c.terminal {
				t.Fatalf("终态判定错误：期望 terminal=%t，实得 %t（%v）", c.terminal, got, err)
			}
			if !strings.Contains(err.Error(), fmt.Sprint(c.status)) {
				t.Fatalf("错误必须带状态码以便排查：%v", err)
			}
		})
	}
}

func TestSeamIndexerTreatsNetworkFailureAsRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close() // 关掉后连接必然失败

	err := newTestIndexer(t, url).Ingest(context.Background(), testEntry("r1"))
	if err == nil {
		t.Fatal("网络失败必须返回错误")
	}
	if IsRejected(err) {
		t.Fatalf("网络失败是可重试的（节点可能刚恢复），不该判成终态：%v", err)
	}
}

func TestNewSeamIndexerRejectsInvalidConfig(t *testing.T) {
	base := SeamConfig{BaseURL: "http://127.0.0.1:8790", IdentitySecret: testSecret, UserID: "u", Roles: []string{"system"}}
	cases := []struct {
		name   string
		mutate func(*SeamConfig)
		reason string
	}{
		{"缺地址", func(c *SeamConfig) { c.BaseURL = "" }, "无法确定投影目标"},
		{"地址无协议", func(c *SeamConfig) { c.BaseURL = "127.0.0.1:8790" }, "非法地址必须启动即失败"},
		{"地址协议不支持", func(c *SeamConfig) { c.BaseURL = "ftp://host/x" }, "只有 http/https 有意义"},
		{"缺身份主体", func(c *SeamConfig) { c.UserID = "" }, "断言必须带 userId"},
		{"缺角色", func(c *SeamConfig) { c.Roles = nil }, "断言要求至少一个角色"},
		{"密钥过短", func(c *SeamConfig) { c.IdentitySecret = "too-short" }, "过短的密钥必须启动即失败而不是每行 403"},
		{"密钥缺失", func(c *SeamConfig) { c.IdentitySecret = "" }, "缺失的密钥不得有默认值"},
	}
	for _, c := range cases {
		cfg := base
		c.mutate(&cfg)
		if _, err := NewSeamIndexer(cfg); err == nil {
			t.Fatalf("%s 必须报错（%s）", c.name, c.reason)
		}
	}
}

func TestNewSeamIndexerDefaultsAreUsable(t *testing.T) {
	indexer, err := NewSeamIndexer(SeamConfig{
		BaseURL: "http://127.0.0.1:8790/", IdentitySecret: testSecret, UserID: "u", Roles: []string{"system"},
	})
	if err != nil {
		t.Fatalf("最小合法配置必须可用: %v", err)
	}
	if strings.HasSuffix(indexer.baseURL, "/") {
		t.Fatalf("baseURL 尾部斜杠必须去掉，否则拼出 //seam/... : %q", indexer.baseURL)
	}
	if indexer.maxBody != defaultMaxBodyBytes {
		t.Fatalf("请求体上限应回落到默认值，实得 %d", indexer.maxBody)
	}
	if indexer.component != "collaborator" {
		t.Fatalf("组件名应回落为 collaborator，实得 %q", indexer.component)
	}
}

func TestClassifySeamFailureTruncatesDetail(t *testing.T) {
	// 超长 message 不能整段进 last_error（列会被写爆，日志也读不了）。
	err := classifySeamFailure(http.StatusInternalServerError, []byte(`{"ok":false,"code":"internal","message":"`+strings.Repeat("x", 5000)+`"}`))
	if err == nil {
		t.Fatal("应返回错误")
	}
	if len(err.Error()) > 400 {
		t.Fatalf("错误信息应被截断，实得 %d 字符", len(err.Error()))
	}
	if errors.Is(err, ErrRejected) {
		t.Fatal("500 不是终态")
	}
}
