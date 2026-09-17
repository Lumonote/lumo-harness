package heartbeat

import (
	"strings"
	"testing"
	"time"
)

func serving(service, instance string) Heartbeat {
	return Heartbeat{
		Service: service, Instance: instance, Status: StatusReady, Version: "1",
		Age: time.Second, Dependencies: map[string]string{"postgres": DependencyOK},
	}
}

func TestEvaluateReadyWhenEveryRequiredServiceServes(t *testing.T) {
	rows := []Heartbeat{serving("scheduler", "scheduler-0"), serving("governance", "governance-0")}
	readiness := Evaluate(rows, []string{"scheduler", "governance"}, DefaultMaxAge)

	if !readiness.Ready {
		t.Fatalf("期望就绪，实际不就绪：%s", readiness.Reason)
	}
	if readiness.Reason != "" {
		t.Errorf("就绪时不应有原因，实际 %q", readiness.Reason)
	}
	if len(readiness.Unhealthy) != 0 {
		t.Errorf("Unhealthy = %v，期望空", readiness.Unhealthy)
	}
	if len(readiness.Services) != 2 {
		t.Errorf("Services 条数 = %d，期望 2", len(readiness.Services))
	}
}

// The whole point of the closed required set: a service that never started must
// read as missing, not as absent from the check.
func TestEvaluateCountsNeverReportedServiceAsMissing(t *testing.T) {
	rows := []Heartbeat{serving("scheduler", "scheduler-0")}
	readiness := Evaluate(rows, []string{"scheduler", "governance"}, DefaultMaxAge)

	if readiness.Ready {
		t.Fatal("缺失服务时不应就绪")
	}
	if len(readiness.Services) != 2 {
		t.Fatalf("Services 条数 = %d，期望 2（缺失的也必须出现）", len(readiness.Services))
	}
	missing := readiness.Services[1]
	if missing.Service != "governance" || missing.Healthy {
		t.Fatalf("缺失项 = %+v", missing)
	}
	if missing.Reason != "从未上报心跳" {
		t.Errorf("原因 = %q", missing.Reason)
	}
	if len(missing.Instances) != 0 {
		t.Errorf("缺失服务不应有实例，实际 %d 个", len(missing.Instances))
	}
	if len(readiness.Unhealthy) != 1 || readiness.Unhealthy[0] != "governance" {
		t.Errorf("Unhealthy = %v，期望 [governance]", readiness.Unhealthy)
	}
	if !strings.Contains(readiness.Reason, "governance") {
		t.Errorf("顶层原因未点出服务名：%q", readiness.Reason)
	}
}

func TestEvaluateStaleInstanceIsNotServing(t *testing.T) {
	row := serving("scheduler", "scheduler-0")
	row.Age = 2 * time.Minute
	readiness := Evaluate([]Heartbeat{row}, []string{"scheduler"}, DefaultMaxAge)

	if readiness.Ready {
		t.Fatal("心跳过期时不应就绪")
	}
	instance := readiness.Services[0].Instances[0]
	if instance.Fresh || instance.Serving {
		t.Errorf("过期实例不应 fresh/serving：%+v", instance)
	}
	if !strings.Contains(instance.Reason, "心跳过期") {
		t.Errorf("原因 = %q", instance.Reason)
	}
}

func TestEvaluateStoppingInstanceIsNotServing(t *testing.T) {
	row := serving("scheduler", "scheduler-0")
	row.Status = StatusStopping
	readiness := Evaluate([]Heartbeat{row}, []string{"scheduler"}, DefaultMaxAge)

	if readiness.Ready {
		t.Fatal("实例停止中时不应就绪")
	}
	instance := readiness.Services[0].Instances[0]
	// It is fresh, but a stopping instance is not serving.
	if !instance.Fresh {
		t.Error("刚写过 stopping 的实例应当是 fresh 的")
	}
	if instance.Serving {
		t.Error("停止中的实例不应算 serving")
	}
	if !strings.Contains(instance.Reason, StatusStopping) {
		t.Errorf("原因 = %q", instance.Reason)
	}
}

