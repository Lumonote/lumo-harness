"""Unit checks for the opt-in drill. No test invokes Docker or PostgreSQL."""
from contextlib import contextmanager, redirect_stdout, redirect_stderr
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'recovery-drill.py'
SPEC = importlib.util.spec_from_file_location('recovery_drill', SCRIPT)
drill = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(drill)


def data():
    body = b'controlled-content'
    return {'markers': [['baseline', '2026-11-07T00:00:00+00:00']],
            'documents': [['d1', 'baseline', body.hex(), hashlib.sha256(body).hexdigest()]],
            'links': [['l1', 'd1']],
            'checks': {'foreign_keys': 2, 'orphan_documents': 0, 'orphan_links': 0, 'bad_content_sha': 0}}


def commits():
    return [{'marker': 'baseline', 'committed_at': '2026-11-07T00:00:00+00:00'},
            {'marker': 'post-snapshot', 'committed_at': '2026-11-07T00:00:01+00:00'},
            {'marker': 'post-fault-declared', 'committed_at': '2026-11-07T00:00:02+00:00'}]


class FakeDocker:
    """Models only current-run create/inspect/remove operations, never a daemon."""
    timeout = 1

    def __init__(self):
        self.calls = []
        self.volumes = {}
        self.containers = {}
        self.fail_create = False
        self.serial = 0

    @staticmethod
    def labels(args):
        return dict(args[i + 1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')

    def call(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ['image', 'inspect']:
            return ('sha256:' + 'a' * 64).encode()
        if args[:2] == ['volume', 'ls']:
            name = args[args.index('--filter') + 1].removeprefix('name=^').removesuffix('$')
            return name.encode() if name in self.volumes else b''
        if args[:2] == ['volume', 'create']:
            name = args[-1]
            self.volumes[name] = {'Name': name, 'Labels': self.labels(args)}
            if self.fail_create:
                raise drill.DrillError('simulated_create_timeout')
            return name.encode()
        if args[0] == 'create':
            name = args[args.index('--name') + 1]
            self.serial += 1
            identity = f'{self.serial:064x}'
            self.containers[identity] = {'Id': identity, 'Name': '/' + name, 'Config': {'Labels': {**self.labels(args), 'image-label': 'safe'}}}
            return identity.encode()
        if args[0] in ('start', 'kill'):
            return b''
        if args[0] == 'rm':
            del self.containers[args[-1]]
            return b''
        if args[:2] == ['volume', 'rm']:
            del self.volumes[args[-1]]
            return b''
        if args[0] == 'exec' and 'pg_dump' in args:
            kwargs['output'].write(b'fixture-custom-dump')
            return b''
        if args[0] == 'exec' and 'pg_restore' in args:
            return b''
        raise AssertionError('Unexpected fake command: ' + args[0])

    def json(self, args):
        self.calls.append((args, {}))
        source = self.containers if args[0] == 'container' else self.volumes
        return [copy.deepcopy(source[args[-1]])]


class ResourceSafetyTests(unittest.TestCase):
    def setUp(self):
        self.docker = FakeDocker()
        self.owner = drill.OwnedResources(self.docker)

    def test_cleanup_only_accepts_this_instances_successful_creates_and_original_ids(self):
        with self.assertRaisesRegex(drill.DrillError, 'not_created'):
            self.owner.verify({'kind': 'container', 'id': 'production', 'name': 'production', 'role': 'source'})
        self.assertEqual(self.owner.cleanup()['resources'], [])
        volume = self.owner.volume('source')
        source = self.owner.container('source', volume, '/private/tmp/secret-file')
        with self.assertRaisesRegex(drill.DrillError, 'not_created'):
            self.owner.verify(copy.deepcopy(source))
        self.owner.kill_source(source)
        cleanup = self.owner.cleanup()
        self.assertTrue(cleanup['complete'])
        self.assertEqual([r['kind'] for r in cleanup['resources']], ['container', 'volume'])
        removed = [args for args, _ in self.docker.calls if args[0] == 'rm' or args[:2] == ['volume', 'rm']]
        self.assertEqual(removed, [['rm', '--force', source['id']], ['volume', 'rm', volume['id']]])

    def test_no_network_ports_or_credential_values_enter_container_or_exec_arguments(self):
        volume = self.owner.volume('source')
        source = self.owner.container('source', volume, '/private/tmp/private-directory/password-file')
        args = next(args for args, _ in self.docker.calls if args[0] == 'create')
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertIn('--pull=never', args)
        self.assertFalse(any(arg in ('-p', '--publish', '--env-file') or arg.startswith('POSTGRES_PASSWORD=') for arg in args))
        harness = drill.RecoveryDrill(self.docker); harness.owned = self.owner
        command = harness.psql_args(source)
        self.assertIn('postgres', command)
        self.assertNotIn('PGPASSWORD', ' '.join(command))
        self.assertNotIn('/private/tmp/private-directory', ' '.join(command))

    def test_changed_ownership_is_retained_and_cleanup_continues_for_other_resources(self):
        a = self.owner.volume('source')
        b = self.owner.volume('target')
        self.docker.volumes[a['id']]['Labels'][drill.LABEL + '.run'] = 'somebody-else'
        cleanup = self.owner.cleanup()
        self.assertFalse(cleanup['complete'])
        self.assertEqual(cleanup['resources'][0]['status'], 'retained_or_unverified')
        self.assertEqual(cleanup['resources'][1]['status'], 'removed')
        self.assertIn(a['id'], self.docker.volumes)
        self.assertNotIn(b['id'], self.docker.volumes)

    def test_existing_volume_is_never_adopted_and_ambiguous_create_is_reported_without_deleting(self):
        name = self.owner.name('source', 'volume')
        self.docker.volumes[name] = {'Name': name, 'Labels': {}}
        with self.assertRaisesRegex(drill.DrillError, 'already_exists'):
            self.owner.volume('source')
        self.assertEqual(self.owner.resources, [])
        self.assertEqual(self.owner.unconfirmed, [])
        del self.docker.volumes[name]
        self.docker.fail_create = True
        with self.assertRaises(drill.DrillError):
            self.owner.volume('source')
        cleanup = self.owner.cleanup()
        self.assertFalse(cleanup['complete'])
        self.assertEqual(cleanup['unconfirmed_creates_retained'], [{'kind': 'volume', 'name': name}])
        self.assertIn(name, self.docker.volumes)

    def test_fault_injection_cannot_target_the_restore_container(self):
        volume = self.owner.volume('target')
        target = self.owner.container('target', volume, '/private/tmp/target-secret')
        with self.assertRaisesRegex(drill.DrillError, 'own_source'):
            self.owner.kill_source(target)
        self.assertFalse(any(args[0] == 'kill' for args, _ in self.docker.calls))


class MeasurementTests(unittest.TestCase):
    def test_rpo_uses_original_source_commit_times_and_reports_exact_missing_set(self):
        report = drill.analyze_recovery(data(), copy.deepcopy(data()), commits(), '2026-11-07T00:00:03+00:00')
        self.assertEqual(report['snapshot']['fingerprint_sha256'], report['recovered']['fingerprint_sha256'])
        self.assertEqual(report['rpo']['recoverable_point_age_at_cutoff_ms'], 3000)
        self.assertEqual(report['rpo']['acknowledged_data_loss_window_ms'], 2000)
        self.assertEqual(report['rpo']['missing_transaction_markers'], ['post-fault-declared', 'post-snapshot'])

    def test_content_sha_foreign_keys_snapshot_changes_and_clock_reversal_fail_closed(self):
        for modify in [
            lambda d: d['documents'][0].__setitem__(2, '00'),
            lambda d: d['documents'][0].__setitem__(1, 'absent'),
            lambda d: d['links'][0].__setitem__(1, 'absent'),
            lambda d: d['checks'].__setitem__('foreign_keys', 1),
            lambda d: d['markers'][0].__setitem__(1, '2026-11-07T00:00:01+00:00'),
        ]:
            altered = data(); modify(altered)
            with self.assertRaises(drill.DrillError):
                drill.analyze_recovery(data(), altered, commits(), '2026-11-07T00:00:03+00:00')
        for evidence in [[], commits()[1:], [commits()[0], commits()[0]]]:
            with self.assertRaises(drill.DrillError):
                drill.analyze_recovery(data(), data(), evidence, '2026-11-07T00:00:03+00:00')
        with self.assertRaisesRegex(drill.DrillError, 'clock_order'):
            drill.analyze_recovery(data(), data(), commits(), '2026-11-07T00:00:01+00:00')
        with self.assertRaises(drill.DrillError):
            drill.instant('2026-11-07T00:00:00')

    def test_microsecond_measurements_preserve_fractional_milliseconds(self):
        self.assertEqual(drill.milliseconds('2026-11-07T00:00:00.000999Z', '2026-11-07T00:00:00Z'), 0.999)


class WorkflowTests(unittest.TestCase):
    def test_default_check_and_dry_run_do_not_even_construct_the_docker_driver(self):
        for args in ([], ['--check'], ['--dry-run']):
            output = io.StringIO()
            with patch.object(drill, 'Docker') as docker, patch.object(subprocess, 'run') as run, patch.object(subprocess, 'Popen') as popen, redirect_stdout(output):
                self.assertEqual(drill.main(args), 0)
            docker.assert_not_called(); run.assert_not_called(); popen.assert_not_called()
            report = json.loads(output.getvalue())
            self.assertFalse(report['executed'])
            self.assertEqual(report['status'], 'dry-run')
            self.assertNotIn('measurement', report)

    def test_no_existing_target_or_unbounded_options_can_be_supplied(self):
        for args in [['--container', 'production'], ['--volume', 'production'], ['--image', 'arbitrary'], ['--rows', '0'], ['--rows', '1001'], ['--timeout', '601'], ['--execute', '--check']]:
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                drill.arguments(args)

    def test_docker_failure_never_reflects_output_credentials_or_argv(self):
        driver = drill.Docker()
        result = subprocess.CompletedProcess(['docker'], 1, b'secret stdout', b'password=private')
        with patch.object(subprocess, 'run', return_value=result) as run:
            with self.assertRaisesRegex(drill.DrillError, '^docker_command_failed$'):
                driver.call(['exec', 'own-container', 'psql'], input_bytes=b'not-printed')
        self.assertNotIn('shell', run.call_args.kwargs)
        with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('sensitive', 1)):
            with self.assertRaisesRegex(drill.DrillError, '^docker_command_unavailable_or_timed_out$'):
                driver.call(['inspect'])

    def test_workflow_binds_dump_snapshot_excludes_late_commits_and_restores_to_new_target(self):
        driver = FakeDocker()
        class FakeDrill(drill.RecoveryDrill):
            def ready(self, container):
                pass

            def sql(self, container, query):
                return b''

            def marker(self, container, marker, rows):
                self.markers.append(marker)

            @contextmanager
            def snapshot(self, source):
                yield {'snapshot_id': '00000003-0000001A-1', 'snapshot_export_observed_at': '2026-11-07T00:00:00.500Z', 'mvcc_snapshot': '10:10:', 'wal_lsn': '0/100', 'data': data()}

            def sql_json(self, container, query):
                if query == drill.DATA_SQL:
                    self.asserted_target = container['role']
                    return data()
                before_late = 'post-fault-declared' not in self.markers
                return {'at': '2026-11-07T00:00:01.500Z' if before_late else '2026-11-07T00:00:03Z', 'commits': commits()[:2] if before_late else commits()}

        harness = FakeDrill(driver, 1); harness.markers = []
        with tempfile.TemporaryDirectory(prefix='lumo-drill-unit-') as directory:
            os.chmod(directory, 0o700)
            report = harness.execute(Path(directory))
            self.assertEqual(report['rpo']['missing_transaction_markers'], ['post-fault-declared', 'post-snapshot'])
            self.assertEqual(harness.asserted_target, 'target')
            self.assertEqual(harness.markers, ['baseline', 'post-snapshot', 'post-fault-declared'])
            commands = [args for args, _ in driver.calls]
            dump = next(args for args in commands if 'pg_dump' in args)
            restore = next(args for args in commands if 'pg_restore' in args)
            self.assertIn('--snapshot=00000003-0000001A-1', dump)
            self.assertNotEqual(dump[3], restore[4])
            self.assertIn('--exit-on-error', restore)
            self.assertEqual(len({resource['id'] for resource in harness.owned.resources}), 4)
            self.assertEqual(report['dump']['sha256'], hashlib.sha256(b'fixture-custom-dump').hexdigest())
            self.assertGreaterEqual(report['rto']['measured_ms'], 0)
            for role in ('source', 'target'):
                secret = (Path(directory) / (role + '.password')).read_text().strip()
                self.assertGreater(len(secret), 20)
                self.assertNotIn(secret, json.dumps(driver.calls, default=str))
                self.assertNotIn(secret, json.dumps(report))
            self.assertTrue(harness.owned.cleanup()['complete'])

    def test_main_reports_failures_and_always_cleans_its_registry(self):
        fake = unittest.mock.Mock()
        fake.owned.run_id = 'fixture-run'
        fake.stage = 'restore'
        fake.execute.side_effect = drill.DrillError('simulated_restore_failure')
        fake.owned.cleanup.return_value = {'complete': True, 'resources': []}
        output = io.StringIO()
        with patch.object(drill, 'RecoveryDrill', return_value=fake), redirect_stdout(output):
            self.assertEqual(drill.main(['--execute']), 1)
        fake.owned.cleanup.assert_called_once()
        self.assertEqual(json.loads(output.getvalue())['failed_stage'], 'restore')
        self.assertNotIn('measurement', json.loads(output.getvalue()))
        fake.execute.side_effect = None; fake.execute.return_value = {'fixture': True}
        fake.owned.cleanup.return_value = {'complete': False, 'resources': [{'status': 'retained_or_unverified'}]}
        with patch.object(drill, 'RecoveryDrill', return_value=fake), redirect_stdout(io.StringIO()):
            self.assertEqual(drill.main(['--execute']), 1)


if __name__ == '__main__':
    unittest.main()
