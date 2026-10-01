package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type NodeObservation struct {
	NodeID string
	Age    time.Duration
}

type LivenessSource interface {
	ReadNodes(context.Context) ([]NodeObservation, error)
}

type NacosLivenessOptions struct {
	BaseURL    string
	Service    string
	Group      string
	Namespace  string
	Candidates func(context.Context) ([]string, error)
	HTTPClient *http.Client
	Now        func() time.Time
}

// NacosLiveness observes only nodes hosting active threads. Nacos expires dead
// ephemeral registrations, so its healthy list alone cannot enumerate lost
// nodes. Absence starts a local monotonic timer, including for nodes missing
// when the observer starts. No clocks from different hosts are compared.
// A failed/incomplete read resets the timers: an unavailable registry is not
// evidence that nodes are down, and its outage must not count toward the grace.
// ReadNodes is called serially by RunNodeLossLoop.
type NacosLiveness struct {
	opts    NacosLivenessOptions
	missing map[string]time.Time
}

func NewNacosLiveness(opts NacosLivenessOptions) (*NacosLiveness, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/"))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("节点存活来源需要合法的 Nacos HTTP 地址")
	}
	if opts.Candidates == nil {
		return nil, fmt.Errorf("节点存活来源缺少活跃线程的承载节点查询")
	}
	opts.BaseURL = base.String()
	if opts.Service == "" {
		opts.Service = "lumo-dsh-node"
	}
	if opts.Group == "" {
		opts.Group = "DEFAULT_GROUP"
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 3 * time.Second}
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &NacosLiveness{opts: opts, missing: map[string]time.Time{}}, nil
}

func (n *NacosLiveness) ReadNodes(ctx context.Context) (observations []NodeObservation, err error) {
	defer func() {
		if err != nil {
			n.missing = map[string]time.Time{}
		}
	}()
	candidates, err := n.opts.Candidates(ctx)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		n.missing = map[string]time.Time{}
		return []NodeObservation{}, nil
	}
	q := url.Values{"serviceName": {n.opts.Service}, "groupName": {n.opts.Group}, "healthyOnly": {"false"}}
	if n.opts.Namespace != "" {
		q.Set("namespaceId", n.opts.Namespace)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.opts.BaseURL+"/nacos/v1/ns/instance/list?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	response, err := n.opts.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Nacos 节点列表返回 HTTP %d", response.StatusCode)
	}
	var body struct {
		Hosts *[]struct {
			Healthy  *bool             `json:"healthy"`
			Metadata map[string]string `json:"metadata"`
		} `json:"hosts"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	if err := decoder.Decode(&body); err != nil {
		return nil, fmt.Errorf("Nacos 节点列表不合法: %w", err)
	}
	if body.Hosts == nil {
		return nil, fmt.Errorf("Nacos 节点列表缺少 hosts 数组")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("Nacos 节点列表含多余或截断数据")
	}
	healthy := map[string]bool{}
	for _, host := range *body.Hosts {
		id := host.Metadata["node_id"]
		if strings.TrimSpace(id) == "" || host.Healthy == nil {
			return nil, fmt.Errorf("Nacos 节点实例缺少 node_id 或 healthy，不据此判定失联")
		}
		// enabled=false disables new placements; a healthy draining node still
		// owns its existing workspace and must not have its threads failed.
		if *host.Healthy {
			healthy[id] = true
		}
	}
	now := n.opts.Now()
	seen := map[string]bool{}
	observations = make([]NodeObservation, 0, len(candidates))
	for _, id := range candidates {
		if seen[id] {
			continue
		}
		seen[id] = true
		age := time.Duration(0)
		if healthy[id] {
			delete(n.missing, id)
		} else {
			since, exists := n.missing[id]
			if !exists || now.Before(since) {
				since = now
				n.missing[id] = since
			}
			age = now.Sub(since)
		}
		observations = append(observations, NodeObservation{NodeID: id, Age: age})
	}
	for id := range n.missing {
		if !seen[id] {
			delete(n.missing, id)
		}
	}
	sort.Slice(observations, func(i, j int) bool { return observations[i].NodeID < observations[j].NodeID })
	return observations, nil
}
