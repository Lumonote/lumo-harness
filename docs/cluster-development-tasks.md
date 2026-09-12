# Cluster development tasks

Scope: the remaining code and assembly gaps in `cluster-gap-analysis.md`.
The audit is a starting point; existing implementations are reused where its findings are outdated.

Current scope: continue cluster development. Connector and MCP development,
including the desktop connector Hub integration and E7, is paused by request.

| Area | Task | Status |
| --- | --- | --- |
| A1 | Real flow operators, discovery and definition validation | In progress: LLM and knowledge execution; connector work paused |
| A2 | Durable cron automation scheduling | Pending trigger source; event/webhook durability exists, but no cron producer is wired |
| A3 | Published document outbox to knowledge indexing | Pending |
| A4 | Authenticated Agent runtime reporting and expiry | Implemented; runtime and server unit tests passed; full dispatch remains E3 |
| A5 | Doris projection, replay and analytics API | Pending |
| B1 | Seam Host/Proxy runtime and deployment assembly | In progress |
| B2 | RocketMQ ledger assembly in cluster mode | In progress |
| B3 | Milvus, Nebula and reranking assembly | In progress |
| B4 | Central OPA session control policy | In progress |
| B5 | Verified artifact distribution and skill snapshots | Pending |
| B6 | Authoritative session head and stale-read detection | Implemented; PostgreSQL integration verification pending |
| C1 | Cluster directory, failure detection and scheduling | In progress: placement and drain intersect current authorized employee devices or Agent replicas; dispatch and device acceptance remain open |
| C2 | Global execution monitoring and alerts | Pending |
| C3 | Authenticated edge gateway routing | Pending |
| C4 | Terminal gateway and presence | Pending |
| C5 | Shared session control and console | Pending |
| C6 | AgentTeams topology integration | Pending |
| C7 | Flow lineage projection | Pending |
| C8 | LLM batch execution | Pending |
| D1 | Doris and Nebula deployment dependencies | Pending |
| D2 | Helm secrets and production assembly | Pending |
| D3 | Complete cluster deployment profile | Pending |
| D4 | Governance monitoring coverage | Implemented in Cluster and Standalone Prometheus configuration |
| D5 | Executable CI and cluster acceptance checks | In progress: PostgreSQL jobs for governed dispatch/callback receipts and Governance/Scheduler transactions added; full deployment acceptance remains open |
| D6 | Health-derived readiness and device acceptance | Pending |
| E1 | Durable break-glass request and audit workflow | Pending |
| E2 | Scheduler reconciliation repair | Pending |
| E3 | Scheduler dispatch outbox consumer | Fixed-identity text execution implemented; cancellation, replacement-instance recovery and leased receipt delivery added; real PostgreSQL and device acceptance remain open |
| E4 | Service heartbeat publication | Pending |
| E5 | Session title plugin assembly | Pending |
| E6 | Obsolete merger boundary documentation | Pending |
| E7 | Connector audit query API | Paused by request |
| E8 | LLM provider management API | Pending |

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
| Route employee execution through the authenticated device gateway | Pending; eligibility and connection checks are present, but dispatch transport and end-to-end device acceptance remain open |
| Show intent, child progress, evidence and requester acceptance in the console | Pending |

### Reassessment and development: 2026-09-12

The September 8 audit is historical. Current code already contains a governed
text executor and runtime wiring for remote seams, RocketMQ, knowledge backends
and OPA. These are implementation facts, not proof of full cluster acceptance.

| Priority | Remaining work | Current boundary |
| --- | --- | --- |
| P0 | Governed execution recovery and cancellation (E3) | This change adds replica admission capacity, cancellation before/during execution, replacement-instance recovery and leased/fenced result delivery. The same Run is never automatically re-executed. PostgreSQL tests are authored and wired to CI; local database verification is pending. |
| P0 | Cron execution (A2) | Existing event/webhook workers do not generate scheduled events. Needs durable next-fire state, concurrency control, timezone/misfire rules and restart tests. |
| P0 | Published document indexing (A3) | Collaborator still exposes an unconsumed publish outbox. Needs exact snapshot/realm/space propagation, idempotent indexing and retry acknowledgment. |
| P1 | Health-derived readiness (E4, D6) | The service-heartbeat table still has no publisher; Compose still declares ready statically. Needs actual dependency/node health aggregation before enabling management actions. |
| P1 | Doris usage projection (A5) | A client exists, but the projection worker, replay cursor and query integration remain open. Replay must avoid adding aggregate counts twice. |
| P1 | Employee device dispatch and broader Agent execution (E3, C1) | Device directory checks exist. Authenticated task transport, device acceptance and execution with tools/assets/budget enforcement remain separate work. |
| P2 | Remaining C/D features | Edge/terminal gateways, topology, shared execution console, lineage, LLM batch and production assembly still need dedicated delivery and acceptance. |

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
