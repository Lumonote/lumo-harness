# Cluster development tasks

Scope: the remaining code and assembly gaps in `cluster-gap-analysis.md`.
The audit is a starting point; existing implementations are reused where its findings are outdated.

Current scope: continue cluster development. Connector and MCP development,
including the desktop connector Hub integration and E7, is paused by request.

| Area | Task | Status |
| --- | --- | --- |
| A1 | Real flow operators, discovery and definition validation | In progress: LLM and knowledge execution; connector work paused |
| A2 | Durable cron automation scheduling | In progress |
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
| D5 | Executable CI and cluster acceptance checks | Pending |
| D6 | Health-derived readiness and device acceptance | Pending |
| E1 | Durable break-glass request and audit workflow | Pending |
| E2 | Scheduler reconciliation repair | Pending |
| E3 | Scheduler dispatch outbox consumer | In progress: durable Governance scheduling and subagent callback receipts implemented; governed dispatch consumption and execution scope remain open |
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
| Consume governed Scheduler dispatch and execute in the correct runtime identity | Pending; current plugins have process-level user, project and Agent configuration; arbitrary Workers must not inherit unrelated host identity |
| Route employee execution through the authenticated device gateway | Pending; eligibility and connection checks are present, but dispatch transport and end-to-end device acceptance remain open |
| Show intent, child progress, evidence and requester acceptance in the console | Pending |

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
session log. Active execution recovery and uncertain child-start delivery are
not solved by callback persistence. A restarted parent can acknowledge and
retain child results, but restoration of its in-memory Agent and workflow
continuation is separate work. These boundaries must be covered by E3 and device
acceptance before claiming a complete cross-device execution loop.
