"""Failure-path checks for the opt-in Docker harness; these never call Docker."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class FaultHarnessTests(unittest.TestCase):
    def setUp(self):
        self.report = tempfile.TemporaryDirectory(prefix='lumo-fault-unit-')
        self.addCleanup(self.report.cleanup)
        script = Path(__file__).resolve().parents[1] / 'fault-injection-cluster.py'
        spec = importlib.util.spec_from_file_location('fault_harness', script)
        self.harness = importlib.util.module_from_spec(spec)
        with patch.dict('os.environ', {'LUMO_ACCEPTANCE_REPORT_DIR': self.report.name}):
            spec.loader.exec_module(self.harness)

    def test_pause_restores_container_after_assertion_without_changing_restart_policy(self):
        calls = []

        def command(*args):
            calls.append(args)
            return 'true' if args[1] == 'inspect' else ''

        with patch.object(self.harness, 'compose', return_value='container-pg'), \
             patch.object(self.harness, 'command', side_effect=command):
            with self.assertRaisesRegex(AssertionError, 'scenario failed'):
                with self.harness.paused('postgres'):
                    raise AssertionError('scenario failed')
        self.assertEqual(self.harness.PAUSED, {})
        self.assertIn(('docker', 'pause', 'container-pg'), calls)
        self.assertIn(('docker', 'unpause', 'container-pg'), calls)
        self.assertFalse(any('update' in call for call in calls))

    def test_failed_unpause_remains_registered_for_outer_cleanup(self):
        def command(*args):
            if args[1] == 'inspect':
                return 'true'
            if args[1] == 'unpause':
                raise RuntimeError('docker unavailable')
            return ''

        with patch.object(self.harness, 'compose', return_value='container-nacos'), \
             patch.object(self.harness, 'command', side_effect=command):
            with self.assertRaisesRegex(RuntimeError, 'docker unavailable'):
                with self.harness.paused('nacos'):
                    pass
        self.assertEqual(self.harness.PAUSED, {'nacos': 'container-nacos'})

    def test_cleanup_restores_other_fault_domains_even_if_unpause_fails(self):
        h = self.harness
        h.PAUSED['postgres'] = 'pg'
        h.STOPPED.add('scheduler-0')
        h.RESTART_POLICIES['scheduler-0'] = {'Name': 'on-failure', 'MaximumRetryCount': 7}
        h.RESTART_NODES.add('cluster-b-dsh-1')
        with patch.object(h, 'unpause', side_effect=RuntimeError('unpause failed')), \
             patch.object(h, 'compose', return_value='scheduler-id') as compose, \
             patch.object(h, 'command', return_value='') as command:
            failures = h.cleanup_runtime()
        self.assertEqual(failures, [{'service': 'postgres', 'action': 'unpause', 'type': 'RuntimeError'}])
        command.assert_called_once_with('docker', 'update', '--restart=on-failure:7', 'scheduler-id')
        self.assertIn(unittest.mock.call('restart', 'cluster-b-dsh-1'), compose.call_args_list)
        self.assertEqual(h.RESTART_POLICIES, {})
        self.assertEqual(h.STOPPED, set())

    def test_rejection_does_not_confuse_auth_failure_success_or_timeout_with_readiness(self):
        h = self.harness
        for status in (200, 201, 202, 400, 401, 403, 404):
            with self.assertRaises(AssertionError):
                h.assert_rejected({'status': status}, 'admission')
        with self.assertRaises(AssertionError):
            h.assert_rejected({'status': None}, 'readiness')
        h.assert_rejected({'status': 503}, 'readiness')
        h.assert_rejected({'status': None}, 'placement', allow_timeout=True)

    def test_ready_probe_failure_alone_does_not_claim_synchronous_admission_has_closed(self):
        h = self.harness
        for response, expected in [
            ({'status': 503, 'body': '{"ready":true}'}, False),
            ({'status': 503, 'body': '{"ready":false}'}, True),
            ({'status': 200, 'body': '{"ready":false}'}, False),
        ]:
            with patch.object(h, 'node_fetch', return_value=response):
                self.assertIs(h.node_admission_closed('node'), expected)

    def test_recovered_probe_rows_or_slots_make_the_scenario_fail(self):
        h = self.harness
        for task_rows, admitted_rows, slots in [('1', '0', 0), ('0', '1', 0), ('0', '0', 2)]:
            with self.subTest(task_rows=task_rows, admitted_rows=admitted_rows, slots=slots), \
                 patch.object(h, 'sql', side_effect=[task_rows, admitted_rows]), \
                 patch.object(h, 'active_slots', return_value=slots):
                with self.assertRaises(AssertionError):
                    h.assert_probes_unadmitted(['fault-hex123'], 1)
        with patch.object(h, 'sql', side_effect=['0', '0']), patch.object(h, 'active_slots', return_value=1):
            h.assert_probes_unadmitted(['fault-hex123'], 1)


if __name__ == '__main__':
    unittest.main()
