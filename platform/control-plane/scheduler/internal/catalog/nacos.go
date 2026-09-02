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
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

type NacosCatalog struct {
	baseURL string
	service string
	group   string
	client  *http.Client
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
		client: observability.ConfiguredHTTPClient(5 * time.Second),
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
	q := url.Values{"serviceName": {n.service}, "groupName": {n.group}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.baseURL+"/nacos/v1/ns/instance/list?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("catalog: Nacos 查询失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog: Nacos 返回 HTTP %d", res.StatusCode)
	}
	var body struct {
		Hosts []nacosHost `json:"hosts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("catalog: Nacos 响应解析失败: %w", err)
	}
	out := make([]domain.Node, 0, len(body.Hosts))
	for _, h := range body.Hosts {
		if !h.Healthy || !h.Enabled || h.IP == "" || h.Port <= 0 {
			continue
		}
		id := h.Metadata["node_id"]
		if id == "" {
			id = h.IP + ":" + strconv.Itoa(h.Port)
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
	return out, nil
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
