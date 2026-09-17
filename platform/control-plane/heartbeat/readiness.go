package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultRequiredServices is the closed set of control-plane services a Cluster
// deployment is expected to run.
//
// It is a constant rather than something derived from the heartbeat table on
// purpose: a set derived from "whoever reported" cannot express "this service
// never started", which is precisely the condition readiness must catch.
//
// A deployment that legitimately omits a service overrides this with
// LUMO_REQUIRED_SERVICES. Readiness is only consulted when the operator has
// declared the deployment to be a cluster, so Local and Standalone are
// unaffected by this list.
var DefaultRequiredServices = []string{
	"collaborator",
	"connector-gateway",
	"flows",
	"governance",
	"llm-gateway",
	"projects",
	"registry",
	"scheduler",
	"usage-ledger",
}

// ParseRequiredServices reads a comma-separated override. An empty value means
// "use the default set", never "require nothing" — an empty requirement would
// make readiness vacuously true, which is the fail-open behaviour this package
// exists to prevent.
func ParseRequiredServices(raw string) ([]string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return append([]string(nil), DefaultRequiredServices...), nil
	}
	seen := map[string]bool{}
	services := make([]string, 0, len(DefaultRequiredServices))
	for _, part := range strings.Split(trimmed, ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			return nil, fmt.Errorf("heartbeat: LUMO_REQUIRED_SERVICES 含空项")
		}
		if seen[name] {
			return nil, fmt.Errorf("heartbeat: LUMO_REQUIRED_SERVICES 重复声明 %q", name)
		}
		seen[name] = true
		services = append(services, name)
	}
	return services, nil
}

// InstanceState is one replica's contribution to readiness.
type InstanceState struct {
	Instance string
	Status   string
	Version  string
	// Age is how long ago the database last saw this instance.
	Age time.Duration
	// Fresh means the report is within the age limit.
	Fresh bool
	// Serving means this instance is fresh, ready, and reports no failing
	// dependency. A service is healthy when at least one instance is serving.
	Serving bool
	// Reason explains Serving=false.
	Reason       string
	Dependencies map[string]string
}

// ServiceState is one required service's contribution to readiness. A service
// that never reported appears here with Healthy=false rather than being omitted.
type ServiceState struct {
	Service string
	Healthy bool
	// Reason explains Healthy=false.
	Reason string
	// Instances lists every replica seen for this service, including stale ones,
	// so an operator can spot the replica that went quiet.
	Instances []InstanceState
}

// Readiness is a derived snapshot of the cluster.
type Readiness struct {
	// Ready is true only when every required service has a serving instance.
	Ready bool
	// Reason is a one-line explanation when Ready is false, and empty when it is
	// true. It is what an operator sees in the API instead of a bare boolean.
	Reason string
	// Services covers the required set in the order it was requested.
	Services []ServiceState
	// Unhealthy names the required services that are not serving, for a one-line
	// reason in an API response.
	Unhealthy []string
	// Unknown names services that reported but are not required. A name typo in
	// the required set shows up as one service missing and one unknown, which
	// points straight at the mistake.
	Unknown []string
	// Dependencies merges the dependency reports of serving instances, for
	// visibility. A dependency only ever counts against the service whose own
	// instance reported it.
	Dependencies map[string]string
	// EvaluatedAt is when this snapshot was computed.
	EvaluatedAt time.Time
}

