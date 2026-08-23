// Package ownership 裁决文档归属：**每个活跃文档由唯一一个实例持有**（§5.4.7.4）。
//
// 用一致性哈希把 documentId 映射到实例，避免多副本各持一份 CRDT 导致分叉。
// 实例列表来自注册中心（Nacos Naming）；本包只做纯函数裁决，不含网络调用。
package ownership

import (
	"crypto/sha1"
	"encoding/binary"
	"sort"
	"strconv"
	"sync"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// vnodesPerInstance 每个实例的虚拟节点数：越大分布越均匀，代价是环更大。
const vnodesPerInstance = 128

type vnode struct {
	hash     uint32
	instance string
}

// Ring 一致性哈希环。并发安全：实例列表变更时整体替换。
type Ring struct {
	mu     sync.RWMutex
	vnodes []vnode
	self   string
}

// NewRing 以本实例标识建环；初始为空（须调用 SetInstances）。
func NewRing(self string) *Ring {
	return &Ring{self: self}
}

// SetInstances 替换实例列表（注册中心 watch 回调里调用）。
func (r *Ring) SetInstances(instances []string) {
	nodes := make([]vnode, 0, len(instances)*vnodesPerInstance)
	for _, inst := range instances {
		for i := 0; i < vnodesPerInstance; i++ {
			nodes = append(nodes, vnode{
				hash:     hashKey(inst + "#" + strconv.Itoa(i)),
				instance: inst,
			})
		}
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].hash < nodes[j].hash })

	r.mu.Lock()
	r.vnodes = nodes
	r.mu.Unlock()
}

// OwnerOf 返回该文档应归属的实例标识；环为空时返回空串。
func (r *Ring) OwnerOf(id domain.DocumentID) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.vnodes) == 0 {
		return ""
	}
	h := hashKey(string(id))
	idx := sort.Search(len(r.vnodes), func(i int) bool { return r.vnodes[i].hash >= h })
	if idx == len(r.vnodes) {
		idx = 0
	}
	return r.vnodes[idx].instance
}

// IsMine 判断本实例是否为该文档的归属者。
//
// 环为空（尚未同步到实例列表）时返回 true：单实例部署与冷启动的可用性优先，
// 集群形态下注册中心就绪后自动收敛。
func (r *Ring) IsMine(id domain.DocumentID) bool {
	owner := r.OwnerOf(id)
	return owner == "" || owner == r.self
}

// Self 返回本实例标识。
func (r *Ring) Self() string {
	return r.self
}

func hashKey(s string) uint32 {
	sum := sha1.Sum([]byte(s))
	return binary.BigEndian.Uint32(sum[:4])
}
