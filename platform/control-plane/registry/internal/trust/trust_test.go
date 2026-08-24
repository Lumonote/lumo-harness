package trust_test

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/trust"
)

func keypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	return pub, priv
}

func TestVerifyGoodSignature(t *testing.T) {
	pub, priv := keypair(t)
	st := trust.NewStore([]trust.Publisher{{ID: "acme", PublicKey: pub, MaxScopes: []string{"kb:query"}}})
	raw := []byte(`{"kind":"Skill"}`)
	if err := st.Verify("acme", raw, ed25519.Sign(priv, raw)); err != nil {
		t.Fatalf("合法签名应通过: %v", err)
	}
}

// TestVerifyRejectsTamperedBytes 字节被改一位就必须失败——
// 这是「执法只认被签名覆盖的字节」的地基。
func TestVerifyRejectsTamperedBytes(t *testing.T) {
	pub, priv := keypair(t)
	st := trust.NewStore([]trust.Publisher{{ID: "acme", PublicKey: pub}})
	raw := []byte(`{"scopes":["kb:query"]}`)
	sig := ed25519.Sign(priv, raw)
	tampered := []byte(`{"scopes":["kb:write"]}`)
	if err := st.Verify("acme", tampered, sig); !errors.Is(err, trust.ErrBadSignature) {
		t.Fatalf("篡改后应报 ErrBadSignature，实得: %v", err)
	}
}

func TestVerifyRejectsWrongPublisher(t *testing.T) {
	pubA, privA := keypair(t)
	pubB, _ := keypair(t)
	st := trust.NewStore([]trust.Publisher{
		{ID: "acme", PublicKey: pubA}, {ID: "evil", PublicKey: pubB},
	})
	raw := []byte("payload")
	// 用 acme 的私钥签，却声称是 evil 发的
	if err := st.Verify("evil", raw, ed25519.Sign(privA, raw)); !errors.Is(err, trust.ErrBadSignature) {
		t.Fatalf("张冠李戴应被拒，实得: %v", err)
	}
}

func TestVerifyUnknownPublisher(t *testing.T) {
	st := trust.NewStore(nil)
	if err := st.Verify("ghost", []byte("x"), make([]byte, ed25519.SignatureSize)); !errors.Is(err, trust.ErrUnknownPublisher) {
		t.Fatalf("未知发布者应被拒，实得: %v", err)
	}
}

func TestScopesWithin(t *testing.T) {
	cases := []struct {
		name      string
		granted   []string
		max       []string
		wantOK    bool
		offending string
	}{
		{"完全相同", []string{"kb:query"}, []string{"kb:query"}, true, ""},
		{"真子集", []string{"kb:query"}, []string{"kb:query", "kb:write"}, true, ""},
		{"通配覆盖", []string{"data:read:warehouse"}, []string{"data:read:*"}, true, ""},
		{"通配不跨段", []string{"data:write:warehouse"}, []string{"data:read:*"}, false, "data:write:warehouse"},
		{"越权", []string{"kb:query", "data:write:all"}, []string{"kb:query"}, false, "data:write:all"},
		{"上限为空则一切越权", []string{"kb:query"}, nil, false, "kb:query"},
		{"申请为空", nil, []string{"kb:query"}, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			off, ok := trust.ScopesWithin(tc.granted, tc.max)
			if ok != tc.wantOK || off != tc.offending {
				t.Fatalf("得 (%q, %v)，期望 (%q, %v)", off, ok, tc.offending, tc.wantOK)
			}
		})
	}
}

// TestLoadFile 信任表从配置文件加载，不从数据库读——
// 数据库是索引，信任根不能放在索引里。
func TestLoadFile(t *testing.T) {
	pub, _ := keypair(t)
	path := filepath.Join(t.TempDir(), "trust.json")
	body, _ := json.Marshal(map[string]any{
		"publishers": []map[string]any{{
			"id":         "acme",
			"public_key": base64.StdEncoding.EncodeToString(pub),
			"max_scopes": []string{"kb:query"},
		}},
	})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	st, err := trust.LoadFile(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	p, ok := st.Lookup("acme")
	if !ok || string(p.PublicKey) != string(pub) || len(p.MaxScopes) != 1 {
		t.Fatalf("加载结果不对: %+v ok=%v", p, ok)
	}
}

func TestLoadFileRejectsBadKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trust.json")
	if err := os.WriteFile(path, []byte(`{"publishers":[{"id":"a","public_key":"c2hvcnQ="}]}`), 0o600); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if _, err := trust.LoadFile(path); err == nil {
		t.Fatal("长度不对的公钥应被拒")
	}
}
