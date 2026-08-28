// Package domain 定义协作服务的领域模型（§5.4.7）。
//
// 核心边界：编辑态（CRDT update 流）与发布态（不可变快照）分离——
// 模型只读发布态（铁律 17），编辑态永不进入 RAG 检索。
package domain

import "time"

// DocumentID 文档标识（归属哈希的输入，§5.4.7.4）。
type DocumentID string

// RealmID 租户隔离边界（首要授权边界，§10.2）。
type RealmID string

// SpaceID 知识空间：项目内的协作单元（§11.1，一个项目可含多个 Space）。
type SpaceID string

// Permission 空间级权限（§5.4.7.1）：read/edit/comment/publish 独立授予。
type Permission string

const (
	PermRead    Permission = "read"
	PermEdit    Permission = "edit"
	PermComment Permission = "comment"
	PermPublish Permission = "publish"
)

// Document 协作文档的权威元数据（正文在 CRDT 状态 + 发布快照中）。
type Document struct {
	ID    DocumentID `json:"id"`
	Realm RealmID    `json:"realm"`
	Space SpaceID    `json:"space"`
	Title string     `json:"title"`
	// PublishedVersion 最新发布版本号；0 表示尚无发布（草稿态）。
	PublishedVersion int       `json:"publishedVersion"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// Update 一次 CRDT 增量（Yjs update 二进制，原样透传不解析）。
//
// 服务不解释 CRDT 语义：合并由客户端 Yjs / 服务端 y-crdt 内核完成，
// 本服务负责顺序化、持久化（WAL 先行）与广播。
type Update struct {
	DocID    DocumentID `json:"docId"`
	Seq      int64      `json:"seq"`
	Actor    string     `json:"actor"`
	Payload  []byte     `json:"payload"`
	Received time.Time  `json:"received"`
}

// Snapshot 不可变发布快照（§5.4.7.1 版本语义）。
//
// 发布 = 一次「源写入」：与 outbox 同事务落库，由 §5.4.3 的同一条管道
// 触发向量重建——不是两套机制。
type Snapshot struct {
	DocID     DocumentID `json:"docId"`
	Version   int        `json:"version"`
	Publisher string     `json:"publisher"`
	// Content 发布时刻的文档正文（Markdown 投影；权威副本另存 MinIO）。
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

// Presence 在场状态（光标/选区，Yjs awareness 的服务端投影）。
//
// 不持久化：断连即消失，重连由客户端重新广播。
type Presence struct {
	DocID     DocumentID `json:"docId"`
	UserID    string     `json:"userId"`
	Display   string     `json:"display"`
	Cursor    []byte     `json:"cursor"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

// Comment 评论线程（以文档位置锚定，存 PG，不污染 CRDT 正文）。
type Comment struct {
	ID        string     `json:"id"`
	DocID     DocumentID `json:"docId"`
	Anchor    string     `json:"anchor"`
	Author    string     `json:"author"`
	Body      string     `json:"body"`
	Resolved  bool       `json:"resolved"`
	CreatedAt time.Time  `json:"createdAt"`
}

// Limits 硬容量上限（§5.4.7.4：无上限的内存态服务必然被拖垮）。
//
// 超限一律拒绝，不降级——对齐「误配置/超限必须响亮失败」。
type Limits struct {
	MaxDocBytes        int           `json:"maxDocBytes"`
	MaxEditorsPerDoc   int           `json:"maxEditorsPerDoc"`
	MaxDocsPerInstance int           `json:"maxDocsPerInstance"`
	IdleEvictAfter     time.Duration `json:"idleEvictAfter"`
	SnapshotInterval   time.Duration `json:"snapshotInterval"`
}

// DefaultLimits 生产可用的保守默认值。
func DefaultLimits() Limits {
	return Limits{
		MaxDocBytes:        8 << 20, // 8 MiB
		MaxEditorsPerDoc:   64,
		MaxDocsPerInstance: 2000,
		IdleEvictAfter:     15 * time.Minute,
		SnapshotInterval:   2 * time.Second,
	}
}

// ErrCapacity 超出硬上限（调用方须向用户显式报错，不得静默降级）。
type ErrCapacity struct{ Detail string }

func (e *ErrCapacity) Error() string { return "collaborator: 超出容量上限: " + e.Detail }

// ErrForbidden 授权拒绝（§5.4.7.1 空间级权限）。
type ErrForbidden struct{ Detail string }

func (e *ErrForbidden) Error() string { return "collaborator: 无权限: " + e.Detail }

// ErrNotFound 表示请求的租户内资源不存在。
type ErrNotFound struct{ Detail string }

func (e *ErrNotFound) Error() string { return "collaborator: 资源不存在: " + e.Detail }
