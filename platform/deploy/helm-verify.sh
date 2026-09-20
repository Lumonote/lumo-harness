#!/usr/bin/env bash
# Render gate for the Helm chart. No cluster and no Docker daemon required:
# everything here is decided from `helm template` output, so it is fast enough
# to run before every deployment and in CI.
#
# What it is for. The chart can be wrong in ways that `helm template` reports as
# success, and those are exactly the ways that reach a cluster:
#
#   * a Secret reference whose name rendered empty (`name: ,`) — invalid YAML
#     that only blows up at apply time, far from the cause;
#   * a Secret reference nobody creates — the pod sits in
#     CreateContainerConfigError and the reason is not in the chart output;
#   * a profile that stopped rendering because a required value is missing.
#
# The last one is why the negative cases below exist: a gate that only checks
# "the good render succeeds" passes even when the guard it is supposed to prove
# has been deleted. Every assertion here is paired with an input that must be
# rejected.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$script_dir/helm/lumo-platform"
release="lumo"
cluster_profile="$chart_dir/values.cluster.yaml"

report_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumo-helm-verify.XXXXXX")"
trap 'rm -rf "$report_dir"' EXIT

failures=0
fail() {
  echo "helm-verify: FAIL: $*" >&2
  failures=$((failures + 1))
}
pass() { echo "helm-verify: OK: $*"; }

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "command $1"
  else
    fail "required command $1 is unavailable"
  fi
}

require_command helm
[[ -r "$chart_dir/Chart.yaml" ]] || {
  echo "helm-verify: chart not found at $chart_dir" >&2
  exit 66
}
[[ -r "$cluster_profile" ]] || {
  echo "helm-verify: cluster profile not found at $cluster_profile" >&2
  exit 66
}

