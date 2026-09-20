# Cluster development tasks

Scope: the remaining code and assembly gaps in `cluster-gap-analysis.md`.
The audit is a starting point; existing implementations are reused where its findings are outdated.

Current scope: continue cluster development. Connector and MCP development,
including the desktop connector Hub integration and E7, is paused by request.

| Area | Task | Status |
| --- | --- | --- |
| A1 | Real flow operators, discovery and definition validation | Implemented: `internal/engine/runtime.go` `registerRuntime` registers `llm.chat`/`llm.answer`/`connector.invoke`/`tool.invoke`/`knowledge.query`/`kb.query` and maintains an `unavailable` map so an unconfigured, malformed or unauthenticated upstream reports a readable reason instead of a runtime 422. Connector execution work remains paused by request |
| A2 | Durable cron automation scheduling | Implemented: `internal/cron` (5-field parser, DST-safe `Next`/`Due`), `internal/schedule` producer, `flow_cron_cursors` with atomic advance-and-enqueue, `source`-branched binding JOIN, project-scoped stall inspection endpoint. PostgreSQL integration verification pending (see "Cron scheduling: 2026-09-14") |
| A3 | Published document outbox to knowledge indexing | Implemented: `internal/indexing` (deterministic chunker, dispatcher, seam HTTP adapter with signed per-realm identity), `PendingPublishes` now propagates realm/space/title, retry acknowledgment via `attempts`/`last_error`. PostgreSQL integration verification pending (see "Published document indexing: 2026-09-14") |
| A4 | Authenticated Agent runtime reporting and expiry | Implemented; runtime and server unit tests passed; full dispatch remains E3 |
| A5 | Usage analytics query surface | Implemented: PG-only read surface (`internal/analytics`, `GET /v1/usage/aggregate`) with a UTC reporting day, half-open interval, 366-day span cap and 400/500 separation. The Doris projection/replay chain was **removed by decision** rather than wired (see "Usage analytics: 2026-09-14"). PostgreSQL integration verification pending |
| B1 | Seam Host/Proxy runtime and deployment assembly | Implemented: `data-plane/dsh-node/src/cluster.ts` `clusterWiring` resolves seam mode (defaulting host/proxy by role in cluster), validates endpoints and requires the mTLS triple as a set; `index.ts` mounts the seam plugin rows and picks the injected surface per mode. Deployment acceptance pending |
| B2 | RocketMQ ledger assembly in cluster mode | Implemented: `clusterWiring` defaults `ledgerTransport` to `rmq` in cluster mode (rejecting unknown values) and `index.ts` injects it into metering |
| B3 | Milvus, Nebula and reranking assembly | Implemented: milvus collection/rebuild URL, nebula URL and the rerank triple are read by `clusterWiring` and injected into the knowledge plugin. The external services themselves are still absent from orchestration (see D1) |
| B4 | Central OPA session control policy | Implemented: `LUMO_OPA_ADDR`/`LUMO_OPA_TOKEN` are read by `clusterWiring` and injected into the control plugin |
| B5 | Verified artifact distribution and skill snapshots | Implemented: `index.ts` reads `PROVISIONER_ARTIFACT_NAME`, derives the snapshot root/file, waits for the snapshot file to appear, then assembles skill-local rows via `skills.ts` and disables the filesystem overlay. The empty compose default is a deployment decision (the operator must pin which artifact to roll out), not a code gap |
| B6 | Authoritative session head and stale-read detection | Implemented; PostgreSQL integration verification pending |
| C1 | Cluster directory, failure detection and scheduling | **Implemented (this round)** (2026-09-15): the federated registry (`scheduler_clusters`), the two-stage judgement (`healthy → suspect(30s) → down(90s)`, a pure function over **database-clock** ages), the placement gate (`suspect`/`down` clusters accept no **new** placements, and the preemption path cannot bypass it), cluster-dimension metrics (age / one-hot state / registry readability) and the `LumoClusterStoppedReporting` rule. **Down-migration closed 2026-09-16** (design §9): tasks on a `down` cluster are returned to the global queue after `down + grace`, through five gates (leader / registry readable / fresh catalog snapshot / cluster past its timeline / **owning node absent from the directory**), with a conditional write plus a `scheduler_task_migrations` ledger. Fencing needs **no new mechanism**: `attempt` is deliberately not advanced, so the old node's terminal report fails the "still active **and** same attempt" check; unclaimed dispatches for that attempt are voided in the same transaction (otherwise `outbox` would hand the work back to the old node) and the old node is appended to `avoid_nodes`. Two boundaries worth remembering: gate ⑤ is **always satisfied** under Nacos (the directory only lists healthy instances) and **never satisfied** under Pg (`scheduler_nodes` is append-only) — the latter is correct, since the Pg form is single-cluster and there is nowhere to migrate to, the same structural fact as C2/R8's "`task_lost` is always 0 under local-lite". The end-to-end drill **proves the source half only**: with a real process, a real PG and a genuinely silent cluster, the task was returned to the global queue in the first loop after `down + grace` elapsed (2088ms observed against a 2000ms threshold). **Not proven**: the target half — the task landing on a healthy node in another cluster (`acceptance-cluster.sh` has no probe for it), §9.10. Still open: global/cluster scheduler layering, preference scoring, version-consistency gating, and the Nacos-form reporting link (TS/dsh-node side). The reconnaissance changed the plan: `catalog/nacos.go:71-73` returns only healthy instances, so **cluster liveness cannot be derived from the node directory** — a lost cluster and a never-deployed one are indistinguishable there, which is what the federated registry exists for. Two design points were dropped during implementation, each because the field could not be trusted: `Node.LastSeen` (traffic-driven in both catalog forms) and the "node registration touches the cluster row" corroboration (one liveness column must have one writer and one meaning) **Corrected 2026-09-17**: two of the four items this row listed as "still open" are **closed** — preference scoring (`planner.PickWeighted`, `scheduler/internal/server/placement.go:74`) and version-consistency gating (`ClusterVersionUnproven` + `declared_version`, pinned by `scheduler/internal/domain/version_gate_test.go`) shipped on 2026-09-17; see the C1 section of `implementation-status.md`. The row carried no 2026-09-17 record at all. Still open from that list: **global/cluster scheduler process layering** (design doc line 45 defers it) — but **the concrete thing that deferral named was closed on 2026-09-17**: `architecture.md:721`'s "cluster-local placement degradation lands with the cluster Scheduler". It shipped without splitting the process, by giving each cluster a **narrower-scoped lease** (`scheduler_cluster_lease`, one row per cluster): with no global leader, a task for *this* cluster is still placed locally, while **cross-cluster placement stays 503** — that is the genuinely global decision. Fencing picks its table from the lease's own scope, and the cross counter-case (a released cluster lease must not authorise a placement) was mutation-verified. Design: `docs/superpowers/specs/2026-09-17-cluster-local-placement-degradation-design.md`. **What remains is only the process shape** — and note the split is what costs the nine wiring surfaces, which this round did not need to touch. **Corrected again 2026-09-17 (later the same day): the "Nacos-form reporting link on the dsh-node side" is NOT open — it shipped.** `cluster-reporter.ts` performs `PUT /v1/clusters/{id}` (`:236-238`, after `:206` reads `suspect_ms` from `GET /v1/clusters` so the period is derived from the control plane rather than configured a second time) and is mounted at `data-plane/dsh-node/src/index.ts:638-659`; `cluster-gap-analysis.md` already records it as closed. **Note the direction of this error**: an over-claim of "still open" sends the next person to build something that exists — the mirror image of the usual stale-checklist failure, and indistinguishable from it by reading the row alone. Lesson: recording the implementation in one file while leaving the status in another guarantees drift. |
| C2 | Global execution monitoring and alerts | Implemented (2026-09-15): see "Global execution monitoring: 2026-09-15". Eleven rules cover the six §7.4.2 classes plus two deliberate extras (`instance_down`, `latency`), each carrying `class`/`tier`/`severity`; two structurally dead rules were fixed by deleting the metric they depended on; the metric layer gained labelled gauges and `ReplaceGauges` (incremental writes cannot express a vanished dimension); `max_stall` reaping converts orphaned active tasks to dead letters. The reference-integrity gate ships with nine counter-cases. Live-PostgreSQL integration cases and a real `promtool` run are unverified |
| C3 | Authenticated edge gateway routing | Implemented (service side, 2026-09-16): `platform/control-plane/edge-gateway/` is the outermost north-south entry — `internal/routing` (declarative JSON/env route table, validated **entirely at load time**, with an explicit upstream-host whitelist because "a route pointing at a host that should not be reachable" must be rejected before serving, not on first request; canary weight maps a seed to `[0,100)` via FNV-1a), `internal/proxy`, `internal/waf`, `internal/gate` (rate limit / body size / connections / CORS, reusing the shared `ratelimit` token bucket; `FailOpen` **defaults to false** so a Redis blip rejects rather than silently admits), `internal/server`. Wired on **all nine surfaces as of 2026-09-16**: `compose.cluster.yml:595-603` (host `18080:8080`, mounts `edge-routes.dev.json`), `compose.standalone.yml`, `prometheus.yml:37`, `prometheus-standalone.yml`, the `service=~` list in `prometheus-alerts.yml:258-276`, `build.sh` image list, `preflight-deployment.sh` service list, the CI matrix, and — the surface that was missing — **the Helm chart** (`services.edge-gateway`, port 8080, plus `templates/edge-routes.yaml`; see "Charting the two gateways: 2026-09-16" below). Guarded by `edge-routes-verify.sh` + `cmd/edge-gateway-check` (a dedicated route-table validator with counter-cases), which as of that day validates **both** deployed tables: `edge-routes.dev.json` and the one the chart renders. **Not done**: real-cluster end-to-end acceptance (`acceptance-cluster.sh` has no probe for it) |
| C4 | Terminal gateway and presence | Implemented (service side, 2026-09-16): `platform/control-plane/terminal-gateway/` — `internal/ws` (RFC6455 server subset), `internal/capability` (negotiation as a pure function), `internal/events` (terminal-agnostic event sink + replay cursor), `internal/presence` (**expiry by time, not TTL** + gauge replacement), `internal/policy` (signature + OPA fail-closed), `internal/server`. It deliberately **does not implement a state machine**: pause/resume/stop semantics live in session-control (§8.4.3 last line), so the terminal only renders a view and emits control events. Wired on **all nine surfaces as of 2026-09-16**: `compose.cluster.yml:611-621` (host `18091:8090`, **deliberately avoiding 18090**, which the optional device-gateway overlay already claims — declaring the same host port twice makes compose refuse to start), `compose.standalone.yml`, both `prometheus*.yml`, the alert list, `build.sh`, `preflight-deployment.sh`, CI matrix, and **the Helm chart** (`services.terminal-gateway`, port 8090, plus the `terminalGateway.signingSecret` it takes; this was the more telling omission, because `templates/configmap.yaml:30-35` already gave it a `LUMO_OPA_URL` value — the chart's own configuration assumed it ran there). Guarded by `compose-ports-verify.sh`, which carries that exact collision as a regression counter-case. **Honestly labelled gap inside the chart**: its event source is still unwired, so it answers 503 on the WebSocket face rather than inventing an empty history — `values.yaml` and `NOTES.txt` both say "a ready pod is not the same as replayable history". **Not done**: real-cluster end-to-end acceptance |
| C5 | Shared session control and console | Implemented (2026-09-16), service side: `platform/control-plane/session-control/` turns pause/resume/stop/abort/approve/reject/replay/degrade into **audited first-class events** (`session_control_state` + `session_control_audit`; rejections are audited too) and exposes the console's read projection (state / which buttons are clickable right now / timeline / queue state). See "Shared session control and deployment wiring: 2026-09-16" below. Two honest gaps: the dispatcher into the session execution face (§8.1 suspend / `agent.inject()`) is **not wired**, so every response reports `effectuation=recorded`; and the Session Console **UI** is not wired (the read projection it needs is ready). Three deliberate deviations from the literal §8.4.2 text are recorded in the section below  **Corrected 2026-09-17 — the "not wired" wording was wrong about *which* channel.** The dispatch channel for state-type commands is the PG table `session_control_state` itself: the `@lumo/control` dsh plugin reads it (1s cache) and enforces at `tools/pre-execute`. It was **broken, not missing** — the repo carried *two* §8.4 implementations that both created `session_control_state` / `session_control_audit` with `CREATE TABLE IF NOT EXISTS` but with **different columns and different state vocabularies** (Go: running/paused/awaiting-approval/stopped/aborted; plugin: running/paused/**stopping**/aborted plus a CHECK constraint). Whoever initialised first won, the other silently got a table it did not understand, and the plugin treated every unrecognised state as "no command" — so a session an operator had paused kept running side-effect tools. Fixed: the two shared tables are now **Go-only** (single writer, the same rule as §八/§九), the vocabulary is the Go five, the effector gate covers all five and **fails closed on unknown**, and `control-schema-contract.spec.ts` derives both sides from source (plus a live-PG end-to-end: Go DDL → Go-shaped row → plugin reads it back). **Corrected 2026-09-17 (later the same day) — both clauses of the previous wording were stale. The old text is kept verbatim first, because what it got wrong is more useful than the correction:** *"Still open: the plugin's `dispatch()` is now a local RBAC pre-flight that raises a typed routing error instead of writing the shared tables — routing it to the control plane's `POST /v1/sessions/{ref}/control` is the remaining step; and `agent/turn-stopping` cannot stop a turn at all (upstream returns `void`), so §8.1 suspend/`agent.inject()` is still the real gap behind "pause does not pause"."* **Neither is open.** ① `dispatch()` **does** route to the control plane: `pg-control.ts:120-135` runs the RBAC pre-flight and then calls `submit()`, and `:235-239` is a real `fetch(url, { method: 'POST' })` against `/v1/sessions/{ref}/control`. `ControlCommandRoutingError` is raised only when `controlPlaneUrl` is unset — which is the local shape, where there is no such service. ② "Pause does not pause" is closed by `actuation.ts`: `agent/pre-step` returns `{kind:'reject'}` to stop at the turn boundary — restoring the claimed messages first, because `claim` is consumption and rejecting outright would silently eat the user's input — and `agent.cancel` hard-cancels for abort. `agent/turn-stopping` genuinely cannot stop a turn (the upstream signature returns `void`), but it was **never the stopping point**; `actuation.ts`'s header names the two that are. So the residual is not "pause does not pause" but the granularity that §8.1's true suspend/`agent.inject()` would add. **What C5 still genuinely lacks is the two items `cluster-gap-analysis.md` lists** (the Go `control.Dispatcher` link into the replicated log, and the Session Console UI view) — note that this row named neither of them. **Lesson: this row and `cluster-gap-analysis.md` were written one minute apart and disagreed, and the row's own C1 entry already carries the diagnosis — one fact recorded in two places will diverge; the fix is to record it in one and cite it from the other.** |
| C6 | AgentTeams topology integration | Implemented: first-party `dsh-plugins/agent-teams` provides `ctx.agentTeams` from one codebase across local/standalone/cluster |
| C7 | Flow lineage projection | Implemented (2026-09-16): lineage lives in `flows/internal/lineage/lineage.go` (DAG → edge set as a **pure function**, no I/O) plus `flows/internal/store/lineage.go` (outbox table `flow_lineage_outbox`, written **in the same transaction** as the publish snapshot), with the read surface wired in `flows/cmd/flows/main.go` and `flows/internal/server`. **The key decision follows A5**: no second storage/query engine is introduced — **Nebula is only the presentation layer over this PG fact table**, fed asynchronously by a projector, so an unavailable Nebula cannot slow down or fail a publish. With `LUMO_FLOW_NEBULA_URL` empty the whole feature is off (no outbox rows, no projector, stated in the startup log and in `/metrics`), and the read surface then returns an explicit "unavailable" reason rather than an empty list pretending "there is no lineage" — same lesson as E7 (a silently narrowed result set is more dangerous than an error). **Note the earlier record was a false negative**: `lineage` sits under `flows/internal/`, not at the `control-plane/` top level, so a search scoped to the latter reported "no hits". **Not done**: Nebula itself is still absent from every orchestration file (= D1, a product decision; it does not block this PG fact chain) |
| C8 | LLM batch execution | Implemented (2026-09-16): `internal/batch/coalescer.go`. §7.2 asks the gateway to coalesce concurrent requests inside a time window so the upstream's own continuous batching sees a large batch instead of 1–2 requests per window. The gateway is a **proxy** — it cannot rewrite the inference request format, so the only thing it can and must do is **align random arrivals into simultaneous ones**. Three properties fix the shape: the added delay is **bounded by `Window` regardless of concurrency** (addition, not multiplication — worst case is one window off the TTFT budget, never "queue behind whoever is ahead"); a full `MaxBatch` **releases immediately**; and `Window == 0` means **entirely off**, with no goroutine and no timer on the pass-through path. Default off is deliberate: **trading TTFT for throughput is a deployment decision**, and cluster and single-node shapes have different optima. Assembly is `cmd/llm-gateway/main.go:68-114` (`LUMO_LLM_BATCH_WINDOW_MS`, `LUMO_LLM_BATCH_MAX`); an invalid configuration exits 2 **before** connecting to the database, because otherwise "misconfigured" and "database unreachable" look identical in the startup log. What it deliberately does *not* do is also in the package comment: no request-body merging (impossible, see above), no cross-model mixing (different models reach different upstreams, so mixing sends the request to the wrong one), and no backpressure queue (that would introduce unbounded waiting, contradicting the bounded-delay property) |
| D1 | Doris and Nebula deployment dependencies | Pending for Nebula: it is absent from every orchestration file (`compose.cluster.yml` / `compose.standalone.yml` / Helm) and defaults to empty in both `cluster-runtime.env` and Helm `values.yaml`. **Decoupled from D5 on 2026-09-15**: `acceptance-cluster.sh` no longer requires it (it is now an optional probe), so this is a product decision about whether the cluster should ship a graph engine, not an acceptance blocker. The Doris half was removed by decision (see A5) |
| D2 | Helm secrets and production assembly | Implemented (2026-09-15): the chart still ships no middleware, but the four Secrets it references now have a written contract instead of being inferred from templates. `templates/NOTES.txt` prints every Secret's name, key, consumer and content shape at install time (the `registry-trust.json` **key name** was previously unknowable, and a wrong volume key mounts an empty directory while the container starts happily). `secrets.create` (default `false`) optionally mints the two pure-random bearers plus a placeholder trust root `{"publishers":[]}`; `lumo-vault-token` and a real trust root are deliberately **never** generated — the first must match a Vault this chart does not deploy, the second is a set of publisher public keys (`registry/internal/trust/trust.go:47-52`). Generation goes through `lookup` so an ordinary `helm upgrade` cannot rotate tokens, and `helm.sh/resource-policy: keep` keeps credentials out of the delete path. No plaintext token is accepted from values. Empty Secret names are omitted rather than rendered as `name: ,`, which `helm template` used to report as success |
| D3 | Complete cluster deployment profile | Implemented (2026-09-15): added `values.cluster.yaml`, which decides all nine default-off switches and writes down the reason for each — on: `dshNode`, `dshWeb`, `secrets.create`, and per-service `replicas` for scheduler/collaborator to match `compose.cluster.yml`; off with external dependencies named: `connectorOAuth`, `deviceGateway{,.istioIngress}`, `serviceMesh.istio`, `productionControls{,.observability}`, `provisioner{,.runtime}`, `dshNode.governedWorker`. Also fixed a **P0 found while doing this**: only `collaborator` received `LUMO_INSTANCE`, and the scheduler resolves its lease holder from `LUMO_INSTANCE` falling back to the **literal `"scheduler-0"`** (`scheduler/cmd/scheduler/main.go:33`) — so `replicaCount: 2` produced two leaders that both pass `checkFencing`, because `Acquire` does not advance `fencing_token` when the holder is unchanged (`scheduler/internal/store/store.go:204-208`, checked at `:253`). Every control-plane service now takes `LUMO_INSTANCE` from `metadata.name`. Added `platform/deploy/helm-verify.sh`, a cluster-free render gate with four "must be rejected" counter-cases |
| D4 | Governance monitoring coverage | Implemented in Cluster and Standalone Prometheus configuration |
| D5 | Executable CI and cluster acceptance checks | Implemented (2026-09-15), including the CI switch: the chain now **refuses to report green with zero evidence** (per-step live-case counting), the silent-skip defect is fixed at the root (`platform/vitest.setup.ts`), `preflight-deployment.sh` requires the full shape-specific service set (cluster 33 / standalone 21, after the 2026-09-16 C5 wiring added session-control and closed the C3/C4 omissions), the Nebula over-requirement is removed, `collaborator` and `connector-gateway/internal/audit` joined the chain, `deploy/acceptance.env.example` supplies the `LUMO_TEST_*` contract, and `compose.cluster.acceptance.yml` + `LUMO_COMPOSE_EXTRA_FILES` publish the infrastructure ports the chain needs. The review also surfaced and fixed a **P0 sub-finding**: `up.sh` never reached `docker compose up` at all — a warning function returned non-zero under `set -e`, so `up.sh standalone` always exited 1 and `up.sh cluster` exited 1 on a first deploy. `.github/workflows/ci.yml` has since been read (2026-09-15): `deploy-smoke` really is `if: ${{ false }}`, and the **same zero-evidence defect was still live in the Go test job** — the DSN was injected for only 2 of the then-9 gated modules, so the other 7 modules' live-DB cases skipped silently while `go test` exited 0. Fixed, guarded and wired (see "CI evidence wiring" below). What remains is not code: no real multi-node run has been recorded yet |
| D6 | Health-derived readiness and device acceptance | Implemented: see "Health-derived readiness: 2026-09-14". Device gateway remains an optional overlay (`compose.cluster.devices.yml`) and is still uncovered by smoke/acceptance |
| E1 | Durable break-glass request and audit workflow | Not a gap: `governance/internal/breakglass` is a documented compliance boundary (`implementation-status.md`), deliberately providing policy-neutral data model plus in-memory implementation until a real approval/secret system is wired. Completing it is a product/compliance decision, not an oversight |
| E2 | Scheduler reconciliation repair | Not a gap (reclassified 2026-09-15): the earlier "never corrects `scheduler_tasks.state`" claim came from the doc comment, not the body. `store.go:966-976` does merge — `if e.Attempt > currentAttempt \|\| (e.Attempt == currentAttempt && stateRank(e.State) > stateRank(currentState))` then `UPDATE scheduler_tasks SET attempt, node_id, state, fencing_token`. Higher attempt wins; same attempt may only advance monotonically. The ledger insert stays idempotent per entry, which is what makes the merge a fixpoint |
| E3 | Scheduler dispatch outbox consumer | Not a gap (reclassified 2026-09-15): the outbox **has** two production consumers, both claiming inline in the same transaction that writes their admission receipt — `dsh-plugins/subagent-host/src/governed-dispatch.ts:61-123` (`PgGovernedDispatch.take()`, Agent path) and `governance/internal/store/devices.go:547-643` (`dispatchDeviceTask`, desktop-device path). `Store.ClaimDispatch` has no caller **by design**: its claim-then-ack two-phase shape would split that transaction and stall a row past both consumers' `claimed_by IS NULL` filter until `RequeueStaleDispatch` fires. Fixed-identity text execution, cancellation, replacement-instance recovery and leased receipt delivery are implemented; real PostgreSQL and device acceptance remain open |
| E4 | Service heartbeat publication | Implemented: nine control-plane services publish via `heartbeat.StartPg`, governance evaluates; migration `004_service_heartbeats.sql` gives the table a `(service, instance)` key plus a `dependencies` column |
| E5 | Session title plugin assembly | Implemented (2026-09-15): `sessionTitleGateway` removed from both `PLATFORM_PLUGIN_MODULES` and `PLATFORM_PLUGIN_DIRECTORIES` in `data-plane/dsh-node/src/plugins.ts`, with an in-place note not to re-add it. It was never a plugin but a **verification slice** (no `src/`, no `main`/`exports`; `__tests__/title-route.spec.ts` proves the title auxiliary LLM call routes through the gateway from Config alone). The defect was the **registration**: `profilePluginSpecs()` iterates that table, so every profile would `dsh plugin add` an unloadable package, and since `isOptionalProfilePlugin('@lumo/...')` is always false the install failure throws and terminates startup instead of degrading to a warning |
| E6 | Obsolete merger boundary documentation | Implemented (2026-09-16): the three boundaries — why it is kept / who may use it / when to delete it — are now written on the type in `collaborator/internal/crdt/merger.go`, and the rule they encode is **executable** rather than a comment: `TestAppendOnlyMergerIsNotConvergent` pins that it violates the `Merger` convergence contract (same update set, reversed order → different bytes) with `UpdateSetMerger` as the control, and `TestAppendOnlyMergerNameStaysLabelledNonProduction` pins the one runtime signal (`merger.Name()` goes into the startup log at `cmd/collaborator/main.go:130`, so a wrong assembly shows up as `kernel=append-only(占位，非生产)`). The earlier "compatible with old state reads and historical tests" wording was **wrong on both counts**: a 2026-09-16 sweep found zero references repo-wide (Go sources, tests, scripts, config, docs), so it has no importer at all. It is deliberately **not** deleted: it is the negative example for the interface contract, and deleting it is removing evidence, not removing dead code |
| E7 | Connector audit query API | Implemented (2026-09-15): `GET /audit` (`connector-gateway/internal/server/audit.go`, `internal/audit/query.go`). Realm comes from the identity header only; non-admins default to their own calls and `all=true` requires an admin role; an unrecognised `decision` is a 400 rather than silently degrading to "no filter"; sort key and keyset cursor are both `id` (not `created_at`, which is transaction-start time and can disagree with insertion order under concurrency). PostgreSQL integration verification pending |
| E7b | Connector audit SessionEvent projection | New (identified 2026-09-15): `connector_audit.projected_at` and `idx_connector_audit_pending` exist only for a projector that was never written — no code anywhere reads or writes that column, so the §10.1 "record every external call as a session event" **timeline half** (the one for the model and the frontend) is unimplemented. Belongs with the C-group cross-process projection work and must be built in the dsh plugin layer (cf. `knowledge/src/graph-projector.ts`), **not** as a new route on connector-gateway — the session store is outside that service's boundary **Reclassified 2026-09-17: ③ withdrawn, ② kept with no writer.** Part ① (the source never carried a session id) was fixed; part ③ — the projector — is **not schedulable work but a structurally impossible one**: dsh gives platform plugins no channel to declare a *persistent* custom event type, so a written event would make the whole session log fail to reload. The replacement path already exists (session-side `tool/call` + `tool/result`, gateway-side `GET /audit?sessionId=…`). See `cluster-gap-analysis.md:424`. This row previously read as "never written", which invites someone to schedule it. Lesson: "deliberately not done" and "not yet done" must never share wording. |
| E8 | LLM provider management API | Implemented: `GET /v1/providers`, `GET|PUT|DELETE /v1/providers/{model...}`; every field but `model` is optional with "omitted = keep current", the API key is structurally unreturnable, disabled rows stay visible, and a new row without `upstreamBaseUrl` is rejected by the column's `NOT NULL`. PostgreSQL integration verification pending |

Validation results and remaining environment requirements will be recorded as each area is completed.

## Priority: Hierarchical Intent And Cross-Device Collaboration

| Work | Status |
| --- | --- |
| Preserve superior objective, inherited constraints, parent identity and delegation depth | Implemented; explicit contracts and governed keyword analysis only; semantic intent recognition remains open |
| Persist immutable Run results and parent notifications; require child acceptance before parent completion | Implemented; authorization and domain tests passed; PostgreSQL transaction tests require a live database |
| Commit Run and scheduling outbox together; retry delivery using the same Run ID | Implemented; concurrent retry, stale placement acknowledgment and state regression tests added |
| Preserve Scheduler placement on duplicate Run delivery | Implemented in store and HTTP paths; realm, Worker and project identity cannot change; replay does not depend on directory availability or leadership |
| Persist cross-node subagent results before callback delivery | Implemented; PostgreSQL outbox, bounded delivery leases, exponential retry, stale-claim fencing and origin revalidation |
| Recover callback authentication and result acknowledgment after parent restart | Implemented; registration persists before child start; immutable inbox accepts identical replays and waits for Scheduler confirmation |
| Consume governed Scheduler dispatch and execute in the correct runtime identity | Implemented for a pinned Agent/owner/project/preset revision/model and text-only tasks. Runtime and cancellation tests pass; PostgreSQL transactions await execution |
| Route employee execution through the authenticated device gateway | **Reaudited 2026-09-17 — narrower than recorded, and blocked on a decision rather than on code.** The dispatch *transport* is **not** open: `governance/internal/store/devices.go` `DispatchDeviceTasks`/`dispatchDeviceTask` bridge Scheduler's `scheduler_dispatch_outbox` into an immutable `governance_device_commands` row (`action='execute_task'`, carrying `run_id`/`attempt`/`session_ref`), claiming the outbox row, stamping `delivered_at` and writing the audit entry **in the same transaction**; `ClaimDeviceCommands` delivers it over the device's mTLS WebSocket; `CompleteDeviceCommand` owns the accept and reject transitions. Eligibility and connection checks are indeed present (`scheduling_eligible`, live `connection_expires`, `applied_revision=revision`, `report_error=''`, `certificate_expires>now()`, active user, `ONLINE`, per-device cap of 16 in-flight commands, deadline not passed). **What is genuinely missing is the last hop**: `registry/cmd/desktop-agent/main.go`'s command switch handles only `reconcile`/`start`/`stop` (`:765-811`), so every `execute_task` falls outside the switch, keeps the initial `failed` + `{"error":"command_denied"}` result and is returned to the gateway, where `CompleteDeviceCommand` takes the terminal "local rejection" path — the attempt ends as "Device did not accept the task assignment". The path therefore **fails deterministically today**; it is not "unwired" but "half-wired and reliably failing". The apparatus for the missing case is already written with **zero call sites** (`taskBody`, `persistTaskInbox`, `persistTaskReceipt`, `taskResultPayload`, `runTaskRunner` — immutable inbox, run-id binding, immutable receipt, socket contract and size caps all present), and `-task-runner-socket` is parsed, validated as an absolute path, then never used. Go does not report unused functions, so this is silent under both the compiler and `vet`. **Why the accept half cannot simply be wired on its own**: the gateway reads `completed` as *accepted*, not *finished* (the audit event is literally `device_execution_accepted`; the transition is `scheduler_tasks PLACED→RUNNING`), while `runTaskRunner` is synchronous (30s socket deadline) and returns a *terminal* outcome (COMPLETED/FAILED/CANCELLED) whose payload shape is exactly `governance_task_results.payload` — and the device has **no channel** to write that table (inbound endpoints are only enroll/renew/connect/plan/blob, and the WS `result` message is pinned to the same command by `CompleteDeviceCommand`'s immutability check). Wiring only the accept half would park tasks in `RUNNING` with nothing able to finish them, which is worse than failing: C5's "recorded but not done is reconcilable" does not apply, because what gets written is not an honest `recorded` but a false `RUNNING`. **Decision required** — ① make `completed` mean *accepted* and add a device-side result channel (new endpoint, or a new WS message type) with `runTaskRunner` going asynchronous, or ② make `completed` mean *finished* and change `CompleteDeviceCommand`'s transition and audit name so accept and finish are two events. **Recommendation: ①** — it matches the existing audit name and the `dispatchDeviceTask` comment ("Scheduler remains PLACED until the desktop confirms that the assignment was persisted in its local task inbox") and leaves the already-correct accept path alone; ② would change the half that is already live. **Option ① design written 2026-09-17**: `docs/superpowers/specs/2026-09-17-device-task-result-channel-design.md`. Reconnaissance for it shrank the change from "build a link" to "join three pieces that already exist": the device's `taskResultPayload` is field-for-field `domain.TaskResult`, `RecordTaskResult` already carries every fence (immutable replay, run/node/session binding, parent notification), and `governance_device_commands` already holds the authoritative `run_id`/`attempt`/`session_ref` — so the missing layer is **transport plus authorization binding**, not data model or business rules. Two findings that change the shape of the work: the device's WS `write` is already `writeMu`-guarded (so an async result sender is safe), and the gateway's `default:` branch **closes the connection** on an unknown inbound type (so the rollout order is hard: governance first, devices second). Also note the device must **refuse** `execute_task` when `-task-runner-socket` is unset rather than accept-then-fail: accepting work it cannot do writes a false `RUNNING` into the task ledger. Awaiting approval to implement (4 steps, all additive). See `implementation-status.md` **Implemented 2026-09-17 (plan ①: `completed` keeps meaning "accepted", and the outcome travels on a separate device-side channel).** Store: `RecordTaskResult`'s transaction body was extracted to `recordTaskResultTx` and is now shared with the new `RecordDeviceTaskResult`, which pins run identity on the command row (reusing `CompleteDeviceCommand`'s exact fence set: same connection, certificate, applied revision, non-revoked node, active owner), refuses a result for a command that never reached `completed`, and refuses any device-reported `run_id`/`session_ref`/`task_id` that disagrees with the row instead of silently preferring one side. The authenticated connection supplies `node_id`, so "a device may only report its own run" needs no new rule, and the audit actor is `device:<node_id>`. Gateway: a new inbound type `task_result` whose payload is field-for-field `domain.TaskResult`. Device: `case "execute_task"` validates the envelope, persists the immutable inbox, acknowledges with `completed`/`{"accepted":true}`, and only then runs the task asynchronously, persisting the receipt before reporting it. A device without `-task-runner-socket`, with an unwritable inbox, or with an execution already in flight **refuses** rather than accepting and reporting FAILED, because acceptance is what moves the task to RUNNING in the ledger. **Deployment order is a hard constraint**: the gateway drops the connection on any unknown inbound type, so governance must be rolled out before the devices. Evidence: 5 live-database store tests, a new mTLS gateway test in `internal/device` (that package had no test fixture at all before this), 4 device-side unit tests pinning the wire shape and the runner contract, and green full-module runs for governance and registry. Still open: cancellation (no device action and no cancel frame in the runner socket contract) and restart recovery (a run with an inbox record but no receipt stays RUNNING until it times out). **Both closed 2026-09-17 (package B; design in `docs/superpowers/specs/2026-09-17-device-cancel-and-recovery-design.md`).** ① **Cancellation**: `DispatchDeviceCancellations` in `governance/internal/store/devices.go` carries `scheduler_tasks.state='CANCELLING'` to the device as a `cancel_task` command — the join is `governance_device_commands.run_id = scheduler_tasks.task_id`, which is what a run id on a device command has always meant, so no new column was needed. The device aborts the run by cancelling its context; `runTaskRunner` closes the socket on cancellation because the runner exchange is one request/one response with an absolute 30s deadline, so a blocked `Decode` would otherwise never observe it. The receipt then records **CANCELLED, not FAILED** — a false failure for work an operator deliberately stopped would be a lie in the task ledger. Two limits are deliberate and written into the code: the cancellation path **skips the per-device in-flight cap** (a device holding sixteen commands is exactly the one that must stay stoppable), and **whether the runner stops on EOF is outside this repository** — the runner is not in this tree, so no cancel frame was invented for it (`{"type":"cancel_task"}` on that socket would be a contract neither end implements). ② **Restart recovery**: `recoverTaskInbox` runs on connect, finds `<runID>.inbox.json` with no `<runID>.receipt.json`, and reports those runs as **FAILED** with a summary naming the restart — FAILED rather than CANCELLED because the device no longer knows how far the run got, and the two lead to different investigations. **Also fixed in this package, and it was a P0**: `persistTaskInbox` and `persistTaskReceipt` wrote **the same path** (`stateDir/tasks/<runID>.json`), so the `O_EXCL` receipt write always hit `ErrExist`, the `ErrExist` branch read the inbox record as a receipt, called it different, and returned `task result is immutable` — after which `finishDeviceTask` logged and returned **without ever sending `task_result`**. The result channel shipped on 2026-09-17 had therefore never carried a single result. The two helpers' own tests could not see it because each gets a fresh `t.TempDir()`; the regression test walks the production order instead. **This one is invisible to the live-DB suite** (no case exercises a device round trip), so it is a reminder that "green on a real database" and "the path ran" are different claims. |
| Show intent, child progress, evidence and requester acceptance in the console | **Scoped 2026-09-17 — smaller than "Pending" implies: the backend and the surface both exist; what is missing is two proxy routes and the views.** (a) **Target corrected**: "the console" is **not** `platform/console` — that static page is **deliberately retired** (`index.html` only carries a migration notice; it was removed because it connected to the control plane from the browser and sent forgeable identity headers). The live ops surface is native DSH Web at `/lumo/ops`, which is a **302 to `/?lumo=operations`** (`dsh-plugins/lumo-ui/src/index.ts:1388`), i.e. a client-side surface inside the DSH Web SPA, implemented in `lumo-ui/src/client/{index.tsx,cluster-panels.tsx}`. (b) **All four data sources already exist in governance**: intent is `governance_delegation_tasks.intent_contract`; child progress is `GET /v1/tasks/{taskID}/collaboration` (`server/server.go:163` → `store.CollaborationProgress`, returning the task plus a `summary` of total/active/awaiting_review/accepted/needs_attention and `children[]` each carrying its current run and result summary); evidence is `GET /v1/tasks/{taskID}/runs/{runID}/result` (full `payload.output`); requester acceptance is the existing `complete`/`reject`/`archive` events plus `business_state` VERIFYING/IN_REVIEW/DONE/REJECTED. (c) **The concrete backend gap is two missing proxy routes**: `lumo-ui`'s `/lumo/api` proxy forwards `/v1/delegations*`, `/v1/tasks/{id}/runs`, `/audit` and `/report`, but has **no route for `/v1/tasks/{id}/collaboration` or `/v1/tasks/{id}/runs/{runID}/result`** — the two faces this item needs (verified: `collaboration` appears nowhere in `lumo-ui/src/index.ts`). (d) **The surface is an extension, not a new one**: the ops client already lists delegations, previews/creates them and refreshes placement, and already declares `TaskRun`/`DelegatedTask` types — so this is adding panels to an existing delegation view. Remaining decisions are presentational (where the four blocks live, and how much of `output` to render inline vs. link). Not started **Proxy layer implemented 2026-09-17.** The two missing routes were added to `lumo-ui`'s `/lumo/api` proxy: `GET /lumo/api/tasks/{id}/collaboration` and `GET /lumo/api/tasks/{id}/runs/{runID}/result`, each validating both identifiers through the existing `safeID` before forwarding to governance. Note the proxy is deliberately **narrower than the control plane's own identifier pattern**: `safeID` accepts `[A-Za-z0-9._-]{1,128}` while the store's run ids allow `:` as well, so a run id containing a colon is not reachable through the ops surface. That is pre-existing behaviour shared with every other task route, not something this item introduced, but it is the kind of constraint that only shows up as a 400 in production. Evidence: a new spec `__tests__/task-evidence-proxy.spec.ts` (4 cases, all passing) pinning both new routes, the untouched run-list route one segment shorter, and the refusal of identifiers the proxy does not accept. Still open: **the view layer itself** -- the three panels (intent contract, child progress, evidence) have not been built,  **Built 2026-09-17 (view layer).** The three panels live in `dsh-plugins/lumo-ui/src/client/cluster-panels.tsx` and are assembled by the task execution panel in `index.tsx` (renamed from "history" to "execution detail", because it now carries more than a run list). The intent contract needs **no new request**: the governance task read face (`delegationSelect`, shared by `/v1/delegations` and the collaboration face) already returns `intent_contract`, `rationale`, tags/skills and the score snapshot -- the client interface simply never declared those columns, so the ops surface could see a task without seeing what it promised. Child progress labels a truncated list as truncated (`has_more`) and repeats the full-population counts. Evidence reads `output` through an exported pure function that tests for null/undefined rather than truthiness, because `json.RawMessage` can legitimately be `0`, `false` or `""` and a truthiness test would render those as "no deliverable produced". The two read faces degrade independently: the collaboration face needs `task:delegate`, and without it only that block is unavailable. Evidence: `__tests__/task-evidence-panels.spec.ts` (3 passing, runs locally in node) plus a clean `tsc --noEmit`. A new cross-language contract test (`governance/internal/domain/console_contract_test.go`) pins the JSON key names the panels read by name -- Go json tags and TypeScript interfaces have no compile-time link, so a rename stays green on the Go side and only shows up as "not recorded" in the panel; it was verified against a real rename (`has_more` -> `hasMore`) to prove it is not vacuous. Still open: `client.spec.tsx` needs jsdom and cannot run locally, so the panels have no local **rendering** evidence. |

### Reassessment and development: 2026-09-12

The September 8 audit is historical. Current code already contains a governed
text executor and runtime wiring for remote seams, RocketMQ, knowledge backends
and OPA. These are implementation facts, not proof of full cluster acceptance.

| Priority | Remaining work | Current boundary |
| --- | --- | --- |
| P0 | Governed execution recovery and cancellation (E3) | This change adds replica admission capacity, cancellation before/during execution, replacement-instance recovery and leased/fenced result delivery. The same Run is never automatically re-executed. PostgreSQL tests are authored and wired to CI; local database verification is pending. |
| P0 | Cron execution (A2) | Producer, durable next-fire state, concurrency control and timezone/misfire rules are implemented (see "Cron scheduling: 2026-09-14"). Remaining: PostgreSQL integration verification and restart acceptance in a real environment. |
| P0 | Published document indexing (A3) | Collaborator now consumes its own publish outbox: exact snapshot/realm/space propagation, deterministic idempotent chunking, signed per-realm seam ingest, acknowledgment only after a successful write, bounded retry with visible stall reasons. Remaining: PostgreSQL integration verification and deployment assembly of the seam URL and identity secret (see "Published document indexing: 2026-09-14"). |
| P1 | ~~Health-derived readiness (E4, D6)~~ **Implemented** | `lumo_service_heartbeats` now has a publisher in all nine services, and governance resolves the cluster gate from derived readiness instead of the static declaration. A declared-ready but unhealthy cluster returns 503 with the failing service names; a non-cluster still returns 403. See "Health-derived readiness: 2026-09-14". |
| P1 | ~~Doris usage projection (A5)~~ **Closed by removal** | Decided against. The cube chain required an extra component, a projection worker and a cursor, and introduced a consistency property that only convention could hold (a replay must not add the aggregate counts twice) — in exchange for pushing down one `GROUP BY`. Replaced by a PG-only query surface (see "Usage analytics: 2026-09-14"). |
| P1 | Employee device dispatch and broader Agent execution (E3, C1) | Device directory checks exist. Authenticated task transport, device acceptance and execution with tools/assets/budget enforcement remain separate work. |
| P2 | Remaining C/D features | **Narrowed on 2026-09-16** (the earlier wording listed items that have since landed): edge gateway (C3), terminal gateway (C4), lineage (C7) and LLM batch (C8) are implemented — see their rows above. What still needs dedicated delivery and acceptance: **the edge and terminal gateways are missing from the Helm chart** (they are in both compose files and in every static list, but `values.yaml` has no `services` key for them, so `helm install` ships a cluster without its outermost north-south entry or its terminal entry — see the note under the D3 area); **the shared execution console** (C5's UI view; the server-side read projection is ready while the dispatcher into the session execution face is unwired, so `effectuation` is always `recorded`); **topology/production assembly** (D2/D3 shipped, D1 remains a product decision); and — cutting across the newly implemented services — **real-cluster end-to-end acceptance**, since `acceptance-cluster.sh` has no probes for the edge gateway, the terminal gateway or lineage. **Corrected 2026-09-17**: the Helm claim in this cell is **stale**. `values.yaml:297-298` declares `edge-gateway` and `terminal-gateway` with `enabled: true`, and `templates/edge-routes.yaml`, `secret.yaml`, `configmap.yaml`, `deployment.yaml` and `NOTES.txt` all cover them — the chart was fixed on 2026-09-16 (see the C3/C4 rows) and this summary paragraph was never updated. The residual for C3/C4/C7 is the same one: **real-cluster end-to-end acceptance** (no probes in `acceptance-cluster.sh`). Lesson: when one place is fixed, go back and fix the summary that refers to it. |

This change also fixes the obsolete Agent setup lookup in the existing remote
subagent path: setup now uses the Agent supplied by the public creation API.
Host tools remain unavailable to the governed text profile. Missing Worker
identity fields are rejected in both the host and packaged node validators.

### Verification: 2026-09-12

- Focused host/runtime/callback/registration and node-wiring suites: **60 tests
  passed**, 17 PostgreSQL-dependent tests skipped (15 governed dispatch/recovery
  cases and two callback receipt cases).
- Platform compilation and a separate TypeScript check of all new test files passed.
- Targeted Governance and Scheduler Go race checks passed; database-dependent
  cases skipped without a PostgreSQL DSN. Shell syntax and whitespace checks passed.
- PostgreSQL is unavailable locally and no dependencies were installed. The new
  dispatch/recovery suite and existing receipt transaction suite are skipped
  locally, not counted as passed.
- CI now provisions PostgreSQL for the governed TypeScript transaction suites
  and the Governance/Scheduler Go transaction suites. The target-environment
  acceptance script also includes those paths. CI and full cluster acceptance
  have not been run in this session.

### Verification: 2026-09-09

- Governance and Scheduler `go test -race ./...` passed with `GOCACHE=/tmp/lumo-go-cache` and existing local module downloads. Database-dependent tests skipped without `LUMO_TEST_PG_DSN`.
- Platform TypeScript compilation passed using `./node_modules/.bin/tsc -b --noEmit`.
- Focused callback, result delivery, runtime reporting, client and registration suites: 31 tests passed; two new PostgreSQL receipt tests skipped. The DSH result tests use the actual public Agent creation and execution APIs with a deterministic model adapter.
- Existing socket-based host/provider suites could not run: this sandbox rejects binding `127.0.0.1` with `EPERM`. Callback request handling is additionally covered without opening a listening socket.
- `git diff --check` passed. `deepseek-harness/` remains untouched; existing upstream installer edits were preserved.

### Remaining Recovery Boundaries

The callback outbox guarantees retry after the result has committed to PostgreSQL.
Transient database failures retry while the host is running; shutdown attempts a
final write. A host crash before that commit still requires recovery from the
session log. Uncertain child-start delivery is not solved by callback persistence. The
governed text executor now settles a replaced instance on the same
realm/Worker/project/node with an explicit failure (or cancellation) receipt.
It preserves any saved result, rejects a conflicting late write and never
automatically replays the old Run. This is loss reporting, not workflow resume.
Permanent node loss, a replacement with a different node ID, and session-log
reconstruction still require further recovery work. A restarted parent can acknowledge and
retain child results, but restoration of its in-memory Agent and workflow
continuation is separate work. These boundaries must be covered by E3 and device
acceptance before claiming a complete cross-device execution loop.

### Cron scheduling: 2026-09-14

Cron automations now have a durable producer. The schema already accepted
`trigger_kind = 'cron'`; what was missing was a next-fire producer and a binding
path for it.

Design decisions and why:

- **The producer lives in `flows`, not `scheduler`.** Advancing the cursor and
  enqueueing the trigger must commit together, otherwise a crash between the two
  either drops or duplicates a run. `flow_trigger_outbox` belongs to `flows`, so
  only `flows` can do both in one transaction. The `scheduler` service places and
  dispatches Workers and has no notion of automations; involving it would add a
  cross-service transaction for nothing. The previous comment in `flows` claiming
  that cron is delivered by an external scheduler was wrong and is corrected.
- **`internal/cron` is dependency-free and owns all scheduling semantics.** `flows`
  had no third-party dependency besides pgx, and the parts most likely to be wrong
  (DST boundaries, the POSIX day-of-month/day-of-week OR rule) should be readable
  and testable in one place. The behaviour is measured rather than assumed:
  `time.Date` normalizes a non-existent spring-forward wall time backwards
  (2026-03-08 02:30 New York reads back as 01:30) and picks the first occurrence of
  an ambiguous fall-back time (2026-11-01 01:30 as EDT). Day arithmetic goes
  through UTC because real zones shift DST at midnight (America/Santiago
  2026-09-06 00:00 becomes 2026-09-05 23:00). `time/tzdata` is embedded because the
  alpine runtime image ships no zoneinfo.
- **Spring-forward times are skipped, not caught up.** A wall time that does not
  exist never appears in `Next`, so no cursor ever lands on it. Vixie cron runs
  skipped jobs immediately after the jump; that requires feeding transition history
  into the schedule calculation, which a pure `Next` cannot do. Missing one
  occurrence is predictable and explainable. Downtime is different and *is* caught
  up: `Due` returns the last missed occurrence and the cursor advances to
  `Next(now)`, so a five-hour outage produces one catch-up run, not five.
- **Concurrency uses compare-and-swap, not claim columns.** `FireCronCursor`
  updates the cursor only where `next_fire_at <= now`, so of two replicas reading
  the same due cursor only the first commits; the second gets `ErrCursorAdvanced`
  and enqueues nothing. Every replica can therefore run the producer without
  leader election.
- **Cron triggers bind by automation, not by expression.** The previous binding
  JOIN matched `trigger_spec = event_name`, which is right for events (fan out to
  all subscribers) and wrong for cron: two automations may legitimately share one
  expression. `flow_trigger_outbox` gained a `source` column and the JOIN now
  branches, with `'event'` preserving the previous behaviour exactly.
- **Invalid expressions are made visible rather than silent.** `projects` stores
  `trigger_spec` as an opaque string and does not validate it, and `flows` only
  parses it inside its own loop. A cursor whose expression cannot be parsed, or can
  never fire (for example `0 0 30 2 *`), is marked stalled with a reason, excluded
  from scheduling, and exposed to project members through
  `GET /v1/projects/{pid}/cron/cursors`. Stalled cursors do not retry on their own:
  the same expression would fail the same way, so recovery is a spec change or
  disable-then-enable.
- **The default time zone is UTC, configurable through `LUMO_FLOW_CRON_TZ`.** An
  expression can carry `TZ=` / `CRON_TZ=` to be explicit. Changing the default
  shifts already-stored fire times until each automation fires once and recomputes.

Verification:

- `internal/cron`: 16 tests passed, 96.2% statement coverage. Covers parsing and
  rejection, macros, ranges/steps/lists, month and weekday names, timezone
  prefixes, day-of-month/day-of-week OR semantics, leap day including the
  seven-year gap across the non-leap year 2100, DST spring-forward and fall-back,
  midnight-DST zones, monotonicity, a minute-by-minute scan proving `Next` returns
  the first match, and the catch-up contract.
- `internal/schedule`: 23 tests passed, 84.5% statement coverage, against a fake
  that reproduces the store's CAS. Covers reconciliation (create, keep, reset on
  spec change, delete stale, stall invalid), firing, catch-up coalescing, benign
  `ErrCursorAdvanced`, limit handling and store-error reporting.
- `go build ./...`, `go vet ./...` and `gofmt -l` are clean across the module.
- PostgreSQL-dependent cases are authored but **not verified locally**:
  `LUMO_TEST_PG_DSN` is unset and this machine has no PostgreSQL or container
  runtime. Exactly **one** integration test skips
  (`integration.TestCronScheduleEndToEnd`); it is deliberately a single case that
  walks the whole story line, because every additional case costs another schema
  and connection pool. Everything else is covered by the fake-based unit tests
  above. The atomic advance-and-enqueue, the CAS and the `source`-branched
  binding JOIN are exactly the parts that only a real database can confirm.
- Known adjacent issue, not touched: `store.ListEventBindings` is dead code (no
  callers) and its query still filters `trigger_kind IN ('event','webhook')`.

### Published document indexing: 2026-09-14

`collab_publish_outbox` was written in the same transaction as the snapshot but had
no consumer: `PendingPublishes` and `MarkDispatched` were referenced only from
inside `collaborator` itself. Publishing therefore updated the collaboration
snapshot and nothing else; the knowledge base never learned about it.

Design decisions and why:

- **The consumer lives in `collaborator`, not in the knowledge plugin.** The
  outbox row and the snapshot are committed together, and only the service that
  owns that transaction can read them without a second delivery mechanism. The
  knowledge side is a TypeScript seam provider reached over
  `POST /seam/knowledge/ingest`, so the Go-side deliverable is the dispatcher.
- **The event carries its own `realm` and `space` instead of re-reading them.**
  `PendingPublishes` previously selected only `doc_id, version, publisher,
  content, created_at`, so the projection would have had to look the tenant up at
  dispatch time. Dispatch can happen after a space migration, which would project
  an old publish into the new space — a cross-space leak. The outbox already
  stored both columns; they are now selected, together with `title` from
  `collab_documents`. A separate `store.PendingPublish` type was introduced rather
  than adding fields to `domain.Snapshot`: the snapshot is the read shape for
  "the only content models may see" (铁律 17) and has no realm/space to give, so
  merging them would hand the read path fields it can only fill with empties.
- **Chunking is a pure function of the content, so retries are byte-identical.**
  The provider upserts on `(doc_id, chunk_index)`, so a replay that produced a
  different segmentation would leave stale fragments behind. Blocks are split on
  blank lines and greedily packed to a rune budget (800, counted in runes not
  bytes — byte-slicing CJK splits characters), oversized blocks are hard-split at
  a whitespace boundary when one is nearby. No overlap: duplicated text
  double-hits in retrieval and makes `chunk_index` less stable. Markdown and wiki
  link targets are extracted into `metadata.references`, which is the only input
  `graph-projector.ts` uses to build graph edges — without it the graph projection
  would be written with no edges at all.
- **Acknowledgment happens only after the write succeeds.** Index first, then
  `MarkDispatched`. A crash in between leaves the row pending, so the next cycle
  re-indexes it, which is safe because the write is idempotent. Reversing the
  order is exactly the silent loss the outbox exists to prevent.
- **No claim column and no leader election.** `PendingPublishes` deliberately does
  not use `FOR UPDATE SKIP LOCKED`: without holding a transaction the lock is
  released at statement end, and holding one would put the embedding call inside a
  database transaction. Two replicas may scan the same row; the outcome is a
  duplicate idempotent write, not a duplicate index record.
- **Failures are bounded and visible.** `collab_publish_outbox` gained `attempts`
  and `last_error`. A row that reaches the limit is no longer scanned — otherwise
  one permanently failing row would occupy the batch quota and starve every later
  publish. Recovery is a spec fix plus a new publish, which creates a fresh row
  with a zeroed counter. `invalid` responses (HTTP 400) are terminal and jump
  straight to the limit, because the payload is a deterministic function of the
  row and retrying identical bytes cannot succeed; 403/5xx/network failures stay
  retryable, since a realm mismatch and a misconfigured token are indistinguishable
  at the HTTP layer and only one of them is permanent.
- **Each document is signed with its own realm.** The seam host compares the realm
  in the payload against the realm in the signed assertion and rejects a mismatch,
  so there is no shared "service identity" that could write across tenants.
  `ingest` is not role-gated today, but the assertion requires a non-empty role, so
  the value is configurable (`LUMO_KNOWLEDGE_INDEX_ROLES`).
- **Misconfiguration fails loudly, or not at all.** With `LUMO_KNOWLEDGE_SEAM_URL`
  unset the pipeline is off and says so at startup, instead of leaving a growing
  outbox that looks like a fault. With the URL set, an invalid address, an empty
  identity, or a signing secret shorter than 32 bytes exits at startup — the same
  treatment `LUMO_YRS_KERNEL` already gets. The embedding model has no default:
  a wrong model identifier does not error, it makes every query miss, so an empty
  value is refused rather than guessed.
- **`store.NewPGOnly` exists so the outbox half can be assembled without Redis.**
  The publish path only touches PostgreSQL. Production assembly must still use
  `New`; `Close` is now nil-safe so the test-only constructor cannot panic.

Verification:

- `internal/indexing`: 37 tests passed (44 including subtests), 94.1% statement
  coverage. The seam adapter is tested against a server that re-implements the
  host's checks independently — HMAC verification, `aud`/`exp` window, realm
  binding, envelope shape and per-field non-emptiness — rather than asserting
  against the code under test.
- `go build ./...`, `go vet ./...` and `gofmt -l` are clean across the module.
- PostgreSQL-dependent cases are authored but **not verified locally**:
  `LUMO_TEST_PG_DSN` is unset and this machine has no PostgreSQL or container
  runtime. Exactly **one** integration test skips
  (`integration.TestPublishOutboxPropagationAndRetry`), deliberately a single case
  that walks the whole story line. It covers the three things only a real database
  can confirm: that realm/space/title are actually produced by the SQL, that
  acknowledgment removes a row from the pending set, and that the attempt limit
  removes a stalled row from the scan. Everything else is covered by the
  fake-based unit tests, whose fake reproduces the store's `attempts` and
  `dispatched` predicates.
- Deployment assembly is **not** done: no Compose file sets
  `LUMO_KNOWLEDGE_SEAM_URL` or `LUMO_IDENTITY_ASSERTION_SECRET` yet, and the seam
  host itself is still being assembled under B1. Wiring the URL before a seam host
  exists would turn every publish into a retry, which is worse than being
  explicitly off.

### Usage analytics: 2026-09-14

A5 was scoped as "Doris projection, replay and analytics API". Reconnaissance
found the gap was narrower and worse than the audit implied: `internal/doris` had
a working HTTP Stream Load client but **zero importers** — `main.go` never
imported it, so the missing pieces were the projection worker, the replay cursor
and the query surface.

Two rounds of design happened. The first made Doris **pluggable** on three axes:
off by deployment (unset env var ⇒ capability off), replaceable by interface
(narrow `Source`/`Sink`), and degrading visibly at runtime (Doris failure falls
back to PG with the reason in the response body and an event on the error
channel, never silently). The second decision superseded it: **remove the chain
entirely.**

Why it was removed rather than wired:

- **The cube's model semantics fought the replay requirement.** A Doris
  `AGGREGATE KEY` table with `SUM` value columns aggregates *on load*, so
  replaying the same batch adds `qty`/`cost_usd`/`tokens` a second time. That is
  model semantics, not a configuration mistake. The two properties therefore had
  to multiply: the cube had to be `UNIQUE KEY` **and** the projection had to write
  the key's complete aggregate value rather than the batch's delta. Worse,
  `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so a legacy
  aggregate cube would have double-counted forever with **no layer erroring** —
  visible only as report numbers drifting upward. That is a correctness property
  held by convention, which is the kind that fails quietly.
- **The cost was an extra component, a worker and a cursor** for the benefit of
  pushing one `GROUP BY` down. The ledger is append-only and unpartitioned, so a
  direct scan is *honestly* slow: the slowness is visible and its cause is
  obvious. A stale cube, by contrast, looks exactly like "no usage".
- **A single cursor made the failure signal clearer, not weaker.** With no head-of-line
  blocking there is nothing for `attempts`/stall machinery to recover: a failure
  simply stops the cursor, which is projection lag. Adding retry accounting would
  have converted "projection is broken" into "projection is silently missing
  data".

What survives, and why it was worth keeping:

- **`ReportingLocation` is fixed to UTC and shared by both sides.** The SQL
  (`timezone($1, ts)`) and the Go day bounds must agree on which day a row belongs
  to, or the keys never match. `ts::date` is banned — it follows the session time
  zone, so the same data lands on different days in different deployments, and
  the error is invisible in single-machine development.
- **The interval is half-open, `[from, toEnd)`.** A row exactly at the boundary is
  neither double-counted nor dropped.
- **The span cap is a 400, not a table scan.** `MaxSpanDays = 366` with a distinct
  `ErrInvalidRange` keeps "the caller asked for too much" from becoming an
  unbounded query on an append-only table.
- **400 and 500 are separated in the handler.** Reporting a database fault as a
  400 tells the caller to fix their parameters, so nobody looks at the alert —
  that disguises an operational failure as a user error.
- **Empty results serialise as `[]Row{}`, not `null`**, and `SortRows` gives a
  stable order so the JSON is diffable and snapshot-testable.

Removed: `internal/doris/`, `internal/projection/`, `internal/analytics/doris.go`,
the projection worker and `LUMO_DORIS_*` wiring in `cmd/usage-ledger/main.go`, and
`/v1/metrics/projection`. `/v1/metrics/pending` is unchanged. The design record
`docs/superpowers/specs/2026-08-26-doris-aggregation-design.md` is marked
superseded and kept for provenance.

Verification:

- `internal/analytics`: 11 test functions, 21 subtests, all passing against a fake
  `Source` — range validation (format, ordering, the 366-day boundary from both
  sides), that an invalid range never reaches the data source, sort order, totals,
  `[]`-not-`null` serialisation, `DayBounds` half-open/UTC behaviour, and the full
  handler matrix including the 500 case.
- `go build ./...`, `go vet ./...` and `gofmt -l` are clean across the module.
- PostgreSQL-dependent cases are authored but **not verified locally**:
  `LUMO_TEST_PG_DSN` is unset and this machine has no PostgreSQL or container
  runtime. What only a real database can confirm is now a single thing — that the
  `GROUP BY`/`ORDER BY` ordinal list and the `timezone($1, ts)` day expression
  actually produce the grouping the Go side assumes. Everything else is covered by
  the fake-based unit tests above.
- **Not touched:** Doris remains a declared platform capability
  (`ctx.datastore.olap`, the `{olap: true}` shape flag validated in
  `registry/internal/plan` and the device gateway). Removing it from the platform's
  data layer is a separate architecture decision and was explicitly out of scope
  here.

### Health-derived readiness: 2026-09-14

`lumo_service_heartbeats` was created by migration 001 and never written to, and
`LUMO_CLUSTER_STATUS=ready` was a static declaration in Compose and Helm. That
declaration was the gate that opened the entire organization / device / skill
management surface, so a cluster whose scheduler had died kept serving
management APIs.

**The two identities were separated.** `LUMO_CLUSTER_STATUS` stays the operator's
*intent* ("this deployment is a cluster"); the effective status is
`intent AND health`. Both are reported side by side as `cluster_status_declared`
and `cluster_status`, and the effective value gains a `degraded` state that can
never be declared — so an operator can tell "nobody declared a cluster" apart
from "a cluster was declared and it is broken" without reading a reason string.

| Decision | Why |
| --- | --- |
| Readiness is computed from heartbeats plus self-reported dependency status | A declaration cannot express a dead replica; a heartbeat can. |
| The required-service set is closed, never derived from "whoever reported" | A set derived from reporters cannot express "this service never started", which is the condition readiness exists to catch. An empty set is treated as **not ready** rather than vacuously true. |
| Staleness is measured as `now() - observed_at` **in the database** | Heartbeats arrive from many hosts, so comparing `observed_at` against the reader's own clock has unbounded skew and would produce flakiness no test could pin down. |
| A service is healthy when **at least one** replica is serving; **every** replica stays in the report | Requiring every replica would close the gate during any rolling restart. Hiding quiet replicas would hide the fault an operator needs to see. |
| Reason strings are deterministic: instance lists and dependency names are sorted | Go map iteration order is random, and an unsorted reason would make `Evaluate` untestable. |
| Graceful shutdown writes `status = stopping` | A rolling restart should read as a transition, not as a crash. |
| The gate reads a **cached** snapshot, never the database | `requireCluster` runs on every management request. A per-request query would turn each API call into a round trip and let a slow database stall the whole surface. |
| The cache fails closed on a failed query **and** on a stale snapshot | "Cannot verify" must not stay open. A failed query additionally drops the last-known service list, because that list is exactly what can no longer be vouched for; staleness keeps the details, since "this held a minute ago" is still diagnostic. |
| Governance answers **403** for a non-cluster and **503** for a degraded one | The first is a configuration fact that retrying cannot fix. The second resolves on its own, and 403 would send an operator to change configuration when the real problem is a dead service. The 503 body carries the reason, the failing services and the verdict time. |
| OIDC availability and the scheduling reconciler follow the **declaration**, not health | Login is how an operator fixes a degraded cluster, and the reconciler is a recovery mechanism. Gating either on health removes the way out. |
| `/healthz` stays 200 while degraded; no `/readyz` was added | Governance is the service used to diagnose a degraded cluster, so failing its liveness probe would restart it in a loop at the worst moment. A `/readyz` wired to cluster health would pull the login path out of load-balancer rotation — the information is already in `/healthz` and `/v1/features`. |

**Assembly.** A new sibling module `platform/control-plane/heartbeat` holds the
publisher, the evaluation and the cached watcher. It could not live in
`observability`, whose `otel.go` documents that "OTLP setup is deliberately
dependency-free and shared by every control-plane binary" — the heartbeat code
needs pgx. All nine services publish; governance consumes through
`governance/internal/readiness`, a thin adapter that keeps the pure `domain` gate
free of database types and the watcher free of governance types. The watcher runs
in **every** deployment mode, because readiness is what an operator checks
*before* declaring `ready`.

**Two traps worth recording.**

1. `CREATE TABLE IF NOT EXISTS` does nothing to an existing table. The 001-era
   table had a single-column primary key, so two replicas of one service
   overwrote each other's row. Corrected with explicit
   `ALTER TABLE ... DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` in migration
   `004_service_heartbeats.sql`, mirrored as idempotent DDL in the service —
   because **no Compose file runs `platform/deploy/migrate.sh`** (verified by
   grep), so versioned migrations only cover production upgrades.
   **Corrected 2026-09-17 — "mirrored" was true of 004 only.** 002
   (`collab_space_grants` primary key) and 003 (`idx_scheduler_tasks_pending_edf`)
   each left statements that never reached any service DDL, so a Compose
   deployment silently kept a realm-collidable primary key and ran EDF task
   pickup without its index. Both are mirrored now, and the promise is a gate:
   `platform/shared/__tests__/ddl-ownership.spec.ts` requires every non-CREATE
   statement in `deploy/migrations/*.sql` to appear in the DDL of *every*
   non-migration creator of that table.
2. Concurrent DDL is serialised with `pg_advisory_xact_lock`, because
   `IF NOT EXISTS` does not guard creation of the backing relation. Existing keys
   `781234567` (scheduler) and `hashtextextended('lumo:organization:'||realm)`
   (governance) are joined by `hashtextextended('lumo:heartbeat:ddl', 0)` and
   `hashtextextended('lumo:required-services', 0)`.

**Deployment.** Compose gives every control-plane service an explicit
`LUMO_INSTANCE`, so the readiness report names replicas instead of container IDs
and the table stays bounded. The Helm chart derives `LUMO_REQUIRED_SERVICES` from
the services it actually deploys, so disabling one in `values.yaml` narrows the
requirement instead of leaving the gate permanently closed. That list is
`sortAlpha`-ed because sprig's `keys` does not sort: an unsorted list would drift
between renders and make the not-ready reason order unstable across restarts.

**Verification.**

- `go build ./...`, `go vet ./...` and `gofmt -l` are clean across all eleven
  control-plane modules, and every module's existing test suite passes.
- New tests: 8 gate tests in `governance/internal/domain` (including a fail-closed
  property test that enumerates every mode × intent × health combination), 7 in
  `governance/internal/server`, 3 in `governance/internal/readiness`, and 12 in
  `heartbeat` for the watcher and `ReadAll` column parsing. `heartbeat` statement
  coverage is 76.7%.
- PostgreSQL-dependent verification is **not** done locally: `LUMO_TEST_PG_DSN`
  is unset and this machine has no PostgreSQL or container runtime. What only a
  real database can confirm is the advisory-locked DDL, the composite-key
  migration against an existing 001-era table, and the `EXTRACT(EPOCH FROM ...)`
  age arithmetic. Everything else is covered by the fake-based suites.

### LLM provider management: 2026-09-14

`llm_providers` had exactly one read path — `store.Provider(ctx, model)`, used by
the routing step of `POST /v1/chat/completions` — and **no write path at all**.
Registering a model, changing a price or taking a model out of rotation all meant
hand-writing SQL against the production database. That is the worst kind of gap
to leave open on a table that decides who gets billed and at what rate.

**Routes.** `GET /v1/providers`, `GET|PUT|DELETE /v1/providers/{model...}`. No new
authentication work was needed: `cmd/llm-gateway` already wraps the whole mux in
`observability.RequireControlPlaneToken`, so every management route inherits the
control-plane credential and `/healthz` + `/metrics` stay the only exemptions.

| Decision | Why |
| --- | --- |
| `{model...}` (multi-segment) rather than `{model}` | Model names legitimately contain slashes (`openai/gpt-4`). A single-segment wildcard truncates them into a 404. A side effect is that `/v1/providers/` matches with an empty model and lands in the handler, yielding a 400 "model cannot be empty" instead of a mux 404 — which is the more accurate answer on a configuration surface. |
| `GET /v1/providers` (literal) wins over `GET /v1/providers/{model...}` | The literal pattern matches a strict subset, so Go's mux ranks it as more specific. Verified by test, not by reading the spec. |
| Every field except `model` is optional; **omitted means keep the current value** | For `apiKey` this is mandatory: the key can never be read back (responses carry only an `apiKeySet` boolean), so any "GET then PUT the body back" client would silently wipe it. For `upstreamBaseUrl` it is an ergonomics requirement: taking a model out of rotation must be `{"enabled": false}`, not a read-modify-write. |
| Explicit `""` for `apiKey` **does** clear it | `COALESCE` catches `NULL` but not the empty string, so "omitted = keep" and "clear" remain distinguishable. Clearing a mistyped key needs an exit. |
| A new row that omits `upstreamBaseUrl` is rejected by the column's `NOT NULL`, translated to 400 | "Omitting is only allowed when updating" is expressed in one atomic statement. A separate existence check would introduce a check-then-delete race. The error is matched on SQLSTATE 23502 **plus the column name**, not the auto-generated constraint name. |
| `PUT` always returns 200, never 201 | PUT is idempotent and distinguishing create from update needs an extra query whose answer is stale by the time it is returned. A client must not build on an unreliable signal; `createdAt` in the response is the honest answer. |
| The management not-found is a **separate** error from the routing one | `store.ErrUnknownModel` also covers "the row exists but is disabled", which is the right contract for an OpenAI-compatible client (404 `unknown_model`). The management surface must see disabled rows, otherwise nobody can re-enable them. |
| Disabled rows are always listed; `enabled` is a field, not a filter | Same reason. |
| `DELETE` removes the row physically and does not filter on `enabled` | Disabling is the routine way to take a model out of rotation. Deleting is for "this row was entered wrong", and a disabled row must still be deletable or it becomes an undeletable orphan. Historical cost events store a `costUsd` snapshot rather than a foreign key, so deleting a row does not invalidate old ledger entries — but it does destroy the explanation of which rate produced them, which is why deletion stays an explicit act. |
| The API key is structurally unreturnable: `domain.ProviderConfig` has no such field | `store.Provider` (routing view) must carry the key to present it upstream; `ProviderConfig` (management view) must be incapable of leaking it. Two types means a future change to the routing struct cannot widen what the management API returns. No masked form either — a mask still discloses a fragment of a credential that is only ever compared. |
| Validation errors never include the key | A 400 body goes back to the client and into the logs. Pinned by test. |
| `upstreamBaseUrl` is only trimmed, not otherwise normalised | `gateway.forward` already does `TrimRight(BaseURL, "/")` before appending `/v1/chat/completions`, so trailing slashes are harmless either way; a `/v1` path prefix is the operator's real upstream shape and rewriting it would produce a wrong address. Validating and then storing the *same* bytes matters: `Validate` returns the normalised copy and the handler must pass that copy on, so "what validation accepted" and "what got stored" cannot diverge. |
| Empty list serialises as `[]`, not `null` | A nil slice encodes to `null` and the client's `providers.map` throws. "Nobody has configured a provider yet" is a normal initial state. |

**Migration.** `llm_providers` gained `updated_at`. `Init` runs both the
`CREATE TABLE IF NOT EXISTS` and an explicit
`ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS updated_at ...`, because
`CREATE TABLE IF NOT EXISTS` does nothing at all to a table that already exists —
the same reason migration 004 had to restate the heartbeat primary key.
`created_at` is deliberately absent from the upsert's `SET` list: it is the row's
birth time, and updating a row must not move it.

**Verification.**

- `gofmt -l`, `go build ./...` and `go vet ./...` are clean; 27 tests pass and 7
  skip by convention.
- The new tests are split deliberately. Twelve handler-contract tests run with
  **no external dependency** — they cover routing, status codes, error codes, JSON
  shape, "an omitted field must reach the store as `nil`", and "the key never
  appears in any response body". Two PostgreSQL-gated tests cover what a fake
  cannot: the `ON CONFLICT` + `COALESCE` "omitted means keep" behaviour and the
  23502 → 400 translation. Asserting SQL semantics through a fake would only be
  asserting the fake.
- `domain` statement coverage is 92.2%; the provider handlers are at 90–100%.
- The PostgreSQL-gated tests were **not** executed locally (no PostgreSQL, no
  container runtime); they skip unless `LUMO_TEST_PG_DSN` is set.

### E-group re-audit and connector audit query surface: 2026-09-15

The E group was the last small, judgement-callable block. Working it item by item
produced a result worth recording: **two of the three "dead code" items were not
defects at all**, and the third one's defect was misidentified.

| Item | Was recorded as | Actually is |
| --- | --- | --- |
| E2 reconciliation | "records observations but never repairs divergence" | **Not a gap.** `store.go:966-976` does `UPDATE scheduler_tasks SET attempt, node_id, state, fencing_token` behind `e.Attempt > currentAttempt \|\| (== && stateRank(e.State) > stateRank(currentState))`. The claim was copied from the doc comment; the body repairs. |
| E3 dispatch outbox | "no production consumer; `ClaimDispatch` only called by tests" | **Not a gap.** Two consumers claim inline in the same transaction as their admission receipt: `PgGovernedDispatch.take()` (`subagent-host/src/governed-dispatch.ts:61-123`, Agent path) and `dispatchDeviceTask` (`governance/internal/store/devices.go:547-643`, device path). Both filter `o.delivered_at IS NULL AND o.claimed_by IS NULL` and then set `delivered_at`. |
| E5 `session-title-gw` | "unfinished plugin, still referenced by the assembly table" | The **registration** was the defect; the package is a deliberate **verification slice**. Now removed from both assembly tables. |

**Why `ClaimDispatch` must stay caller-less.** Its shape is claim-then-ack across
two round trips. Both real consumers need the claim, the admission gate and the
`delivered_at` write in **one** transaction — `PgGovernedDispatch`'s own comment
states the reason: a crash after acceptance is settled by a replacement with an
explicit failure receipt, and the same Run must never silently execute twice. An
HTTP claim route would create a second competitor for the same rows, and a row
claimed but not acked is invisible to both real consumers (they filter
`claimed_by IS NULL`) yet not executing — it would sit until
`RequeueStaleDispatch` (`cmd/scheduler/main.go:93`, period `ttl*2`) recovers it.
So `ClaimDispatch` is kept as the pull-model reference implementation, pinned by
`internal/integration/drain_test.go`, and **no route should be added for it**.

**E5: why the registration was worse than dead weight.** `PLATFORM_PLUGIN_MODULES`
is not just a name table — `profilePluginSpecs()` iterates it to build
`dsh plugin add` specs. Because `isOptionalProfilePlugin('@lumo/...')` is always
`false`, an install failure **throws and terminates startup** rather than degrading
to a warning. Registering a package that can never load therefore plants an
unconditional startup failure on every profile. `PLATFORM_PLUGIN_DIRECTORIES` is
typed `Record<keyof typeof PLATFORM_PLUGIN_MODULES, string>`, so the two tables
cannot drift apart silently — but that also means the key has to be removed from
both, which is exactly the kind of half-edit worth checking for
(`link:.../undefined`).

**E7: the connector audit query surface.** `connector_audit` had a writer, three
read-shaped indexes and **no read route**, so "what did this session actually call
externally" could only be answered with `psql` against production. An audit table
that is only readable by its writer is not an audit.

`GET /audit` (`connector-gateway/internal/server/audit.go`,
`internal/audit/query.go`):

| Decision | Why |
| --- | --- |
| Realm comes from the identity header only; a `?realm=` parameter is ignored | The package's own rule: realm decides which calls you can see, so self-reporting it is privilege escalation. Pinned by a test, so a later "convenience" change breaks it. |
| Non-admins default to their own calls; `all=true` requires an admin role | Mirrors the sibling `approval.List(ctx, realm, requester, all)`. Audit rows carry `target_host` and `operation`; cross-user visibility is an administrative capability. The rejection happens **before** the data layer is touched. |
| An unrecognised `decision` is a 400, never "no filter" | `?decision=denyed` silently degrading to no filter would turn a "show me only the denied calls" compliance query into "show me everything". A widened result set is more dangerous than an error. |
| Sort key **and** keyset cursor are both `id` | `created_at` is the transaction start time while `id` is the insert time, so under concurrency a transaction that started earlier can insert later. Ordering by one and paginating by the other loses or repeats rows. `id` is a strict total order. |
| Keyset (`beforeId`) rather than offset | The table only grows; concurrent inserts shift an offset window between pages. Pinned by a test that walks every row in pages of two and asserts exact coverage. |
| Reading is a separate type (`audit.Reader`) from writing (`audit.PgSink`) | The write path is authoritative and must fail loudly; the read path is realm- and role-filtered and its failure only affects investigation. Sharing a type invites treating a read failure as a write failure. |
| `projected_at` is not in the DTO | It is projection bookkeeping, not audit content — and since the projector does not exist (see E7b below), exposing it would imply a timeline that is not there. |
| An unconfigured reader returns 503, not an empty list | "Nothing matched" and "not configured" have to be distinguishable. |
| Store errors are not echoed | SQL errors can carry the realm and the query. The response is a generic message and the detail goes to the log. |

**New item E7b.** While implementing the above it became clear the projection half
was never built: `connector_audit.projected_at` and `idx_connector_audit_pending`
exist solely for a projector, and nothing anywhere reads or writes that column.
So §10.1's "record every external call as a session event" is only half true — the
authoritative PG table is written, the timeline for the model and the frontend is
not. It belongs with the C-group cross-process projection work and must be built in
the dsh plugin layer (cf. `knowledge/src/graph-projector.ts`), **not** as a new
route on connector-gateway: the session store is outside that service's boundary.

**Verification.**

- `gofmt -l`, `go build ./...` and `go vet ./...` are clean across
  `connector-gateway`.
- 16 tests pass, 4 skip. Thirteen handler-contract tests run with **no external
  dependency** — realm-from-identity, own-calls-only, the admin gate, the
  unknown-decision 400, malformed cursor/limit, verbatim filter pass-through, the
  503-when-unconfigured distinction, `Cache-Control: no-store`, error hiding, and
  non-GET methods. Three pure tests cover `ParseDecision` and `NormalizeLimit`.
  Four PostgreSQL-gated tests cover what a fake cannot: that the `WHERE` clauses
  actually apply, that keyset paging is exact, that the order is by `id` and not
  `created_at`, and the degenerate inputs.
- `handleAudit`, `parseLimit` and `parseBeforeID` are at 100% statement coverage;
  so are `ParseDecision` and `NormalizeLimit`. `Reader.Query` reads 0% locally
  because its tests skip without `LUMO_TEST_PG_DSN`.
- `Server.New` now defaults a missing `Logger` to `slog.New(slog.DiscardHandler)`
  (Go 1.24+). Two existing call sites already dereferenced `s.log` without a nil
  check, so a caller that omitted the logger was a latent panic.
- E5 was verified by executing the changed functions directly under
  `node --experimental-strip-types` rather than through vitest: the local profile
  list matches the exhaustive `toEqual` in `plugins.spec.ts:50` exactly (16 names,
  same order), and across all four profile/mode combinations there are no
  malformed specs (`link:.../undefined`) and no duplicates. The machine was at
  load average ~28 on 16 cores, and vitest could not start a worker at all
  (`Timeout waiting for worker to respond`), so the full spec could not be run —
  see the note in `.workbuddy-ai/memory/local-sandbox.md`.

### D5: the acceptance chain no longer reports green without evidence — 2026-09-15

Worked D5 by reading the two acceptance scripts and the specs they invoke. The
item was recorded as "acceptance was never actually executed"; the real finding
is worse — **one of its steps was reporting success while executing nothing.**

#### 1. The silent-skip defect (the substantive find)

`acceptance-cluster.sh` exported `LUMO_TEST_PG_DSN` only, but
`dsh-plugins/session-log/__tests__/pg-log.spec.ts:16` reads

```ts
const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
```

The names never matched, so the step took the `it.skip` branch. Measured with
the JSON reporter and no DSN:

```
total 19  passed 0  pending 19  todo 0  success true   # exit code 0
```

Nineteen live cases — including the cross-node resume/fencing story that is the
entire point of the step — were skipped, and the chain printed "passed". This is
the worst failure mode in the repo's own idiom: a green that is not evidence.

The same alias mismatch affects `session-log/{hot-log,query,backfill,cold-archive}`,
`job-control`, `metering/{pg-contract,outbox,pg-budget,sink}` and
`storage/pg-backend`. The Go side never had this problem: every control-plane
module reads `LUMO_TEST_PG_DSN` directly.

**Fix**: `platform/vitest.setup.ts`, wired via `setupFiles` in
`platform/vitest.config.ts`, fills each `<SUBSYSTEM>_TEST_DSN` from
`LUMO_TEST_PG_DSN` when the subsystem name is unset. One mechanism instead of
twelve spec edits, and it fixes `pnpm test` locally as well as the acceptance
chain. Explicit subsystem names still win, so "point just this subsystem at
another database" keeps working.

Verified three ways:
- canonical set → all four aliases filled (`setup 558ms` in the report, so the
  setup file really ran before the spec's top-level code);
- canonical unset → no aliases invented (specs still skip rather than connecting
  to a wrong database);
- canonical set, explicit `SESSION_LOG_TEST_DSN` present → explicit value kept.

And the decisive one: with **only** `LUMO_TEST_PG_DSN` set to a dead address,
`pg-log.spec.ts` now reports `pending 0`, i.e. all 19 cases execute (they fail
only because the address is dead). Before the fix the same invocation was 19
skipped / exit 0.

#### 2. Every step now asserts it executed live cases

Exit codes cannot carry this contract: `it.skip`, `describe.skipIf` and
`t.Skip` all leave the exit code at 0. So the script counts what actually ran.

- vitest steps run with `--reporter=default --reporter=json
  --outputFile.json=<tmp>` and count `numTotalTests - numPendingTests -
  numTodoTests`.
- Go steps run with `-v` into a report file and count `^--- PASS` / `^--- SKIP`.
- Zero executed → hard failure with the evidence dumped. Skip counts are printed
  on success too, so partial coverage is at least visible.

Proven for both runners on real output: `go test -v ./internal/integration` with
nothing set prints `PASS` / `ok` / exit 0 while all 8 tests SKIP (`passed=0
skipped=8`) — precisely the case the guard rejects.

Deliberate limit: the invariant is "at least one live case per step", not "no
skips". A stricter rule would turn today's green CI red for packages whose
optional dependencies (e.g. `registry`'s object-store cases) are absent, which
is a separate decision from "this step produced no evidence at all".

#### 3. `preflight-deployment.sh` required-service list

Was ten hardcoded names; omitted `connector-gateway`, `llm-gateway`, `flows`,
`projects`, `usage-ledger`, `collaborator-*`, `opa`, `vault`, `milvus`, `etcd`,
`tei`, `tei-rerank`, `rocketmq-namesrv`, `rocketmq-topic-init`. The static check
passed even when those were absent.

Now shape-aware and exact: cluster 34 services, standalone 20. Verified by
extracting the arrays from the script and diffing against the compose
default-render sets — zero missing, zero extra in both shapes. Two corrections
to the numbers that stood here before:

- Both counts dropped by one on 2026-09-20, when the one-shot
  `rocketmq-topic-init` service was merged into the `rocketmq` entrypoint and
  therefore stopped being a topology entry.
- The cluster figure was stated as 33 and had **never** matched the topology:
  re-diffing on 2026-09-20 (after the merge) gives 34 required == 34 rendered,
  so before the merge the true pair was 35/21, not 33/21. Only the standalone
  figure was accurate. The invariant that carries the check is
  `required == rendered`, not the number itself — `preflight` prints the count
  it actually compared, so read that line rather than this paragraph.

Two details:

- `provisioner` and `artifact-runtime` are behind `profiles: [provisioner]`, so
  `docker compose config --services` does not render them by default. Requiring
  them would fail every default deployment.
- The expected list is **hardcoded on purpose**. Deriving it from the compose
  file would make the check vacuous.

#### 4. Nebula was required but exists nowhere

The script called `require_value LUMO_TEST_NEBULA_HEALTH_URL`. There is no
Nebula service in any compose file or Helm chart, `cluster-runtime.env:9` and
Helm `values.yaml:24` both default it to empty, and
`knowledge/src/index.ts:69` documents empty as "fall back to PG recursive CTE".
So the gate demanded an external service the product itself treats as optional —
it announced "this can never pass" before any evidence was gathered.

Now optional: probed when set, one INFO line when not. This also decouples D1
from D5.

#### 5. Chain coverage

`collaborator ./internal/integration` was missing entirely (a control-plane
service with a PG-gated integration suite). Added, plus
`connector-gateway ./internal/audit` for the read surface added earlier today.
The original note also claimed governance was absent — that was stale;
`acceptance-cluster.sh:53` already included it. Report filenames now include the
package path so one module can contribute two steps without overwriting evidence.

#### 6. `LUMO_TEST_*` contract

Added `deploy/acceptance.env.example`: required vs optional, the compose-internal
port of every dependency (read off the healthchecks and standalone's published
mappings, not guessed), the warning that `LUMO_TEST_RMQ_ENDPOINT` wants the
mqproxy gRPC port and not the namesrv port, and the subsystem-override
explanation. Documented in `deploy/README.md`.

#### 7. RocketMQ topic reset targeted the wrong broker

`usage-ledger/internal/integration/rmq_e2e_test.go` defaulted
`LUMO_TEST_RMQ_CONTAINER` to `lumo-platform-standalone-rocketmq-1` while the
cluster acceptance path runs that same test. The reset then failed silently
(a warning nobody reads), topics accumulated across runs, and the suite timed
out for reasons unrelated to the code under test — the failure mode the file's
own comment says was "learned after two red runs".

Now: explicit env wins, otherwise discover the running broker by
`label=com.docker.compose.service=rocketmq`; ambiguous (both topologies up) or
absent means skip **with the variable named in the message** rather than
guessing. `acceptance-cluster.sh` additionally resolves the container from
`compose.cluster.yml`, because that script knows it is the cluster.

#### Verification

- `vitest.setup.ts` ordering and all three env cases: verified by a throwaway
  probe spec (since deleted) plus a live-vs-skipped comparison on
  `pg-log.spec.ts`.
- Guard counting: verified on real vitest JSON (`19/0/19`) and real
  `go test -v` output (`passed=0 skipped=8`).
- Preflight lists: verified by diffing extracted arrays against compose
  default-render sets (30/30 and 18/18).
- Script behaviour: `bash -n` clean; missing env fails at `require_value` naming
  the variable; unreachable endpoints fail at the health probe; a full run
  against a local stub printed the four "healthy" lines, the Nebula INFO line,
  and proceeded into the Go steps.
- `gofmt`/`go vet` clean on the changed Go package.
- **Not verified**: an end-to-end acceptance run. No Docker daemon is reachable
  from this machine and no live PG/RocketMQ is available, so the chain has still
  never produced real multi-node evidence — see the remaining item below.

#### 8. The last blocker: the cluster topology publishes no infrastructure ports

`compose.cluster.yml` has `ports:` only on prometheus, dsh-web and the eleven
control-plane services (18081-18093). `postgres`, `redis`, `minio`, `nacos`,
`milvus`, `opa`, `vault`, `etcd` and `rocketmq` are reachable only inside the
compose network — so the DSN, the five health URLs and the RocketMQ endpoint the
chain requires could not be reached from the host after a plain `up.sh cluster`.
(Standalone *does* publish them, which makes it the easier local target.)

Closed with two pieces:

- `compose.cluster.acceptance.yml` — an additive override that adds `ports:` to
  nine existing services. It introduces no new service and removes none, so
  `preflight-deployment.sh` and `smoke-cluster.sh` keep working untouched: their
  `config --services` result is unchanged (verified: merged service set is still
  exactly 32). Host ports deliberately match `compose.standalone.yml`, so the
  values in `acceptance.env.example` hold for both shapes; the cost is that the
  two topologies cannot run at once.
- `LUMO_COMPOSE_EXTRA_FILES` (colon-separated) in `up.sh`, appended after
  `compose.<shape>.yml`.

Port numbers are not guesses: postgres/redis/minio/nacos/rocketmq come from
standalone's published mappings; milvus 19530 from `LUMO_MILVUS_URL`, opa 8181
from `LUMO_OPA_ADDR`, vault 8200 from `LUMO_VAULT_ADDR` (`cluster-runtime.env`
and Helm `values.yaml` agree); milvus 9091 from its own healthcheck.

#### 9. P0 found while verifying the above: `up.sh` never started anything

Chasing why the extra-file branch did not run produced a much bigger find. The
original `up.sh`, run against a stub `docker`, exits 1 **before** reaching
`docker compose up`:

```
=== 原始 up.sh standalone（docker 桩有输出，模拟容器已在运行）===
  退出码 = 1
  是否到达 docker compose up: 0
=== 原始 up.sh cluster ===
  退出码 = 0
  是否到达 docker compose up: 1        # 仅因为桩让 postgres 容器“已存在”
```

Cause: `warn_legacy_cluster_storage` only *warns*, but it is called as an
ordinary command under `set -e`, and its two early exits are bare `return`s:

```sh
[[ "$shape" == "cluster" ]] || return        # up.sh:24 — standalone 必中
[[ -n "$postgres_container" ]] || return     # up.sh:34 — 首次部署必中
```

A bare `return` yields the status of the last command executed — here the failed
`[[ ]]`, i.e. **1**. So a warning aborted the script:

- `up.sh standalone` exited 1 **unconditionally** (the shape check fires first);
- `up.sh cluster` exited 1 whenever no postgres container existed yet, i.e. on
  every first deploy.

Both startup paths documented in `deploy/README.md` were therefore dead. Fixed
by making all three early returns explicit `return 0` plus a trailing `return 0`.
Verified across four scenarios (standalone/fresh, cluster/fresh, cluster with a
legacy bind mount, cluster with a volume mount): all four now reach
`docker compose up` with exit 0, and the legacy warning still prints when it
should and stays silent otherwise.

**Rule this generalises to: a "warning" function called under `set -e` must
always return 0, or the warning becomes a fatal error.**

#### Remaining

Not code. The chain has still never produced real multi-node evidence: no Docker
daemon is reachable from this machine and no live PG / RocketMQ is available.
The CI `deploy-smoke` switch is also still unverified
(`.github/workflows/ci.yml` has not been read).

---

### D2 + D3: the chart's Secrets get a contract, and the cluster shape gets a profile — 2026-09-15

#### 1. What was actually wrong

The gap list recorded D2 as "no Secret template" and D3 as "nine switches default
to false". Both were true and both understated the problem. Reading the templates
end to end showed two distinct defects behind D2:

- **The default render is not installable.** `lumo-control-plane-token` is read
  with `optional: false` by every enabled control-plane service, and the chart
  never creates it, so a fresh `helm install` leaves every pod in
  `CreateContainerConfigError` until an operator guesses the right Secret names
  *and* key names from the templates.
- **Nothing documented the key names.** `registry-trust.json` is a key that
  cannot be inferred from `registry.trustSecret`, and the volume mount does not
  fail loudly when it is wrong — the container starts with an empty trust
  directory.

And D3's real content is not "turn things on" but "decide, per switch, whether
the fact it needs is knowable at chart-authoring time".

#### 2. Secret generation: what is mintable, and what can never be

`secrets.create` (default `false`) is opt-in, because a chart that mints
credentials by default stores them in the release object — readable by anyone
with `helm get manifest` — and never rotates them. It generates:

| Secret | Key | Generated? | Why |
|---|---|---|---|
| `lumo-control-plane-token` | `token` | yes | pure random bearer, no external counterpart |
| `lumo-subagent-host-token` | `token` | yes | pure random bearer, no external counterpart |
| `lumo-registry-trust` | `registry-trust.json` | placeholder `{"publishers":[]}` | readable so the Registry starts; trusts nothing, so verification fails **closed** |
| `lumo-vault-token` | `token` | **no** | must match a real Vault this chart does not deploy; a random value is an invalid credential |
| `lumo-registry-trust` (real) | `registry-trust.json` | **no** | it is a set of publisher public keys (`registry/internal/trust/trust.go:47-52`), not a credential |

The `vault.tokenSecret=""` case is handled by **omitting the env var entirely**
rather than by making it optional in place, and the same class of guard covers
`registry.trustSecret` (required when the Registry is enabled) and
`dshNode.hostTokenSecret` (required when dshNode or dshWeb is enabled).

#### 3. Rotation safety, and why it is not a nicety

`randAlphaNum` is evaluated on every render, so an unguarded generator turns a
plain `helm upgrade` into a credential rotation: every workload already holding
the old bearer starts failing authentication. `_helpers.tpl`'s
`lumo-platform.managedSecretValue` therefore reads the live object first and only
mints when it is absent. Paired with `helm.sh/resource-policy: keep`, an
uninstall does not destroy credentials, and re-installing under the same release
name adopts the object and reuses the same value.

Caveat kept in the template comment: `lookup` needs an API server, so under
`helm template` / `--dry-run` it always returns empty and a fresh value is
minted. Rendered output from this path must not be committed or diffed as if it
were stable.

#### 4. The cluster profile: every switch, decided

`values.cluster.yaml` is the Helm counterpart of `compose.cluster.yml`. The
switches it turns **on**: `dshNode` (the definitional cluster capability),
`dshWeb` (the operator entry point), `secrets.create` (so the profile is
installable as-is, matching compose's development defaults), and per-service
`replicas` for `scheduler` and `collaborator`.

The switches it leaves **off**, each with the operator-specific fact it needs:

| Switch | Needs |
|---|---|
| `connectorOAuth` | a registered OAuth application and `callbackUrl` |
| `deviceGateway` | an exact public HTTPS origin, a server certificate, a dedicated device CA |
| `deviceGateway.istioIngress` | additionally an Istio-managed ingress controller |
| `serviceMesh.istio` | the mesh `trustDomain` — deliberately not guessed: "a wrong SPIFFE trust domain is an authentication bug" |
| `productionControls` | approved compliance references and retention/cost numbers ("Helm cannot make business/compliance choices") |
| `productionControls.observability` | a collector, a Loki endpoint, an object-store bucket |
| `provisioner{,.runtime}` | an artifact that has actually been published |
| `dshNode.governedWorker` | a per-pod identity specialisation, all six fields known up front |

Per-service `replicas` had to be added to `templates/deployment.yaml`: the
cluster shape is not uniform (scheduler and collaborator in pairs, the rest
singly) and a single global `replicaCount` cannot express it. A single-replica
scheduler would also leave the lease/standby path — the thing cluster acceptance
exists to exercise — unable to run at all.

#### 5. P0 found while doing the above: `replicaCount: 2` produced two leaders

Only `collaborator` received `LUMO_INSTANCE` from `metadata.name`. The scheduler
resolves its lease holder as `LUMO_INSTANCE` **or the literal `"scheduler-0"`**
(`scheduler/cmd/scheduler/main.go:33`, whose flag help reads "本实例标识（租约
holder，重启后不得与旧进程重复）") — not the hostname. So two replicas both claim
the holder `scheduler-0`, and `Acquire`:

```sql
fencing_token = CASE WHEN scheduler_leader_lease.holder = EXCLUDED.holder
  THEN scheduler_leader_lease.fencing_token      -- same holder → not advanced
  ELSE scheduler_leader_lease.fencing_token + 1 END
...
WHERE scheduler_leader_lease.holder = EXCLUDED.holder   -- still matches
```

(`scheduler/internal/store/store.go:204-208`) returns a row to **both** processes
with the same `fencing_token`. `checkFencing` compares holder and token only
(`:253`), so both pass: **two leaders with no fencing between them.**

Fixed by giving every control-plane service `LUMO_INSTANCE` from
`fieldRef: metadata.name`. Using the pod name also closes a second hole: a
restarted pod gets a fresh holder name and therefore a higher fencing token,
fencing out the previous process, whereas a static name would let a restart
resurrect the same token.

#### 6. The render gate

`platform/deploy/helm-verify.sh` — pure `helm`, no cluster, no Docker daemon,
runs in seconds. It asserts:

- both profiles render, and both pass `helm lint` (the only offline way to render
  `NOTES.txt`, proven by control: injecting a bad reference into `NOTES.txt` makes
  lint fail);
- every referenced Secret is either rendered or named in an explicitly
  **hardcoded** operator-supplied list — deriving the list would make the check
  true by construction;
- no Secret reference rendered an empty name;
- the cluster profile's Secret set and scheduler replica count match expectations;
- every control-plane service binds `LUMO_INSTANCE` to its pod name;
- four guard inputs are **rejected** (no control-plane Secret, no subagent host
  Secret, no registry trust Secret, dsh-web with neither assertion Secret nor
  static identity), and the control-plane guard is **conditional** (all nine
  services disabled still renders, so the guard is not vacuously true).

The counter-cases exist because a gate that only checks "the good render
succeeds" stays green after the guard it was supposed to protect has been
deleted.

#### Verification

- Base profile render is byte-for-byte equivalent in shape to before: 19
  documents, **0 Secrets** — `secrets.create` defaults to false and nothing else
  changed.
- Cluster profile renders 11 Deployments, 11 Services, 1 HPA, 1 ConfigMap and
  exactly 4 Secrets.
- Guard behaviour probed directly: `vault.tokenSecret=` now emits **no**
  `LUMO_VAULT_TOKEN` at all (was: `secretKeyRef: { name: , ... }`), and all nine
  services disabled still renders.
- **Six control experiments**, each deleting one guard in a throwaway copy of the
  chart, all turn the gate red — and each for the right reason (the vault case
  trips both the "still emitted the variable" check and the "9 empty names"
  check; the deleted Secret trips both the resolve check and the exact-set
  check).
- `helm lint` clean on both profiles; `bash -n` clean on the new script.
- **Not verified**: an actual `helm install` against a cluster. No cluster is
  reachable from this machine, so the gate's output has never been applied.

#### Remaining

Wiring `helm-verify.sh` into CI was recorded here as unverified while
`.github/workflows/ci.yml` had not been read. It has been read and the gate is now
wired (see "CI evidence wiring" below). The gate itself was runnable by hand from
the day it was written, which is exactly why the omission was easy to miss: **a
gate that nobody invokes is indistinguishable from a gate that passes.**

#### 7. Found while re-auditing C3/C4 (2026-09-16): the gate cannot see a service that never entered the chart

Re-checking the edge gateway (C3) and terminal gateway (C4) surface by surface
turned up one surface that is simply absent: **neither service is in this chart.**
`compose.cluster.yml`, `compose.standalone.yml`, `prometheus.yml`,
`prometheus-standalone.yml`, `prometheus-alerts.yml`, `preflight-deployment.sh`,
the CI matrix and `build.sh` all list both of them — eight surfaces out of nine —
but `values.yaml` has no `services` key for either, so `helm install` produces a
cluster without its outermost north-south entry or its terminal entry.

The stronger evidence that this is an omission rather than a deliberate scope cut
is in this chart's own configuration: `templates/configmap.yaml:30-35` reads

> 同一个 OPA 有两个环境变量名：connector-gateway 读 `LUMO_OPA_ADDR`,
> session-control 与 terminal-gateway 读 `LUMO_OPA_URL`。**两条都要有**

i.e. the config surface was written on the assumption that a terminal gateway runs
inside the chart. It was given a policy-engine address and no Deployment.

**Why §6's render gate cannot catch this, and why that is not a bug in the gate.**
`helm-verify.sh:203` hardcodes `expected_instance_refs=10`, and 10 *was* exactly the
number of services `values.yaml` declared at that time. (It is 12 now — the two
gateways were charted the same day, see "Charting the two gateways" below — and the
structural hole described here is closed by the "chart coverage" comparison rather
than by that count.) The comment above it explains
the rule and it is the right rule — deriving the count from the rendered output
would make the check true by construction. But a hardcoded expectation pinned to
the chart's *current* contents can only detect **value drift** (a binding that
disappears from a service that is present). It is structurally blind to a **missing
member**: if a service was never in the chart, the expected count was never raised
for it, and the check passes for the same reason it passed the day before the
service was written.

A gate that closes that hole has to compare two independently maintained sets
rather than one set against its own count. The comparison is also exact and cheap
here, because the two sets are already written down:

| Set | Count | Where |
|---|---|---|
| Control-plane modules shipped as images | **12** | walk `platform/control-plane/*/Dockerfile` |
| `services` keys in the chart | **12** | `values.yaml` |

The difference *was* exactly `{edge-gateway, terminal-gateway}`, which is what the
comparison was written to find — and it found it: the gate failed on those two
names before either was charted. **Both are charted as of 2026-09-16** (see their
rows above), so the two sets are now equal and the comparison is unconditional:
the exclusion list it briefly carried is gone. That list is worth one sentence
because it was the defect's own shape — "every module is charted *or excused*" is
a weaker question than "every module is charted", and the excuse is where a
forgotten service hides; it also had to be maintained by hand inside a file whose
own reasoning is that hand-maintained lists rot in the direction nobody checks.
It came out the moment the drift lock forced it, which is the lock working, not a
cleanup.

Note that the comparison must **walk the repository tree**, not use `preflight-deployment.sh`'s
cluster list as the reference: that list (33) deliberately includes middleware
(postgres, redis, nacos, opa, vault, rocketmq, minio, milvus …) which this chart
intentionally does not ship — see §2's framing, and the same "derive it from the
tree, never from a hand-written enum" rule that the CI matrix fix arrived at.

That judgement **is implemented** in `platform/deploy/helm-verify.sh` (the "chart
coverage" section), and it runs in CI through the existing `Chart render gate`
step — no new wiring was needed. It carries a counter-case (deleting a charted
service from `values.yaml` must be reported by name).

#### Charting the two gateways: 2026-09-16

Closing the coverage gap meant more than two lines in `values.yaml`, because both
services are **entry points** and the edge gateway's configuration is a *file*:

- **The route table is rendered, not copied** (`templates/edge-routes.yaml`). Its
  upstream hosts and ports come from the release name and from each service's own
  `port`. Copying `edge-routes.dev.json` would have been the obvious move and it
  is wrong twice over: the routing package requires the whitelist to equal
  `url.Host` **exactly**, so a hardcoded `<name>-flows:8087` breaks the moment the
  release is named something else (the cluster profile is documented to be
  installed twice in one namespace); and a hardcoded port silently points at the
  old one after `services.flows.port` moves, which loads fine, starts fine, and
  shows up as a 502 on the first matching request. A route naming a service that
  is not enabled fails at **render** time instead.
  The chart's whitelist is derived from its own routes. That is not a weakening:
  the dev table's hand-written whitelist is a second place to mistype a host
  (`edge-routes-verify.sh` asserts it has no dangling entries), whereas here the
  constraint "no route may point at a host that is not a deployed Service" holds
  by construction — and the derived list is still checked, because "true by
  construction" is exactly the kind of claim that decays.
- **Mounted as a directory, not via `subPath`** (`templates/deployment.yaml`). A
  subPath mount never receives ConfigMap updates, so the gateway's SIGHUP reload
  would re-read the bytes the pod started with — the hot-reload path would exist
  in the code and be dead in the deployment.
- **Exposure stays the operator's decision.** The global `service.type` remains
  ClusterIP; each entry point can override it per service. The alternative lever —
  flipping the global — would expose all twelve services, including internal
  faces that must not be reachable. Whether an Ingress fronts them is deliberately
  still a product decision (D3), not something this change decided.
- **The signing Secret is minted through the same lookup-and-reuse helper as the
  bearers.** An empty signing key does not stop the process: it makes every
  sensitive terminal action fail closed with a log line that reads like a
  permissions problem, so the name is required at render time. Reuse (rather than
  a fresh `randAlphaNum` per render) matters more here than for a bearer — a
  rotating key invalidates signatures already in flight.
- **Adding a service to the chart adds a runtime gate, not just a Deployment.**
  `LUMO_REQUIRED_SERVICES` is derived from the `services` keys, so every charted
  service must publish a heartbeat or governance readiness stays closed. Both
  gateways do (`heartbeat.StartPg` with service names `edge-gateway` /
  `terminal-gateway`), and that was checked before charting them rather than
  assumed. The same derivation is why `helm-verify.sh`'s `all_off` list must name
  every key: forgetting one leaves it enabled, which makes the "every service
  disabled" render reference a Secret that is not rendered — the check fails
  loudly, which is how the addition was caught in review.
- **`--set edgeGateway.routes={}` does not produce an empty list**, so the
  counter-case for "enabled gateway with an empty table" uses a values overlay
  instead. Pinning the counter-case to `--set` would have tested `--set`'s parser
  rather than the guard.

Two traps found by writing this, both silent by nature:

1. **Hyphenated service keys cannot be named with dotted access.** Go templates
   read `{{ .Values.services.terminal-gateway.enabled }}` as subtraction and fail
   with `bad character U+002D` — a parse error naming a column, not the key.
   Every hyphenated key needs `index .Values.services "terminal-gateway"`. This
   stayed hidden until now because no template had ever referenced one
   (`connector-gateway`, `llm-gateway`, `session-control`, `usage-ledger` were all
   only ever ranged over as `$name`).
2. **`| quote` on a large number renders scientific notation.** Helm decodes
   values as float64, and `%v`/`%g` switches at 1e6: the default
   `maxBodyBytes: 1048576` rendered as `"1.048576e+06"`. The gateway parses that
   with `strconv.ParseInt`, fails, and falls back to its built-in default — which
   *happens to be the same value*, so the defect was invisible until someone set
   `maxBodyBytes: 2000000` and the effective limit silently stayed 1 MiB. The
   fix is `{{ int ... | quote }}`, and any future numeric env needs the same cast.

Finally, the **second deployed route table now has a gate of its own**: the dev
table was validated by `edge-routes-verify.sh` (which feeds it to the gateway's
own validator), but the Helm-rendered table had none — the chart side only had
structural assertions that never *load* it, and loading is the only thing the
gateway does with it at startup. `edge-routes-verify.sh` now renders that table
and runs it through the same validator, with two assertions specific to it: the
derived whitelist still rejects a foreign host, and dropping a route is reported
by the pinned coverage expectation.

### Global execution monitoring: 2026-09-15

#### 1. Two rules that could never fire

`LumoServiceDown`'s condition was `lumo_service_up == 0`, but `lumo_service_up`
was a hardcoded literal `1` printed by `Metrics.Write`. It could never be 0, so
the alert had never fired and could not. Separately, the Helm recording rule
selected `lumo_http_requests_total{status=~"5.."}` while that counter carries
**no labels at all** — the selector matched nothing, forever, and
`lumo:http_error_ratio5m` was therefore always empty. Both were syntactically
valid and accepted by Prometheus; they were simply dead.

The fix for the first was to **delete** `lumo_service_up` rather than leave it
in place. Deleting it means any future reference fails the new gate on "this
metric has no writer", instead of failing silently at 03:00. The correct
instance-liveness signal is Prometheus's own `up`: it is produced by the
scraper, so it does not depend on the monitored service truthfully reporting
its own death.

#### 2. What the metric layer was missing

Two things, and both are required before any cluster dimension can exist:

- **Labelled gauges** (`SetGaugeWithLabels`) so a series can be drilled into by
  `cluster_id` / `state` / `service`.
- **Whole-set replacement** (`ReplaceGauges`). Incremental writes cannot express
  *disappearance*: a series that stops being written keeps its last value
  forever, so "cluster X has 100 queued" survived the queue draining and the
  matching alert could never resolve. Replacement removes every series under the
  name first, keyed on the **rendered** label string rather than the caller's
  map — keying on the map would let two concurrent callers sharing an aliased
  map delete each other's series.

Label *values* are escaped, not rejected (`\`, `"`, newline): a rejected series
loses its alert silently, while a stray escape character is trivially
diagnosable. Every rejection — invalid metric name, invalid label name,
cardinality overflow, invalid point inside `ReplaceGauges` — increments
`lumo_observability_metric_series_dropped_total`. Counting only one of the two
rejection kinds would leave the other a silent disappearance channel.

#### 3. Data sources for the six classes

| Class | Source |
|---|---|
| `task_lost` | active tasks whose `node_id` is absent from the directory snapshot |
| `node_down` | healthy nodes per cluster from the directory |
| `queue_backlog` | per-cluster oldest `PENDING` wait, plus the global pending total |
| `budget_overrun` | new aggregate over `budget_trees` (DDL owned by the TS `pg-meter.ts`) |
| `gateway_5xx` | existing counters, plus a new scrape-time `service` label |
| `seam_circuit_open` | breaker `Group.Snapshot()`, non-closed only |

`task_lost` and `node_down` are **structurally unsatisfiable under the Pg
catalog** (local-lite): `scheduler_nodes` is upsert-only and has no liveness
signal whatsoever. That is written next to the rules rather than left implied —
a rule that can never fire must not masquerade as coverage.

Two details that would otherwise be wrong:

- The scrape path must not do network I/O. `/metrics` is polled, so querying the
  directory inside the handler makes "metrics are scrapeable" depend on another
  service's availability; a directory slowdown becomes "all metrics vanished".
  The node set is cached by a background loop, and its age is exported so stale
  data is visible as stale.
- On directory failure the cached node set is **kept**, only `ok` flips to 0 and
  `at` freezes. Clearing it would mark every active task as orphaned and trigger
  mass dead-letter migration — precisely what §7.4.1's "confirm fencing before
  migrating" exists to prevent.

#### 4. `max_stall` reaping

Three gates, none sufficient alone:

1. the directory snapshot must be **fresh** — a stale snapshot is a *subset* of
   the true node set, so it biases toward false-positive orphans;
2. the node must be **absent** from it — the fencing check;
3. the attempt must have been silent for `max_stall` (default 8h) — a *grace*
   period, not the primary predicate.

The third one is the subtle one. `scheduler_tasks.updated_at` only advances on a
state **transition** (`reconcile` writes it only when `stateRank` advances), so
a healthy 9-hour `RUNNING` task and a 9-hour-stuck one look identical. Using it
would mass-kill long tasks, and terminal states do not regress — the node's
later real result would be discarded. The clock is therefore taken from the
`attempt` row, which is refreshed unconditionally on every reconcile report, and
the stall duration is computed **in SQL** so application/database clock skew
cannot be mistaken for stall time.

Reaping is leader-only, and the write is conditional on (still active, same
attempt) so a task that progressed between decision and write is left alone.
Terminal state is `FAILED`, not `ABORTED`: `ABORTED` means "stopped on request",
and conflating the two makes it impossible to tell afterwards who gave up.
`ABORTED` would also be indistinguishable from a user cancellation. The ledger
table `scheduler_dead_letters` records node, stall duration and snapshot age, so
the decision — which was made on incomplete evidence, since the node is only
*absent from the directory*, not *proven dead* — stays auditable.

A negative `max-stall-ms` disables reaping, and says so in the log. A silently
non-running reaper would let "no dead letters" be read as "no stuck tasks".

#### 5. The gate, and why it has counter-cases

`platform/deploy/alerts-verify.sh` walks `platform/control-plane` with `go/ast`
(comments are not AST nodes, so a metric name mentioned in prose does not count
as a writer), extracts every `SetGauge`/`SetGaugeWithLabels`/`ReplaceGauges` call
site and every `# TYPE` literal, then checks each alert selector's metric and
label names against that set plus a per-metric label contract.

It also carries **nine counter-cases**, each of which must fail *with a specific
message*. A gate that only checks "the good input passes" stays green after the
check it protects is deleted — it cannot prove it is still working. Asserting
the exit code alone would be no better: a non-zero exit can come from any check,
so "assert it failed" leaves a backdoor for "the check was swapped for another".
The gate was itself verified by disabling the grouping-label check and watching
exactly the corresponding counter-case go red.

One genuine defect was caught this way: `LumoSchedulerQueueDepthHigh` had been
written as `max by (cluster_id) (lumo_scheduler_pending_tasks)`, but that gauge
is deliberately unlabelled (it is the external autoscaler's contract). Grouping
by a non-existent label does not error — it collapses every dimension and prints
an empty cluster name in the annotation.

#### Verification

- `go test ./...` green across the scheduler module; `go vet` clean; `gofmt -l`
  empty.
- **Eight counter-cases** for the reaper, each deleting one guard in a throwaway
  copy and asserting the *named* test fails. One of them exposed a vacuous test:
  `TestReapStalledDoesNothingWithoutLeader` passed even with the leader check
  removed, because a zero-value snapshot let the freshness gate short-circuit
  first. It now sets a fresh snapshot so only the leader check can stop it.
- The alert gate runs green with all nine counter-cases caught.
- The two recording rules turned out to have **no consumer anywhere in the repo**
  (not in the alert file, no Grafana dashboards shipped). They were left in place
  — deleting production Helm config on the strength of a repo-wide search is not
  a safe unilateral call — but a comment now records why the alerts must *not* be
  pointed at them: `lumo:http_error_ratio5m` aggregates `by (job)` while every
  control-plane service shares one `job`, so it collapses all services into a
  single series; and `service` is a scrape-time label whose global scrape config
  is not in this repository, so depending on it would put "will this alert fire"
  on a premise this repo cannot verify.
- **Not verified**: the `LUMO_TEST_PG_DSN`-gated integration cases (no PostgreSQL
  on this machine), and whether a real Prometheus accepts the rule file (no
  `promtool`). Rule-level keys were validated against Prometheus's strict set —
  one extra rule-level key (e.g. `class` outside `labels`) makes the **whole
  file** fail to load while YAML parsing still succeeds.

#### Remaining

The two extras beyond the spec's six classes (`instance_down`, `latency`) were
kept deliberately and documented in the rule file: `instance_down` is not "one
more rule" but the precondition that keeps the rest from going collectively
silent, since a total control-plane outage empties almost every expression and
an empty set looks exactly like "all clear". `latency` is a leading indicator
for `queue_backlog` at P3, so it wakes nobody.

### CI evidence wiring: 2026-09-15

D5 fixed the acceptance chain so that "green" means "evidence". Two things were
left outside it, and they are the same defect wearing different clothes: the
gates built that day were never invoked by anyone, and the CI job that does run
on every push still could not tell "all live-DB cases skipped" from "all passed".

`.github/workflows/ci.yml` had been recorded as unreadable in two consecutive
reviews. It is readable; it was read this round. Four findings, in severity
order.

#### 1. The Go test job reported green with zero live-DB evidence

The job ran `go test ./...` with

```yaml
LUMO_TEST_PG_DSN: ${{ contains(fromJSON('["governance","scheduler"]'), matrix.module) && 'postgres://…' || '' }}
```

The other eight matrix entries received an **empty string**, which is
indistinguishable from unset for `os.Getenv`. Their live-DB cases therefore hit
`t.Skip` and the job stayed green. By 2026-09-15 nine modules carry 12
`os.Getenv("LUMO_TEST_PG_DSN")` call sites, so the list covered 2 of 9.

This was **not** a case of someone disabling failing tests. `git log -S` on the
condition shows it was introduced together with the PostgreSQL service in
`c853dabf` (2026-09-13) and never narrowed — the list was correct when written
and rotted as modules grew. That is the same failure mode as the stale gap list:
a hand-maintained enumeration in a place nobody re-reads.

Fix: inject the DSN unconditionally. The gating lives in the test files, so the
provisioning should be global; there is nothing module-specific left to express.

#### 2. `heartbeat` was absent from the matrix entirely

`platform/control-plane/heartbeat` is a Go module with 30 tests added the same
day (E4/D6) and it does not appear in `matrix.module`. Nothing in CI ever
compiled or tested it.

Note that the obvious guard — "every module with `LUMO_TEST_PG_DSN`-gated cases
must be in the matrix" — **would not have caught this**: `heartbeat` has zero
such call sites. A guard derived from the symptom is blind to the instance that
lacks the symptom. The predicate is "every Go module is in the matrix".

#### 3. The two new gates had no caller

`platform/deploy/helm-verify.sh` and `platform/deploy/alerts-verify.sh` were both
built this day, both runnable by hand, and neither was referenced anywhere in
`.github/workflows/`. A gate that nothing invokes is indistinguishable from a
gate that passes. Both are now wired: the chart gate into `production-gates`
(which already installs Helm and renders the chart — its `helm template` calls
cannot replace it, since `helm template` reports success on manifests that are
not valid YAML and never renders `NOTES.txt`), and the alert gate into a new
`alert-rules-gate` job with its own Go setup.

#### 4. `deploy-smoke` is really off — and why it stays off

Confirmed: `if: ${{ false }}`. The comment now records the verification and what
enabling it would require (image production plus a runner that can run Docker).
Removing the `if:` line alone would produce a job that cannot pass.

#### The guard, and its own counter-cases

The new `Live-DB gate is wired for every module that has one` step asserts, from
the repository tree and the workflow file only — no database:

1. the DSN is injected in the `control-plane-go` job;
2. it is not injected as an expression (`${{ … }}`);
3. every directory under `platform/control-plane` containing a `go.mod` appears
   in the matrix.

Three details were forced by running the guard against mutated inputs, and each
is a defect the first draft had:

- **It matched itself.** The guard's own source lives in the file it greps, so a
  literal `LUMO_TEST_PG_DSN: ${{` in the pattern made the real file look
  conditional, and a literal `LUMO_TEST_PG_DSN: postgres://` made the "is it
  injected at all" check **true by construction** (deleting the injection did not
  turn it red). Both patterns are now written in escaped form
  (`…:[[:space:]]+postgres://`, `…: \$[[:space:]]*\{\{`) so they cannot match
  their own source.
- **It was satisfied from outside the job it was guarding.** `platform`'s job
  also injects a `LUMO_TEST_PG_DSN` (for the vitest suites), and a whole-file
  search found that one first — so deleting the Go job's injection still passed.
  The guard now extracts the `control-plane-go` block with `awk` and checks only
  inside it.
- **The diagnosis was ordered wrong.** A conditional value is
  `LUMO_TEST_PG_DSN: ${{ … }}` — it does not have `postgres://` after the colon,
  so checking "is it present" first reported "not injected" for the enum case.
  Wrong diagnosis is worse than silence; the conditional check now runs first.

Seven cases drive the guard: the real workflow passes, four mutations (DSN
missing, DSN conditional, a module absent, a module with live cases absent) each
fail **on the named message** rather than merely non-zero, and two boundaries
hold — removing the *other* job's DSN is not a finding, and a directory without a
`go.mod` is not required to be in the matrix.

The `bash -n` step in `production-gates` now globs `platform/deploy/*.sh`
instead of naming three scripts — the same enumeration-rot argument as finding 1,
applied to the check that would have caught a broken new gate script.

#### Verification

- The guard was extracted from the real workflow (not retyped) and driven by
  fixtures built from the real module tree: 7/7 as described above. The first
  run of the real file **failed** for the self-reference reason, which is how
  that defect was found.
- `ci.yml` parses; the matrix holds 11 modules; the `Test` step's env is
  unconditional; `deploy-smoke` is `if: ${{ false }}`.
- `bash -n` clean on `platform/deploy/*.sh` and `platform/build.sh`.
- `helm-verify.sh` and `alerts-verify.sh` both run green from the repository
  root, so the two newly wired steps are known-good at the moment of wiring.
- `heartbeat`: `gofmt -l` empty, `go build`, `go vet`, `go test` green — it is a
  real, passing module, not one that was excluded for failing.
- Module-wide `go build ./... && go vet ./...` green across all 11 modules.

#### Not verified

The consequence of finding 1 is that **seven modules' live-DB cases will execute
in CI for the first time**. There is no PostgreSQL on this machine, so none of
them could be run locally. If any of them fails, the job turns red — that is the
intended discovery mechanism, not a regression. The pre-change state could not
have reported it either way.

`LUMO_TEST_RMQ_*` / `LUMO_TEST_S3_*` gated cases still skip in CI by design: no
RocketMQ and no S3 there. The RMQ case names the missing variable in its skip
message, so the omission stays visible.
### Multicluster scheduling: design review — 2026-09-15

C1's remaining half is a scheduling decision, not a data-model problem, and it
was explicitly gated on C2's cluster-dimension monitoring. That gate is now open,
so the reconnaissance was done first. It changed the plan.

Full document: `docs/superpowers/specs/2026-09-15-multicluster-scheduling-design.md`.
What follows is why it is not the obvious design.

#### The shortcut that does not work

The cheapest possible design is to derive cluster liveness from the node
directory: a cluster is alive if it has listed nodes. It fails, and the reason is
one line:

```go
if !h.Healthy || !h.Enabled || h.IP == "" || h.Port <= 0 { continue }
```

`catalog/nacos.go:71-73` filters unhealthy instances out of `List`. So a cluster
that has gone dark and a cluster that was never deployed produce an **identical**
directory view: "no nodes of that cluster". The directory cannot answer "is this
cluster down, or simply absent", which is precisely what a federated registry is
for. It is not a formality carried over from the spec — it is load-bearing.

The second reason is that `scheduler_nodes` is only written on placement
(`SyncNodeSnapshot`) and never deleted, so an idle cluster's row ages out and
would be judged lost while it is perfectly healthy. Traffic-driven liveness is
not liveness.

#### Also worth recording before anyone writes code

- **Preferring the `heartbeat` package would have been a semantic collision.**
  `lumo_service_heartbeats` means "a control-plane *service instance* is alive"
  and governance uses it to derive the readiness gate. Putting clusters into it
  would make one column carry two meanings — the exact thing E4/D6 existed to
  undo. Hence a separate `scheduler_clusters`.
- **Cross-cluster placement is not missing; admission is.** `EligibleNodes`
  hard-filters on `cluster_id` only when the task's value is non-empty
  (`planner.go:42-44`). An empty value already means "any cluster". What does not
  exist is a gate that stops new placements to a suspect cluster, and any
  preference ordering.
- **Time must come from the database.** `last_seen_at` is written with the DB's
  `now()` (as `scheduler_nodes.registered_at` already is) and the reader gets an
  **age** from SQL, not a timestamp. Go then maps age to state in a pure function.
  That split keeps the state machine unit-testable without a database while the
  cross-host clock problem stays solved in one place.

#### Scope of the implementation round, and what is deliberately not in it

In: the federated registry, the two-stage judgement as a pure function, the
placement gate, and cluster-dimension metrics wired into the alert gate.

Out, each with its reason:

- **Down-migration (moving tasks off a lost cluster).** This is an irreversible
  state change and §7.4.1 requires fencing to be confirmed before it. It needs its
  own set of gates (fresh snapshot, cluster genuinely down, conditional write,
  audit ledger) at the same level of care as the `max_stall` reaper. Landing the
  judgement first and the migration second avoids moving tasks on evidence that
  has not been shown to be trustworthy.
- **~~Preference scoring (`clusterTag`/`region`), version-consistency gating.~~**
  **Done (2026-09-17)**, see §10 of the multicluster design doc. Preference scoring
  landed as a two-term weighted sum (load + affinity) over the range the §6.2
  formula left undefined — the A4 rejection was "unimplementable", not "wrong",
  so each term now has a stated range, normalisation and tuning procedure, and
  the default weights reproduce the previous `Pick` byte for byte. Version
  gating reads a per-cluster `version` that the *node pool* declares (same
  reasoning as the liveness reporter), is off by default, only gates
  cluster-unpinned placements, and fails **closed** on unknown versions —
  deliberately the opposite direction from the liveness gate. Wiring (compose,
  Helm, three new static rules in `cluster-registry-check.py`, two alerts,
  metric contract) is part of the same change, because the previous round's
  lesson was that code + tests + metrics + alerts can all be green while the
  switch is absent from every deployable topology.
- **A separate cluster-scheduler process/role** is now the only C1 item left.
  It is coupled to where the liveness signal comes from, so it is decided after
  the registry exists.

#### Two failure modes the design has to avoid up front

1. **Thresholds inverted** (`suspect >= down`) makes `suspect` unreachable — and
   "no suspect clusters" looks exactly like "everything is healthy". Refuse to
   start and name the variable; do not clamp.
2. **No reporter.** The registry is server-side this round, so if nothing
   reports, every registered cluster ages into `down` and the gate blocks all
   placement. The capability must therefore be **entirely off** unless the
   instance is told which cluster it speaks for — a half-enabled registry is a
   self-inflicted outage.
### Federated cluster registry and placement gate — 2026-09-15

C1's remaining half is implemented. Full design and record:
`docs/superpowers/specs/2026-09-15-multicluster-scheduling-design.md` (§8 is the
implementation record). What follows is only what a reader of this file needs
that is not in the design document.

#### The one-line reason the registry has to exist

`catalog/nacos.go:71-73` filters unhealthy instances out of `List`. A cluster
that went dark and a cluster that was never deployed therefore produce an
**identical** directory view, and `scheduler_nodes` (written only on placement,
never deleted) ages out for idle clusters anyway. Traffic-driven liveness is not
liveness. So `scheduler_clusters` + explicit self-reports is not ceremony.

#### The gate is one line in `EligibleNodes`, and that placement is the point

`EligibleNodes` is shared by placement and preemption *specifically* so
preemption cannot bypass hard constraints (the comment there says so). Cluster
health is a hard constraint, so it goes in that same function rather than in an
upstream prune — an upstream prune would be bypassable. No signature changed:
the state travels as `domain.Node.ClusterState`, filled once by the catalog
decorator, so the four call sites and their tests are untouched.

#### Deliberately absent (a subset of what the design says, restated for readers here)

- **No `Node.LastSeen`.** The design listed it; dropped. `scheduler_nodes.registered_at`
  is traffic-driven in the Pg form and equal to the query time in the Nacos form,
  so the field has no trustworthy consumer in either — only misuse.
- **No "node registration touches the cluster row" corroboration.** A liveness
  column must have exactly one writer and one meaning. Refreshing it from node
  registration would disguise a traffic-driven signal as a self-report, and idle
  clusters are precisely the ones with no traffic.
- **No down-migration.** Unchanged from the design: irreversible, needs fencing
  confirmation, its own round. Until then tasks stay where they are — safe, and
  written down so it is not read as an omission.
- **No `suspect` alert rule.** With the default thresholds a cluster stays
  suspect for only `down - suspect` = 60s, so any rule with `for >= 1m` can never
  accumulate the duration. Watch `lumo_scheduler_cluster_age_seconds` instead.

#### Failure modes the implementation guards, and how

| Failure mode | Guard |
|---|---|
| Thresholds inverted → `suspect` unreachable, "no suspect clusters" looks identical to "everything healthy" | `ClusterThresholds.Validate` refuses to start and names the variable (exit 2, verified by running the real binary); the >= 1s lower bound comes from iron rule 19 |
| The reporting interval is slower than `suspect` → the instance judges **itself** suspect and blocks its own placement | The interval is derived (`suspect/3`), not configurable |
| A cross-realm registration silently overwrites another realm's cluster | `RegisterCluster` returns 409 `cluster-realm-conflict`; realm is taken from the gateway-injected identity, never from the request body |
| "Not registered" reported as if it were "lost" → someone edits config while the real problem is a dead service | `GET /v1/clusters/{id}` returns 404 `cluster-not-registered`; a registered-but-lost cluster returns 200 with `state=down` |
| An unwired server panics | All three endpoints return 503 `cluster-registry-unavailable` |
| One DB blip stops the reporter → the cluster ages to `down` and blocks itself | The loop retries every derived interval; failures are logged once per transition (first failure Error, recovery Info), never per tick |
| The gate blocks everything because the registry cannot be read | Fail **open** with a log line; `PlaceTask` needs the same PG anyway |
| A stale "down" alert never clears because a failed read keeps the last values | `lumo_scheduler_cluster_registry_ok` separates "really down" from "cannot read" (documented in the rule itself) |

#### Verification

- 82 component/pure cases pass (`domain` / `planner` / `catalog` / `server`);
  `go test -race -count=1 ./...`, `gofmt -l`, `go vet` all clean.
- Boundary points for the two-stage judgement are asserted one by one
  (`-1 / 0 / suspect-1 / suspect / down-1 / down / down+1 / huge`), plus
  `Evaluate` and the pure function are asserted to be the same source of truth.
- Gate: eligible-set membership for all four states, `Pick` never falling back to
  another cluster, and `FullEligibleNodes` keeping the gate on the preemption path.
- Real process start with three invalid threshold pairs → exit 2 and the variable
  named, all before the database connection is attempted.
- Reporter: reports immediately, keeps retrying after failure, logs transitions
  only, exits on ctx cancel.
- `platform/deploy/alerts-verify.sh` green (14 rules / 14 expressions, 9
  counter-cases), which is what proves the three new metric names have write points.

#### Not verified

**Correction (2026-09-16):** these five cases were recorded below as skipping "on
this machine (no PostgreSQL, no container runtime)". The second half was wrong —
this machine *has* Docker; the daemon merely was not running. `open -a Docker`
plus `platform/deploy/test-local-pg.sh scheduler` runs them for real, and the whole
scheduler module now reports **155 PASS / 0 FAIL / 0 SKIP**. Kept here rather than
deleted because "environment blocked" and "not yet written" look identical in a
test report, and this was the former.

Five live-DB cases: DDL idempotence for the new table, "the age is computed by SQL"
(backdating `last_seen_at` moves the age), cross-realm registration refused with
no partial write, unregistered vs lost distinguishable, and the end-to-end gate
(registry → catalog annotation → planner → HTTP 202 then 201 after recovery).
The highest-risk one is `RegisterCluster`'s `ON CONFLICT ... DO UPDATE ... WHERE`:
its rejection branch relies on `RETURNING` producing no row. That construct is the
same one `store.Acquire` uses (which does have live coverage), but it is not
thereby proven.

### Down-migration after cluster loss: 2026-09-16

C1's last deferred piece — §7.4.1's "task drifts back to the global Task Bus" —
which §2 of the design explicitly postponed (irreversible, and it must confirm
fencing first). Full record: `docs/superpowers/specs/2026-09-15-multicluster-scheduling-design.md`
§9. Only what a reader of *this* file needs, below.

#### The action is "drop the old binding", not "pick a new cluster"

`state→PENDING`, `node_id→NULL`, `cluster_id→''`, `attempt` **unchanged**.
Clearing `cluster_id` returns the task to the "any cluster" degenerate form
(`planner.go:42` only filters when non-empty), and since the lost cluster's nodes
are blocked by the placement gate anyway, the task lands on a healthy cluster by
itself. Choosing *which* cluster stays a placement concern — preference scoring is
still out of scope, and a "target cluster" parameter here would quietly grow
scoring logic inside the migration loop.

`attempt` is left alone on purpose: the next `PlaceTask` allocates `attempt+1` from
`PENDING` (existing logic), and that is exactly what fences the old node.

#### Fencing needed no new mechanism, and that was verified by contrast

`CompleteTaskAttempt` requires *still active* **and** *same attempt*. After
migration neither holds, so a late terminal report from the old node has no
effect. Proven on a live database by contrast: same DB, same attempt, same report —
the migrated task's report does nothing, the un-migrated one's takes effect. The
difference can only come from the migration, which rules out "the report path never
worked" as an explanation.

#### Two honest compensations, because fencing is only half the story

1. **`avoid_nodes` gets the old node appended.** The fencing above holds at the
   *reporting* layer; it cannot stop the old node from physically still running
   (the criterion only confirms "not in the directory", which is not "stopped").
   If the cluster later recovers and the task is placed back on that same node,
   that is a genuine double execution. `AvoidNodes` is an existing mechanism; one
   line closes the path.
2. **Unclaimed dispatches for that attempt are voided in the same transaction.**
   `ClaimDispatch` filters on `node_id + claimed_by IS NULL + delivered_at IS NULL`
   and **does not look at task state**, so an unclaimed outbox row would hand the
   execution request back to the old node after migration — a back door around
   fencing. `RequeueStaleDispatch`'s `EXISTS (state IN ('PLACED','RUNNING'))` guard
   only covers *reclaiming already-claimed* rows; the unclaimed half had no owner.
   Already-claimed rows are deliberately kept: that RPC may be in flight, and
   deleting it would make the local ledger lie (its reclaim path is already dead
   once `state=PENDING`).

Physical duplicate side effects are ultimately R2's problem (turn-level recovery
contract, tool idempotency classes) — which is why §7.4.1 ties fencing to R2 in
the same sentence.