// Multi-replica correctness: one quiet replica must not take the service down.
func TestEvaluateOneServingReplicaIsEnough(t *testing.T) {
	fresh := serving("scheduler", "scheduler-1")
	stale := serving("scheduler", "scheduler-0")
	stale.Age = time.Hour

	readiness := Evaluate([]Heartbeat{stale, fresh}, []string{"scheduler"}, DefaultMaxAge)
	if !readiness.Ready {
		t.Fatalf("有健康副本时应当就绪：%s", readiness.Reason)
	}
	// The quiet replica still has to be visible, otherwise an operator cannot see
	// that half the replicas are gone.
	if len(readiness.Services[0].Instances) != 2 {
		t.Fatalf("实例条数 = %d，期望 2（含过期副本）", len(readiness.Services[0].Instances))
	}
	if readiness.Services[0].Instances[0].Serving {
		t.Error("按实例名排序后第一项应当是过期的 scheduler-0")
	}
}

func TestEvaluateFailingDependencyBlocksService(t *testing.T) {
	row := serving("scheduler", "scheduler-0")
	row.Dependencies = map[string]string{"postgres": "unreachable"}
	readiness := Evaluate([]Heartbeat{row}, []string{"scheduler"}, DefaultMaxAge)

	if readiness.Ready {
		t.Fatal("依赖不可用时不应就绪")
	}
	instance := readiness.Services[0].Instances[0]
	if instance.Serving {
		t.Error("依赖不可用的实例不应算 serving")
	}
	if !strings.Contains(instance.Reason, "postgres") {
		t.Errorf("原因未点出依赖名：%q", instance.Reason)
	}
}

// A dependency only counts against the instance that reported it. A quiet
// replica complaining about PostgreSQL must not condemn a healthy sibling.
func TestEvaluateIgnoresDependenciesOfNonServingInstances(t *testing.T) {
	stale := serving("scheduler", "scheduler-0")
	stale.Age = time.Hour
	stale.Dependencies = map[string]string{"postgres": "unreachable"}
	fresh := serving("scheduler", "scheduler-1")

	readiness := Evaluate([]Heartbeat{stale, fresh}, []string{"scheduler"}, DefaultMaxAge)
	if !readiness.Ready {
		t.Fatalf("健康副本应当足以就绪：%s", readiness.Reason)
	}
	// And the merged view must come only from serving instances.
	if got := readiness.Dependencies["postgres"]; got != DependencyOK {
		t.Errorf("合并依赖 postgres = %q，期望 %s", got, DependencyOK)
	}
}

func TestEvaluateReportsUnknownServicesWithoutAffectingReadiness(t *testing.T) {
	rows := []Heartbeat{serving("scheduler", "scheduler-0"), serving("schedular", "typo-0")}
	readiness := Evaluate(rows, []string{"scheduler"}, DefaultMaxAge)

	if !readiness.Ready {
		t.Fatalf("非必需服务不应影响就绪：%s", readiness.Reason)
	}
	// A typo in the required list then shows up as one missing plus one unknown,
	// which points straight at the mistake.
	if len(readiness.Unknown) != 1 || readiness.Unknown[0] != "schedular" {
		t.Errorf("Unknown = %v，期望 [schedular]", readiness.Unknown)
	}
}

// Map iteration order is random, so an unsorted reason would name a different
// dependency on each run and no test could pin the behaviour down.
func TestEvaluateReasonIsDeterministicWithTwoFailingDependencies(t *testing.T) {
	for i := 0; i < 50; i++ {
		row := serving("scheduler", "scheduler-0")
		row.Dependencies = map[string]string{"redis": "unreachable", "postgres": "unreachable"}
		readiness := Evaluate([]Heartbeat{row}, []string{"scheduler"}, DefaultMaxAge)
		reason := readiness.Services[0].Instances[0].Reason
		if !strings.Contains(reason, "postgres") {
			t.Fatalf("第 %d 次原因 = %q，期望按名排序取 postgres", i, reason)
		}
	}
}

