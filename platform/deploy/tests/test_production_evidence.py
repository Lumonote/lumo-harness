import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'production-evidence.py'
SPEC = importlib.util.spec_from_file_location('production_evidence', SCRIPT)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='lumo-evidence-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.now = datetime(2026, 11, 9, 1, tzinfo=timezone.utc)
        self.policy = dict(schema_version='lumo-production-evidence-policy/v1', environment_id='staging-cn', cluster_uid='d916b635-d6be-40d8-bd7a-e00b53d4100b', namespace='lumo', release='lumo-1', platform_commit='a' * 40, upstream_commit='b' * 40, max_age_days=7, max_rpo_ms=1000, max_rto_ms=10000, require_idp=True, require_kms=True)
        self.data = {k: self.policy[k] for k in ('environment_id', 'cluster_uid', 'namespace', 'release', 'platform_commit', 'upstream_commit')}
        self.data.update(schema_version='lumo-production-observations/v1', hosts=[{'host_id': 'a', 'failure_domain': 'rack-a', 'volume_id': 'disk-a'}, {'host_id': 'b', 'failure_domain': 'rack-b', 'volume_id': 'disk-b'}], checks=[])
        for name, assertions in gate.SCENARIOS.items():
            source = self.root / (name + '.json')
            source.write_text(json.dumps({'fixture_only': name}))
            observed = copy.deepcopy(assertions)
            if name == 'pitr_restore':
                observed.update(rpo_ms=100, rto_ms=1000)
            self.data['checks'].append(dict(scenario=name, status='passed', started_at='2026-11-09T00:00:00.000Z', finished_at='2026-11-09T00:01:00.000Z', host_ids=['a', 'b'], observed=observed, evidence=[{'path': source.name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}]))

    def evaluate(self, data=None):
        return gate.evaluate(self.policy, data or self.data, self.root, self.now)

    def test_complete_fixture_validates_integrity_without_attesting_provenance(self):
        result = self.evaluate()
        self.assertTrue(result['passed'])
        self.assertEqual(result['evidence_status'], 'operator-observations-not-independently-attested')
        self.assertEqual(len(result['verified_files']), 10)

    def test_missing_blocked_failed_old_future_or_wrong_target_never_pass(self):
        for mutate in (
            lambda v: v['checks'].pop(),
            lambda v: v.update(namespace='other'),
            lambda v: v.update(cluster_uid='e916b635-d6be-40d8-bd7a-e00b53d4100b'),
            lambda v: v.update(upstream_commit='c' * 40),
            lambda v: v['checks'][0].update(status='blocked'),
            lambda v: v['checks'][0].update(started_at='2026-10-01T00:00:00.000Z'),
            lambda v: v['checks'][0].update(finished_at='2026-12-01T00:00:00.000Z'),
            lambda v: v['checks'][0]['observed'].update(stale_writer_rejected=False),
        ):
            data = copy.deepcopy(self.data); mutate(data)
            self.assertFalse(self.evaluate(data)['passed'])

    def test_cluster_uid_is_required_bounded_public_identity_on_both_inputs(self):
        policy = copy.deepcopy(self.policy); policy.pop('cluster_uid')
        with self.assertRaisesRegex(ValueError, 'missing_or_unknown_field'):
            gate.parse_policy(policy)
        data = copy.deepcopy(self.data); data.pop('cluster_uid')
        with self.assertRaisesRegex(ValueError, 'missing_or_unknown_field'):
            self.evaluate(data)
        for uid in ('', ' ', 'cluster uid', 'uid\n', 'uid\x00', 'https://cluster.example', '../uid', 'a' * 129, None, True, 123):
            with self.subTest(uid=repr(uid)):
                policy = {**self.policy, 'cluster_uid': uid}
                with self.assertRaisesRegex(ValueError, 'invalid_cluster_uid'):
                    gate.parse_policy(policy)
                data = {**self.data, 'cluster_uid': uid}
                with self.assertRaisesRegex(ValueError, 'invalid_cluster_uid'):
                    self.evaluate(data)

    def test_independent_hosts_volumes_and_measured_recovery_limits_are_required(self):
        for mutate in (
            lambda v: v['hosts'][1].update(failure_domain='rack-a'),
            lambda v: v['hosts'][1].update(volume_id='disk-a'),
            lambda v: v['checks'][0].update(host_ids=['a']),
            lambda v: v['checks'][4]['observed'].update(rpo_ms=1001),
            lambda v: v['checks'][4]['observed'].update(rto_ms=10001),
            lambda v: v['checks'][4]['observed'].update(rpo_ms=True),
        ):
            data = copy.deepcopy(self.data); mutate(data)
            self.assertFalse(self.evaluate(data)['passed'])

    def test_evidence_must_exist_and_match_bytes(self):
        source = self.root / self.data['checks'][0]['evidence'][0]['path']
        source.write_text('changed')
        self.assertIn('evidence_digest_mismatch:lease_fencing', self.evaluate()['failures'])
        source.unlink()
        self.assertIn('missing_or_oversized_evidence:lease_fencing', self.evaluate()['failures'])

    def test_each_cross_host_scenario_needs_independent_failure_domains(self):
        self.data['hosts'].append({'host_id': 'c', 'failure_domain': 'rack-a', 'volume_id': 'disk-c'})
        self.data['checks'][0]['host_ids'] = ['a', 'c']
        self.assertIn('cross_host_evidence_required:lease_fencing', self.evaluate()['failures'])
        self.data['checks'][0]['host_ids'] = ['c', 'b']
        self.assertTrue(self.evaluate()['passed'])

    def test_paths_symlinks_duplicate_checks_and_unknown_fields_are_rejected(self):
        for path in ('../secret', '/etc/passwd', 'a/../secret', 'a\\secret'):
            data = copy.deepcopy(self.data); data['checks'][0]['evidence'][0]['path'] = path
            with self.assertRaises(ValueError): self.evaluate(data)
        link = self.root / 'link'; link.symlink_to(self.root / 'lease_fencing.json')
        data = copy.deepcopy(self.data); data['checks'][0]['evidence'][0]['path'] = 'link'
        with self.assertRaisesRegex(ValueError, 'symlink'): self.evaluate(data)
        data = copy.deepcopy(self.data); data['checks'][-1] = data['checks'][0]
        with self.assertRaisesRegex(ValueError, 'duplicate'): self.evaluate(data)
        self.policy['unexpected'] = True
        with self.assertRaises(ValueError): self.evaluate()

    def test_cli_fails_incomplete_evidence_and_duplicate_json_keys(self):
        policy = self.root / 'policy.json'; policy.write_text(json.dumps(self.policy))
        data = self.root / 'observations.json'; data.write_text(json.dumps({**self.data, 'checks': []}))
        result = subprocess.run([sys.executable, str(SCRIPT), '--policy', str(policy), '--observations', str(data), '--root', str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(json.loads(result.stdout)['passed'])
        data.write_text('{"same":1,"same":2}')
        with self.assertRaisesRegex(ValueError, 'duplicate_json'): gate.load(data)


if __name__ == '__main__':
    unittest.main()
