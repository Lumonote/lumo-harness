#!/usr/bin/env python3
"""Render native model overlays with fake credentials; never start containers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


DEPLOY = Path(__file__).resolve().parents[1]
FAKE_TOKEN = 'fixture-$UNCHANGED-"double"-\'single\'-\\literal'
NODE_NAMES = [f'cluster-{cluster}-dsh-{index}' for cluster in ('a', 'b') for index in (0, 1)]
SHAPES = {
    'standalone': (['standalone', 'models.standalone'], None, {'dsh-node': ['/root/.dsh']}),
    'full': (['cluster', 'models.cluster'], 'cluster-full',
             {name: ['/root/.dsh'] for name in ['dsh-web'] + NODE_NAMES}),
    'compact': (['cluster', 'cluster.compact', 'models.cluster.compact'], 'cluster-compact', {
        'dsh-web': ['/root/.dsh'],
        **{f'cluster-{c}-bundle': [f'/var/lib/lumo/dsh/cluster-{c}-dsh-{i}' for i in (0, 1)]
           for c in ('a', 'b')},
    }),
}


class NativeModelDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lumo-native-models-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        patch = self.directory / 'cordis.patch.yml'
        patch.write_text((DEPLOY / 'examples/dsh-models.anthropic.patch.yml').read_text())
        credentials = self.directory / 'credentials.env'
        # DSH_HOME must be bound to the mounted home even if accidentally supplied
        # in the credentials file. Compose environment takes priority over env_file.
        credentials.write_text(f'ANTHROPIC_AUTH_TOKEN={FAKE_TOKEN}\nDSH_HOME=/wrong-home\n')
        credentials.chmod(0o600)
        self.env = {key: value for key, value in os.environ.items()
                    if key in ('PATH', 'HOME', 'TMPDIR', 'DOCKER_CONFIG')}
        self.env.update(LUMO_CONTROL_PLANE_TOKEN='native-model-config-test',
                        DSH_MODELS_PATCH_FILE=str(patch),
                        DSH_MODEL_CREDENTIALS_FILE=str(credentials))

    def render(self, shape, env=None, overlay=True):
        files, profile, _ = SHAPES[shape]
        command = ['docker', 'compose', '--env-file', '/dev/null', '-p', 'native-model-config-test']
        for name in ['shared', 'control-plane.bundle'] + files:
            if overlay or not name.startswith('models.'):
                command.extend(['-f', str(DEPLOY / f'compose.{name}.yml')])
        if profile:
            command.extend(['--profile', profile])
        command.extend(['config', '--format', 'json'])
        return subprocess.run(command, env=self.env if env is None else env,
                              text=True, capture_output=True, timeout=30, check=False)

    def test_native_models_all_shapes(self):
        for shape, (_, _, targets) in SHAPES.items():
            with self.subTest(shape=shape):
                result = self.render(shape)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(result.stdout)
                services, home_volumes = config['services'], []
                self.assertTrue(targets.keys() <= services.keys())
                if shape == 'compact':
                    self.assertTrue(set(NODE_NAMES).isdisjoint(services), 'compact must run only bundles')
                for name, service in services.items():
                    if name not in targets:
                        self.assertNotIn('ANTHROPIC_AUTH_TOKEN', service.get('environment', {}), name)
                        continue
                    # config escapes $ as $$ so the emitted model can be read by
                    # Compose again. No expansion or removal of quotes is allowed.
                    self.assertEqual(service['environment']['ANTHROPIC_AUTH_TOKEN'],
                                     FAKE_TOKEN.replace('$', '$$'), name)
                    if not name.endswith('-bundle'):
                        self.assertEqual(service['environment']['DSH_HOME'], '/root/.dsh')
                    mounts = {volume['target']: volume for volume in service['volumes']}
                    for home in targets[name]:
                        self.assertEqual(mounts[home]['type'], 'volume')
                        home_volumes.append(mounts[home]['source'])
                        patch = mounts[f'{home}/cordis.patch.yml']
                        self.assertEqual(patch['source'], self.env['DSH_MODELS_PATCH_FILE'])
                        self.assertTrue(patch['read_only'])
                        self.assertFalse(patch.get('bind', {}).get('create_host_path', False))
                self.assertEqual(len(home_volumes), len(set(home_volumes)), 'DSH homes must not be shared')

    def test_default_topologies_preserve_service_selection(self):
        for shape in SHAPES:
            with self.subTest(shape=shape):
                result = self.render(shape, overlay=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                services = json.loads(result.stdout)['services']
                self.assertTrue(SHAPES[shape][2].keys() <= services.keys())
                if shape == 'compact':
                    self.assertTrue(set(NODE_NAMES).isdisjoint(services))
                for service in services.values():
                    self.assertNotIn('ANTHROPIC_AUTH_TOKEN', service.get('environment', {}))

    def test_missing_model_inputs_fail_closed(self):
        for shape in SHAPES:
            for key in ('DSH_MODELS_PATCH_FILE', 'DSH_MODEL_CREDENTIALS_FILE'):
                with self.subTest(shape=shape, missing=key):
                    env = dict(self.env)
                    del env[key]
                    result = self.render(shape, env)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(key, result.stderr)
            with self.subTest(shape=shape, missing='credentials file'):
                env = dict(self.env, DSH_MODEL_CREDENTIALS_FILE=str(self.directory / 'missing.env'))
                result = self.render(shape, env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('missing.env', result.stderr)

    def test_compact_child_configuration_files_are_isolated(self):
        script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[1], 'utf8')
  .split('// Register handlers before spawning children')[0]
  .replace(/^#!.*\n/, '').replace(/^import .*\n/gm, '');
const results = [];
for (const cluster of ['cluster-a', 'cluster-b']) {
  const sandbox = { process: { env: {
    LUMO_BUNDLE_CLUSTER_ID: cluster,
    LUMO_CONTROL_PLANE_TOKEN: 'fixture',
    DSH_HOME: '/wrong-home', LUMO_PATCH_PATH: '/shared-patch.yml'
  } }, console };
  results.push(vm.runInNewContext(source + '\n[nodeEnv(), agentEnv()]', sandbox));
}
console.log(JSON.stringify(results.flat().map(env => ({
  node: env.LUMO_NODE_ID, home: env.DSH_HOME, patch: env.LUMO_PATCH_PATH
}))));
"""
        result = subprocess.run(['node', '-e', script, str(DEPLOY / 'cluster-bundle.mjs')],
                                text=True, capture_output=True, timeout=10, check=True)
        children = json.loads(result.stdout)
        self.assertEqual(len(children), 4)
        self.assertEqual(len({child['patch'] for child in children}), 4)
        for child in children:
            self.assertEqual(child['home'], f"/var/lib/lumo/dsh/{child['node']}")
            self.assertEqual(child['patch'], f"{child['home']}/lumo.patch.yml")


if __name__ == '__main__':
    unittest.main()
