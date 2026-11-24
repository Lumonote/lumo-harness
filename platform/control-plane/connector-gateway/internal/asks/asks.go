// Package asks 把连接器网关的人工审批投影为统一的 Ask 读模型（P0-1），并提供
// 进程内事件广播。权威存储仍是 approval.Store（connector_approvals 表）：一次性、
// request_hash 绑定、申请人不可自批等语义不变；本包只做投影与通知。
//
// 线格式与 shared/seam-contracts/asks.ts 一一对应。
package asks

import (
	"strings"
	"sync"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/approval"
)

type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type Source struct {
	Kind        string `json:"kind"`
	Ref         string `json:"ref"`
	ConnectorID string `json:"connector_id,omitempty"`
	Operation   string `json:"operation,omitempty"`
}

type Answer struct {
	Value      string    `json:"value"`
	AnsweredBy string    `json:"answered_by"`
	AnsweredAt time.Time `json:"answered_at"`
}

type Ask struct {
	ID              string    `json:"id"`
	Kind            string    `json:"kind"`
	Status          string    `json:"status"`
	Realm           string    `json:"realm"`
	Title           string    `json:"title"`
	Detail          string    `json:"detail,omitempty"`
	Options         []Option  `json:"options,omitempty"`
	Source          Source    `json:"source"`
	RequesterUserID string    `json:"requester_user_id"`
	ProjectID       string    `json:"project_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	ExpiresAt       time.Time `json:"expires_at"`
	Answer          *Answer   `json:"answer,omitempty"`
	SourceStatus    string    `json:"source_status,omitempty"`
}

const ConnectorPrefix = "connector:"

var approvalOptions = []Option{{ID: "approve", Label: "批准"}, {ID: "reject", Label: "拒绝"}}

// StatusOf 把 connector_approvals 状态映射到统一状态机。
func StatusOf(s string) string {
	switch s {
	case "pending":
		return "pending"
	case "approved", "consumed":
		return "answered"
	case "rejected":
		return "rejected"
	case "cancelled":
		return "cancelled"
	default:
		return "expired"
	}
}

// FromApproval 投影；r.Status 应已是 effectiveStatus（List 已处理过期）。
func FromApproval(r approval.Request) Ask {
	a := Ask{
		ID: ConnectorPrefix + r.ID, Kind: "approval", Status: StatusOf(r.Status), Realm: r.Realm,
		Title:   "连接器高敏感写入：" + r.ConnectorID + " · " + r.Operation,
		Detail:  "批准仅对完全相同的请求生效一次。",
		Options: approvalOptions,
		Source:  Source{Kind: "connector", Ref: r.ID, ConnectorID: r.ConnectorID, Operation: r.Operation},
		RequesterUserID: r.RequesterUserID, ProjectID: r.ProjectID,
		CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, SourceStatus: r.Status,
	}
	if r.ApproverUserID != "" && (a.Status == "answered" || a.Status == "rejected") {
		v := "approve"
		if a.Status == "rejected" {
			v = "reject"
		}
		a.Answer = &Answer{Value: v, AnsweredBy: r.ApproverUserID, AnsweredAt: r.CreatedAt}
	}
	return a
}

// ParseConnectorID 从 `connector:<id>` 取回审批 ID；也接受裸 ID 以兼容旧客户端。
func ParseConnectorID(id string) (string, bool) {
	id = strings.TrimPrefix(id, ConnectorPrefix)
	if id == "" || len(id) > 128 {
		return "", false
	}
	for _, c := range id {
		if !(c == '-' || c == '_' || c == '.' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return "", false
		}
	}
	return id, true
}

// Event 统一事件。
type Event struct {
	Type string    `json:"type"`
	Ask  Ask       `json:"ask"`
	At   time.Time `json:"at"`
}

// Broker 进程内事件广播（单副本足够做 UI 刷新提示；多副本下客户端仍以轮询 /asks 为准）。
type Broker struct {
	mu   sync.Mutex
	subs map[chan Event]string // chan -> realm
}

func NewBroker() *Broker { return &Broker{subs: map[chan Event]string{}} }

func (b *Broker) Subscribe(realm string) (<-chan Event, func()) {
	ch := make(chan Event, 16)
	b.mu.Lock()
	b.subs[ch] = realm
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
}

// Publish 非阻塞：慢订阅者丢事件而不是拖住调用链路。nil Broker 安全。
func (b *Broker) Publish(typ string, a Ask) {
	if b == nil {
		return
	}
	ev := Event{Type: typ, Ask: a, At: time.Now().UTC()}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch, realm := range b.subs {
		if realm != a.Realm {
			continue
		}
		select {
		case ch <- ev:
		default:
		}
	}
}