# --- extraction -------------------------------------------------------------
# Secret names a document defines. Only the first `name:` after `kind: Secret`
# counts: the entries under `data:` are also `name:`-shaped at the same indent.
rendered_secret_names() {
  awk '
    /^---/ { isSecret = 0; seen = 0 }
    /^kind: Secret[[:space:]]*$/ { isSecret = 1 }
    isSecret && !seen && /^  name:/ {
      sub(/^  name:[[:space:]]*/, ""); gsub(/"/, ""); print; seen = 1
    }
  ' "$1" | sort -u
}

# Secret names a document references. Three shapes are in use, and all three
# are covered on purpose — an earlier version of this check looked for one and
# would have missed volume-mounted references entirely:
#   valueFrom: { secretKeyRef: { name: X, ... } }
#   envFrom:   [ { secretRef:    { name: X, ... } } ]
#   volumes:   secret: { secretName: X }  /  secretName: X
referenced_secret_names() {
  {
    grep -oE 'secretKeyRef: \{[^}]*\}' "$1" | sed -n 's/.*name:[[:space:]]*\([^,}]*\).*/\1/p'
    grep -oE 'secretRef: \{[^}]*\}' "$1" | sed -n 's/.*name:[[:space:]]*\([^,}]*\).*/\1/p'
    grep -oE 'secretName:[[:space:]]*[^,}]*' "$1" | sed 's/secretName:[[:space:]]*//'
  } | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/"//g' | sort -u
}

# A reference that rendered to nothing. Checked separately from the name-set
# comparison because an empty name is not a missing name — it is invalid output.
check_no_empty_secret_names() {
  local label="$1" file="$2"
  local hits
  hits="$(grep -cE 'secretKeyRef: \{[[:space:]]*name:[[:space:]]*,|secretRef: \{[[:space:]]*name:[[:space:]]*,|secretName:[[:space:]]*,|secretName:[[:space:]]*$' "$file" || true)"
  if [[ "$hits" == "0" ]]; then
    pass "$label: no Secret reference rendered an empty name"
  else
    grep -nE 'secretKeyRef: \{[[:space:]]*name:[[:space:]]*,|secretRef: \{[[:space:]]*name:[[:space:]]*,|secretName:[[:space:]]*,|secretName:[[:space:]]*$' "$file" >&2
    fail "$label: $hits Secret reference(s) rendered an empty name"
  fi
}

# Every referenced name must be either defined by this render or named in the
# profile's operator-supplied list. The lists are hardcoded rather than derived
# from the chart: deriving them would make this check true by construction.
check_secret_references_resolve() {
  local label="$1" file="$2" allowed="$3"
  local name missing=""
  local rendered; rendered="$(rendered_secret_names "$file")"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if grep -Fxq "$name" <<< "$rendered"; then continue; fi
    if [[ -n "$allowed" ]] && grep -Fqw "$name" <<< "$allowed"; then continue; fi
    missing="$missing $name"
  done < <(referenced_secret_names "$file")
  if [[ -z "$missing" ]]; then
    pass "$label: every referenced Secret is either rendered or declared operator-supplied"
  else
    fail "$label: Secret reference(s) that nothing creates:$missing"
  fi
}

render_ok() {
  local label="$1" out="$2"; shift 2
  if helm template "$release" "$chart_dir" "$@" > "$out" 2>"$out.err"; then
    pass "$label renders"
  else
    cat "$out.err" >&2
    fail "$label does not render"
    return 1
  fi
}

render_rejected() {
  local label="$1"; shift
  if helm template "$release" "$chart_dir" "$@" >/dev/null 2>&1; then
    fail "$label was expected to be rejected but rendered successfully"
  else
    pass "$label is rejected"
  fi
}

# `helm template` deliberately excludes NOTES.txt, so lint is the only offline
# way to render it. Verified by control: injecting a bad reference into
# NOTES.txt makes lint fail, so this is not a vacuous check.
lint_ok() {
  local label="$1"; shift
  if helm lint "$chart_dir" "$@" >/dev/null 2>&1; then
    pass "$label lints (templates, values and NOTES.txt)"
  else
    helm lint "$chart_dir" "$@" >&2 || true
    fail "$label fails helm lint"
  fi
}

# --- the two shipped profiles ----------------------------------------------
default_render="$report_dir/default.yaml"
cluster_render="$report_dir/cluster.yaml"

# Operator-supplied in the base profile: the chart renders no Secrets there by
# design. lumo-vault-token is `optional: true` and may legitimately be absent.
base_operator_secrets="lumo-control-plane-token lumo-registry-trust lumo-vault-token lumo-terminal-signing"
# The cluster profile claims to be installable as-is, so its allowed list holds
# only the one reference that is explicitly optional. Anything else that is
# referenced but not rendered is a real prerequisite and must fail here.
# `lumo-terminal-signing` is not in this list because the cluster profile renders
# it (secrets.create=true) — if that minting is ever removed, this check fails
# rather than the pod failing at CreateContainerConfigError.
cluster_operator_secrets="lumo-vault-token"

if render_ok "base profile" "$default_render"; then
  check_no_empty_secret_names "base profile" "$default_render"
  check_secret_references_resolve "base profile" "$default_render" "$base_operator_secrets"
  # Hardcoded expectation, not derived from the render: deriving it would make
  # the check vacuous. Base profile renders no Secrets at all.
  base_secrets="$(rendered_secret_names "$default_render" | wc -l | tr -d ' ')"
  if [[ "$base_secrets" == "0" ]]; then
    pass "base profile renders no Secrets (credentials stay operator-owned)"
  else
    fail "base profile rendered $base_secrets Secret(s); secrets.create should default to false"
  fi
fi

if render_ok "cluster profile" "$cluster_render" -f "$cluster_profile"; then
  check_no_empty_secret_names "cluster profile" "$cluster_render"
  check_secret_references_resolve "cluster profile" "$cluster_render" "$cluster_operator_secrets"
  expected_cluster_secrets="lumo-control-plane-token lumo-dsh-web-identity lumo-registry-trust lumo-subagent-host-token lumo-terminal-signing"
  actual_cluster_secrets="$(rendered_secret_names "$cluster_render" | tr '\n' ' ' | sed 's/ *$//')"
  if [[ "$actual_cluster_secrets" == "$expected_cluster_secrets" ]]; then
    pass "cluster profile renders exactly the expected Secrets"
  else
    fail "cluster profile Secrets are [$actual_cluster_secrets], expected [$expected_cluster_secrets]"
  fi
  # The cluster shape is the reason the profile exists; if it silently went back
  # to one scheduler, the lease/standby path would be untested.
  scheduler_replicas="$(awk '
    /^kind: Deployment[[:space:]]*$/ { svc = "" }
    /^    lumo.dev\/service:/ { svc = $2 }
    /^  replicas:/ && svc == "scheduler" { print $2; exit }
  ' "$cluster_render")"
  if [[ "$scheduler_replicas" == "2" ]]; then
    pass "cluster profile runs two schedulers (lease/standby path exists)"
  else
    fail "cluster profile scheduler replicas is [$scheduler_replicas], expected 2"
  fi
  # Every replica must carry a unique instance id, and it must come from the pod
  # name. Two replicas sharing an instance id is not a cosmetic problem: the
  # scheduler resolves its lease holder from LUMO_INSTANCE and falls back to the
  # literal "scheduler-0" (cmd/scheduler/main.go:33), and Acquire does not
  # advance the fencing token when the holder is unchanged
  # (internal/store/store.go:204-208), so two pods would both hold token 1 and
  # both pass checkFencing. Count is hardcoded for the same reason the service
  # lists elsewhere are: deriving it would make the check true by construction.
  # 12 control-plane services as of 2026-09-16: the ten that were charted plus
  # edge-gateway and terminal-gateway. Pinned rather than counted from the render
  # for the reason given below, and because the count is the only thing that
  # notices a service whose Deployment lost its instance id: the render stays
  # valid, the pod starts, and two replicas of a service that uses LUMO_INSTANCE
  # as a lease holder collapse onto the same identity.
  expected_instance_refs=12
  instance_refs="$(grep -A1 'name: LUMO_INSTANCE' "$cluster_render" | grep -c 'fieldPath: metadata.name' || true)"
  if [[ "$instance_refs" == "$expected_instance_refs" ]]; then
    pass "cluster profile binds LUMO_INSTANCE to the pod name on all $expected_instance_refs control-plane services"
  else
    fail "cluster profile has $instance_refs LUMO_INSTANCE pod-name bindings, expected $expected_instance_refs"
  fi

  # --- C5: the dsh workloads must be told where the control plane is --------
  # `ctx.sessionControl.dispatch` posts a control command to
  # `POST /v1/sessions/{ref}/control`. Without this variable it throws
  # ControlCommandRoutingError instead, and that failure lives entirely at
  # runtime: the render is valid, the pods start, and the only symptom is a
  # console button that does nothing. So it gets a render-time assertion.
  #
  # The expected value is written down rather than read back out of the render —
  # reading it back would make the check true by construction, which is the
  # failure mode this file exists to avoid. The count is pinned for the same
  # reason: one too few means a workload lost its wiring, one too many means a
  # copy-paste in the template. Both dsh workloads load @lumo/control, hence 2;
  # a third one would fail here, which is the prompt to decide whether it needs
  # this variable too.
  #
  # The chart's half of this pair is `index .Values.services "session-control"`
  # in templates/dsh-node.yaml — the key has a hyphen, so `.Values.services.
  # session-control.port` is a parse error, not a silent empty string.
  expected_session_control_url="http://lumo-platform-session-control:8092"
  session_control_refs="$(grep -A1 '^ *- name: LUMO_SESSION_CONTROL_URL$' "$cluster_render" | grep -cF "$expected_session_control_url" || true)"
  if [[ "$session_control_refs" == "2" ]]; then
    pass "cluster profile points both dsh workloads at $expected_session_control_url"
  else
    fail "cluster profile has $session_control_refs dsh workload(s) with LUMO_SESSION_CONTROL_URL=$expected_session_control_url, expected 2"
  fi

  # --- A3: the knowledge projection must name a seam host that exists ------
  # collaborator pushes its published-document outbox to `POST
  # /seam/knowledge/ingest` on a seam host. Without the URL it logs a warning and
  # projects nothing — a green deployment in which published documents never
  # reach vector search. So the URL is asserted, **and so is the thing it names**:
  # a URL that points at a Service this chart does not render would render
  # cleanly, lint cleanly, and fail only as a connection error at ingest time.
  #
  # The host is the node pool, not dsh-web: dsh-web also runs a seam host, but its
  # Service does not publish the seam port, so a URL naming it is unreachable
  # from another pod.
  expected_knowledge_seam_url="http://lumo-platform-dsh-node:8090"
  knowledge_seam_refs="$(grep -A1 '^ *- name: LUMO_KNOWLEDGE_SEAM_URL$' "$cluster_render" | grep -cF "$expected_knowledge_seam_url" || true)"
  if [[ "$knowledge_seam_refs" == "1" ]]; then
    pass "cluster profile points the knowledge projection at $expected_knowledge_seam_url"
  else
    fail "cluster profile has $knowledge_seam_refs workload(s) with LUMO_KNOWLEDGE_SEAM_URL=$expected_knowledge_seam_url, expected 1"
  fi
  # The URL is only half the claim; the other half is that the host and port it
  # names are actually published by a Service in this same render. A host that
  # resolves to nothing renders cleanly, lints cleanly, and fails only as a
  # connection error at ingest time — the deployment looks wired either way.
  #
  # This reads the **rendered** URL rather than comparing against the literal
  # above, and that is the whole point of having both checks. Verified by
  # counter-case: renaming the host in the template leaves the pinned check
  # failing on the literal while this one keeps passing — a check anchored to the
  # literal can only ever confirm the Service exists, never that the URL points at
  # it. Both are wanted: the pinned one notices the URL drifting, this one notices
  # an URL that resolves to nothing.
  rendered_seam_url="$(grep -A1 '^ *- name: LUMO_KNOWLEDGE_SEAM_URL$' "$cluster_render" | grep -o 'http://[^"]*' | head -1 || true)"
  seam_host="${rendered_seam_url#http://}"
  seam_port="${seam_host##*:}"
  seam_host="${seam_host%%:*}"
  seam_service_block="$(awk -v host="$seam_host" '
    /^kind: Service$/ { svc = 1 }
    svc && /^  name: / { cur = $2 }
    svc && cur == host { if ($0 == "---") exit; print }
  ' "$cluster_render")"
  if [[ "$seam_host" == "" || "$seam_port" == "" ]]; then
    fail "no knowledge seam URL found in the cluster render to resolve"
  elif grep -q "name: seam" <<<"$seam_service_block" && grep -q "port: $seam_port" <<<"$seam_service_block"; then
    pass "the rendered knowledge seam URL $rendered_seam_url resolves to a Service port in the same render"
  else
    fail "the rendered knowledge seam URL $rendered_seam_url names no Service port in this render"
  fi

  # Counter-case: with the node pool off there is no seam host at all, and the
  # variable must be **omitted** rather than rendered as a name that resolves to
  # nothing. "No seam host" and "a seam host that is never up" look identical in
  # the ingress log and are fixed by different people.
  if helm template "$release" "$chart_dir" -f "$cluster_profile" --set dshNode.enabled=false 2>/dev/null \
    | grep -q "LUMO_KNOWLEDGE_SEAM_URL"; then
    fail "disabling dshNode still renders LUMO_KNOWLEDGE_SEAM_URL (it must be omitted, not dangling)"
  else
    pass "disabling dshNode omits the knowledge seam URL entirely"
  fi
