// Command scheduler 是全局任务调度服务（§6.2 / §7.4.1，评审 N1）。
//
// leader 选举基于 PG 单行租约（spec 决策：fencing 与写路径同源），
// 放置写入事务内 fencing 校验；派发走 PG outbox（§13.2 本地替代 RocketMQ）。
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/lumo-harness/platform/heartbeat"
	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func main() {
	var (
		pgDSN             = flag.String("pg", envOr("LUMO_PG_DSN", "postgres://lumo:lumo@localhost:55432/lumo"), "PostgreSQL DSN")
		listen            = flag.String("listen", envOr("LUMO_LISTEN", ":8083"), "HTTP 监听地址")
		instance          = flag.String("instance", envOr("LUMO_INSTANCE", "scheduler-0"), "本实例标识（租约 holder，重启后不得与旧进程重复）")
		ttlMs             = flag.Int64("ttl-ms", envOrInt("LUMO_TTL_MS", 10000), "租约 TTL（毫秒）")
		drainMs           = flag.Int64("drain-ms", envOrInt("LUMO_DRAIN_MS", 1000), "drain loop 周期（毫秒）")
		metricsMs         = flag.Int64("metrics-ms", envOrInt("LUMO_METRICS_MS", 30000), "节点快照刷新周期（毫秒，供集群维度指标使用）")
		reapMs            = flag.Int64("stall-reap-ms", envOrInt("LUMO_STALL_REAP_MS", 300000), "停滞任务收割周期（毫秒）")
		maxStallMs        = flag.Int64("max-stall-ms", envOrInt("LUMO_MAX_STALL_MS", 28800000), "停滞判定宽限期（毫秒，默认 8h；负值=关闭停滞收割）")
		clusterID         = flag.String("cluster-id", envOr("LUMO_SCHEDULER_CLUSTER_ID", ""), "本实例代表哪个集群自报存活；留空=本实例不自报（判定仍可由 -cluster-enforce 单独打开）")
		clusterEnf        = flag.String("cluster-enforce", envOr("LUMO_CLUSTER_ENFORCE", ""), "本实例是否参与集群失联判定（闸门+指标）；留空=由 -cluster-id 派生（设了身份即判定）")
		clusterSelfReport = flag.String("cluster-self-report", envOr("LUMO_CLUSTER_SELF_REPORT", ""), "本实例是否替 -cluster-id 的集群自报存活；留空=由身份派生（有身份即自报）。认领身份但不自报的组合见 domain.ResolveClusterSelfReport")
		suspectMs         = flag.Int64("cluster-suspect-ms", envOrInt("LUMO_CLUSTER_SUSPECT_MS", domain.DefaultClusterThresholds().SuspectMS), "集群可疑阈值（毫秒）：距上次自报超过它即停止向其新放置")
		downMs            = flag.Int64("cluster-down-ms", envOrInt("LUMO_CLUSTER_DOWN_MS", domain.DefaultClusterThresholds().DownMS), "集群下线阈值（毫秒）")
		migrateMs         = flag.Int64("migrate-ms", envOrInt("LUMO_MIGRATE_MS", 30000), "集群失联后任务漂移循环周期（毫秒，负值=关闭漂移）")
		graceMs           = flag.Int64("migrate-grace-ms", envOrInt("LUMO_MIGRATE_GRACE_MS", 300000), "集群进入 down 之后额外等待多久才漂移它的任务（毫秒）")
		// 版本一致性前置（§7.4.1）与偏好打分（C1 剩余）。三个都是**新增**的部署面，
		// 名字必须与文档/拓扑里写的一模一样（部署侧的变量名必须等于代码读的那个名字）。
		clusterVer  = flag.String("cluster-version", envOr("LUMO_CLUSTER_VERSION", ""), "本实例替所代表集群声明的版本（版本一致性前置的唯一输入）；留空=不声明")
		versionGate = flag.String("cluster-version-gate", envOr("LUMO_CLUSTER_VERSION_GATE", ""), "版本一致性前置：true=全局放置只落到版本可证明一致的集群；留空/false=关闭")
		loadWeight  = flag.Float64("placement-load-weight", envOrFloat("LUMO_PLACEMENT_LOAD_WEIGHT", domain.DefaultPlacementWeights().Load), "放置打分负载项权重（必须 > 0；0 会把放置退化成按亲和硬选）")
		affinWeight = flag.Float64("placement-affinity-weight", envOrFloat("LUMO_PLACEMENT_AFFINITY_WEIGHT", domain.DefaultPlacementWeights().Affinity), "放置打分亲和项权重（0=关闭偏好排序；它/负载权重=亲和能翻转的最大负载比差）")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	// 阈值校验放在连库之前：配置反了（suspect ≥ down）时 suspect 永远不可达，
	// 而「没有可疑集群」与「一切健康」长得一模一样——一个静默失效的状态机比一个
	// 起不来的进程危险得多，所以这里拒绝启动并点名变量，不 clamp。
	thresholds := domain.ClusterThresholds{SuspectMS: *suspectMs, DownMS: *downMs}
	if err := thresholds.Validate(); err != nil {
		log.Error("集群失联判定阈值非法，拒绝启动", "err", err)
		os.Exit(2)
	}

	// 漂移宽限同样在连库之前校验。负数在这里**拒绝启动**而不是 clamp：
	// `-1` 在本仓库的约定里表示「显式关闭」，但那是**循环开关**的语义（见
	// LUMO_MIGRATE_MS 的负值），宽限期是**时间量**。两个含义挤进同一个数值，
	// 会让人以为「宽限=0」等于「漂移关着」——它其实是「down 即漂移」，
	// 是这个功能最激进的档位。
	if err := domain.ValidateMigrationGrace(*graceMs); err != nil {
		log.Error("集群任务漂移宽限期非法，拒绝启动", "err", err)
		os.Exit(2)
	}

	// 同样放在连库之前：`LUMO_CLUSTER_ENFORCE` 打错字会让判定悄悄关掉，而
	// 「判定关着」与「所有集群都健康」在面板上长得一模一样（同阈值的理由）。
	enforcement, err := domain.ResolveClusterEnforcement(*clusterEnf, *clusterID)
	if err != nil {
		log.Error("集群判定开关非法，拒绝启动", "err", err)
		os.Exit(2)
	}

	// 版本闸门同样是三态，同样在连库之前校验：打错字会让闸门悄悄关掉，而
	// 「闸门关着」与「版本本来就一致」在面板上长得一模一样（同上面的理由）。
	versionGateOn, err := domain.ResolveVersionGate(*versionGate)
	if err != nil {
		log.Error("版本一致性前置开关非法，拒绝启动", "err", err)
		os.Exit(2)
	}

	// 「本实例是否替它的集群自报存活」——与身份分开解析。留空 = 由身份派生，
	// 所以既有拓扑（compose 那两个每集群实例）的行为逐字不变；Helm chart 要的
	// 「认领身份但不自报」现在写得出来了（见 domain.ResolveClusterSelfReport）。
	selfReport, err := domain.ResolveClusterSelfReport(*clusterSelfReport, *clusterID)
	if err != nil {
		log.Error("集群自报开关非法，拒绝启动", "err", err)
		os.Exit(2)
	}

	// 偏好打分权重：非法值**拒绝启动**而不是回落默认值。`load=0` 会让放置退化成
	// 「按亲和硬选」（一个集群被写满、另一个空转），而它看起来只是「配置没生效」。
	weights := domain.PlacementWeights{Load: *loadWeight, Affinity: *affinWeight}
	if err := weights.Validate(); err != nil {
		log.Error("放置打分权重非法，拒绝启动", "err", err)
		os.Exit(2)
	}
	server.LogPlacementWeights(log, weights)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	shutdownOTel, telemetryErr := observability.ConfigureOTelFromEnv(ctx, "lumo-scheduler")
	if telemetryErr != nil {
		log.Error("invalid OpenTelemetry configuration", "err", telemetryErr)
		os.Exit(2)
	}

	st, err := store.New(ctx, *pgDSN)
	if err != nil {
		log.Error("连接存储失败", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.Init(ctx); err != nil {
		log.Error("初始化表结构失败", "err", err)
		os.Exit(1)
	}

	// 心跳上报：集群就绪态由心跳新鲜度与自报依赖派生（E4/D6），不再只看
	// LUMO_CLUSTER_STATUS 这个静态声明。实例名沿用 -instance，与租约 holder 同源。
	heartbeat.StartPg(ctx, st.Pool(), heartbeat.Options{
		Service: "scheduler", Instance: *instance, Logger: log,
		Depends: heartbeat.PgDependency(st.Pool()),
	})

	var cat catalog.Catalog = &catalog.Pg{Pool: st.Pool()}
	if nacosAddr := os.Getenv("LUMO_NACOS_ADDR"); nacosAddr != "" {
		cat = catalog.NewNacos(nacosAddr, os.Getenv("LUMO_NACOS_SERVICE"), os.Getenv("LUMO_NACOS_GROUP"))
		log.Info("使用 Nacos 节点目录", "addr", nacosAddr)
	}
	// 联邦注册表打开判定时，目录给出的每个节点都带上它所属集群的状态（放置闸门的输入）。
	// 包在目录这一层而不是各个调用点：List 在放置、节点列表、控制面寻址与指标快照
	// 四处被调用，逐个加必然漏一处，而漏掉的那处就是「闸门在这条路上不生效」。
	//
	// 两个闸门是**独立**的开关，装饰器按并集安装：只开版本闸门时 HealthGate 为 false，
	// 节点不会被存活判定挡住，也不带状态（否则「只想拦版本不一致」的部署会顺手把
	// 存活闸门也打开——那是另一个部署决策）。
	if enforcement.Enabled || versionGateOn {
		cat = catalog.WithClusterStates(cat, st, domain.ClusterAnnotation{
			Thresholds:  thresholds,
			HealthGate:  enforcement.Enabled,
			VersionGate: versionGateOn,
		}, log)
	}
	elec := &election.State{}
	workers := catalog.WorkerDirectory{URL: os.Getenv("LUMO_GOVERNANCE_URL"), Token: os.Getenv("LUMO_CONTROL_PLANE_TOKEN")}

	// HTTP 层在这里就构造出来（而不是等下面那段），因为 drain 循环要用它的
	// `PreparePlacement` / `PickPrepared`：放置决策必须在两条路径上共用同一份实现，
	// 各拼一遍的漂移方向恰好是「drain 里漏掉了亲和输入」。
	api := server.New(st, elec, cat, log, os.Getenv("LUMO_SUBAGENT_HOST_TOKEN"))
	api.SetWorkerDirectory(workers)
	api.SetPlacementWeights(weights)

	// 选主循环：acquire + 续租（TTL/3）
	electionCtx, cancelElection := context.WithCancel(ctx)
	go election.Run(electionCtx, elec, st, *instance,
		time.Duration(*ttlMs)*time.Millisecond, func(isLeader bool) {
			log.Info("领导权变更", "leader", isLeader, "instance", *instance)
		})

	// 集群本地租约：全局调度缺席时，本集群仍要有一个（且只有一个）决策者。
	// 只在设了 -cluster-id 时启动——没有集群身份的实例无从判断「本地」是什么，
	// 让它参与只会造出一把「所有没有身份的实例」共用的锁（RunCluster 里同一条判据）。
	//
	// 它**不替代**全局租约：两条路径的准入判据在 server.degradedPlacement 里。
	clusterElec := &election.State{}
	if *clusterID != "" {
		go election.RunCluster(electionCtx, clusterElec, st, *clusterID, *instance,
			time.Duration(*ttlMs)*time.Millisecond, func(isLeader bool) {
				log.Info("集群本地决策权变更（降级路径）", "leader", isLeader, "cluster_id", *clusterID, "instance", *instance)
			})
	}
	api.SetClusterPlacement(*clusterID, clusterElec)

	// drain loop：leader 时把 PENDING 任务接续放置（非 leader 空转，不查库）
	go func() {
		ticker := time.NewTicker(time.Duration(*drainMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !elec.IsLeader() {
					continue
				}
				if _, err := st.RequeueStaleDispatch(ctx, *ttlMs*2); err != nil {
					log.Warn("回收过期派发失败", "err", err)
				}
				drainOnce(ctx, st, cat, elec.Current(), log, api, workers)
			}
		}
	}()

	// 联邦注册表：上报/查询端点始终装配（它们是**别的集群**上报的入口），
	// 而「判定（闸门 + 集群维度指标）」与「本实例自报」是两个**独立**的开关：
	// 前者是本实例判不判别人，后者是本实例替谁宣称存活。全局调度实例服务多个集群时
	// 正需要「判定开、自报关」这一档（理由见 domain.ResolveClusterEnforcement）。
	// 半开的注册表是自伤：判定开着而没有上报方时，所有集群都会走到 down。
	api.SetClusterRegistry(st, thresholds, enforcement.Enabled, versionGateOn)
	if *clusterID != "" && !selfReport {
		// 认领了身份但不自报：这是 Helm chart 要的那一档。自报方仍是节点池——
		// 「调度器还在跑」不等于「这个集群还能接放置」，把节点池缩到 0 时调度器照旧活着。
		// 但身份仍然有用：它让**集群本地放置降级**知道「本地」是哪个集群。
		log.Info("集群身份已认领但不自报存活：本实例只做本地放置决策，自报方是节点池",
			"cluster_id", *clusterID, "self_report", false, "enforce", enforcement.Enabled)
	}
	if *clusterID != "" && selfReport {
		realm := envOr("LUMO_REALM", "dev")
		log.Warn("集群自报已启用：本实例代表该集群自报存活。"+
			"**被纳入放置的每个集群都必须有上报方**，否则它们会在 down 阈值后一起拒绝新放置",
			"cluster_id", *clusterID, "realm", realm,
			"enforce", enforcement.Enabled, "enforce_explicit", enforcement.Explicit,
			"suspect_ms", thresholds.SuspectMS, "down_ms", thresholds.DownMS,
			"report_ms", thresholds.ReportInterval().Milliseconds(),
			"declared_version", *clusterVer)
		go api.RunClusterReporter(ctx, server.ClusterIdentity{
			ClusterID: *clusterID, Realm: realm, Version: *clusterVer,
		}, thresholds.ReportInterval())
	} else {
		log.Info("本实例不自报集群存活（未设 LUMO_SCHEDULER_CLUSTER_ID）：自报由集群侧发起", "enforce", enforcement.Enabled)
	}
	if enforcement.Enabled {
		// 「判定开 + 本实例不自报」是全局调度实例的正常形态，但它的正确性完全
		// 依赖**集群侧有上报方**。这一档必须显式说出来：一个只配了判定、没人配
		// 上报方的部署，症状是一段时间后所有集群一起变成 down、新放置全被拒。
		log.Warn("集群失联判定已启用：可疑/下线集群将不再接受新放置（已有任务不动）。"+
			"**被纳入放置的每个集群都必须有上报方**（本集群的调度实例或集群侧节点），"+
			"否则它们会在 down 阈值后一起拒绝新放置",
			"self_reports", *clusterID != "", "enforce_explicit", enforcement.Explicit,
			"suspect_ms", thresholds.SuspectMS, "down_ms", thresholds.DownMS)
	} else {
		log.Info("集群失联判定未启用：注册表仍可收上报、但仍会给出状态，闸门恒放行",
			"cluster_id", *clusterID, "enforce_explicit", enforcement.Explicit)
	}

	// 版本闸门的生效范围必须说全，因为它拦的是**全局**任务：只报「已启用」会让人
	// 以为集群固定放置也会被拦。同时点名它唯一的输入（LUMO_CLUSTER_VERSION）——
	// 闸门开着而整个拓扑没人声明版本时它恒放行，那个组合与「版本一致」长得一样，
	// 是本功能最可能的静默失效。
	if versionGateOn {
		log.Warn("版本一致性前置已启用：**全局**任务（未指定 cluster_id）只会落到版本"+
			"可证明一致的集群上；版本分叉时全局任务转排队而不是报错。指定了 cluster_id 的"+
			"放置不受影响（那是运维的显式意图）。本闸门的唯一输入是各集群自报的版本"+
			"（集群侧 LUMO_CLUSTER_VERSION / 本实例的 -cluster-version）——"+
			"**整个拓扑没有任何声明时闸门恒放行**，而它与『版本一致』在面板上长得一样",
			"health_gate", enforcement.Enabled, "declared_version", *clusterVer)
	} else {
		log.Info("版本一致性前置未启用（LUMO_CLUSTER_VERSION_GATE 未设）：全局放置不看版本",
			"declared_version", *clusterVer)
	}

	// 节点快照刷新：/metrics 是抓取路径，不能在里面查目录（见 server/metrics.go）。
	// 每个副本都刷，不只在 leader 上——Prometheus 是逐个副本抓的。
	metricsCtx, cancelMetrics := context.WithCancel(ctx)
	defer cancelMetrics()
	go api.RunMetricsRefresh(metricsCtx, time.Duration(*metricsMs)*time.Millisecond)

	// 停滞收割：把「所属节点已不在目录中且静默超过 max_stall」的活跃任务转死信
	// （spec §7.4.2）。只消费上面那个循环刷出的快照，不自己查目录——快照不新鲜
	// 时它整轮不动手，而不是拿旧数据做不可逆操作。
	reapCtx, cancelReap := context.WithCancel(ctx)
	defer cancelReap()
	go api.RunStallReaper(reapCtx, time.Duration(*reapMs)*time.Millisecond, time.Duration(*maxStallMs)*time.Millisecond)

	// 跨集群任务漂移（§7.4.1：集群进入 down 之后把它的任务「漂回全局 Task Bus
	// 重放置」）。时间线是三段的，日志要把**生效的**那一段完整说出来：
	// suspect(默认 30s) 停止新放置 → down(默认 90s) → **down + grace** 才漂移已有
	// 任务。只报 down 阈值会让人以为 90s 后任务就搬走了——而运维的应急预案是按
	// 「什么时候任务会开始搬家」定的，不是按「什么时候不再接新活」定的。
	migrateCtx, cancelMigrate := context.WithCancel(ctx)
	defer cancelMigrate()
	if *migrateMs < 0 {
		log.Warn("集群任务漂移已关闭（LUMO_MIGRATE_MS 为负）：失联集群上的任务不会被自动搬走，只能人工处理")
	} else {
		log.Info("集群任务漂移已启用",
			"migrate_ms", *migrateMs, "grace_ms", *graceMs,
			"suspect_ms", thresholds.SuspectMS, "down_ms", thresholds.DownMS,
			"migrate_after_ms", thresholds.DownMS+*graceMs,
			"enforced", enforcement.Enabled, "self_reports", *clusterID != "")
		go api.RunClusterTaskMigrator(migrateCtx, time.Duration(*migrateMs)*time.Millisecond,
			time.Duration(*graceMs)*time.Millisecond)
	}

	srv := &http.Server{
		Addr:              *listen,
		Handler:           observability.Middleware(observability.RequireControlPlaneToken(os.Getenv("LUMO_CONTROL_PLANE_TOKEN"))(api.Routes())),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("调度服务启动", "listen", *listen, "instance", *instance, "ttl_ms", *ttlMs)
		if err := observability.Serve(srv); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP 服务异常退出", "err", err)
			stop()
		}
	}()

	<-ctx.Done()

	// 优雅停机顺序（spec §2）：
	// ① 停选主循环——先停止续租，否则 Release 之后一轮续租会把租约「复活」；
	// ② 排空 HTTP——在途放置仍有效（租约尚未过期）；
	// ③ 释放租约（expires_at=0）——备节点零等待接管；
	// ④ 关池（defer st.Close）。
	log.Info("收到停机信号，开始优雅排空")
	cancelElection()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("排空失败", "err", err)
	}
	if err := shutdownOTel(shutdownCtx); err != nil {
		log.Warn("flush OpenTelemetry failed", "err", err)
	}
	if err := st.Release(context.Background(), *instance); err != nil {
		log.Warn("释放租约失败", "err", err)
	}
	log.Info("调度服务已停止")
}

// drainOnce 一轮接续：取 PENDING → 规划 → 放置。任何一处失败仅记录并等下一轮。
//
// 放置决策走 api.PreparePlacement + api.PickPrepared（与 HTTP 放置路径同一份实现）：
// 各拼一遍的漂移方向恰好是「drain 里漏掉了亲和输入」，而那个症状（同一批任务走
// HTTP 有偏好、被 drain 接续时没有）几乎不可能从外部观察出来。
//
// 亲和输入**一次查完一轮的全部项目**而不是逐任务查：一轮最多 32 个任务，
// 逐任务查会把一轮变成 32 次往返，而它们本来只需要一条 `= ANY($2)`。
func drainOnce(ctx context.Context, st *store.Store, cat catalog.Catalog, lease *domain.Lease, log *slog.Logger, api *server.Server, directories ...catalog.WorkerDirectory) {
	var workers catalog.WorkerDirectory
	if len(directories) > 0 {
		workers = directories[0]
	}
	pending, err := st.PendingTasks(ctx, 32)
	if err != nil {
		log.Error("取排队任务失败", "err", err)
		return
	}
	if len(pending) == 0 {
		return
	}
	nodes, err := cat.List(ctx)
	if err != nil {
		log.Error("列节点失败", "err", err)
		return
	}
	active, err := st.ActiveCounts(ctx)
	if err != nil {
		log.Error("活跃计数失败", "err", err)
		return
	}
	prepared := make([]*domain.Task, 0, len(pending))
	for i := range pending {
		prepared = append(prepared, &pending[i])
	}
	api.PreparePlacement(ctx, prepared)
	for _, task := range planner.OrderPending(pending, time.Now()) {
		eligible, err := workers.Filter(ctx, task, nodes)
		if err != nil {
			log.Warn("Worker 设备目录不可用，保留排队任务", "task_id", task.TaskID, "err", err)
			continue
		}
		n := api.PickPrepared(ctx, task, eligible, active)
		if n == nil {
			continue // Other employees/Agents can still have eligible idle devices.
		}
		if err := st.SyncNodeSnapshot(ctx, *n); err != nil {
			log.Error("同步节点快照失败", "node_id", n.NodeID, "err", err)
			continue
		}
		if _, err := st.PlaceTask(ctx, lease, task, n.NodeID); err != nil {
			var ncap *domain.NoCapacityError
			if errors.As(err, &ncap) {
				continue
			}
			log.Error("drain 放置失败", "task_id", task.TaskID, "err", err)
			continue
		}
		active[n.NodeID]++
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return fallback
}

// envOrFloat 读浮点配置。
//
// 解析失败**回落默认值**而不是报错——与 envOrInt 一致。这里刻意不做得更严格：
// 严格版要区分「没设」与「设错了」，而那个区分只在 `flag` 层做得干净（`-flag=x` 会
// 直接报错退出）。真正的把关在下游的 Validate()：它拿到的是已经解析出来的值，
// 非法值（≤0、NaN、Inf）在那里拒绝启动。
func envOrFloat(key string, fallback float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return fallback
}