// An empty required set makes readiness vacuously true. On a gate that opens
// management APIs that is a fail-open path, so it is treated as not ready.
func TestEvaluateEmptyRequiredSetIsNotReady(t *testing.T) {
	for _, required := range [][]string{nil, {}} {
		readiness := Evaluate([]Heartbeat{serving("scheduler", "scheduler-0")}, required, DefaultMaxAge)
		if readiness.Ready {
			t.Fatal("空必需集不应判为就绪")
		}
		if readiness.Reason != "未配置必需服务清单" {
			t.Errorf("原因 = %q", readiness.Reason)
		}
	}
}

func TestEvaluateMaxAgeDefaultsWhenUnset(t *testing.T) {
	row := serving("scheduler", "scheduler-0")
	row.Age = DefaultMaxAge - time.Second
	if readiness := Evaluate([]Heartbeat{row}, []string{"scheduler"}, 0); !readiness.Ready {
		t.Fatalf("未指定上限时应回落 DefaultMaxAge：%s", readiness.Reason)
	}
}

func TestParseRequiredServices(t *testing.T) {
	t.Run("空值回落到默认闭集而不是空集", func(t *testing.T) {
		services, err := ParseRequiredServices("")
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if len(services) != len(DefaultRequiredServices) {
			t.Fatalf("条数 = %d，期望 %d", len(services), len(DefaultRequiredServices))
		}
	})

	t.Run("显式覆盖并去空白", func(t *testing.T) {
		services, err := ParseRequiredServices(" scheduler , governance ")
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if len(services) != 2 || services[0] != "scheduler" || services[1] != "governance" {
			t.Errorf("services = %v", services)
		}
	})

	t.Run("拒绝空项", func(t *testing.T) {
		if _, err := ParseRequiredServices("scheduler,,governance"); err == nil {
			t.Fatal("期望报错")
		}
	})

	t.Run("拒绝重复", func(t *testing.T) {
		if _, err := ParseRequiredServices("scheduler,scheduler"); err == nil {
			t.Fatal("期望报错")
		}
	})
}

func TestDefaultRequiredServicesHasNoDuplicates(t *testing.T) {
	seen := map[string]bool{}
	for _, service := range DefaultRequiredServices {
		if seen[service] {
			t.Fatalf("默认必需集重复：%s", service)
		}
		seen[service] = true
	}
}

// The publisher and the reader must agree on the table and the age expression,
// otherwise the two halves could drift apart with nothing failing.
func TestSchemaConstantsAreConsistent(t *testing.T) {
	for name, statement := range map[string]string{"UpsertSQL": UpsertSQL, "SelectSQL": SelectSQL, "PruneSQL": PruneSQL, "CreateTableSQL": CreateTableSQL, "UpgradeSQL": UpgradeSQL} {
		if !strings.Contains(statement, Table) {
			t.Errorf("%s 未引用表名常量 %s", name, Table)
		}
	}
	if !strings.Contains(SelectSQL, "now() - observed_at") {
		t.Error("SelectSQL 必须在数据库侧计算 age，不能拿 Go 的时钟去比另一台机器的时间")
	}
	// Losing the composite key would silently collapse replicas into one row
	// again, which is the defect 004_service_heartbeats.sql exists to fix.
	if !strings.Contains(CreateTableSQL, "PRIMARY KEY (service, instance)") {
		t.Error("CreateTableSQL 必须使用 (service, instance) 复合主键")
	}
	if !strings.Contains(UpgradeSQL, "PRIMARY KEY (service, instance)") {
		t.Error("UpgradeSQL 必须把旧表的主键纠正为 (service, instance)")
	}
	if !strings.Contains(UpgradeSQL, "ADD COLUMN IF NOT EXISTS dependencies") {
		t.Error("UpgradeSQL 必须补上 dependencies 列")
	}
	// The upsert's conflict target has to match the key, or every write fails at
	// runtime with "no unique or exclusion constraint matching".
	if !strings.Contains(UpsertSQL, "ON CONFLICT (service, instance)") {
		t.Error("UpsertSQL 的冲突目标必须与复合主键一致")
	}
}