// Evaluate derives readiness from heartbeat rows.
//
// `required` is the closed set of services that must be serving. `maxAge` is how
// old a report may be before its instance stops counting.
func Evaluate(rows []Heartbeat, required []string, maxAge time.Duration) Readiness {
	if maxAge <= 0 {
		maxAge = DefaultMaxAge
	}
	byService := map[string][]Heartbeat{}
	for _, row := range rows {
		byService[row.Service] = append(byService[row.Service], row)
	}

	requiredSet := map[string]bool{}
	result := Readiness{
		Services:     make([]ServiceState, 0, len(required)),
		Unhealthy:    []string{},
		Unknown:      []string{},
		Dependencies: map[string]string{},
		EvaluatedAt:  time.Now(),
	}

	for _, service := range required {
		requiredSet[service] = true
		state := ServiceState{Service: service, Instances: []InstanceState{}}
		reported := byService[service]
		if len(reported) == 0 {
			state.Reason = "从未上报心跳"
			result.Services = append(result.Services, state)
			result.Unhealthy = append(result.Unhealthy, service)
			continue
		}

		// Sort so the reported reason is deterministic: map iteration order would
		// otherwise make "which replica is the reason" vary between evaluations.
		sorted := append([]Heartbeat(nil), reported...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Instance < sorted[j].Instance })

		failing := make([]string, 0, len(sorted))
		servingCount := 0
		for _, row := range sorted {
			instance := InstanceState{
				Instance: row.Instance, Status: row.Status, Version: row.Version,
				Age: row.Age, Dependencies: row.Dependencies,
			}
			switch {
			case row.Age > maxAge:
				instance.Reason = fmt.Sprintf("心跳过期 %s（上限 %s）", roundDuration(row.Age), roundDuration(maxAge))
			case row.Status != StatusReady:
				instance.Reason = fmt.Sprintf("实例状态为 %s", row.Status)
			default:
				if dependency, ok := failingDependency(row.Dependencies); ok {
					instance.Reason = fmt.Sprintf("依赖 %s 不可用", dependency)
				}
			}
			instance.Fresh = row.Age <= maxAge
			instance.Serving = instance.Reason == ""
			state.Instances = append(state.Instances, instance)
			if instance.Serving {
				servingCount++
				for name, status := range row.Dependencies {
					result.Dependencies[name] = status
				}
				continue
			}
			failing = append(failing, fmt.Sprintf("%s：%s", row.Instance, instance.Reason))
		}

		// A service is healthy when **at least one** replica is serving. Requiring
		// every replica would take the cluster down whenever one replica is being
		// restarted, which is the normal case during a rollout.
		if state.Healthy = servingCount > 0; !state.Healthy {
			state.Reason = strings.Join(failing, "；")
			result.Unhealthy = append(result.Unhealthy, service)
		}
		result.Services = append(result.Services, state)
	}

	for service := range byService {
		if !requiredSet[service] {
			result.Unknown = append(result.Unknown, service)
		}
	}
	sort.Strings(result.Unknown)

	result.Ready = len(result.Unhealthy) == 0 && len(required) > 0
	switch {
	case len(required) == 0:
		// An empty required set would make readiness vacuously true, which is a
		// fail-open path on a gate that opens management APIs. ParseRequiredServices
		// never produces one; this guards a caller that builds the slice by hand.
		result.Reason = "未配置必需服务清单"
	case !result.Ready:
		result.Reason = "服务未就绪：" + strings.Join(result.Unhealthy, "、")
	}
	return result
}

// failingDependency returns the name of the first dependency that is not ok.
// Names are sorted because map iteration order is random and a varying reason
// string would make the evaluation untestable.
func failingDependency(dependencies map[string]string) (string, bool) {
	if len(dependencies) == 0 {
		return "", false
	}
	names := make([]string, 0, len(dependencies))
	for name := range dependencies {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if dependencies[name] != DependencyOK {
			return name, true
		}
	}
	return "", false
}

// roundDuration trims a duration to something readable in a reason string.
func roundDuration(value time.Duration) string {
	if value < time.Second {
		return value.Round(time.Millisecond).String()
	}
	return value.Round(time.Second).String()
}

// Reader loads heartbeat rows. *pgxpool.Pool satisfies it; tests supply a fake
// so readiness can be exercised without a database.
type Reader interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// ReadAll loads every heartbeat. Age is computed by the database, so the caller
// never compares its own clock against another host's.
func ReadAll(ctx context.Context, reader Reader) ([]Heartbeat, error) {
	rows, err := reader.Query(ctx, SelectSQL)
	if err != nil {
		return nil, fmt.Errorf("heartbeat: 读取心跳失败: %w", err)
	}
	defer rows.Close()

	out := []Heartbeat{}
	for rows.Next() {
		var (
			row          Heartbeat
			ageSeconds   float64
			dependencies []byte
		)
		if err := rows.Scan(&row.Service, &row.Instance, &row.Status, &row.Version, &dependencies, &ageSeconds); err != nil {
			return nil, fmt.Errorf("heartbeat: 扫描心跳失败: %w", err)
		}
		row.Dependencies = map[string]string{}
		if len(dependencies) > 0 {
			if err := json.Unmarshal(dependencies, &row.Dependencies); err != nil {
				return nil, fmt.Errorf("heartbeat: 解析 %s/%s 的依赖上报失败: %w", row.Service, row.Instance, err)
			}
		}
		if row.Dependencies == nil {
			// A JSON null unmarshals to a nil map. The publisher never writes one
			// (it normalises to {}), so this guards any other writer — and keeps
			// the field's contract honest, since consumers treat it as a map.
			row.Dependencies = map[string]string{}
		}
		row.Age = time.Duration(ageSeconds * float64(time.Second))
		out = append(out, row)
	}
	return out, rows.Err()
}

// Prune drops rows silent for longer than `olderThan`. A replica that has been
// gone that long is not "quiet", it is gone; keeping its row would make the
// report grow without bound.
func Prune(ctx context.Context, pool *pgxpool.Pool, olderThan time.Duration) (int64, error) {
	if olderThan <= 0 {
		olderThan = DefaultPruneAfter
	}
	tag, err := pool.Exec(ctx, PruneSQL, olderThan.Seconds())
	if err != nil {
		return 0, fmt.Errorf("heartbeat: 清理心跳失败: %w", err)
	}
	return tag.RowsAffected(), nil
}