fi

# --- chart coverage: the tree is the reference, not the chart ---------------
# Every check above is about a service that *is* in the chart. Nothing above can
# see a service that never got there, because a missing Service leaves no trace:
# the render succeeds, lint passes, and `expected_instance_refs` above is pinned
# to the chart's own contents. That is exactly how `edge-gateway` and
# `terminal-gateway` came to sit outside the chart while the other eight wiring
# surfaces (both compose files, both Prometheus configs, the alert list,
# preflight, the CI matrix, build.sh) all listed them — see
# docs/cluster-development-tasks.md, "Found while re-auditing C3/C4".
#
# The comparison is exact because both sets are already written down:
# control-plane modules that ship as images, and the chart's `services` keys.
# The tree half is derived by walking `platform/control-plane/*/Dockerfile` rather
# than from a hand-written list, for the same reason the CI matrix is: a list that
# is maintained by hand rots in the direction nobody checks.
#
# Deliberately NOT compared against `preflight-deployment.sh`'s cluster list: that
# one includes middleware (postgres, redis, nacos, opa, vault, rocketmq, minio,
# milvus) which this chart intentionally does not ship, so it would report ~20
# false positives and bury the real ones.
chart_service_names() {
  awk '
    /^services:[[:space:]]*$/ { in_services = 1; next }
    in_services && /^[^[:space:]#]/ { in_services = 0 }
    in_services && /^  [A-Za-z0-9_-]+:/ { key = $1; sub(/:$/, "", key); print key }
  ' "$1/values.yaml" | sort -u
}

# There is deliberately no exclusion list any more. The one that used to live
# here held `edge-gateway` and `terminal-gateway`, and it is worth recording how
# it ended: the two entries were honest when written (both really were outside
# the chart), but an escape hatch shaped like "this service is allowed to be
# missing" is exactly the shape of the defect — the list answered "is every
# module charted?" with "every module is charted or excused", and the excuse is
# where a forgotten service hides. It also had to be maintained by hand, in a
# file whose own docstring argues that hand-maintained lists rot in the
# direction nobody checks.
#
# Both services are now charted (values.yaml, templates/edge-routes.yaml), so the
# invariant is unconditional: every module that builds an image is in the chart.
# If a module ever genuinely cannot be charted, re-introducing an exclusion is a
# deliberate edit — and it should come with the reason in the message, not as a
# quiet line in a list.
control_plane_modules="$(cd "$script_dir/../control-plane" && for d in */; do
  [[ -f "$d/Dockerfile" ]] && printf '%s\n' "${d%/}"
done | sort)"

