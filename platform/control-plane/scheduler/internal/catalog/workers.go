package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// WorkerDirectory intersects physical capacity with current governance facts.
// Resolve on every placement/drain cycle: persisted device allow-lists would
// survive revocation, ownership changes, or an Agent preset revision change.
type WorkerDirectory struct {
	URL    string
	Token  string
	Client *http.Client
}

func (d WorkerDirectory) Filter(ctx context.Context, task domain.Task, nodes []domain.Node) ([]domain.Node, error) {
	if task.WorkerID == "" {
		return nodes, nil
	}
	if strings.TrimSpace(d.URL) == "" || d.Token == "" {
		return nil, fmt.Errorf("worker placement requires governance directory configuration")
	}
	endpoint := strings.TrimRight(d.URL, "/") + "/v1/runtime/workers/" + url.PathEscape(task.WorkerID) + "/nodes?project_id=" + url.QueryEscape(task.ProjectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Lumo-Realm", task.Realm)
	req.Header.Set("Authorization", "Bearer "+d.Token)
	configured := d.Client
	if configured == nil {
		configured = observability.ConfiguredHTTPClient(5 * time.Second)
	}
	client := *configured
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("worker directory unavailable: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker directory returned HTTP %d", res.StatusCode)
	}
	var scope struct {
		Realm    string   `json:"realm"`
		WorkerID string   `json:"worker_id"`
		NodeIDs  []string `json:"node_ids"`
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return nil, fmt.Errorf("read worker directory: %w", err)
	}
	if len(body) > 1<<20 {
		return nil, fmt.Errorf("worker directory response exceeds 1 MiB")
	}
	if err := json.Unmarshal(body, &scope); err != nil {
		return nil, fmt.Errorf("invalid worker directory response: %w", err)
	}
	if scope.Realm != task.Realm || scope.WorkerID != task.WorkerID {
		return nil, fmt.Errorf("worker directory identity mismatch")
	}
	allowed := make(map[string]bool, len(scope.NodeIDs))
	for _, id := range scope.NodeIDs {
		allowed[id] = true
	}
	filtered := make([]domain.Node, 0)
	for _, node := range nodes {
		if node.Realm == task.Realm && allowed[node.NodeID] {
			filtered = append(filtered, node)
		}
	}
	return filtered, nil
}
