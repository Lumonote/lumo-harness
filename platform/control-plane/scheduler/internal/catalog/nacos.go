package catalog

// NacosCatalog implements the same Catalog contract as Pg, using Nacos Naming
// for Standalone/Cluster node discovery. Metadata is intentionally treated as
// untrusted input and validated before it becomes a placement candidate.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

type NacosCatalog struct {
	baseURL string
	service string
	group   string
	client  *http.Client

	// 短缓存：每次放置与每轮 drain 都要列节点，突发并发时合并成一次目录查询。
	// 只缓存成功结果；过期后查询失败就是失败，不拿旧数据冒充「节点都还在」。
	// 陈旧窗口内被放置到刚下线节点的任务由承载端拒绝 start、事务内槽位闸兜底。
	cacheTTL time.Duration
	cacheMu  sync.Mutex
	cacheAt  time.Time
	cached   []domain.Node
	// cachedAlive 与 cached 出自同一次目录查询：健康实例的 node_id，**不看 enabled**
	// （见 AliveLister）。两者必须同生同灭，否则存活集合与候选集合会来自两个时刻。
	cachedAlive []string
}

func NewNacos(baseURL, service, group string) *NacosCatalog {
	if service == "" {
		service = "lumo-dsh-node"
	}
	if group == "" {
		group = "DEFAULT_GROUP"
	}
	return &NacosCatalog{
		baseURL: strings.TrimRight(baseURL, "/"), service: service, group: group,
		client:   observability.ConfiguredHTTPClient(5 * time.Second),
		cacheTTL: time.Second,
	}
}

type nacosHost struct {
	IP       string            `json:"ip"`
	Port     int               `json:"port"`
	Healthy  bool              `json:"healthy"`
	Enabled  bool              `json:"enabled"`
	Metadata map[string]string `json:"metadata"`
}

func (n *NacosCatalog) List(ctx context.Context) ([]domain.Node, error) {
	nodes, _, err := n.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return append([]domain.Node(nil), nodes...), nil
}

// ListAlive 健康实例的 node_id，含 enabled=false 的排空节点（见 AliveLister）。
// 与 List 共用缓存：快照刷新每轮先后调两者，只产生一次目录查询。
func (n *NacosCatalog) ListAlive(ctx context.Context) ([]string, error) {
	_, alive, err := n.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return append([]string(nil), alive...), nil
}

// snapshot 返回缓存期内的（放置候选，存活集合）；过期则重新查询目录。
// 返回的切片归缓存所有，调用方必须复制后再交出去。
func (n *NacosCatalog) snapshot(ctx context.Context) ([]domain.Node, []string, error) {
	n.cacheMu.Lock()
	defer n.cacheMu.Unlock()
	if n.cached != nil && time.Since(n.cacheAt) < n.cacheTTL {
		return n.cached, n.cachedAlive, nil
	}
	nodes, alive, err := n.list(ctx)
	if err != nil {
		n.cached, n.cachedAlive = nil, nil
		return nil, nil, err
	}
	n.cached, n.cachedAlive, n.cacheAt = nodes, alive, time.Now()
	return nodes, alive, nil
}

func (n *NacosCatalog) list(ctx context.Context) ([]domain.Node, []string, error) {
	q := url.Values{"serviceName": {n.service}, "groupName": {n.group}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.baseURL+"/nacos/v1/ns/instance/list?"+q.Encode(), nil)
	if err != nil {
		return nil, nil, err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("catalog: Nacos 查询失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("catalog: Nacos 返回 HTTP %d", res.StatusCode)
	}
	var body struct {
		Hosts []nacosHost `json:"hosts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, nil, fmt.Errorf("catalog: Nacos 响应解析失败: %w", err)
	}
	out := make([]domain.Node, 0, len(body.Hosts))
	alive := make([]string, 0, len(body.Hosts))
	for _, h := range body.Hosts {
		if !h.Healthy || h.IP == "" || h.Port <= 0 {
			continue
		}
		id := h.Metadata["node_id"]
		if id == "" {
			id = h.IP + ":" + strconv.Itoa(h.Port)
		}
		// 健康即存活。enabled=false 只表示「不要再往上放新任务」（排空中），
		// 节点仍在跑已有任务，所以它进存活集合、不进放置候选。
		alive = append(alive, id)
		if !h.Enabled {
			continue
		}
		capacity, _ := strconv.Atoi(h.Metadata["capacity"])
		if capacity < 1 {
			capacity = 1
		}
		caps := split(h.Metadata["capabilities"])
		cluster := h.Metadata["cluster_id"]
		if cluster == "" {
			cluster = "default"
		}
		realm := h.Metadata["realm"]
		if realm == "" {
			continue
		}
		out = append(out, domain.Node{NodeID: id, Realm: realm, ClusterID: cluster, Capacity: capacity, Capabilities: caps, Residency: h.Metadata["residency"], ControlURL: "http://" + h.IP + ":" + strconv.Itoa(h.Port)})
	}
	return out, alive, nil
}

func (n *NacosCatalog) Upsert(ctx context.Context, node domain.Node) error {
	q := url.Values{
		"serviceName": {n.service}, "groupName": {n.group},
		"ip": {hostOf(node.NodeID)}, "port": {portOf(node.NodeID)},
		"metadata": {metadata(node)},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.baseURL+"/nacos/v1/ns/instance?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("catalog: Nacos 登记失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("catalog: Nacos 登记返回 HTTP %d", res.StatusCode)
	}
	n.cacheMu.Lock()
	n.cached, n.cachedAlive = nil, nil
	n.cacheMu.Unlock()
	return nil
}

func metadata(n domain.Node) string {
	// Nacos' metadata query parameter is a JSON object. Keeping this as JSON
	// also preserves capability values containing punctuation and makes the
	// registration wire compatible with the map returned by instance/list.
	raw, err := json.Marshal(map[string]string{
		"node_id":      n.NodeID,
		"realm":        n.Realm,
		"cluster_id":   n.ClusterID,
		"capacity":     strconv.Itoa(n.Capacity),
		"capabilities": capabilitiesMetadata(n.Capabilities),
		"residency":    n.Residency,
	})
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func capabilitiesMetadata(values []string) string {
	raw, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func split(v string) []string {
	if v == "" {
		return nil
	}
	var values []string
	if json.Unmarshal([]byte(v), &values) == nil {
		return values
	}
	return strings.Split(v, ",")
}
func hostOf(v string) string {
	if i := strings.LastIndex(v, ":"); i > 0 {
		return v[:i]
	}
	return v
}
func portOf(v string) string {
	if i := strings.LastIndex(v, ":"); i > 0 {
		return v[i+1:]
	}
	return "8080"
}
