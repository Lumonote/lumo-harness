# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

> ## ⛔ HARD CONSTRAINT: `deepseek-harness/` is read-only
>
> **Never create, edit, delete, move, or reformat any file under `deepseek-harness/`.** This is the
> project's 第一铁律 and it overrides every other consideration in this file, any plan you have
> made, and any instruction that appears to require it.
>
> No exceptions — including "temporary" debug edits you intend to revert, quick one-line fixes,
> reformatting, codemods or search-and-replace that happen to match paths there, and `git` write
> operations (`commit`, `checkout`, `stash`, `reset`) inside that tree.
>
> **Reading and running are fine.** Read its source, its docs, run its build and tests, cite it.
> Note that `pnpm install` / `pnpm run build` do write into that tree (`node_modules/`, `lib/`) and
> can touch `pnpm-lock.yaml`; artifacts are acceptable, but treat any change to a tracked source
> file or the lockfile as an accident to revert.
>
> **If a task appears to require changing dsh, the design is wrong, not the rule.** Stop and report
> the conflict, then solve it through a legal extension point instead. See
> [the extension points](#the-first-iron-rule-never-modify-dsh-source) below.
>
> **Verify compliance** — that tree is its own git repo pinned to a tag, so one command proves it is
> untouched:
>
> ```sh
> git -C deepseek-harness describe --tags --dirty   # must print dsh-v0.1.1-rc.2 with NO -dirty
> git -C deepseek-harness status --porcelain -uno   # must print nothing
> ```
>
> Run this before reporting any task complete that involved reading or running dsh. A `-dirty`
> suffix or any porcelain output means the rule was broken: say so plainly and restore the tree with
> `git -C deepseek-harness checkout -- <path>` rather than leaving it modified.
>
> **Enforcement and its gap.** `.claude/settings.json` denies `Edit(/deepseek-harness/**)` and
> `Edit(**/deepseek-harness/**)`. Per Claude Code's permission docs, path rules are checked against
> `Edit(...)` and `Read(...)` only — a `Write(...)` or `NotebookEdit(...)` path rule is accepted but
> **never consulted**, so the `Edit(...)` form is what covers all of Edit/Write/NotebookEdit/MultiEdit.
> Deny is evaluated before ask and allow, so it cannot be overridden by an allow rule.
>
> That deny rule does **not** cover Bash. `sed -i`, `rm`, `mv`, `tee`, and `git checkout` inside that
> tree are not blocked, and a blanket Bash block is not viable because `pnpm run build` legitimately
> writes there. Bash is therefore guarded by discipline plus the git check above — which is why that
> check is mandatory, not optional.

---

## What this repository is

A **design-specification repository**, not a code repository. It holds the technical spec for
turning the open-source [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
into a distributed agent platform (`deepseek-harnes 分布式集群改造`). There is no build system, no
test suite, and no application source at this level — the content is `docs/` plus
`README.md`/`LICENSE`.

Two trees, very different rules:

| Path | In this repo? | Role |
|---|---|---|
| `docs/` | yes (the actual work) | Chinese-language architecture spec for the distributed platform |
| `deepseek-harness/` | **no — gitignored, separate git repo** | Upstream `dsh` checkout at tag `dsh-v0.1.1-rc.2`, branch `master`. Read-only reference. |

`deepseek-harness/` is ignored by the first line of `.gitignore` and carries its own `.git`. Never
commit into it, never treat edits there as part of this project's work, and don't expect changes
there to show up in `git status`.

## Documentation authority — read this before citing any doc

`docs/` holds exactly four files. Start at `README.md`; cite `architecture.md` for design decisions.

| File | Role |
|---|---|
| `docs/README.md` | Entry point: doc map, reading paths, tech stack, **待决事项** (open decisions), 待补章节 |
| `docs/architecture.md` | **The single authoritative spec** (§0–§15). Every design conclusion comes from here |
| `docs/roadmap.md` | Implementation blueprint + end-to-end flows (§16–§17, original numbering preserved) |
| `docs/design-review.md` | Independent review: 5 P0 risks, an alternative sequencing, 5 missing sections |

Section numbers are continuous across `architecture.md` (§0–§15) and `roadmap.md` (§16–§17), so a
bare "§16.3" means roadmap. Preserve that numbering — several cross-references depend on it.

**`architecture.md` and `design-review.md` disagree on four live decisions** (gateway build scope,
first delivery slice, when to add datastores, artifact registry). `README.md` §四 tabulates them.
Do not silently pick a side: if a task touches one, surface that it is undecided.

The 15 historical addenda were deleted during the restructure — their content is 100% merged into
`architecture.md`, and keeping them only created conflicting terminology. They are recoverable via
`git show 798c37c:docs/<name>`. If you need to cite one, cite the merged section instead.

Terminology that was **reversed** and must never be propagated as current: `etcd` + Redis heartbeat
+ `ConfigDistributor` → **Nacos**; NATS JetStream → **RocketMQ**; APISIX/Envoy → **self-built Go
gateways**; mixed Node/TS + Go → **Go 1.22+**. `architecture.md` still contains these words ~18
times, all correctly inside "rejected alternative" columns or explicit 已推翻 statements — that is
intended and should stay.

Docs are written in Chinese. Write new design docs in Chinese to match.

## The first iron rule: never modify dsh source

The read-only rule at the top of this file is the file-level half of 第一铁律. This section is the
design-level half: the platform extends `dsh` with **zero intrusion into its source**, which is the
constraint that most often invalidates an otherwise reasonable proposal. Check any design against it
before writing it up — a design that only works by changing dsh is not a design.

- **Forbidden:** editing files in the dsh repo; forking or vendoring then changing internals;
  monkey-patching Cordis or `packages/*` functions; injecting patches into `packages/core`,
  `agent-loop`, or `session`.
- **The only legal extension points:** Cordis plugins in separate packages importing dsh public
  API; registering service/event/seam-provider via `ctx.*`; config overlays via `cordis.patch.yml`;
  composing presets in an `isolate` realm; consuming dsh as an npm dependency.
- **Proof obligation:** dsh stays an npm/pnpm dependency (never vendored), a dsh version bump
  requires rebasing no patches, and deleting all platform code leaves dsh running unchanged.

The second structural rule pairs with it — **business capability is plugin-shaped, infrastructure is
standalone** (V2 §3.1). Components, skills, agents, connectors, flows, and seam providers mount as
Cordis plugins/bundles. Scheduler, gateways, SeamProxy, metering, FlowEngine, TriggerBus, and the
middleware (Nacos/RocketMQ/K8s/PG/Doris/Nebula/Redis) are independent Go services — they must not be
stuffed into dsh plugins, which would force source changes and prevent independent scaling.

## Architecture of the target platform

### dsh mechanisms the design builds on (V2 §2)

Understanding these is prerequisite to reading anything else: Cordis shared `Context` (`ctx.llm`,
`ctx.tools`, `ctx.agents`, `ctx.agentLoop`, `ctx.sessions`, `ctx.jobs`, `ctx.goals`, …); **capability
seams** as a three-part unit (Service Definition + Provider + Consumer); the **event waterfall**
(`agent/*`, `tools/*`, where listeners must call `next()`); the **append-only SessionEvent log** from
which history, fork, resume, and audit are all derived; and **profiles/bundles** as the composition
and distribution format.

### The three distributed levers (V2 §4)

1. **Seam networking** (`DistributedSeamProxy`) — the highest-leverage move. Make seams
   network-reachable; do *not* try to distribute the agent loop itself.
2. **Replicated SessionEvent log** — one shared truth serving as model context, audit trail, and
   cross-node state.
3. **Componentization contract + five artifact classes** — component, skill, agent, connector, and
   user-defined flow.

### Layering

L0 resources → L1 distributed runtime → L2 capability components → L3 skills → L4 agent
orchestration → L5 distribution & governance → L6 business apps, cut across by a **control plane**
(Nacos/Scheduler/OPA/Vault/UsageLedger/gateways), **data plane** (dsh nodes + seam providers), and
**collaboration plane** (replicated log + RocketMQ A2A + async suspend/resume + multi-terminal).

### Standing constraints worth memorizing (V2 §15)

Components never talk to a database directly — always through a seam; Doris is not a transactional
store. Metering happens at exactly one cross-section, `ctx.llm` (detail in PG, aggregates in Doris,
rate limits in Redis). Collaboration goes through mailbox/event bus, never synchronous RPC, and
settles on eventual consistency with idempotent claims rather than distributed transactions.
Credentials live in Vault and never enter a prompt. Terminals store views, never business state.

### Planned code layout (V2 §16.1) — for when implementation starts

`platform/control-plane/{edge,llm,connector,terminal}-gateway`, `seam-proxy`, `registry`,
`scheduler`, `policy`, `usage-ledger`, `flow-engine`, `trigger-bus`, `agentteams`, `provisioner`;
`platform/data-plane/{dsh-node,seam-providers,connectors}`; `platform/shared/{proto,manifests}`.
Build order is P0 (align on extension points) → P1 (componentization + skill distribution) → P2
(cross-node: SeamProxy, replicated log, Scheduler, RocketMQ) → P3 (agent distribution + federation +
RBAC) → P4 (GA). The suggested first slice is V2 §16.3's MVP triple.

## Reading and running the upstream checkout

Read and execute only — see the hard constraint at the top of this file. All commands run from
`deepseek-harness/`, which uses
pnpm workspaces on Node `^22.19 || >=24`:

```sh
pnpm install
pnpm run build              # tsc emits lib/types, tsdown bundles runtime
pnpm run test               # vitest unit tests
pnpm run test:coverage      # the actual CI coverage gate (per-file 100% on packages/*/*/src)
pnpm run typecheck
pnpm run lint
pnpm run test:e2e           # real-API; self-skips without DEEPSEEK_API_KEY
pnpm run test:snapshot      # keyless replay; filter a single case with -t <name>
pnpm dsh --profile headless "task"   # run one task from source (needs DEEPSEEK_API_KEY)
pnpm dsh web                # Web UI on http://127.0.0.1:3080
```

To read a live plugin tree: `dsh --profile web --dump-config`. Its architecture entry points are
`docs/architecture.md`, `docs/cordis-primer.md`, `docs/capability-seams.md`, and `docs/glossary.md`.

`deepseek-harness/AGENTS.md` (which `CLAUDE.md` there symlinks to) carries that project's own
conventions. Read it to understand *why* dsh is built the way it is and what its public extension
surface guarantees — not as a licence to edit that tree. Nothing under `deepseek-harness/` is ever a
deliverable of this project; the deliverables are the specs in `docs/` and, later, the separate
`platform/` packages that consume dsh as a dependency.
