// Package ws 是终端网关所需的 RFC 6455 WebSocket 服务端**子集**，全部用标准库手写
// （crypto/sha1 + base64 握手、net.Conn hijack、帧编解码），不引入任何第三方 websocket
// 依赖——本仓库目前零 websocket 依赖，而 §12.2 的取向是自研（TLS/熔断/mTLS 都自己写）。
//
// 明确边界（见各函数注释，凡放宽都会变成静默半实现）：
//  1. 只支持「单帧完整可用」的帧——即一帧 payload 在硬上限内、不跨多帧拼接。我们不实现
//     分片消息（continuation / FIN=0）：收到分片帧按协议关闭，并在 close reason 写明
//     「不支持分片」，而不是静默拼回一个完整消息。
//  2. 客户端→服务端帧**必须**带掩码（RFC 6455 §5.1）；缺掩码按协议拒绝，而非宽容放行。
//  3. 支持 text / binary / ping / pong / close 五种 opcode，其余（含 continuation=0）不支持。
//  4. 帧大小有硬上限（maxFrameSize），超限立即拒绝，绝不分配未知长度缓冲。
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// maxFrameSizeDefault 是单帧 payload 的硬上限（1 MiB）。超出直接拒绝——防止一个超大
// 帧把连接缓冲撑爆（§8.2「帧大小要有硬上限」）。本实现不跨段重组超大帧，所以这是
// 内存与「拒绝」之间的安全线。
const maxFrameSizeDefault = 1 << 20

// handshakeMagic 是 RFC 6455 §1.3 规定的握手魔法串，拼在客户端 key 后面做 SHA1。
const handshakeMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// OpCode 帧类型。本实现只承认下列几种；continuation(0) 明确不支持（见 ReadFrame）。
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xa
)

// 协议层哨兵错误。读取端据此选择按协议关闭的连接 reason（见 CloseReason）。
var (
	// ErrUnmaskedFrame：客户端帧未带掩码，违反 RFC 6455 §5.1，属协议违规。
	ErrUnmaskedFrame = errors.New("客户端帧未掩码（协议要求掩码）")
	// ErrFragmented：收到分片帧（FIN=0 或 continuation），本实现明确不支持。
	ErrFragmented = errors.New("不支持分片帧（FIN=0 / continuation）")
	// ErrServerMasked：服务端帧不应带掩码（RFC 6455 §5.1 禁止服务端掩码）。
	ErrServerMasked = errors.New("服务端帧不应带掩码")
)

// Frame 一帧已解析的内容。Masked 仅对来自客户端的帧有意义（服务端发送时恒为 false）。
type Frame struct {
	Fin     bool
	OpCode  byte
	Masked  bool
	Payload []byte
}

// Conn 是握手成功后拿到的连接。帧 IO 走 bufio；Close 关闭底层 TCP。
//
// wmu 保护**写**路径：live 推送 goroutine 与 ping→pong 主循环都会写帧，必须串行，
// 否则两个 goroutine 并发 WriteFrame 会交错写出损坏的帧。读路径（bufio.Reader）与写路径
// （bufio.Writer）相互独立，读不需要这把锁。
type Conn struct {
	conn net.Conn
	rw   *bufio.ReadWriter
	max  int
	wmu  sync.Mutex
}

// ComputeAccept 计算 RFC 6455 §1.3 的 Sec-WebSocket-Accept：SHA1(key+magic) 后 base64。
// 抽出为纯函数便于单测（RFC 示例向量见 ws_test.go）。
func ComputeAccept(key string) string {
	h := sha1.Sum([]byte(key + handshakeMagic))
	return base64.StdEncoding.EncodeToString(h[:])
}

// ValidateUpgrade 在劫持连接**之前**检查握手请求是否合法。任何一项不合法都必须在此返回
// 错误，由调用方转成 HTTP 错误——一旦劫持，就无法再回 HTTP 错误了。
func ValidateUpgrade(r *http.Request) error {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return errors.New("缺少或错误的 Upgrade: websocket 头")
	}
	// Connection 头是大小写不敏感的逗号分隔列表，必须含 "upgrade"。
	conn := strings.ToLower(r.Header.Get("Connection"))
	hasUpgrade := false
	for _, part := range strings.Split(conn, ",") {
		if strings.TrimSpace(part) == "upgrade" {
			hasUpgrade = true
			break
		}
	}
	if !hasUpgrade {
		return errors.New("Connection 头必须包含 upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Key") == "" {
		return errors.New("缺少 Sec-WebSocket-Key")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return errors.New("仅支持 WebSocket 协议版本 13")
	}
	return nil
}

