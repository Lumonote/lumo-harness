#!/usr/bin/env python3
"""Validate operator-owned production observations and their local evidence.

Read-only: never connects to a cluster, executes a fault, restores a DB or
destroys a key. Passing verifies completeness/integrity, not provenance.
"""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import re
import sys

SCENARIOS = {
    'lease_fencing': {'stale_writer_rejected': True, 'duplicate_execution': False},
    'session_migration': {'history_equal': True, 'attachments_equal': True, 'old_owner_rejected': True, 'input_replayed': False},
    'network_partition': {'stale_writer_rejected': True, 'split_brain': False, 'recovered': True},
    'database_failover': {'acknowledged_writes_preserved': True, 'reconnected': True},
    'pitr_restore': {'snapshot_verified': True, 'independent_target': True},
    'application_recovery': {'login': True, 'conversation': True, 'attachments': True, 'permissions': True, 'metering': True},
    'certificate_rotation': {'new_certificate_accepted': True, 'retired_certificate_rejected': True},
    'capacity_slo': {'error_budget_met': True, 'latency_slo_met': True, 'capacity_met': True},
    'oidc_login': {'login': True, 'revocation': True, 'key_rotation': True, 'replica_consistency': True},
    'kms_key_destroy': {'two_person_approval': True, 'exact_target': True, 'signed_receipt_verified': True, 'readback_absent': True},
}
POLICY_KEYS = {'schema_version', 'environment_id', 'cluster_uid', 'namespace', 'release', 'platform_commit', 'upstream_commit', 'max_age_days', 'max_rpo_ms', 'max_rto_ms', 'require_idp', 'require_kms'}
SHA = re.compile(r'^[a-f0-9]{64}$')
COMMIT = re.compile(r'^[a-f0-9]{40}$')
CLUSTER_UID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def load(path):
    value = Path(path)
    if value.is_symlink() or not value.is_file() or value.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('input_must_be_bounded_regular_file')
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = item
        return result
    return json.loads(value.read_text(encoding='utf-8'), object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('missing_or_unknown_field')


def text(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and value == value.strip() and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def cluster_uid(value):
    # Public kube-system Namespace metadata.uid, never a credential or URL.
    return isinstance(value, str) and CLUSTER_UID.fullmatch(value) is not None


def integer(value, minimum=0, maximum=2**53 - 1):
    return type(value) is int and minimum <= value <= maximum


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value):
        raise ValueError('invalid_utc_timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def parse_policy(value):
    exact(value, POLICY_KEYS)
    if value['schema_version'] != 'lumo-production-evidence-policy/v1' or not all(text(value[k]) for k in ('environment_id', 'namespace', 'release')):
        raise ValueError('invalid_policy_identity')
    if not cluster_uid(value['cluster_uid']):
        raise ValueError('invalid_cluster_uid')
    if not all(isinstance(value[k], str) and COMMIT.fullmatch(value[k]) for k in ('platform_commit', 'upstream_commit')):
        raise ValueError('policy_requires_exact_commits')
    if not integer(value['max_age_days'], 1, 366) or not all(integer(value[k]) for k in ('max_rpo_ms', 'max_rto_ms')) or not all(type(value[k]) is bool for k in ('require_idp', 'require_kms')):
        raise ValueError('invalid_policy_limits')
    return value


def evaluate(policy, observations, root, now=None):
    policy = parse_policy(policy)
    now = now or datetime.now(timezone.utc)
    root = Path(root).resolve(strict=True)
    exact(observations, {'schema_version', 'environment_id', 'cluster_uid', 'namespace', 'release', 'platform_commit', 'upstream_commit', 'hosts', 'checks'})
    if observations['schema_version'] != 'lumo-production-observations/v1':
        raise ValueError('unsupported_observations')
    if not cluster_uid(observations['cluster_uid']):
        raise ValueError('invalid_cluster_uid')
    failures = []
    def require(ok, code):
        if not ok:
            failures.append(code)
    for key in ('environment_id', 'cluster_uid', 'namespace', 'release', 'platform_commit', 'upstream_commit'):
        require(observations[key] == policy[key], 'identity_mismatch:' + key)
    hosts = observations['hosts']
    if not isinstance(hosts, list) or len(hosts) > 64:
        raise ValueError('invalid_hosts')
    for host in hosts:
        exact(host, {'host_id', 'failure_domain', 'volume_id'})
        if not all(text(v) for v in host.values()):
            raise ValueError('invalid_host_identity')
    require(len(hosts) >= 2 and len({h['host_id'] for h in hosts}) == len(hosts) and len({h['failure_domain'] for h in hosts}) >= 2 and len({h['volume_id'] for h in hosts}) == len(hosts), 'independent_hosts_and_volumes_required')
    checks = observations['checks']
    if not isinstance(checks, list) or len(checks) > len(SCENARIOS):
        raise ValueError('invalid_checks')
    required = set(SCENARIOS) - ({'oidc_login'} if not policy['require_idp'] else set()) - ({'kms_key_destroy'} if not policy['require_kms'] else set())
    seen = set()
    files = []
    total_evidence_bytes = 0
    for check in checks:
        exact(check, {'scenario', 'status', 'started_at', 'finished_at', 'host_ids', 'observed', 'evidence'})
        scenario = check['scenario']
        if not isinstance(scenario, str) or scenario not in SCENARIOS or scenario in seen:
            raise ValueError('duplicate_or_unknown_scenario')
        seen.add(scenario)
        require(check['status'] == 'passed', 'scenario_not_passed:' + scenario)
        try:
            start, end = instant(check['started_at']), instant(check['finished_at'])
            require(start <= end <= now + timedelta(minutes=1) and start >= now - timedelta(days=policy['max_age_days']), 'expired_or_invalid_clock:' + scenario)
        except (ValueError, TypeError):
            require(False, 'invalid_clock:' + scenario)
        ids = check['host_ids']
        if not isinstance(ids, list) or not ids or not all(text(i) for i in ids) or len(ids) != len(set(ids)) or any(i not in {h['host_id'] for h in hosts} for i in ids):
            raise ValueError('invalid_scenario_hosts')
        if scenario in ('lease_fencing', 'session_migration', 'network_partition', 'database_failover', 'pitr_restore'):
            selected = [host for host in hosts if host['host_id'] in ids]
            require(len(ids) >= 2 and len({host['failure_domain'] for host in selected}) >= 2
                    and len({host['volume_id'] for host in selected}) == len(selected),
                    'cross_host_evidence_required:' + scenario)
        fields = set(SCENARIOS[scenario]) | ({'rpo_ms', 'rto_ms'} if scenario == 'pitr_restore' else set())
        exact(check['observed'], fields)
        for field, expected in SCENARIOS[scenario].items():
            require(check['observed'][field] is expected, 'invariant_failed:' + scenario + ':' + field)
        if scenario == 'pitr_restore':
            for name in ('rpo_ms', 'rto_ms'):
                measured = check['observed'][name]
                require(integer(measured) and measured <= policy['max_' + name], 'recovery_limit_failed:' + name)
        evidence = check['evidence']
        if not isinstance(evidence, list) or not 1 <= len(evidence) <= 32:
            raise ValueError('bounded_evidence_files_required')
        scenario_paths = set()
        for entry in evidence:
            exact(entry, {'path', 'sha256'})
            path = entry['path']
            if not isinstance(path, str) or not path or len(path) > 1024 or '\\' in path or Path(path).is_absolute() or any(part in ('.', '..') for part in path.split('/')) or path in scenario_paths or not isinstance(entry['sha256'], str) or not SHA.fullmatch(entry['sha256']):
                raise ValueError('invalid_evidence_path_or_digest')
            scenario_paths.add(path)
            source = root / path
            # No symlink component may redirect the evidence to a credential or
            # outside the operator-owned bundle. Never output file contents.
            current = root
            for part in Path(path).parts:
                current /= part
                if current.is_symlink():
                    raise ValueError('evidence_symlink_forbidden')
            if not source.is_file() or source.stat().st_size > 16 * 1024 * 1024 or source.stat().st_size == 0:
                require(False, 'missing_or_oversized_evidence:' + scenario)
                continue
            # Keep the complete gate bounded even if the same evidence file
            # is intentionally referenced by many scenarios.
            total_evidence_bytes += source.stat().st_size
            if total_evidence_bytes > 64 * 1024 * 1024:
                raise ValueError('evidence_bundle_exceeds_64_mib')
            with source.open('rb') as stream:
                raw = stream.read(16 * 1024 * 1024 + 1)
            if not raw or len(raw) > 16 * 1024 * 1024:
                raise ValueError('evidence_file_changed_or_exceeds_limit')
            actual = hashlib.sha256(raw).hexdigest()
            require(actual == entry['sha256'], 'evidence_digest_mismatch:' + scenario)
            files.append({'scenario': scenario, 'path': path, 'sha256': actual})
    failures.extend('missing_scenario:' + name for name in sorted(required - seen))
    return {'schema_version': 'lumo-production-evidence-report/v1', 'passed': not failures,
            'evidence_status': 'operator-observations-not-independently-attested',
            'policy_digest': digest(policy), 'observations_digest': digest(observations),
            'checked_at': now.isoformat(), 'verified_files': files, 'failures': failures}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', required=True)
    parser.add_argument('--observations', required=True)
    parser.add_argument('--root', required=True, help='Local evidence bundle root; no remote URLs')
    args = parser.parse_args(argv)
    try:
        result = evaluate(load(args.policy), load(args.observations), args.root)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['passed'] else 2
    except (ValueError, OSError, TypeError) as error:
        print(json.dumps({'passed': False, 'error': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
