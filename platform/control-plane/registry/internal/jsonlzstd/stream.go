// Package jsonlzstd provides a bounded, strict JSON Lines + zstd stream.
//
// The stream is deliberately more constrained than "a file containing JSON":
// every decompressed record is one UTF-8 JSON object terminated by LF, duplicate
// object keys are rejected at every depth, and both zstd and decoded limits are
// enforced before callers interpret a record.  Higher-level formats (Bundle,
// install snapshots, audit exports) own their record types and ordering.
package jsonlzstd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
)

const (
	FileExtension       = ".jsonl.zst"
	ContentType         = "application/zstd"
	OriginalContentType = "application/x-ndjson"
)

var ErrInvalid = errors.New("registry: 非法 JSONL+zstd 流")

// Limits bounds attacker-controlled compressed inputs.  Values are intentionally
// independent: a small compressed file may expand greatly, and a valid zstd
// frame may otherwise ask the decoder for an excessive history window.
type Limits struct {
	MaxCompressedBytes int
	MaxDecodedBytes    int
	MaxLineBytes       int
	MaxRecords         int
	MaxWindowBytes     int
}

var DefaultLimits = Limits{
	MaxCompressedBytes: 32 << 20,
	MaxDecodedBytes:    128 << 20,
	MaxLineBytes:       24 << 20,
	MaxRecords:         10_000,
	MaxWindowBytes:     8 << 20,
}

func normalized(l Limits) Limits {
	d := DefaultLimits
	if l.MaxCompressedBytes > 0 {
		d.MaxCompressedBytes = l.MaxCompressedBytes
	}
	if l.MaxDecodedBytes > 0 {
		d.MaxDecodedBytes = l.MaxDecodedBytes
	}
	if l.MaxLineBytes > 0 {
		d.MaxLineBytes = l.MaxLineBytes
	}
	if l.MaxRecords > 0 {
		d.MaxRecords = l.MaxRecords
	}
	if l.MaxWindowBytes > 0 {
		d.MaxWindowBytes = l.MaxWindowBytes
	}
	return d
}

// Encode writes validated records as LF-delimited JSON, then zstd-compresses
// them.  The output must be signed/digested as returned; consumers must never
// decompress and recompress before verifying it.
func Encode(records []json.RawMessage, limits Limits) ([]byte, error) {
	l := normalized(limits)
	if len(records) == 0 || len(records) > l.MaxRecords {
		return nil, invalid("记录数必须在 1..%d", l.MaxRecords)
	}

	var plain bytes.Buffer
	for _, record := range records {
		if err := validateRecord(record, l); err != nil {
			return nil, err
		}
		if plain.Len() > l.MaxDecodedBytes-len(record)-1 {
			return nil, invalid("解压后内容超过 %d 字节", l.MaxDecodedBytes)
		}
		_, _ = plain.Write(record)
		_ = plain.WriteByte('\n')
	}

	var compressed bytes.Buffer
	enc, err := zstd.NewWriter(&compressed,
		zstd.WithEncoderConcurrency(1),
		zstd.WithEncoderCRC(true),
		zstd.WithWindowSize(l.MaxWindowBytes),
	)
	if err != nil {
		return nil, fmt.Errorf("registry: 创建 zstd 编码器失败: %w", err)
	}
	if _, err := enc.Write(plain.Bytes()); err != nil {
		_ = enc.Close()
		return nil, fmt.Errorf("registry: 写入 zstd 流失败: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("registry: 关闭 zstd 流失败: %w", err)
	}
	if compressed.Len() > l.MaxCompressedBytes {
		return nil, invalid("压缩内容超过 %d 字节", l.MaxCompressedBytes)
	}
	return compressed.Bytes(), nil
}

// Decode verifies the compression and JSONL envelope before returning raw JSON
// objects.  Record semantics are intentionally left to the caller.
func Decode(raw []byte, limits Limits) ([]json.RawMessage, error) {
	l := normalized(limits)
	if len(raw) == 0 || len(raw) > l.MaxCompressedBytes {
		return nil, invalid("压缩内容必须在 1..%d 字节", l.MaxCompressedBytes)
	}
	dec, err := zstd.NewReader(bytes.NewReader(raw),
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderLowmem(true),
		zstd.WithDecoderMaxMemory(uint64(l.MaxDecodedBytes)),
		zstd.WithDecoderMaxWindow(uint64(l.MaxWindowBytes)),
	)
	if err != nil {
		return nil, invalid("zstd 头或 window 非法: %v", err)
	}
	defer dec.Close()

	reader := bufio.NewReaderSize(dec, l.MaxLineBytes+1)
	records := make([]json.RawMessage, 0)
	decoded := 0
	for {
		line, readErr := reader.ReadSlice('\n')
		if errors.Is(readErr, bufio.ErrBufferFull) {
			return nil, invalid("单行超过 %d 字节", l.MaxLineBytes)
		}
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, invalid("解压 zstd 流失败: %v", readErr)
		}
		if len(line) == 0 && errors.Is(readErr, io.EOF) {
			break
		}
		if errors.Is(readErr, io.EOF) {
			return nil, invalid("最后一条 JSONL 记录必须以 LF 结束")
		}
		if len(line) > l.MaxLineBytes+1 {
			return nil, invalid("单行超过 %d 字节", l.MaxLineBytes)
		}
		decoded += len(line)
		if decoded > l.MaxDecodedBytes {
			return nil, invalid("解压后内容超过 %d 字节", l.MaxDecodedBytes)
		}
		line = line[:len(line)-1] // trim the required LF
		if err := validateRecord(line, l); err != nil {
			return nil, err
		}
		records = append(records, append(json.RawMessage(nil), line...))
		if len(records) > l.MaxRecords {
			return nil, invalid("记录数超过 %d", l.MaxRecords)
		}
	}
	if len(records) == 0 {
		return nil, invalid("不得为空流")
	}
	return records, nil
}