#### Five gates, and the fifth behaves completely differently per catalog form

Gates: leader / registry readable / fresh catalog snapshot / cluster past
`down + grace` / **owning node absent from the snapshot**. Plus three conditions
in the conditional write (state still migratable, same attempt, same cluster); if
any fails, nothing happens — including no ledger row. `CANCELLING` is deliberately
excluded from the migratable states, because migrating it **discards the
cancellation** (the new node has no idea someone asked it to stop).

The gate worth writing down: "owning node absent from the directory" is

- **always satisfied** under Nacos (`catalog/nacos.go:71-73` only lists healthy
  instances, so a lost cluster's nodes are already gone), and
- **never satisfied** under Pg (`scheduler_nodes` is append-only — there is no
  `DELETE` anywhere in the tree) → migration performs **no action at all**.

The second looks like a defect and is not: the Pg form *is* the single-cluster
form (local-lite) and there is nowhere to migrate to. Same structural fact as
C2/R8's "`task_lost` / `node_down` are always 0 under local-lite". Multi-cluster
implies Nacos.

#### One documented deviation, in a default value

`LUMO_MIGRATE_GRACE_MS` defaults to **300000 (5 min)**, not 0. The architecture
says "down(90s) then migrate", which read strictly means `grace=0`. But `down`
answers "how long since the last report", not *why* — a cluster that died and a
reporter that is restarting (rolling update, OOM) look identical in that column,
and the costs are asymmetric: waiting a few more minutes costs the task some
queueing time; a wrong migration costs a cross-cluster move plus a new attempt
plus an idempotency fallback. That is the same reasoning the architecture itself
uses for "no second-scale switching" — it just does not cover the reporter-restart
case. `grace=0` restores the literal reading; `LUMO_MIGRATE_MS` negative disables
migration entirely (and must say so in the log, or "nothing was migrated" reads as
"no cluster was lost").

#### Verification, and what is still unproven

Live-DB suite **155 PASS / 0 FAIL / 0 SKIP**; the 16 new test functions were each
confirmed to actually execute (not masked by a skip count). The timeline is
asserted point by point at ten boundaries, plus one invariant: for any `grace ≥ 0`,
"eligible to migrate" implies "judged down" — which excludes the whole category of
"migrating during `suspect`" rather than checking points. `alerts-verify` passes
with 17 rules / 17 expressions / 11 counter-cases, so the two new metric names are
proven to have writers.

**Proven end to end on the source half only.** A real scheduler process, real
PostgreSQL, real HTTP and a genuinely lost cluster: a `PUT /v1/clusters/cn-east`
with nobody renewing it, plus a `RUNNING` task on a node absent from
`scheduler_nodes`, was migrated inside the first loop after `down + grace` elapsed
(2088 ms measured against a 2000 ms threshold) — `state→PENDING`, `cluster_id→''`,
`node_id→NULL`, `attempt` unchanged, `avoid_nodes` extended with the old node, with
the ledger, the metrics and a per-task log line all carrying the evidence.

**Not proven: the target half.** Nothing shows the task actually landing on a
healthy node of *another* cluster — that needs a second cluster with real node rows,
and every `MigrateTask` case calls the store layer directly, so the
"directory + gates + placement" chain is still unexercised. That belongs on
`acceptance-cluster.sh`, alongside the OPA probe that was equally "catchable but
never run". Note also that a plain Pg-form run **cannot** exhibit the action at all
(gate ⑤ is never satisfied there) — that is §9.6's structural fact, not a defect,
which is why the experiment above had to point the task at an unregistered node.

### Shared session control and deployment wiring: 2026-09-16

C5 (§8.4) is implemented service-side, and — the part that turned out to be
most of the work — wired into every place a new control-plane process has to
appear. The service is `platform/control-plane/session-control/`:
`internal/{state,policy,queue,store,control,server}` plus
`cmd/session-control`. Policy lives in `platform/deploy/policies/session-control.rego`.

#### The shape of one control command

`POST /v1/sessions/{ref}/control` → queue the pulse for that session → isolate
the realm → OPA → state-machine matrix → `Store.Commit` (row lock + revision
CAS) → audit → dispatch. A verdict is one of `applied` / `noop` /
`state_rejected` / `policy_denied` / `policy_unavailable` / `realm_mismatch` /
`conflict` / `busy`, and each maps to a distinct HTTP status (200 / 409 / 403 /
**503 + `Retry-After`** / 500). `conflict` is retried with a fresh read, so a
lost race is retried, not surfaced as an error.

#### Decisions that are not visible from the code's structure

- **Realm isolation is decided before OPA, and a rejected attempt must not
  create the state row.** The session's `realm` is written once, on the first
  *effective* command, and is immutable afterwards. If a cross-realm attempt
  created the row, a rejected attempt would bind the session to the wrong realm
  forever — refusal itself would be the damage. That is also why realm
  mismatches are **not** in `session_control_audit`: writing them would need the
  row we just decided not to create. They are in the WARN log and in
  `lumo_session_control_realm_mismatch_total` instead, and a rule now watches
  that counter (see below).
- **The audit includes rejections** (`from_state` == `to_state` for refused
  commands), keyed `(session_ref, id)`. There is deliberately **no per-session
  `seq`**: dsh owns `SessionEvent.seq` (`session-log.ts`), and a second sequence
  number for the same stream is exactly the kind of thing that later gets
  confused with the real one.
- **No `usage_ledger` write**, although §8.4.2 says every control command
  ("including denials") writes one. `cost_type` is a closed cross-language set
  with no member that describes a control command; writing one would put a
  unit-less row into every cost aggregate. This is a **recorded deviation**, not
  an oversight — the audit table plus the event stream carry the same
  attribution.
- **Commit before dispatch.** The state row and the audit row are durable before
  anything is sent to the session execution face. "Recorded but not done" is
  reconcilable; "done but not recorded" is not auditable at all. Consequently an
  unwired dispatcher degrades to `effectuation=recorded`, which is a truthful
  value rather than a silently missing step.
- **Fail-closed with two distinct codes.** An engine that is down
  (`policy_unavailable`, 503 + `Retry-After`) and an engine that said no
  (`policy_denied`, 403) must not be conflated: the first is an outage to wait
  out, the second is a decision. Distinguishing them is `errors.Is(err, ErrUnavailable)`.
- **Concurrency is arbitrated in the service, not by the Scheduler.** §8.4.2
  says the control command is adjudicated on the session's leader with the
  Scheduler as final arbiter. An in-process queue (FIFO, with forced takeover
  once a pulse exceeds `MaxHold`) plus a PG row lock and a revision CAS gives the
  same guarantee — one effective pulse per session — without putting the
  Scheduler on the control path. Also a recorded deviation.
- **The Go input and the deployed rego are held together by a test.**
  `policy.Request.Input()` flattens to
  `{command, sessionRef, realm, role, actor, reason?, correlationId?, sessionOwners?}`,
  and `TestInputCoversKeysReadByDeployedPolicy` reads the `input.*` keys out of
  `platform/deploy/policies/session-control.rego` and asserts the Go side covers
  every one of them, with a counter-guard on the required set. The test exists
  because the alignment is otherwise only checkable by eye. Two traps it already
  caught: **empty string is truthy in rego** (so "missing" and "empty" need
  separate rule bodies), and an `input.X` mentioned inside a rego *comment*
  used to be read as a referenced key (the extractor now strips comments first).

#### Failure modes the implementation guards, and how

| Failure mode | Guard |
|---|---|
| A denied attempt takes over the session's realm ("refusal as damage") | Realm check runs before OPA and before any write; only `ChangeState` may create the row |
| Two instances both apply a command to one session | PG `SELECT ... FOR UPDATE` plus a revision compare-and-swap; the loser gets `conflict` and retries with a fresh read |
| A stuck pulse blocks a session's control path forever | Queue holding limit (`MaxHold`, default 30s) with forced takeover, wired to a counter and to a P3 rule |
| A queue depth that only reflects "right now" misses "it was blocked" | Forced releases are a monotonic process-lifetime accumulator — the historical evidence — and separately alerted |
| An OPA outage is reported as a permission problem | `policy_unavailable` (503 + `Retry-After`) vs `policy_denied` (403); the startup log names `LUMO_OPA_URL` |
| `/metrics` depends on the database | Counters accumulate on the adjudication path; the background tick only publishes. A DB blip cannot turn into "this instance's metrics all vanished" |
| A dimension disappears but the series stays | `ReplaceGauges` rewrites the whole `outcome × command` set each tick |
| The console invents a state for a session that has never been controlled | The read surface reports `registered=false`, `state=null` and the `base_state` it is deriving from — never a fabricated `running` |
| A metrics name with no consumer | All six exported names are declared in the alerts gate's contract; the two that can fire have rules, and the one that cannot (`dispatch_failures_total`, because nothing dispatches) deliberately has none — a rule that can never fire is the dead-rule defect this repo already fixed twice |

#### Deployment wiring: the seven places a new service must appear

Five of them are hardcoded lists, and each omission has its own symptom. All
seven were updated for `session-control`:

| Place | Symptom if missed |
|---|---|
| `compose.cluster.yml` + `compose.standalone.yml` | The topology has no such service |
| `prometheus.yml` + `prometheus-standalone.yml` | Nothing scrapes it, so the non-gateway 5xx rule has no series for `service="session-control"` |
| `prometheus-alerts.yml` | No rule consumes its domain metrics |
| `preflight-deployment.sh` required-service list | The check that "a default service disappearing turns red" does not cover it |
| `.github/workflows/ci.yml` matrix | Its tests never run on any CI (the repo's existing guard derives this from a glob, so it fails loudly) |
| Helm `values.yaml` `services` + `templates/configmap.yaml` | The production path silently lacks it; and `LUMO_OPA_URL` is a **different name** from connector-gateway's `LUMO_OPA_ADDR`, so without it every control command is fail-closed with nothing visible in `helm template` |
| `platform/build.sh` image list | `--push` ships a set without the image that compose and Helm both reference |

Five adjacent defects were found and fixed while wiring, all of the same family:

1. **`preflight-deployment.sh` was missing three services** — `edge-gateway` and
   `terminal-gateway` (omitted when C3/C4 landed) as well as `session-control`.
   The check's whole purpose is "a default service disappearing must be red", and
   it did not cover the two newest gateways.
2. **`build.sh`'s image list was missing the same three.** Local `up.sh --build`
   hides it (compose builds from source); only the registry path breaks.
3. **The chart's ConfigMap carried only `LUMO_OPA_ADDR`.** `session-control` and
   `terminal-gateway` read `LUMO_OPA_URL`; with it absent, policy evaluation is
   fail-closed and `helm template` still reports success — the same silent class
   as the empty Secret name D2 fixed.
4. **Three "counter-case self-proof" gates were silently skipping all their
   counter-cases on macOS.** In bash 3.2 an unbound variable inside a *function*
   neither exits the script nor sets a non-zero status, so `"$name：..."` (a
   full-width colon glued to a variable expansion) made `expect_pass`/`expect_fail`
   return silently: `compose-ports-verify.sh` printed its five positive OKs, ran
   **none** of its four counter-cases, never printed its summary, and exited 0.
   `edge-routes-verify.sh` and `cluster-registry-verify.sh` had the same shape.
   CI (bash 5) was unaffected, so only the local verdict was false — the exact
   "same exit code, opposite conclusion" mode this repo keeps running into.
   Fixed by writing `${name}：` (16 occurrences across 5 scripts), and guarded by
   a new `platform/deploy/shell-portability-check.py` with `--self-test`, wired
   into the existing CI validation step.
5. **The cluster topology's OPA was unreachable from every consumer.** Its command
   was `["run", "--server", "/policies"]`, and OPA binds `localhost:8181` by
   default — a container-internal loopback, while sibling containers resolve the
   service name to the *container IP*. So in the cluster shape all three policy
   consumers were silently fail-closed: connector-gateway's egress checks,
   terminal-gateway's presence actions, and every session-control command
   (`policy_unavailable`). Fail-closed is the *designed* direction, which is
   exactly why it read as a permissions problem rather than a connectivity one.
   Measured with the same command on a user-defined network: container-to-container
   `curl http://opa:8181/health` → `000` as shipped, `200` with
   `--addr=0.0.0.0:8181`. The acceptance chain would have caught it — its
   `LUMO_TEST_OPA_HEALTH_URL` probe is mandatory — but that chain has never been
   run end to end, so nothing did. Fixed, and the image tag pinned to `1.3.0`
   (the version the rego was validated against) so "the policy we verified" and
   "the engine that runs" cannot drift apart.

#### Verification

- `go build ./...`, `go vet ./...`, `gofmt -l` clean; all unit tests pass,
  including `-race` and a 40-cell property test asserting the controller's
  verdict agrees with the state machine for every (state × command) pair.
- **7 live-PostgreSQL cases pass** against a real server:
  first effective command creates the row; a refusal on an unknown session writes
  audit but no row; realm mismatch refused with the state untouched; a stale
  revision refused with no side effects; 8 concurrent commits on one revision
  leave exactly one winner; timeline paging includes rejections; concurrent
  first commands do not overwrite the realm.
- The rego is validated with `opa check --strict` **and** `opa eval` against six
  inputs (ok / wrong role / no realm / unknown role / missing realm / no actor),
  so the "empty is truthy" branches are exercised, not just parsed.
- Gates all green, counter-cases included: `compose-ports-verify.sh` 9/9
  (the merged-topology case is what proves `18092:8092` does not collide with the
  device overlay's 18090), `edge-routes-verify.sh` 14/14,
  `cluster-registry-verify.sh` 12/12, `helm-verify.sh` all checks (including
  `LUMO_INSTANCE` on all 10 services), `alerts-verify.sh` 16 rules / 16
  expressions with 11 counter-cases.

#### The seam's `dispatch`, wired: 2026-09-17

C5 left one link open: the plugin's `ctx.sessionControl.dispatch` only threw
`ControlCommandRoutingError` — a placeholder whose entire job was to say "this is
not wired yet". It now issues a real `POST /v1/sessions/{ref}/control` and
returns the control plane's verdict.

**First, the name collision, because it will mislead someone.** There are two
`dispatch`es on this chain and they are different links:

| Name | Where | Does what | State |
|---|---|---|---|
| `control.Dispatcher` | Go `session-control/internal/control` | sends an **already adjudicated** command to the **session execution face** (§8.1 suspend / `agent.inject()`) | **still unwired** |
| `ControlSeam.dispatch` | TS `dsh-plugins/control` | **submits** a command **to the control plane** | wired 2026-09-17 |

So the two sentences above about `effectuation` staying `recorded` and
`dispatch_failures_total` deliberately having no rule **remain true** — they are
about the first one. Only the second moved.

**The contract was relaxed from "must throw" to "must produce evidence".**
"Throw on success" described one implementation, not the seam; once a real
implementation existed the old assertion would have failed it. Both shapes are
now legal — return the control plane's `outcome` (including when it refuses), or
throw the routing error when no control plane address is configured — and both
must leave behind what the control plane actually said. What is still forbidden
is `allowed=true` with no `outcome`: claiming effect locally. A second assertion
checks the evidence is self-consistent, because `allowed` is derived from
`outcome` and an implementation that reports them in opposite directions is
harder to notice than one that reports nothing.

**"Got a verdict" and "got no verdict" are orthogonal exits**, mirroring Go's
`(Result, nil)` / `(Result{}, err)` split:

| Case | Handling |
|---|---|
| 403 `policy_denied`, 409 `state_rejected`, 503 `policy_unavailable` | a **verdict** — return it, `allowed=false` |
| Connection refused / timeout | throw `ControlPlaneUnreachableError` (unknown, retry is meaningful) |
| 401 `{"error":"control_plane_auth"}` from the auth middleware | throw `ControlPlaneProtocolError` — a token mismatch is not a refusal |
| A gateway's 502 HTML | throw `ControlPlaneProtocolError`, carrying the first 200 chars |

The verdict is read from the response body's `outcome`, **not** the status code:
`statusFor` is many-to-one (403 is both `policy_denied` and `realm_mismatch`).
A status→outcome table is deliberately *not* mirrored in TS to cross-check —
that would be a second implementation of one contract surface, and its drift
symptom is a command silently classified as the wrong kind of failure.

**Three classification bugs fixed along the way.** (1) The local pre-check
reported "engine unavailable" as "permission denied" — `OpaControlPolicy`
returned `policy-denied` for connection failures, non-2xx and a missing
`result`. Go's `internal/policy` had already split those (`ErrUnavailable` vs
`Allowed=false`, with the reasoning in its package doc: an OPA crash must not
read as "everyone lost control permissions"). The TS side now mirrors that
table, including the case that matters most — a missing/null `result` means the
policy bundle is not loaded, so it is unavailable, not `allow=false`.
(2) `ControlPolicy.allowed` ("this layer did not block") and
`ControlDecision.allowed` ("the command took effect") shared one type; they are
now two. (3) `LUMO_SESSION_CONTROL_URL` deliberately has **no default** — a
default would turn "this deployment is not wired" into "the control plane is
unreachable", pointing the investigation at networking instead of configuration.

**Deployment wiring and its gate.** Five dsh services in `compose.cluster.yml`
plus one in `compose.standalone.yml` get
`LUMO_SESSION_CONTROL_URL=http://session-control:8092`; it is deliberately
**not** in any `depends_on`, since `dispatch` is a runtime call rather than a
startup dependency and wiring it there would escalate "the control plane is
down" into "the data plane will not start". In the chart, the dsh-node value is
built in the template with `index .Values.services "session-control"` — the key
contains a hyphen, so dot access parses as subtraction. `helm-verify.sh` gained
an assertion whose expected value is written down (reading it back from the
render would make it true by construction) and whose count is pinned to 2: one
too few means a workload lost its wiring, one too many means a template
copy-paste. The counter-case was exercised by pointing the value at `:9999`,
which produced "1 dsh workload(s) ... expected 2".

**Verification.** 18 new cases in
`dsh-plugins/control/__tests__/dispatch-routing.spec.ts`, all passing, driven
against a real HTTP fake control plane rather than a mocked `fetch` — the
assertions are about what actually goes on the wire (path, method, headers,
body), so mocking `fetch` would replace the subject under test with the
expectation. The seam contract spec gained two positive cases (a forwarding stub
also passes; a control-plane refusal is a verdict, not an error) and one
counter-case (`allowed` contradicting `outcome`). `helm-verify.sh` fully green
including the new check; all three compose files parsed with PyYAML and checked
**per service** rather than per line.

**Not done.** The Go `Dispatcher` is still unwired, so `effectuation` remains
`recorded`. ⚠️ **The next subsection corrects what that costs**: it does *not*
cost "pause has no effect". `dispatch` also has no production caller yet: it is a
seam, and the console reaches the control plane over HTTP directly. Wiring it buys
"an agent can control sessions programmatically", not "the console button works".

- **The image was built and run.** `docker build` succeeds, and the container
  started against the real database answers `/healthz` 200 without a token, 401
  on the read surface without a token and 200 with one (reporting
  `registered=false`, `state=null`), returns **503 `policy_unavailable` with
  `Retry-After: 5`** for a valid command when no OPA is configured — and, checked
  directly in SQL, that rejection left an `session_control_audit` row while
  `session_control_state` stayed at **0 rows**. `/metrics` exposes the domain
  metrics with the contracted labels, and the process runs as uid 10001.

#### The effectuation face, wired: 2026-09-17

The previous subsection recorded the Go `Dispatcher` as still unwired and implied
that was why `pause` did nothing. This round established, from evidence, that the
**two are unrelated**, and closed the real gap.

**Why the `Dispatcher` is not the reason `pause` had no effect.** The plugin
already reads `session_control_state` (1 s cache) and consumes it at its hooks, so
the moment the control plane writes `paused` the execution face can see it. No
push is involved. What the `Dispatcher` is actually for is §8.4.2's requirement
that a control command travel as a `session/control` event **into the replicated
log, visible to every endpoint** — "can a terminal see that someone pressed
pause", not "did pause take effect".

**And appending to that log directly is forbidden.** `session_log` is
single-writer with fencing: `session_writer_lease` holds a `fencing_token`, the
log's key is `(session_ref, seq)`, and its own comment says two different contents
at one seq "must fail loudly" because the single-writer invariant was broken. An
external process with no lease inserting rows would collide on seq at best, and at
worst make the real writer violate its own invariant. So that chain's correct
shape is a **node-addressed mailbox** following the `job_control_command`
precedent (correlation-id primary key for idempotency, `take`/`ack` lease,
`FOR UPDATE SKIP LOCKED`) — not an HTTP push, and certainly not a direct insert.
Left as a follow-up slice; not part of this delivery.

**Only two things can stop a turn**, and `agent/turn-stopping` is neither:

| Mechanism | Meaning | §8.4.1 action point |
|---|---|---|
| `agent/pre-step` returns `{kind:'reject'}` | this step does not open, so the turn does not. **Reversible** | pause / stop, "turn boundary" |
| `agent.cancel(cause)` | hard-cancel the turn, aborting in-flight model calls. **Irreversible** | abort, "session" |

`agent/turn-stopping` **can only extend, never shorten**: the loop calls it once
the turn has already ended and `inbox.nextStep` is empty, then re-checks
`inbox.nextStep` to decide whether to continue (`agent-loop/src/agent.ts`, `turn()`).
Treating it as a suspend point yields "the turn always finishes, nothing ever
stops it".

**Messages must be put back before rejecting.** `preStep()` calls
`inbox.claim(target, turn)` *before* the `agent/pre-step` waterfall, and claim is
consuming — a bare `reject` swallows the user's message. That is data loss, not a
pause. The fix mirrors upstream's own `restoreOtherClaimed()` in
`goal-round-driver`: prepend the batch back in reverse order, **without waking**
(whether the next turn opens is decided by the state recovering, not by the
restore). Two details worth their own lines: which list to restore into is
*inferred* (`step === 1` ⟺ `next-turn`, from the loop's `target`/`step` coupling),
so it lives in one pure function with the reasoning attached; and duplicate ids
must be skipped, because the real inbox **throws** on "same id pending twice" and
that error poisons the whole session log.

**One table, two projections.** `gate.ts` now derives `controlGate` (tool level:
allow / read-only / deny) and `controlActuation` (turn level: run / suspend /
cancel) from a single state table — two tables would drift, and the drift symptom
is "pause blocked the tools but the agent is still talking". `suspend` covers
`paused` / `awaiting-approval` / `stopped` without distinguishing which are
reversible: that is Go `internal/state`'s explicit matrix, and duplicating it here
would be a second implementation of one question. Off-vocabulary states stay
fail-closed (deny everything, suspend) but deliberately **not** cancelled —
cancellation is irreversible and an unrecognised value is no reason to take an
irreversible action.

**A real trap on the way.** The lookup started as an object literal, so
`table['constructor']` resolved to a prototype member and "hit" a record whose
`gate` was `undefined`; the hook's `gate === 'deny'` check then fell through to
the read-only branch, turning an unknown state from fail-closed into fail-open. A
`Map` has no prototype chain. The counter-case pins this so the choice cannot be
quietly reverted.

**Active polling covers the two actions nobody triggers**: `aborted`'s hard
cancel (the agent may be deep inside one long model call, with the next step
boundary nowhere near) and the wake after recovery (the agent is idle, so no event
will arrive). `actuationPollMs` defaults to 1 s and **0 disables it**; disabling
only affects those two — the pre-step suspend, the tool gate and the boundary
observation all live in hooks. Duplicate suppression is the only real risk here
(1 s rounds would fire `cancel` every second), so it is a pure function,
`actuationStep(previous, actuation, pending)`: cancel fires once per state, and
`run` wakes only when the previous round was `suspend` **and** something is
actually queued — `steer()` opens a turn for an idle driver, and a turn whose only
content is a note is a pure model-call cost. `cancel` → `run` deliberately does
*not* wake: what is special about `suspend` is that we put the input back without
waking it, so somebody has to supply that nudge; after a hard cancel the path that
resumes is simply new input.

**Verification.** 20 new cases in
`dsh-plugins/control/__tests__/actuation.spec.ts`, all passing: the decision table
cell by cell, twelve adversarial off-vocabulary values, restore order and
de-duplication, "restore does not wake", the cancel cause, the wake note's source
and a fresh id, and four groups on poll duplicate suppression. Existing specs
regression-clean and the gate refactor **byte-compatible**
(`control-schema-contract.spec.ts` 8 passed | 1 skipped — the skip is the real-PG
case and there is no local database running, `opa-policy.spec.ts` 5,
`dispatch-routing.spec.ts` 18). Two counter-cases, each run and reverted:
swapping `Map.get` back to an object-literal subscript turns the off-vocabulary
case red (`constructor` yields `undefined`), proving the `Map` is load-bearing
rather than stylistic; and making `preStepDecision` reject without restoring turns
the restore case red.

**Not done.** No Go `Dispatcher` (see above — different problem, and the correct
shape is a mailbox). Nothing has run inside a real dsh process: this repository's
plugin tests have never re-tested "will dsh dispatch the hook per its contract" —
that belongs to dsh's own suite — so the judgement and ordering here are covered
against a fake agent, and real-process behaviour remains unverified.
`actuationPollMs` was not added to any deployment file: the 1 s default suits both
compose forms and the chart, and the form with no control plane was not explicitly
disabled (it costs one indexed read per second). That is a known, deliberate
omission.
- **The whole chain was then exercised against a real OPA** (the fixed command,
  a real PostgreSQL, three containers on one network), which is the only run that
  covers the policy path end to end. What the timeline shows, in order:
  `pause` by an operator → **200 applied**, `running → paused`, revision 1;
  `pause` again → **200 noop** with the revision unchanged; `resume` → **applied**,
  revision 2; `pause` by a `viewer` → **403 `policy_denied`** with the state
  untouched; `abort` by an `admin` → **applied**, `running → aborted`, revision 3;
  then `pause` / `resume` on the aborted session → **409 `state_rejected`** with
  the reason, and `abort` again → **noop**. A `realm="other"` attempt returned
  **403 `realm_mismatch`** — and, confirmed in SQL, left **no row in the
  timeline** while the state row stayed bound to `realm=dev`, which is the
  refusal-as-damage invariant observed rather than argued. `session_control_state`
  ended at `dev / aborted / revision 3` and the audit table held
  applied 3, noop 2, policy_denied 2, state_rejected 3, policy_unavailable 1 —
  no `realm_mismatch` — with `lumo_session_control_realm_mismatch_total` at 1.

#### Not verified, and open

- **No two-process run.** Cross-instance arbitration is proven by concurrent
  transactions against one server, not by two live replicas; the row-lock + CAS
  argument is what carries it beyond that.
- **The Session Console UI is not wired.** The projection it needs (state,
  per-button availability, timeline, queue state) is served and tested; the front
  end is a separate item.
- **The edge gateway deliberately does not route to `session-control`.** Control
  is not a south-north surface: a browser session has no decided way to hold the
  control-plane token, and adding a public route before that is a security
  decision rather than wiring.
- **~~The chart still has no `edge-gateway` / `terminal-gateway` service entries.~~**
  **Fixed later the same day (2026-09-16)**: both are now in `values.yaml`'s
  `services` map, with the edge route table rendered from the chart (see the
  "Gateway wiring and the cluster probe layer" section). Left here struck through
  because it was true when written and it is the reason the two services were
  classified as "partially closed" for part of that day.

### The cluster probe layer: making acceptance executable — 2026-09-16

C3 / C4 / C7 / C1 / C5 all ended their rows in the gap list with the same
sentence: *no acceptance probe exists*. `acceptance-cluster.sh` did not touch
any of them, and `smoke-cluster.sh` only asked whether a process was alive. This
round adds the missing layer:

| file | role |
|---|---|
| `platform/deploy/lib/probes.sh` | derived probe targets + HTTP primitives (sourced) |
| `platform/deploy/probes-cluster.sh` | behaviour probes (6) |
| `platform/deploy/probes-cluster-verify.sh` | the gate: 19 checks over injected fake servers |

#### Liveness and behaviour are different questions

`smoke-cluster.sh` answers "is the process up" (`/healthz` 2xx).
`probes-cluster.sh` answers "is the process doing its job". A deployment can be
green on the first and wrong on the second — C5's OPA bind address is the proof:
every service was healthy, policy evaluation could not reach a sibling container
at all, and nothing looked at it.

The probe set is **derived from the topology**, not written down: a service whose
container port lands in the control-plane band (default `8080-8099`) is probed.
Add a service and a probe appears; rename or remove one and the run reports
`probe-targets-not-derived` instead of silently probing fewer things.
`smoke-cluster.sh`'s ten hand-written `wait_http` lines became the same loop.

Failure is classified, not just counted: transport errors (`curl` 7/28/6) mean
*absent*, HTTP 4xx/5xx mean *present but wrong*, and the two need different
remediation. Both exit non-zero, so the probe reports the **classification text**,
never the status code alone.

The three metric probes assert a **series exists**, not that it equals 1. A
gauge at 0 can be a correctly assembled feature that has not fired yet; a
missing series can only mean the binary was built without it.

#### The judgment that had to be widened

The end-to-end chain (`edge-gateway` → `terminal-gateway`) ends in one of three
shapes, and only two of them are correct:

- no event source → `503 no_event_source` (honest; the gateway refuses to fake
  empty history) — `terminal-gateway/internal/server/server.go:106-113`
- event source configured → a plain GET is rejected at `ws.ValidateUpgrade` with
  `400` — `server.go:124-127`
- a non-WS request answered with **2xx** → the fabrication §8.2 forbids

The first version accepted only the 503. That means the probe would have gone
**red on a correct deployment the day the event source was wired** — and the
event source is the next item on C4's own row. A false alarm of that kind gets
the probe weakened, not the wiring investigated. Both correct shapes now pass;
the fabrication case is still caught, and `probes-cluster-verify.sh` has a
forward case for each shape so the widening cannot silently become "anything
passes".

Observed, not argued: the same real binaries were started with and without
`--mem-events`, and probe 1 reported the 503 shape first and the 400 shape after
— i.e. under the old judgment that second run was a false failure.

#### Two implementation bugs the gate caught

Both were only visible against fake servers, and both pointed the wrong way:

- `$?` after `if` is reset to 0 → every transport failure was reported as
  `transport:0` ("connected, status 0") instead of "no listener".
- `metric_value` only matched labelled series (`name{...} 0`) → unlabelled
  gauges, which is exactly what C5's three accumulators are, were all judged
  "not assembled".

Also carried over from this repository's own notes: `fail` must never be called
inside a command substitution (the counter increments in a subshell, so the
script prints FAIL and exits 0), and under `set -euo pipefail` a zero-match
`grep | wc -l` exits the script silently — replaced with a pure-bash
`string_count`.

#### Verification

- `probes-cluster-verify.sh`: **19 passed / 0 failed**, including 11 negative
  cases (each asserting the expected classification text), 2 forward cases, and
  5 derivation checks (cluster = 13 targets, standalone = 12, ports moved out of
  the band, a new service, and long-syntax port entries).
- **Real binaries**: `edge-gateway` and `terminal-gateway` were run locally on
  the same host ports `compose.cluster.yml` publishes (18080 / 18091) and probed
  against the **real topology file** — probes 1, 2 and 3 passed in both
  event-source shapes; the three metric probes correctly reported
  `probe-service-absent` (those services are not running on this machine).
- `shell-portability-check.py` (self-test + 21 scripts), `bash -n` over
  `platform/deploy/*.sh` **and** `platform/deploy/lib/*.sh`, and the other six
  deploy gates all pass. The portability glob now covers `lib/*.sh` — it had
  already caught two full-width-punctuation-after-`$var` bugs in `lib/probes.sh`,
  which `bash -n` on the main scripts cannot see.

#### Not verified, and open

- **No green run inside a real compose cluster.** The Docker daemon is up, but
  the platform images are not built; this is the same class of residue D5 left
  behind ("a real multi-node pass is still owed"), not a code gap.
- **Probe 5 does not prove migration happened.** It proves the drift loop was
  assembled into the binary. The target end — a task dropped back to `PENDING`
  landing on a healthy node in a *second* cluster — is still unverified and needs
  a live-DB case with real node rows.
