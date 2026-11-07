#!/usr/bin/env bash
# Render all supported feature combinations; validate parsed YAML, built-in
# Kubernetes schemas (when required in CI) and selector counterexamples.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
chart="$script_dir/helm/lumo-platform"
python_bin="${LUMO_DEPLOY_PYTHON:-python3}"
command -v helm >/dev/null
"$python_bin" -c 'import yaml'
report_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumo-chart-combinations.XXXXXX")"
trap 'rm -rf "$report_dir"' EXIT
render() {
  local label="$1"; shift
  helm template lumo "$chart" "$@" >"$report_dir/$label.yaml"
  "$python_bin" "$script_dir/check-rendered-chart.py" "$report_dir/$label.yaml" lumo
  if command -v kubeconform >/dev/null; then
    # Istio is checked by our parsed-structure gate; its CRDs are provided by
    # the installed mesh and are outside upstream Kubernetes JSON schemas.
    kubeconform -kubernetes-version "${LUMO_KUBERNETES_VERSION:-1.31.0}" -strict -summary -skip PeerAuthentication,DestinationRule,AuthorizationPolicy,Gateway,VirtualService "$report_dir/$label.yaml"
  elif [[ "${LUMO_REQUIRE_KUBECONFORM:-0}" == 1 ]]; then
    echo 'chart-combinations: kubeconform is required' >&2; exit 1
  fi
}
cluster=(-f "$chart/values.cluster.yaml")
device=(--set deviceGateway.enabled=true --set deviceGateway.publicUrl=https://devices.lumo.invalid --set deviceGateway.tlsSecret=test-device-server --set deviceGateway.issuerSecret=test-device-issuer)
render base
render cluster "${cluster[@]}"
render device "${cluster[@]}" "${device[@]}"
render mesh-device "${cluster[@]}" "${device[@]}" --set serviceMesh.istio.enabled=true --set serviceMesh.istio.trustDomain=cluster.local --set deviceGateway.istioIngress.enabled=true
render provisioner "${cluster[@]}" --set provisioner.enabled=true --set provisioner.artifactName=test-artifact --set provisioner.artifactVersion=1.0.0
render production "${cluster[@]}" -f "$chart/values.production.yaml" -f "$script_dir/tests/fixtures/production-values.yaml"
render external-hpa "${cluster[@]}" --set dshNode.hpa.targetCPUUtilizationPercentage=0 --set 'dshNode.hpa.externalMetrics[0].name=lumo_pending_tasks' --set-string 'dshNode.hpa.externalMetrics[0].averageValue=4'
native_models=(--set dshNode.harness.patchConfigMap=models-node --set dshNode.harness.patchKey=node-patch.yml --set dshNode.harness.credentialsSecret=credentials-node --set dshWeb.harness.patchConfigMap=models-web --set dshWeb.harness.patchKey=web-patch.yml --set dshWeb.harness.credentialsSecret=credentials-web)
render native-models "${cluster[@]}" "${native_models[@]}"
render native-models-persistent "${cluster[@]}" "${native_models[@]}" --set dshNode.harness.persistence.enabled=true --set dshWeb.harness.persistence.enabled=true
render native-home-only "${cluster[@]}" --set dshNode.harness.persistence.enabled=true --set dshWeb.harness.persistence.enabled=true --set dshNode.spool.persistence.enabled=false --set dshWeb.spool.persistence.enabled=false
for workload in dshNode dshWeb; do
  if helm template lumo "$chart" "${cluster[@]}" --set "$workload.spool.persistence.enabled=false" --set "$workload.workloadKind=Deployment" --set "$workload.harness.persistence.enabled=true" > /dev/null 2>"$report_dir/negative.txt"; then
    echo 'chart-combinations: persistent Harness home on Deployment was accepted' >&2; exit 1
  fi
  grep -q 'persistent Harness home requires StatefulSet' "$report_dir/negative.txt"
done
for invalid in 'dshNode.harness.patchKey=' 'dshWeb.harness.patchKey=dir/patch.yml' 'dshNode.harness.patchConfigMap=bad..name' 'dshWeb.harness.credentialsSecret=bad..name' 'dshNode.harness.credentialsSecret=true' 'dshWeb.harness.apiKey=not-allowed' 'dshNode.harness.persistence.claimName=shared-home' 'dshWeb.harness.persistence.enabled=maybe'; do
  if helm template lumo "$chart" "${cluster[@]}" --set "$invalid" > /dev/null 2>"$report_dir/negative.txt"; then
    echo "chart-combinations: invalid Harness configuration was accepted: $invalid" >&2; exit 1
  fi
  grep -q 'schema' "$report_dir/negative.txt"
done
helm template lumo-b "$chart" "${cluster[@]}" --set nameOverride=lumo-platform-b --set dshNode.clusterId=cluster-b >"$report_dir/second.yaml"
"$python_bin" "$script_dir/check-rendered-chart.py" "$report_dir/cluster.yaml" lumo --other-file "$report_dir/second.yaml" --other-release lumo-b
# Reproduce the exact unsafe selector shape from the audit; gate must reject it.
"$python_bin" - "$report_dir/cluster.yaml" "$report_dir/unscoped.yaml" <<'PYMUTATE'
import sys, yaml
docs=list(yaml.safe_load_all(open(sys.argv[1])))
def remove(value):
    if isinstance(value,dict):
        value.pop('app.kubernetes.io/instance',None)
        for child in value.values(): remove(child)
    elif isinstance(value,list):
        for child in value: remove(child)
remove(docs)
with open(sys.argv[2],'w') as output: yaml.safe_dump_all(docs,output)
PYMUTATE
if "$python_bin" "$script_dir/check-rendered-chart.py" "$report_dir/unscoped.yaml" lumo >"$report_dir/negative.txt" 2>&1; then
  echo 'chart-combinations: unsafe selectors were accepted' >&2; exit 1
fi
if helm template lumo "$chart" "${cluster[@]}" --set dshNode.workloadKind=Deployment > /dev/null 2>"$report_dir/negative.txt"; then
  echo 'chart-combinations: persistent spool on Deployment was accepted' >&2; exit 1
fi
grep -q 'persistent session spool requires StatefulSet' "$report_dir/negative.txt"
if helm template lumo "$chart" "${cluster[@]}" -f "$chart/values.production.yaml" > /dev/null 2>"$report_dir/negative.txt"; then
  echo 'chart-combinations: incomplete production profile was accepted' >&2; exit 1
fi
if helm template lumo "$chart" "${cluster[@]}" -f "$chart/values.production.yaml" -f "$script_dir/tests/fixtures/production-values.yaml" --set redis.address=redis:6379 > /dev/null 2>"$report_dir/negative.txt"; then
  echo 'chart-combinations: production development Redis endpoint was accepted' >&2; exit 1
fi
grep -q 'production dependency redis requires an explicit external endpoint' "$report_dir/negative.txt"
echo 'chart-combinations: feature combinations and negative cases passed'