# Modules present in the tree but absent from the chart.
# `comm` requires *globally* sorted input, so the chart side is sorted here — an
# earlier version concatenated an already-sorted list with already-sorted
# exclusions, which is not sorted, and that silently disabled them.
chart_missing_from() {
  local chart="$1"
  comm -23 \
    <(printf '%s\n' "$control_plane_modules") \
    <(chart_service_names "$chart" | sort -u) |
    grep -v '^$' || true
}

chart_missing="$(chart_missing_from "$chart_dir")"
if [[ -z "$chart_missing" ]]; then
  pass "every control-plane module that builds an image is in the chart"
else
  fail "control-plane modules absent from the chart: $(printf '%s' "$chart_missing" | tr '\n' ' ')"
fi

chart_orphans="$(comm -13 \
  <(printf '%s\n' "$control_plane_modules") \
  <(chart_service_names "$chart_dir") | grep -v '^$' || true)"
if [[ -z "$chart_orphans" ]]; then
  pass "every charted service has a control-plane module that builds an image"
else
  fail "charted services with no control-plane module: $(printf '%s' "$chart_orphans" | tr '\n' ' ')"
fi

# Counter-case: the comparison must actually fail when a module is dropped from
# the chart. Without this, deleting the whole section would keep the gate green,
# which is the failure mode the negative cases in this file exist to prevent.
if [[ "$(grep -c '^  usage-ledger:' "$chart_dir/values.yaml" || true)" == "1" ]]; then
  counter_chart="$report_dir/chart-missing-service"
  mkdir -p "$counter_chart"
  cp -R "$chart_dir/." "$counter_chart/"
  awk '!/^  usage-ledger:/' "$counter_chart/values.yaml" >"$counter_chart/values.yaml.new"
  mv "$counter_chart/values.yaml.new" "$counter_chart/values.yaml"
  counter_missing="$(chart_missing_from "$counter_chart")"
  if [[ "$counter_missing" == "usage-ledger" ]]; then
    pass "counter-case: a module dropped from the chart is detected"
  else
    fail "counter-case: dropping usage-ledger yielded [$counter_missing], expected [usage-ledger]"
  fi
