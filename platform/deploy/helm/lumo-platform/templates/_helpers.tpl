{{- define "lumo-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "lumo-platform.labels" -}}
app.kubernetes.io/name: {{ include "lumo-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- /*
Return the base64 value to store under a generated Secret key, reusing whatever
is already live in the cluster.

Why the lookup is mandatory rather than a nicety: `randAlphaNum` alone is
evaluated on every render, so a plain `helm upgrade` would mint a new bearer
token and every workload that already holds the old one would start failing
authentication. Reading the existing object first turns generation into
"mint once, then never touch again".

Caveat that must stay documented: `lookup` needs a live API server, so under
`helm template` / `--dry-run` it always returns empty and a fresh value is
minted on every render. That is why this path is opt-in (secrets.create) and
why `helm template` output for it must never be committed or diffed as if it
were stable.

Arguments (dict): namespace, name, key, length.
*/ -}}
{{- define "lumo-platform.managedSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .namespace .name -}}
{{- if and $existing (hasKey ($existing.data | default dict) .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- randAlphaNum (int .length) | b64enc -}}
{{- end -}}
{{- end }}
