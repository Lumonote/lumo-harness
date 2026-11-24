// Package memsync 跨设备记忆同步（P1）：服务端只做「带版本的追加式变更日志 +
// 乐观并发」，不理解记忆正文（正文可以是端到端加密后的密文）。
//
// 隔离键 = (realm, user, workspace)：realm/user 只取网关注入的身份头，workspace
// 是客户端对工作区标识做 sha256 后的十六进制串，服务端看不到明文路径。
package memsync

import (
	"errors"
	"regexp"
)

// Item 一条记忆的当前状态。Seq 是服务端单调序号（拉取游标）；HLC 是客户端混合
// 逻辑时钟 "<毫秒13位>-<计数4位>-<设备>"，可按字典序比较；Deleted=true 即墓碑。
type Item struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Payload string `json:"payload"`
	HLC     string `json:"hlc"`
	Device  string `json:"device"`
	Deleted bool   `json:"deleted"`
	Seq     int64  `json:"seq"`
}

// Change 客户端推送的一次修改。BaseSeq 是客户端修改前看到的服务端序号（新建为 0）。
type Change struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Payload string `json:"payload"`
	HLC     string `json:"hlc"`
	Deleted bool   `json:"deleted"`
	BaseSeq int64  `json:"baseSeq"`
}

type Outcome string

const (
	Accepted  Outcome = "accepted"  // 写入，分配新 seq
	Duplicate Outcome = "duplicate" // 与服务端内容一致，幂等成功，不分配新 seq
	Conflict  Outcome = "conflict"  // 两端都改过且内容不同，交给用户
)

// Result 单条推送结果；Conflict/Duplicate 时 Current 为服务端现值。
type Result struct {
	ID      string  `json:"id"`
	Outcome Outcome `json:"outcome"`
	Seq     int64   `json:"seq,omitempty"`
	Current *Item   `json:"current,omitempty"`
}

var (
	idRe        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hlcRe       = regexp.MustCompile(`^[0-9]{13}-[0-9]{4}-[A-Za-z0-9_-]{1,64}$`)
	workspaceRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	deviceRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	kinds       = map[string]bool{"card": true, "goal": true, "note": true}
)

const (
	MaxPayload = 16 * 1024
	MaxBatch   = 200
	MaxPull    = 500
)

var ErrInvalid = errors.New("invalid memory sync request")

func ValidWorkspace(w string) bool { return workspaceRe.MatchString(w) }
func ValidDevice(d string) bool    { return deviceRe.MatchString(d) }

func (c Change) Validate() error {
	if !idRe.MatchString(c.ID) || !kinds[c.Kind] || !hlcRe.MatchString(c.HLC) || c.BaseSeq < 0 {
		return ErrInvalid
	}
	if len(c.Payload) > MaxPayload || (c.Deleted && c.Payload != "") || (!c.Deleted && c.Payload == "") {
		return ErrInvalid
	}
	return nil
}

// Decide 冲突规则（纯函数，服务端唯一判定点）：
//  1. 服务端没有这条：BaseSeq 必须为 0 → Accepted；否则说明服务端丢失/越权猜 id → Conflict(current=nil)。
//  2. 内容与服务端现值一致（同 payload、同墓碑态）→ Duplicate（重连补发幂等）。
//  3. BaseSeq == current.Seq：客户端基于最新版修改 → Accepted。
//  4. 两边都删 → Duplicate（墓碑合并）。
//  5. 其余（基于旧版且内容不同）→ Conflict，服务端不自动覆盖，由用户选择
//     「保留本机」（以 current.Seq 为 BaseSeq 重推）或「采用云端」。
func Decide(current *Item, in Change) Outcome {
	if current == nil {
		if in.BaseSeq == 0 {
			return Accepted
		}
		return Conflict
	}
	if current.Deleted == in.Deleted && current.Payload == in.Payload && current.Kind == in.Kind {
		return Duplicate
	}
	if in.BaseSeq == current.Seq {
		return Accepted
	}
	if current.Deleted && in.Deleted {
		return Duplicate
	}
	return Conflict
}