else
  fail "counter-case anchor '  usage-ledger:' does not appear exactly once in values.yaml"
fi

# --- the edge route table is derived from the chart, not copied ------------
# values.edgeGateway.routes names *services*; the upstream host and port are
# computed from the release name and from each service's own `port`. The failure
# mode of a copied table is silent, which is why it gets its own section:
# a table that still says `<name>-flows:8087` after `services.flows.port` moved
# is internally consistent (its whitelist matches its own routes), so the gateway
# starts, the render is clean, and the first request on that prefix is a 502 —
# a place nobody looks when the change they made was "a port number".
#
# Two things are deliberately NOT derived here: the route count and the set of
# prefixes. They are written out below, because a check that reads its
# expectation from the artefact under test answers "is the table internally
# consistent?" while claiming to answer "does it cover what we think it covers?".
render_rejected_saying() {
  local label="$1" want="$2"; shift 2
  if helm template "$release" "$chart_dir" "$@" >"$report_dir/reject.out" 2>&1; then
    fail "$label was expected to be rejected but rendered successfully"
    return
  fi
  if grep -qF -- "$want" "$report_dir/reject.out"; then
    pass "$label is rejected ($want)"
  else
    fail "$label was rejected, but not for the expected reason"
    cat "$report_dir/reject.out" >&2
  fi
}

