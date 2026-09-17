package indexing

import (
	"context"
	"errors"
)

// Doc 投影目标文档的元数据。字段名与 JSON 形状必须逐字对齐
// platform/shared/seam-contracts/knowledge.ts 的 KnowledgeDoc —— seam host 的
// dispatch.ts 会逐个字段做非空校验，少一个字段就是 400（terminal）。
type Doc struct {
	DocID string `json:"docId"`
	Realm string `json:"realm"`
	Space string `json:"space"`
	Title string `json:"title"`
	// SourceVersion 必须等于发布版本号。下游用它做单调校验（旧版本显式拒绝）与
	// 检索时的一致性核对：投影版本低于源版本的内容不会被召回（§5.4.3 宁可少召回）。
	SourceVersion int `json:"sourceVersion"`
	// EmbeddingModel 是部署级常量，必须与 Provider 配置的模型完全一致；
	// 不一致的后果不是报错而是**检索永远查不到**（query 按 embedding_model 过滤）。
	EmbeddingModel string `json:"embeddingModel"`
}

// Ingest 一次投影写入。对应 KnowledgeIngest。
type Ingest struct {
	Doc    Doc     `json:"doc"`
	Chunks []Chunk `json:"chunks"`
}

// Indexer 是投影下游的最小接口：一个方法、无返回值语义、可整体替换。
//
// 刻意不暴露 query/remove/rebuild：管道只需要写入能力，把其余三个也暴露出去
// 只会让「谁有权删除知识库内容」这个问题失去唯一答案。
type Indexer interface {
	Ingest(ctx context.Context, entry Ingest) error
}

// ErrRejected 载荷被下游判定为非法（HTTP 400 / code=invalid）。
//
// 它是**终态**：载荷是 outbox 行的确定性函数，同样的字节重试只会得到同样的 400。
// 继续重试的代价是白烧 embedding 调用，所以调度器直接把该行记为停滞并暴露原因。
// 与之相对，403/5xx/网络错误都视为可重试——它们可能是配置或节点故障，会自愈。
var ErrRejected = errors.New("indexing: 载荷被 seam 拒绝，重试同一载荷不会成功")

// IsRejected 判断错误是否为终态拒绝。
func IsRejected(err error) bool { return errors.Is(err, ErrRejected) }
