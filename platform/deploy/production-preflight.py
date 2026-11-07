#!/usr/bin/env python3
"""Read-only production gate: real Secret keys, no dev credentials, API validation.

Usage: production-preflight.py NAMESPACE RELEASE OPERATOR_VALUES.yaml
The operator file must complete values.production.yaml. No Secret bytes or
rendered Secret content is printed or persisted.
"""
import base64
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


def main():
    if len(sys.argv) != 4:
        raise RuntimeError('usage: production-preflight.py NAMESPACE RELEASE OPERATOR_VALUES.yaml')
    namespace, release, values = sys.argv[1:]
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
    assert references, 'no Secret references were rendered'
    known = {'lumo', 'lumo-admin-123', 'lumo-minio-123', 'dev-root-token', 'dev-subagent-token', 'replace-me', 'dev-terminal-signing-secret'}
    for name, keys in references.items():
        secret = json.loads(run('kubectl', '-n', namespace, 'get', 'secret', name, '-o', 'json'))
        data = secret.get('data', {})
        assert keys <= set(data), f'Secret {name}: required keys are absent'
        assert data, f'Secret {name}: empty data'
        for key, value in data.items():
            decoded = base64.b64decode(value).decode('utf-8', errors='replace')
            assert decoded and decoded not in known, f'Secret {name}/{key}: empty/development value'
            if key in ('LUMO_PG_DSN', 'REGISTRY_PG_DSN'):
                from urllib.parse import urlparse
                dsn = urlparse(decoded)
                assert dsn.hostname not in ('postgres', 'localhost', '127.0.0.1'), f'{name}/{key}: development DB host'
                assert dsn.password not in known, f'{name}/{key}: development DB password'
                from urllib.parse import parse_qs
                assert parse_qs(dsn.query).get('sslmode', [''])[0] in ('verify-full', 'verify-ca'), f'{name}/{key}: verified database TLS required'
            if key == 'registry-trust.json':
                assert json.loads(decoded).get('publishers'), f'Secret {name}: registry trust has no publishers'
        print(f'production-preflight: Secret {name}: present, required keys verified')
    run('kubectl', '-n', namespace, 'apply', '--dry-run=server', '-f', '-', input=text)
    print(f'production-preflight: {len(docs)} manifests validated by target API; {len(references)} Secrets verified')
    print('HA, restore and durability evidence references require operator review; this check does not certify HA.')


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, RuntimeError, ValueError, KeyError) as error:
        print(f'production-preflight: FAIL: {error}', file=sys.stderr)
        sys.exit(1)