extract_edge_routes_json() {
  local render="$1" out="$2"
  python3 - "$render" "$out" <<'PY'
import json, sys

src, dst = sys.argv[1:3]
body, inside = [], False
for line in open(src, encoding="utf-8").read().split("\n"):
    if line.strip().startswith("edge-routes.json:"):
        inside = True
        continue
    if inside:
        if line.startswith("    "):
            body.append(line[4:])
        elif line.strip():
            break
if not inside:
    print("render contains no edge-routes.json key", file=sys.stderr)
    sys.exit(2)
text = "\n".join(body)
try:
    json.loads(text)
except Exception as err:  # noqa: BLE001 - any parse failure is the same defect here
    print(f"route table is not valid JSON: {err}", file=sys.stderr)
    sys.exit(3)
open(dst, "w", encoding="utf-8").write(text)
PY
}

# Cross-checks the table against the Services rendered *in the same pass*, so a
# table that drifted from the chart cannot pass by agreeing with itself.
check_edge_routes() {
  python3 - "$1" "$2" <<'PY'
import json, re, sys

table = json.load(open(sys.argv[1], encoding="utf-8"))
render = open(sys.argv[2], encoding="utf-8").read()

ports = {}
for doc in render.split("\n---\n"):
    if not re.search(r"^kind: Service\s*$", doc, re.M):
        continue
    name = re.search(r"^  name: (\S+)\s*$", doc, re.M)
    port = re.search(r"ports: \[\{ name: http, port: (\d+), targetPort: http \}\]", doc)
    if name and port:
        ports[name.group(1)] = int(port.group(1))

expected_prefixes = [
    "/v1/auth/", "/v1/chat/", "/v1/flows", "/v1/operators",
    "/v1/projects", "/v1/providers", "/v1/tasks/", "/v1/terminals/",
]

def report(ok, label, detail=""):
    print(("ok" if ok else "fail") + "\t" + label + ("\t" + detail if detail else ""))

report(len(ports) == 12, "the render exposes 12 http Services to compare against",
       f"parsed {len(ports)}: {sorted(ports)}")

actual_prefixes = sorted(r["prefix"] for r in table["routes"])
report(actual_prefixes == expected_prefixes, "route coverage is the pinned set",
       f"expected {expected_prefixes}, got {actual_prefixes}")

mismatched = []
for r in table["routes"]:
    host = re.sub(r"^http://", "", r["upstream"])
    name, _, port = host.partition(":")
    if ports.get(name) != int(port):
        mismatched.append(f"{r['prefix']} -> {host} but Service {name} is on port {ports.get(name)}")
report(not mismatched, "every upstream matches the host and port of the Service in the same render",
       "; ".join(mismatched))

used = sorted({re.sub(r"^http://", "", r["upstream"]) for r in table["routes"]})
report(used == table["whitelist"], "the whitelist is exactly the set of upstreams in use",
       f"whitelist {table['whitelist']} vs used {used}")
PY
}