func validateRecord(record []byte, l Limits) error {
	if len(record) == 0 || len(record) > l.MaxLineBytes {
		return invalid("JSONL 记录长度必须在 1..%d 字节", l.MaxLineBytes)
	}
	if bytes.IndexByte(record, '\n') >= 0 || bytes.IndexByte(record, '\r') >= 0 {
		return invalid("JSONL 记录内不得包含换行符")
	}
	if !utf8.Valid(record) {
		return invalid("JSONL 记录必须是 UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(record))
	token, err := dec.Token()
	if err != nil {
		return invalid("JSON 解析失败: %v", err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return invalid("每条 JSONL 记录必须是对象")
	}
	if err := validateObject(dec); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return invalid("JSONL 记录只能包含一个对象")
		}
		return invalid("JSON 解析失败: %v", err)
	}
	return nil
}

func validateObject(dec *json.Decoder) error {
	seen := map[string]struct{}{}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return invalid("JSON object key 解析失败: %v", err)
		}
		key, ok := token.(string)
		if !ok {
			return invalid("JSON object key 必须是字符串")
		}
		if _, exists := seen[key]; exists {
			return invalid("JSON object 含重复键 %q", key)
		}
		seen[key] = struct{}{}
		if err := validateValue(dec); err != nil {
			return err
		}
	}
	end, err := dec.Token()
	if err != nil {
		return invalid("JSON object 结束符缺失: %v", err)
	}
	if delim, ok := end.(json.Delim); !ok || delim != '}' {
		return invalid("JSON object 结束符非法")
	}
	return nil
}

func validateArray(dec *json.Decoder) error {
	for dec.More() {
		if err := validateValue(dec); err != nil {
			return err
		}
	}
	end, err := dec.Token()
	if err != nil {
		return invalid("JSON array 结束符缺失: %v", err)
	}
	if delim, ok := end.(json.Delim); !ok || delim != ']' {
		return invalid("JSON array 结束符非法")
	}
	return nil
}

func validateValue(dec *json.Decoder) error {
	token, err := dec.Token()
	if err != nil {
		return invalid("JSON value 解析失败: %v", err)
	}
	if delim, ok := token.(json.Delim); ok {
		switch delim {
		case '{':
			return validateObject(dec)
		case '[':
			return validateArray(dec)
		default:
			return invalid("JSON value 出现意外结束符")
		}
	}
	return nil
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}