// Hijack 完成 RFC 6455 握手：假定调用方已用 ValidateUpgrade 校验通过，这里只劫持连接并
// 写出 101 响应。返回错误仅发生在劫持本身失败（极少见），此时连接已被 Close。
//
// 必须用 Hijack 返回的同一个 brw 写出 101：http.Server 可能已把客户端第一帧的字节缓冲在
// brw.Reader 里，用底层 conn 直接写会弄丢它们。写完后 Flush 确保对端收到。
func Hijack(w http.ResponseWriter, r *http.Request, maxFrameSize int) (*Conn, error) {
	if maxFrameSize <= 0 {
		maxFrameSize = maxFrameSizeDefault
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("底层 ResponseWriter 不支持劫持（非 TCP 服务器）")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("劫持连接失败: %w", err)
	}
	accept := ComputeAccept(r.Header.Get("Sec-WebSocket-Key"))
	brw.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	brw.WriteString("Upgrade: websocket\r\n")
	brw.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(brw, "Sec-WebSocket-Accept: %s\r\n", accept)
	brw.WriteString("\r\n")
	if err := brw.Flush(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("写出 101 响应失败: %w", err)
	}
	return &Conn{conn: conn, rw: brw, max: maxFrameSize}, nil
}

// ReadFrame 读一帧。expectMasked=true 表示对端是客户端、必须带掩码（服务端读客户端帧）；
// false 表示对端是服务端、不得带掩码（客户端读服务端帧）。本实现**不跨 TCP 段重组半帧**：
// 依赖 bufio.Reader 透明地把分散到达的字节拼成完整帧；一旦帧头表明 payload 超过 max，
// 立即拒绝（不分配、不读取未知长度的流）。
func (c *Conn) ReadFrame() (Frame, error) {
	return readFrame(c.rw.Reader, c.max, true)
}

// ReadFrameFrom 供测试/客户端侧使用：从任意 bufio.Reader 读一帧。expectMasked 含义同上。
func ReadFrameFrom(br *bufio.Reader, max int, expectMasked bool) (Frame, error) {
	return readFrame(br, max, expectMasked)
}

func readFrame(br *bufio.Reader, max int, expectMasked bool) (Frame, error) {
	b0, err := br.ReadByte()
	if err != nil {
		return Frame{}, err
	}
	b1, err := br.ReadByte()
	if err != nil {
		return Frame{}, err
	}
	fin := b0&0x80 != 0
	opcode := b0 & 0x0f
	masked := b1&0x80 != 0
	length := int(b1 & 0x7f)
	if length == 126 {
		ext, err := readUint16(br)
		if err != nil {
			return Frame{}, err
		}
		length = int(ext)
	} else if length == 127 {
		ext, err := readUint64(br)
		if err != nil {
			return Frame{}, err
		}
		if ext > uint64(max) { // 顺手挡掉 64 位长度里藏着的超大值
			return Frame{}, fmt.Errorf("帧长度 %d 超过上限 %d", ext, max)
		}
		length = int(ext)
	}
	if length > max {
		return Frame{}, fmt.Errorf("帧大小 %d 超过上限 %d", length, max)
	}

	// 协议层裁决（在读 payload 之前，避免无谓分配）：
	// 1) 期望掩码却没掩码（客户端违规）→ 拒绝。
	if expectMasked && !masked {
		return Frame{}, ErrUnmaskedFrame
	}
	// 2) 不该掩码却掩码了（服务端违规）→ 拒绝。
	if !expectMasked && masked {
		return Frame{}, ErrServerMasked
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(br, maskKey[:]); err != nil {
			return Frame{}, err
		}
	}
	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(br, payload); err != nil {
			return Frame{}, err
		}
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}

	f := Frame{Fin: fin, OpCode: opcode, Masked: masked, Payload: payload}
	// 3) 分片帧（FIN=0）与 continuation 一律不支持。
	if opcode == OpContinuation || !fin {
		return Frame{}, ErrFragmented
	}
	// 4) 控制帧（close/ping/pong）payload 不得超过 125 字节（RFC 6455 §5.5）。
	if isControl(opcode) && length > 125 {
		return Frame{}, errors.New("控制帧 payload 超过 125 字节")
	}
	return f, nil
}

// WriteFrame 写一个服务端帧（恒 FIN=1、**不**掩码，符合 RFC 6455 §5.1）。
// 受 wmu 保护：live 推送与 ping 响应可能并发，必须串行写。
func (c *Conn) WriteFrame(f Frame) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return writeFrame(c.rw.Writer, f, c.max)
}

