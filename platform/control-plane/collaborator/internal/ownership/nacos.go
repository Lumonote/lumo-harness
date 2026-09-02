package ownership

// Nacos peer discovery for the stateful collaborator ring. The registration is
// ephemeral: a dead instance disappears from the ring after Nacos' lease
// timeout, allowing the next owner to recover the document from PG + Redis.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
)

type NacosPeerOptions struct {
	BaseURL  string
	Service  string
	Group    string
	Instance string
	Host     string
	Port     int
	Poll     time.Duration
}

type NacosPeerSync struct {
	opts   NacosPeerOptions
	client *http.Client
	log    *slog.Logger
}

func NewNacosPeerSync(options NacosPeerOptions, log *slog.Logger) *NacosPeerSync {
	if options.Service == "" {
		options.Service = "lumo-collaborator"
	}
	if options.Group == "" {
		options.Group = "DEFAULT_GROUP"
	}
	if options.Poll <= 0 {
		options.Poll = 5 * time.Second
	}
	return &NacosPeerSync{
		opts:   options,
		client: observability.ConfiguredHTTPClient(3 * time.Second),
		log:    log,
	}
}

// Run registers this instance and continuously replaces the ring with the
// healthy ephemeral instances reported by Nacos Naming.
func (n *NacosPeerSync) Run(ctx context.Context, ring *Ring) {
	ring.MarkReady()
	n.sync(ctx, ring)
	ticker := time.NewTicker(n.opts.Poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n.sync(ctx, ring)
		}
	}
}

// Close removes the ephemeral registration during graceful shutdown. Nacos
// still expires it if the process is terminated without this call.
func (n *NacosPeerSync) Close(ctx context.Context) error {
	if n.opts.BaseURL == "" || n.opts.Instance == "" {
		return nil
	}
	q := n.query()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, n.base()+"/nacos/v1/ns/instance?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("collaborator: Nacos 注销失败: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("collaborator: Nacos 注销返回 HTTP %d", res.StatusCode)
	}
	return nil
}

func (n *NacosPeerSync) sync(ctx context.Context, ring *Ring) {
	if n.opts.BaseURL == "" {
		return
	}
	if err := n.register(ctx); err != nil {
		n.warn("Nacos 注册失败", err)
	}
	instances, err := n.list(ctx)
	if err != nil {
		n.warn("Nacos 节点查询失败", err)
		return
	}
	ring.SetInstances(instances)
}

func (n *NacosPeerSync) register(ctx context.Context) error {
	q := n.query()
	q.Set("ephemeral", "true")
	metadata, _ := json.Marshal(map[string]string{"node_id": n.opts.Instance})
	q.Set("metadata", string(metadata))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.base()+"/nacos/v1/ns/instance?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return nil
}

func (n *NacosPeerSync) list(ctx context.Context) ([]string, error) {
	q := url.Values{"serviceName": {n.opts.Service}, "groupName": {n.opts.Group}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.base()+"/nacos/v1/ns/instance/list?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var body struct {
		Hosts []struct {
			IP       string            `json:"ip"`
			Port     int               `json:"port"`
			Healthy  bool              `json:"healthy"`
			Enabled  bool              `json:"enabled"`
			Metadata map[string]string `json:"metadata"`
		} `json:"hosts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	instances := make([]string, 0, len(body.Hosts))
	for _, host := range body.Hosts {
		if !host.Healthy || !host.Enabled {
			continue
		}
		id := host.Metadata["node_id"]
		if id == "" && host.IP != "" && host.Port > 0 {
			id = host.IP + ":" + strconv.Itoa(host.Port)
		}
		if id != "" {
			instances = append(instances, id)
		}
	}
	return instances, nil
}

func (n *NacosPeerSync) query() url.Values {
	return url.Values{
		"serviceName": {n.opts.Service},
		"groupName":   {n.opts.Group},
		"ip":          {n.opts.Host},
		"port":        {strconv.Itoa(n.opts.Port)},
	}
}

func (n *NacosPeerSync) base() string { return strings.TrimRight(n.opts.BaseURL, "/") }

func (n *NacosPeerSync) warn(message string, err error) {
	if n.log != nil {
		n.log.Warn(message, "err", err)
	}
}
