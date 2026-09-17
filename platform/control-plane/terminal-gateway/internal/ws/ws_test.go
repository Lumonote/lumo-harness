package ws

import (
	"bufio"
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// RFC 6455 §1.3 给出的官方示例向量：key 固定，accept 固定。
func TestComputeAccept_RFCSample(t *testing.T) {
	const key = "dGhlIHNhbXBsZSBub25jZQ=="
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got := ComputeAccept(key); got != want {
		t.Fatalf("ComputeAccept = %q, want %q", got, want)
	}
}

func TestValidateUpgrade(t *testing.T) {
	cases := []struct {
		name   string
		header map[string]string
		wantOK bool
	}{
		{"正常", map[string]string{
			"Upgrade": "websocket", "Connection": "Upgrade",
			"Sec-WebSocket-Key": "x3", "Sec-WebSocket-Version": "13",
		}, true},
		// 反例：缺 Upgrade 头 → 拒绝（不在劫持之后才报错，而是直接 HTTP 400）。
		{"缺 Upgrade", map[string]string{
			"Connection": "Upgrade", "Sec-WebSocket-Key": "x3", "Sec-WebSocket-Version": "13",
		}, false},
		// 反例：Connection 不含 upgrade（大小写不敏感应放行，这里全错）。
		{"Connection 不含 upgrade", map[string]string{
			"Upgrade": "websocket", "Sec-WebSocket-Key": "x3", "Sec-WebSocket-Version": "13",
		}, false},
		// 反例：缺 Sec-WebSocket-Key → 拒绝。
		{"缺 Key", map[string]string{
			"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13",
		}, false},
		// 反例：版本不是 13 → 拒绝。
		{"版本错误", map[string]string{
			"Upgrade": "websocket", "Connection": "Upgrade",
			"Sec-WebSocket-Key": "x3", "Sec-WebSocket-Version": "8",
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/x", nil)
			for k, v := range c.header {
				r.Header.Set(k, v)
			}
			err := ValidateUpgrade(r)
			if c.wantOK && err != nil {
				t.Fatalf("期望通过，却失败: %v", err)
			}
			if !c.wantOK && err == nil {
				t.Fatalf("期望失败，却通过")
			}
		})
	}
}

// 服务端→客户端（不掩码）与 客户端→服务端（必须掩码）两个方向的帧往返。
// 用内存 buffer 而非 net.Pipe：net.Pipe 是完全同步的，单 goroutine 先写后读会死锁；
// 而帧编解码本身与方向无关（仅掩码位不同），用 buffer 即可验证往返正确性。
func TestFrameRoundTrip(t *testing.T) {
	// 服务端→客户端：writeFrame 写不掩码帧，ReadFrameFrom(...,false) 解出。
	var srvBuf bytes.Buffer
	srvBW := bufio.NewWriter(&srvBuf)
	if err := writeFrame(srvBW, Frame{OpCode: OpText, Payload: []byte("hello")}, 1<<20); err != nil {
		t.Fatalf("服务端写帧失败: %v", err)
	}
	got, err := ReadFrameFrom(bufio.NewReader(&srvBuf), 1<<20, false)
	if err != nil {
		t.Fatalf("读服务端帧失败: %v", err)
	}
	if got.OpCode != OpText || string(got.Payload) != "hello" {
		t.Fatalf("服务端→客户端往返内容不符: %+v", got)
	}

	// 客户端→服务端：WriteClientFrame 写带掩码帧，ReadFrameFrom(...,true) 解出。
	var cliBuf bytes.Buffer
	cliBW := bufio.NewWriter(&cliBuf)
	if err := WriteClientFrame(cliBW, Frame{Fin: true, OpCode: OpText, Payload: []byte("world")}); err != nil {
		t.Fatalf("客户端写帧失败: %v", err)
	}
	got2, err := ReadFrameFrom(bufio.NewReader(&cliBuf), 1<<20, true)
	if err != nil {
		t.Fatalf("读客户端帧失败: %v", err)
	}
	if string(got2.Payload) != "world" {
		t.Fatalf("客户端→服务端掩码往返内容不符: %q", got2.Payload)
	}
}

// 反例：客户端发来未掩码帧 → 必须按协议拒绝，而非宽容接收。
func TestReadRejectsUnmasked(t *testing.T) {
	// 0x81=text,FIN=1；0x05=长度5且未设掩码位；后跟 5 字节 payload。
	raw := []byte{0x81, 0x05, 'h', 'e', 'l', 'l', 'o'}
	br := bufio.NewReader(bytes.NewReader(raw))
	_, err := ReadFrameFrom(br, 1<<20, true)
	if !errors.Is(err, ErrUnmaskedFrame) {
		t.Fatalf("期望 ErrUnmaskedFrame，得到 %v", err)
	}
}

// 反例：超大帧（超过硬上限）→ 必须拒绝，且不读取/分配未知长度缓冲。
func TestReadRejectsOversize(t *testing.T) {
	const max = 8
	// 0x81 text/FIN；0xfe = 掩码位(0x80) + 126 长度指示；扩展长度 0x0010 = 16 > max。
	// 紧跟 4 字节掩码 + 16 字节 payload（长度判断发生在读掩码之前，所以 payload 是否完整不重要）。
	raw := []byte{0x81, 0xfe, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	br := bufio.NewReader(bytes.NewReader(raw))
	_, err := ReadFrameFrom(br, max, true)
	if err == nil || !strings.Contains(err.Error(), "超过上限") {
		t.Fatalf("期望「超过上限」错误，得到 %v", err)
	}
}

// 反例：分片帧（FIN=0）→ 必须按协议关闭，明确拒绝而非静默拼接。
func TestReadRejectsFragmented(t *testing.T) {
	// 0x01 = text, FIN=0（分片）；0x83 = 掩码位 + 长度3；4 字节掩码 + 3 字节 payload。
	raw := []byte{0x01, 0x83, 0x00, 0x00, 0x00, 0x00, 'a', 'b', 'c'}
	br := bufio.NewReader(bytes.NewReader(raw))
	_, err := ReadFrameFrom(br, 1<<20, true)
	if !errors.Is(err, ErrFragmented) {
		t.Fatalf("期望 ErrFragmented，得到 %v", err)
	}
}

// 反例：服务端帧若带掩码（违反 RFC 6455 §5.1）→ 拒绝。
func TestReadRejectsServerMasked(t *testing.T) {
	// 0x82 binary/FIN；0x83 = 掩码位 + 长度3；掩码 + payload。
	raw := []byte{0x82, 0x83, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03}
	br := bufio.NewReader(bytes.NewReader(raw))
	_, err := ReadFrameFrom(br, 1<<20, false)
	if !errors.Is(err, ErrServerMasked) {
		t.Fatalf("期望 ErrServerMasked，得到 %v", err)
	}
}

func TestCloseReason(t *testing.T) {
	if got := CloseReason(ErrUnmaskedFrame); !strings.Contains(got, "未掩码") {
		t.Fatalf("CloseReason 未说明未掩码: %q", got)
	}
	if got := CloseReason(ErrFragmented); !strings.Contains(got, "分片") {
		t.Fatalf("CloseReason 未说明分片: %q", got)
	}
	if CloseReason(nil) != "" {
		t.Fatalf("nil 应返回空 reason")
	}
}