// WriteClientFrame 写一个客户端帧（带随机掩码）。仅用于客户端侧；测试中用它模拟对端，
// 因为本包的服务端读路径强制要求掩码。
func WriteClientFrame(bw *bufio.Writer, f Frame) error {
	if len(f.Payload) > maxFrameSizeDefault {
		return fmt.Errorf("待发送帧 %d 超过上限", len(f.Payload))
	}
	b0 := byte(0)
	if f.Fin {
		b0 |= 0x80
	}
	b0 |= f.OpCode & 0x0f
	var b1 byte
	length := len(f.Payload)
	switch {
	case length < 126:
		b1 = byte(length)
	case length < 1<<16:
		b1 = 126
	default:
		b1 = 127
	}
	b1 |= 0x80 // 客户端帧必须掩码
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	if err := bw.WriteByte(b0); err != nil {
		return err
	}
	if err := bw.WriteByte(b1); err != nil {
		return err
	}
	switch {
	case length >= 1<<16:
		if err := writeUint64(bw, uint64(length)); err != nil {
			return err
		}
	case length >= 126:
		if err := writeUint16(bw, uint16(length)); err != nil {
			return err
		}
	}
	if _, err := bw.Write(mask[:]); err != nil {
		return err
	}
	masked := make([]byte, length)
	for i, c := range f.Payload {
		masked[i] = c ^ mask[i%4]
	}
	if _, err := bw.Write(masked); err != nil {
		return err
	}
	return bw.Flush()
}

func writeFrame(bw *bufio.Writer, f Frame, max int) error {
	if len(f.Payload) > max {
		return fmt.Errorf("待发送帧 %d 超过上限 %d", len(f.Payload), max)
	}
	b0 := byte(0x80) // 服务端发送总是 FIN=1
	b0 |= f.OpCode & 0x0f
	var b1 byte
	length := len(f.Payload)
	switch {
	case length < 126:
		b1 = byte(length)
	case length < 1<<16:
		b1 = 126
	default:
		b1 = 127
	}
	if err := bw.WriteByte(b0); err != nil {
		return err
	}
	if err := bw.WriteByte(b1); err != nil {
		return err
	}
	switch {
	case length >= 1<<16:
		if err := writeUint64(bw, uint64(length)); err != nil {
			return err
		}
	case length >= 126:
		if err := writeUint16(bw, uint16(length)); err != nil {
			return err
		}
	}
	if _, err := bw.Write(f.Payload); err != nil {
		return err
	}
	return bw.Flush()
}

// CloseWith 发送一个 close 帧（code 1002 = protocol error，RFC 6455 §7.4.1）并关闭连接。
// reason 必须是 UTF-8 且 ≤ 123 字节；用于把「为什么被拒」清楚地告诉对端。
func (c *Conn) CloseWith(reason string) error {
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload[:2], 1002)
	copy(payload[2:], reason)
	c.wmu.Lock()
	_ = writeFrame(c.rw.Writer, Frame{OpCode: OpClose, Payload: payload}, c.max)
	c.wmu.Unlock()
	return c.conn.Close()
}

// Close 直接关闭底层连接（用于非协议错误的清理路径）。
func (c *Conn) Close() error {
	return c.conn.Close()
}

// CloseReason 把读取错误翻译成 close 帧的 reason，让对端知道被拒的具体原因。
// 通用错误也尽量可读，而不是只发一个空 close。
func CloseReason(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, ErrUnmaskedFrame):
		return "客户端帧未掩码，按协议关闭"
	case errors.Is(err, ErrFragmented):
		return "不支持分片帧（FIN=0 / continuation）"
	case errors.Is(err, ErrServerMasked):
		return "服务端帧不应带掩码"
	default:
		return "协议错误: " + err.Error()
	}
}

func isControl(op byte) bool { return op == OpClose || op == OpPing || op == OpPong }

func readUint16(br *bufio.Reader) (uint16, error) {
	var b [2]byte
	if _, err := io.ReadFull(br, b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(b[:]), nil
}

func readUint64(br *bufio.Reader) (uint64, error) {
	var b [8]byte
	if _, err := io.ReadFull(br, b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint64(b[:]), nil
}

func writeUint16(bw *bufio.Writer, v uint16) error {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], v)
	_, err := bw.Write(b[:])
	return err
}

func writeUint64(bw *bufio.Writer, v uint64) error {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	_, err := bw.Write(b[:])
	return err
}