if [[ -r "$cluster_render" ]]; then
  if helm template "$release" "$chart_dir" -f "$cluster_profile" -s templates/edge-routes.yaml \
    >"$report_dir/edge-routes-render.yaml" 2>"$report_dir/edge-routes-render.err"; then
    if extract_edge_routes_json "$report_dir/edge-routes-render.yaml" "$report_dir/edge-routes.json"; then
      while IFS=$'\t' read -r verdict label detail; do
        if [[ "$verdict" == "ok" ]]; then
          pass "edge route table: $label"
        else
          fail "edge route table: $label — $detail"
        fi
      done < <(check_edge_routes "$report_dir/edge-routes.json" "$cluster_render")
    else
      fail "the rendered edge-routes ConfigMap did not yield a parseable JSON table"
    fi
  else
    cat "$report_dir/edge-routes-render.err" >&2
    fail "templates/edge-routes.yaml did not render"
  fi
else
  fail "the cluster profile did not render, so the route table could not be cross-checked"
fi

# Counter-cases, one per way the section above could be vacuous.
if helm template "$release" "$chart_dir" -f "$cluster_profile" -s templates/edge-routes.yaml \
  --set services.flows.port=9999 >"$report_dir/routes-port-moved.yaml" 2>/dev/null \
  && extract_edge_routes_json "$report_dir/routes-port-moved.yaml" "$report_dir/routes-port-moved.json"; then
  # The already-cross-checked table is the reference here, which is exactly what a
  # counter-case wants: the question is not "is the base table right" (answered
  # above) but "does this number come from the Service or from a copy of it".
  if python3 - "$report_dir/edge-routes.json" "$report_dir/routes-port-moved.json" <<'PY'
import json, sys

base = json.load(open(sys.argv[1], encoding="utf-8"))
moved = json.load(open(sys.argv[2], encoding="utf-8"))

def flows_upstreams(table):
    return sorted({r["upstream"] for r in table["routes"] if r["prefix"] in ("/v1/flows", "/v1/operators")})

want = sorted(u.replace(":8087", ":9999") for u in flows_upstreams(base))
got = flows_upstreams(moved)
if not want or got != want:
    print(f"expected {want}, got {got}", file=sys.stderr)
    sys.exit(1)
PY
  then
    pass "counter-case: moving services.flows.port moves the route upstream with it"
  else
    fail "counter-case: services.flows.port=9999 did not move the flows upstream"
  fi
else
  fail "counter-case: rendering with services.flows.port=9999 failed"
fi

render_rejected_saying "a route pointing at a disabled service" "which is disabled" \
  -f "$cluster_profile" --set services.flows.enabled=false

# An overlay that empties the table is written as a values file rather than
# `--set edgeGateway.routes={}`: that form does not produce an empty list, and
# pinning the counter-case to it would be testing Helm's --set parser (and would
# pass or fail for reasons unrelated to the guard).
printf 'edgeGateway:\n  routes: []\n' >"$report_dir/empty-routes.yaml"
render_rejected_saying "edge-gateway enabled with an empty route table" "requires edgeGateway.routes" \
  -f "$cluster_profile" -f "$report_dir/empty-routes.yaml"

# A malformed entry, on the other hand, is exactly what `--set` mangles — and the
# point of the type guard is that this is reported as a values error rather than
# as a Go template error naming a column in a template the operator never wrote.
render_rejected_saying "a route entry that is not a mapping" "must be a mapping" \
  -f "$cluster_profile" --set edgeGateway.routes={}

