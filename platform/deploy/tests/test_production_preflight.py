import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'production-preflight.py'
SPEC = importlib.util.spec_from_file_location('production_preflight', SCRIPT)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)
EVIDENCE_SPEC = importlib.util.spec_from_file_location('preflight_evidence_fixture', SCRIPT.with_name('production-evidence.py'))
evidence_gate = importlib.util.module_from_spec(EVIDENCE_SPEC)
EVIDENCE_SPEC.loader.exec_module(evidence_gate)


class PreflightIdentityTests(unittest.TestCase):
    def setUp(self):
        self.policy = dict(schema_version='lumo-production-evidence-policy/v1',
                           environment_id='prod', cluster_uid='d916b635-d6be-40d8-bd7a-e00b53d4100b', namespace='lumo', release='lumo-1',
                           platform_commit='a' * 40, upstream_commit='b' * 40,
                           max_age_days=7, max_rpo_ms=1000, max_rto_ms=10000,
                           require_idp=True, require_kms=True)

    def test_target_and_both_actual_checkout_commits_must_match(self):
        preflight.verify_target_identity(self.policy, 'lumo', 'lumo-1', 'a' * 40 + '\n', 'b' * 40 + '\n')
        for args in (('other', 'lumo-1', 'a' * 40, 'b' * 40),
                     ('lumo', 'other', 'a' * 40, 'b' * 40),
                     ('lumo', 'lumo-1', 'c' * 40, 'b' * 40),
                     ('lumo', 'lumo-1', 'a' * 40, 'c' * 40)):
            with self.assertRaisesRegex(RuntimeError, 'identity'):
                preflight.verify_target_identity(self.policy, *args)

    def test_mismatch_dirty_source_and_missing_evidence_fail_before_cluster_access(self):
        with tempfile.TemporaryDirectory(prefix='lumo-preflight-') as temporary:
            root = Path(temporary)
            policy = root / 'policy.json'; policy.write_text(json.dumps(self.policy))
            observations = root / 'observations.json'
            observations.write_text(json.dumps({**{k: self.policy[k] for k in ('environment_id', 'cluster_uid', 'namespace', 'release', 'platform_commit', 'upstream_commit')},
                                               'schema_version': 'lumo-production-observations/v1', 'hosts': [], 'checks': []}))
            argv = [str(SCRIPT), 'lumo', 'lumo-1', 'values.yaml', '--evidence-policy', str(policy),
                    '--evidence', str(observations), '--evidence-root', str(root)]
            for outputs, message in ((['c' * 40, 'b' * 40], 'identity'),
                                     (['a' * 40, 'b' * 40, ' M platform/source.ts'], 'clean'),
                                     (['a' * 40, 'b' * 40, '', ''], 'incomplete')):
                with patch('sys.argv', argv), patch.object(preflight, 'run', side_effect=outputs) as command:
                    with self.assertRaisesRegex(RuntimeError, message):
                        preflight.main()
                    self.assertTrue(all(call.args[0] == 'git' for call in command.call_args_list))

    def valid_bundle(self):
        from datetime import datetime, timezone
        directory = tempfile.TemporaryDirectory(prefix='lumo-preflight-identity-')
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        policy = root / 'policy.json'; policy.write_text(json.dumps(self.policy))
        observation = {key: self.policy[key] for key in ('environment_id', 'cluster_uid', 'namespace', 'release', 'platform_commit', 'upstream_commit')}
        observation.update(schema_version='lumo-production-observations/v1',
                           hosts=[dict(host_id='a', failure_domain='rack-a', volume_id='disk-a'),
                                  dict(host_id='b', failure_domain='rack-b', volume_id='disk-b')], checks=[])
        timestamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        source = root / 'receipt.json'; source.write_text('{"fixture_only":true}')
        for scenario, facts in evidence_gate.SCENARIOS.items():
            observed = dict(facts)
            if scenario == 'pitr_restore':
                observed.update(rpo_ms=100, rto_ms=1000)
            observation['checks'].append(dict(scenario=scenario, status='passed', started_at=timestamp,
                                               finished_at=timestamp, host_ids=['a', 'b'], observed=observed,
                                               evidence=[dict(path=source.name, sha256=hashlib.sha256(source.read_bytes()).hexdigest())]))
        observations = root / 'observations.json'; observations.write_text(json.dumps(observation))
        return [str(SCRIPT), 'lumo', 'lumo-1', 'values.yaml', '--evidence-policy', str(policy),
                '--evidence', str(observations), '--evidence-root', str(root)]

    def fake_deployment(self, cluster, context='reviewed-context\n'):
        state = {'current_context': context.rstrip('\r\n')}
        def command(*args, **kwargs):
            if args[0] == 'git':
                if args[-2:] == ('rev-parse', 'HEAD'):
                    return ('b' if Path(args[2]).name == 'deepseek-harness' else 'a') * 40 + '\n'
                return ''
            if args == ('kubectl', 'config', 'current-context'):
                state['current_context'] = 'other-cluster-after-capture'
                return context
            if args[0] == 'kubectl':
                # A drift in current-context would select a different cluster if
                # any API call omitted the captured explicit context.
                self.assertEqual(args[1:3], ('--context', context.rstrip('\r\n')))
                self.assertNotEqual(args[2], state['current_context'])
                if args[3:] == ('get', 'namespace', 'kube-system', '-o', 'json'):
                    return json.dumps(cluster)
                if 'secret' in args:
                    return json.dumps({'data': {'TOKEN': base64.b64encode(b'production-unique-token').decode()}})
                if 'apply' in args:
                    self.assertIn('--dry-run=server', args)
                    self.assertIn('secretKeyRef', kwargs['input'])
                    return ''
            if args[0] == 'helm':
                return json.dumps({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'fixture'},
                                   'spec': {'containers': [{'name': 'fixture', 'env': [{'name': 'TOKEN', 'valueFrom': {
                                       'secretKeyRef': {'name': 'production-auth', 'key': 'TOKEN'}}}]}]}})
            raise AssertionError('unexpected command: ' + repr(args))
        return command

    def test_cluster_uid_mismatch_missing_or_invalid_blocks_secret_and_dry_run(self):
        argv = self.valid_bundle()
        for cluster in ({'metadata': {'uid': 'different-cluster'}}, {'metadata': {}}, {},
                        {'metadata': {'uid': ''}}, {'metadata': {'uid': 'x' * 129}},
                        {'metadata': None}, []):
            with self.subTest(cluster=cluster), patch('sys.argv', argv), \
                    patch.object(preflight, 'run', side_effect=self.fake_deployment(cluster)) as command:
                with self.assertRaisesRegex(RuntimeError, 'cluster UID'):
                    preflight.main()
                calls = [call.args for call in command.call_args_list]
                self.assertTrue(any('kube-system' in args for args in calls))
                self.assertFalse(any('secret' in args or 'apply' in args or args[0] == 'helm' for args in calls))

    def test_every_cluster_api_call_uses_one_captured_context_even_after_default_changes(self):
        argv = self.valid_bundle()
        cluster = {'metadata': {'uid': self.policy['cluster_uid']}}
        with patch('sys.argv', argv), patch.object(preflight, 'run', side_effect=self.fake_deployment(cluster)) as command:
            preflight.main()
        calls = [call.args for call in command.call_args_list]
        self.assertEqual(calls.count(('kubectl', 'config', 'current-context')), 1)
        api_calls = [args for args in calls if args[0] == 'kubectl' and args[1] != 'config']
        self.assertEqual(len(api_calls), 3)
        self.assertTrue(all(args[1:3] == ('--context', 'reviewed-context') for args in api_calls))
        self.assertIn('kube-system', api_calls[0])
        self.assertIn('secret', api_calls[1])
        self.assertIn('apply', api_calls[2])

    def test_missing_or_invalid_current_context_blocks_all_cluster_api_access(self):
        argv = self.valid_bundle()
        for context in ('', '\n', '   \n', 'context\nother', 'a' * 1025):
            with self.subTest(context=repr(context)), patch('sys.argv', argv), \
                    patch.object(preflight, 'run', side_effect=self.fake_deployment({}, context)) as command:
                with self.assertRaisesRegex(RuntimeError, 'current-context'):
                    preflight.main()
                self.assertFalse(any(call.args[0] == 'kubectl' and call.args[1] != 'config'
                                     for call in command.call_args_list))

    def test_secret_and_tls_gate_remains_enabled_under_python_optimization(self):
        code = '''import importlib.util, sys
spec = importlib.util.spec_from_file_location('gate', sys.argv[1])
gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
gate.verify_secret('fixture', {'required'}, {})
'''
        result = subprocess.run([sys.executable, '-O', '-c', code, str(SCRIPT)], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('required keys are absent', result.stderr)
        for dsn in ('postgres://prod:unique@database.example/prod?sslmode=require',
                    'postgres://prod:lumo@database.example/prod?sslmode=verify-full',
                    'postgres://prod:%6cumo@database.example/prod?sslmode=verify-full',
                    'postgres://prod:unique@[::1]/prod?sslmode=verify-full',
                    'postgres://prod:unique@database.example/prod?sslmode=verify-full&sslmode=disable'):
            with self.assertRaises(RuntimeError):
                preflight.verify_secret('fixture', {'LUMO_PG_DSN'}, {'LUMO_PG_DSN': base64.b64encode(dsn.encode()).decode()})
        preflight.verify_secret('fixture', {'LUMO_PG_DSN'}, {'LUMO_PG_DSN': base64.b64encode(b'postgres://prod:unique@database.example/prod?sslmode=verify-full').decode()})


if __name__ == '__main__':
    unittest.main()
