#!/usr/bin/env python3
"""Read-only production gate: real Secret keys, no dev credentials, API validation.

Usage: production-preflight.py NAMESPACE RELEASE OPERATOR_VALUES.yaml
       --evidence-policy POLICY --evidence OBSERVATIONS --evidence-root BUNDLE
The operator file must complete values.production.yaml. No Secret bytes or
rendered Secret content is printed or persisted.
"""
import base64
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import yaml


def run(*command, input=None):
    result = subprocess.run(command, input=input, text=True, capture_output=True)
    if result.returncode:
        # kubectl/Helm diagnostics can contain input; keep Secret bytes out of
        # the report, identify the failed command rather than echoing stderr.
        raise RuntimeError(f'{command[0]} {command[1]} failed (exit {result.returncode}); inspect locally')
    return result.stdout


def verify_target_identity(policy, namespace, release, platform_commit, upstream_commit):
    expected = dict(namespace=namespace, release=release,
                    platform_commit=platform_commit.strip(), upstream_commit=upstream_commit.strip())
    if any(policy[key] != value for key, value in expected.items()):
        raise RuntimeError('evidence policy identity differs from deployment checkout/target')


def require(condition, message):
    # Production checks must remain active under python -O/PYTHONOPTIMIZE.
    if not condition:
        raise RuntimeError(message)


def verify_secret(name, keys, data):
    require(isinstance(data, dict) and keys <= set(data), f'Secret {name}: required keys are absent')
    require(bool(data), f'Secret {name}: empty data')
    known = {'lumo', 'lumo-admin-123', 'lumo-minio-123', 'dev-root-token', 'dev-subagent-token', 'replace-me', 'dev-terminal-signing-secret'}
    for key, value in data.items():
        decoded = base64.b64decode(value, validate=True).decode('utf-8', errors='replace')
        require(bool(decoded) and decoded not in known, f'Secret {name}/{key}: empty/development value')
        if key in ('LUMO_PG_DSN', 'REGISTRY_PG_DSN'):
            from urllib.parse import urlparse, parse_qs, unquote
            dsn = urlparse(decoded)
            require(dsn.scheme in ('postgres', 'postgresql') and bool(dsn.hostname)
                    and dsn.hostname not in ('postgres', 'localhost', '127.0.0.1', '::1'), f'{name}/{key}: development/invalid DB host')
            require(dsn.password is None or bool(dsn.password) and unquote(dsn.password) not in known,
                    f'{name}/{key}: empty/development DB password')
            require(parse_qs(dsn.query).get('sslmode', ['']) == ['verify-full']
                    or parse_qs(dsn.query).get('sslmode', ['']) == ['verify-ca'], f'{name}/{key}: verified database TLS required')
        if key == 'registry-trust.json':
            require(bool(json.loads(decoded).get('publishers')), f'Secret {name}: registry trust has no publishers')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('namespace'); parser.add_argument('release'); parser.add_argument('values')
    parser.add_argument('--evidence-policy', required=True)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--evidence-root', required=True)
    args = parser.parse_args()
    namespace, release, values = args.namespace, args.release, args.values
    spec = importlib.util.spec_from_file_location('production_evidence', Path(__file__).with_name('production-evidence.py'))
    evidence = importlib.util.module_from_spec(spec); spec.loader.exec_module(evidence)
    policy = evidence.parse_policy(evidence.load(args.evidence_policy))
    repository = Path(__file__).resolve().parents[2]
    verify_target_identity(policy, namespace, release,
                           run('git', '-C', str(repository), 'rev-parse', 'HEAD'),
                           run('git', '-C', str(repository / 'deepseek-harness'), 'rev-parse', 'HEAD'))
    for checkout in (repository, repository / 'deepseek-harness'):
        if run('git', '-C', str(checkout), 'status', '--porcelain', '--untracked-files=no').strip():
            raise RuntimeError('production preflight requires clean deployment checkouts')
    report = evidence.evaluate(policy, evidence.load(args.evidence), args.evidence_root)
    if not report['passed']:
        raise RuntimeError('production evidence is incomplete, stale or failed; run production-evidence.py for codes')
    print('production-preflight: operator evidence integrity verified; observations are not independently attested')
    # Capture once: a later change of kubeconfig current-context must not move
    # Secret reads or the server dry-run to a different deployment target.
    context = run('kubectl', 'config', 'current-context').rstrip('\r\n')
    require(bool(context) and len(context) <= 1024 and context == context.strip()
            and not any(ord(c) < 32 or ord(c) == 127 for c in context), 'invalid kubectl current-context')
    kubectl = ('kubectl', '--context', context)
    cluster = json.loads(run(*kubectl, 'get', 'namespace', 'kube-system', '-o', 'json'))
    metadata = cluster.get('metadata') if isinstance(cluster, dict) else None
    uid = metadata.get('uid') if isinstance(metadata, dict) else None
    require(evidence.cluster_uid(uid) and uid == policy['cluster_uid'],
            'target cluster UID differs from evidence policy or is absent/invalid')
    print('production-preflight: target cluster UID verified using pinned kubectl context')
    chart = Path(__file__).parent / 'helm/lumo-platform'
    text = run('helm', 'template', release, str(chart), '--namespace', namespace,
               '-f', str(chart / 'values.cluster.yaml'), '-f', str(chart / 'values.production.yaml'), '-f', values)
    docs = [doc for doc in yaml.safe_load_all(text) if doc]
    references = {}
    def walk(value):
        if isinstance(value, dict):
            if 'secretKeyRef' in value:
                ref = value['secretKeyRef']; references.setdefault(ref['name'], set()).add(ref['key'])
            if 'secretRef' in value:
                references.setdefault(value['secretRef']['name'], set())
            if 'secretName' in value:
                keys = {item['key'] for item in value.get('items', [])}
                references.setdefault(value['secretName'], set()).update(keys)
            for child in value.values(): walk(child)
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(docs)
    require(bool(references), 'no Secret references were rendered')
    for name, keys in references.items():
        secret = json.loads(run(*kubectl, '-n', namespace, 'get', 'secret', name, '-o', 'json'))
        data = secret.get('data', {})
        verify_secret(name, keys, data)
        print(f'production-preflight: Secret {name}: present, required keys verified')
    run(*kubectl, '-n', namespace, 'apply', '--dry-run=server', '-f', '-', input=text)
    print(f'production-preflight: {len(docs)} manifests validated by target API; {len(references)} Secrets verified')
    print('HA, restore and durability observations require operator review; this check does not independently certify HA.')


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, RuntimeError, ValueError, KeyError, TypeError, OSError) as error:
        print(f'production-preflight: FAIL: {error}', file=sys.stderr)
        sys.exit(1)