# The per-service Service type exists so an entry point can be exposed without
# flipping the global default, which would expose every internal face at once.
# Asserted as "exactly one Service changed type", not just "the named one did":
# the value of this override is that it stays scoped.
if helm template "$release" "$chart_dir" -f "$cluster_profile" \
  --set services.edge-gateway.type=LoadBalancer >"$report_dir/entry-type.yaml" 2>/dev/null; then
  entry_types="$(python3 - "$report_dir/entry-type.yaml" <<'PY'
import re, sys

out = []
for doc in open(sys.argv[1], encoding="utf-8").read().split("\n---\n"):
    if not re.search(r"^kind: Service\s*$", doc, re.M):
        continue
    name = re.search(r"^  name: (\S+)\s*$", doc, re.M)
    typ = re.search(r"^  type: (\S+)\s*$", doc, re.M)
    if name and typ:
        out.append(f"{name.group(1)}={typ.group(1)}")
print(" ".join(sorted(out)))
PY
)"
  non_clusterip="$(printf '%s' "$entry_types" | tr ' ' '\n' | grep -vc '=ClusterIP$' || true)"
  if [[ "$non_clusterip" == "1" ]] && printf '%s' "$entry_types" | grep -q 'lumo-platform-edge-gateway=LoadBalancer'; then
    pass "counter-case: services.edge-gateway.type=LoadBalancer exposes that one Service and no other"
  else
    fail "counter-case: expected exactly one non-ClusterIP Service (edge-gateway), got [$entry_types]"
  fi
else
  fail "counter-case: rendering with services.edge-gateway.type=LoadBalancer failed"
fi

lint_ok "base profile"
lint_ok "cluster profile" -f "$cluster_profile"

# --- guards that must stay guards ------------------------------------------
# Each of these fails today. If one starts rendering, the corresponding check in
# templates/secret.yaml was removed or weakened.
render_rejected "an enabled control plane with no control-plane Secret" \
  --set controlPlaneAuth.tokenSecret=
render_rejected "dsh-node enabled with no subagent host Secret" \
  --set dshNode.enabled=true --set dshNode.hostTokenSecret=
render_rejected "a Registry enabled with no trust Secret" \
  --set registry.trustSecret=
render_rejected "dsh-web enabled with neither assertion Secret nor static identity" \
  --set dshWeb.enabled=true --set secrets.create=false

# An empty Secret name must be omitted, not rendered as `name: ,`. This is the
# defect that motivated the gate: `helm template` reported success on output no
# cluster would accept.
if render_ok "vault token Secret name emptied" "$report_dir/no-vault.yaml" --set vault.tokenSecret=; then
  if grep -q 'LUMO_VAULT_TOKEN' "$report_dir/no-vault.yaml"; then
    fail "emptying vault.tokenSecret still emitted LUMO_VAULT_TOKEN"
  else
    pass "emptying vault.tokenSecret omits LUMO_VAULT_TOKEN entirely"
  fi
  check_no_empty_secret_names "vault token Secret name emptied" "$report_dir/no-vault.yaml"
fi

# The guard above must be conditional, not always-on: with every service
# disabled there is nothing to read the token and the chart must still render.
# This list must name **every** key of values.services. Forgetting one is not
# silent: that service stays enabled, so the render still references the
# control-plane Secret and this check fails loudly (which is how session-control
# was caught when it was added).
all_off=()
for service in collaborator scheduler registry connector-gateway llm-gateway session-control flows projects governance usage-ledger edge-gateway terminal-gateway; do
  all_off+=(--set "services.$service.enabled=false")
done
if render_ok "every service disabled" "$report_dir/all-off.yaml" "${all_off[@]}" --set controlPlaneAuth.tokenSecret=; then
  pass "the control-plane Secret guard is conditional, not unconditional"
fi

if (( failures > 0 )); then
  echo "helm-verify: $failures check(s) failed." >&2
  exit 1
fi

echo "helm-verify: all checks passed."
