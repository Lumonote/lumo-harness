#!/usr/bin/env python3
"""Fault real full-topology containers and assert admission, fencing and recovery.

Requires an isolated test Compose project and LUMO_ALLOW_FAULT_INJECTION=1.
No LLM is mocked here: these are control-plane and node lifecycle assertions;
agent/log/callback transaction and recovery tests run separately in acceptance.
"""
import json
import os
from contextlib import contextmanager
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
REPORT = Path(os.environ.get('LUMO_ACCEPTANCE_REPORT_DIR', '/tmp/lumo-cluster-acceptance'))
REPORT.mkdir(parents=True, exist_ok=True)
COMPOSE = ['docker', 'compose']
if os.environ.get('LUMO_ENV_FILE'):
    COMPOSE += ['--env-file', os.environ['LUMO_ENV_FILE']]
for name in ['compose.shared.yml', 'compose.control-plane.bundle.yml', 'compose.cluster.yml', 'compose.cluster.acceptance.yml']:
    COMPOSE += ['-f', str(HERE / name)]
COMPOSE += ['--profile', 'cluster-full']
TOKEN = os.environ.get('LUMO_CONTROL_PLANE_TOKEN', '')
EVENTS = []
STOPPED = set()
DRAINED = set()
RESTART_POLICIES = {}
PAUSED = {}
RESTART_NODES = set()
EXECUTION_NODES = ('cluster-a-dsh-1', 'cluster-b-dsh-1')


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {result.returncode})')
    return result.stdout.strip()


def compose(*args):
    return command(*(COMPOSE + list(args)))


def sql(query):
    return compose('exec', '-T', 'postgres', 'psql', '-U', os.environ.get('LUMO_POSTGRES_USER', 'lumo'),
                   '-d', os.environ.get('LUMO_POSTGRES_DB', 'lumo'), '-At', '-c', query)


def eventually(label, read, timeout=90):
    start = time.monotonic()
    last = None
    while time.monotonic() - start < timeout:
        try:
            value = read()
            if value:
                EVENTS.append({'assertion': label, 'seconds': round(time.monotonic() - start, 3)})
                print(f'fault-injection: PASS: {label}', flush=True)
                return value
        except (RuntimeError, ValueError, TimeoutError, subprocess.TimeoutExpired, urllib.error.URLError) as error:
            last = type(error).__name__
        time.sleep(1)
    raise RuntimeError(f'timed out after {timeout}s: {label} ({last})')


def http(port, path, payload=None):
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': f'Bearer {TOKEN}', 'X-Lumo-Realm': 'dev', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=6) as response:
        return json.load(response)


def http_response(port, path, payload=None):
    """Observe HTTP rejection or a timed-out dependency call without treating it as success."""
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': f'Bearer {TOKEN}', 'X-Lumo-Realm': 'dev', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return {'status': response.status, 'body': response.read().decode()}
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'body': error.read().decode()}
    except (TimeoutError, socket.timeout, urllib.error.URLError) as error:
        # A network timeout is fail-closed for this request, but is not an HTTP
        # readiness response. Database state is checked again after recovery.
        return {'status': None, 'error': type(error).__name__}


def lease():
    holder, token = sql('SELECT holder, fencing_token FROM scheduler_leader_lease WHERE id=1 AND expires_at > (extract(epoch from clock_timestamp())*1000)::bigint').split('|')
    return holder, int(token)


PORTS = {'scheduler-0': 18096, 'scheduler-1': 18093,
         'scheduler-cluster-a': 18094, 'scheduler-cluster-b': 18095}


def nodes():
    holder, _ = lease()
    return http(PORTS[holder], '/v1/nodes')['nodes']


def node_fetch(service, path, method='GET', payload=None):
    # Resolve container-only listeners through docker exec. Credentials stay in
    # the container environment rather than appearing in process argv or logs.
    script = """const r = await fetch('http://127.0.0.1:8091'+process.argv[1], {
      method: process.argv[2], headers: {'content-type':'application/json',
      'X-Lumo-Realm':process.env.LUMO_REALM, 'X-Lumo-Seam-Token':process.env.LUMO_SUBAGENT_HOST_TOKEN},
      body: process.argv[3] === 'null' ? undefined : process.argv[3], signal: AbortSignal.timeout(20000)});
      console.log(JSON.stringify({status:r.status,body:await r.text()}));"""
    return json.loads(compose('exec', '-T', service, 'node', '--input-type=module', '-e', script,
                              path, method, json.dumps(payload)))


def crash(service):
    ids = compose('ps', '-q', service).splitlines()
    assert len(ids) == 1, f'{service}: expected one isolated failure domain'
    STOPPED.add(service)
    RESTART_POLICIES[service] = json.loads(command('docker', 'inspect', '--format', '{{json .HostConfig.RestartPolicy}}', ids[0]))
    command('docker', 'update', '--restart=no', ids[0])
    command('docker', 'kill', '--signal=KILL', ids[0])


def restart_policy_argument(policy):
    name = policy['Name']
    maximum = policy.get('MaximumRetryCount', 0)
    return f'{name}:{maximum}' if name == 'on-failure' and maximum else name


def restore_crashed(service):
    compose('start', service)
    command('docker', 'update', '--restart=' + restart_policy_argument(RESTART_POLICIES[service]),
            compose('ps', '-q', service))
    # Retain both recovery entries until all restoration steps have succeeded.
    STOPPED.discard(service)
    RESTART_POLICIES.pop(service)


def unpause(service):
    container = PAUSED[service]
    if command('docker', 'inspect', '--format', '{{.State.Paused}}', container) == 'true':
        command('docker', 'unpause', container)
    PAUSED.pop(service)


@contextmanager
def paused(service):
    """Pause one isolated failure domain without changing its restart policy."""
    ids = compose('ps', '-q', service).splitlines()
    assert len(ids) == 1, f'{service}: expected one isolated failure domain'
    # Register before the RPC: even a command timeout may have paused Docker.
    PAUSED[service] = ids[0]
    try:
        command('docker', 'pause', ids[0])
        yield
    finally:
        unpause(service)


def assert_rejected(response, label, allow_timeout=False):
    status = response.get('status')
    assert (status is None and allow_timeout) or (isinstance(status, int) and 500 <= status < 600), \
        f'{label}: expected dependency rejection, got {response}'


def active_slots():
    return int(sql("SELECT count(*) FROM scheduler_tasks WHERE state IN ('PLACED','RUNNING','CANCELLING')"))


def assert_probes_unadmitted(task_ids, slots_before):
    # IDs are minted locally as hex, never read from an external response.
    quoted = ','.join("'" + task + "'" for task in task_ids)
    assert sql(f'SELECT count(*) FROM scheduler_tasks WHERE task_id IN ({quoted})') == '0', \
        'fault-period submission created a task after dependency recovery'
    assert sql(f'SELECT count(*) FROM subagent_start_guard WHERE child_id IN ({quoted}) AND admitted') == '0', \
        'fault-period start was durably admitted'
    assert active_slots() <= slots_before, 'fault-period probes consumed new execution slots'


def node_admission_closed(service):
    response = node_fetch(service, '/readyz')
    # A DB probe can fail before the process's synchronous admission state
    # closes. Wait for both, so the subsequent start cannot linger in PG.
    return response['status'] == 503 and json.loads(response['body']).get('ready') is False


def postgres_outage():
    holder, _ = eventually('global lease ready before PostgreSQL pause', lease)
    slots_before = active_slots()
    child = 'fault-pg-start-' + uuid.uuid4().hex
    # This is a real authenticated start envelope, intentionally without a
    # Scheduler assignment: it can never start an Agent, even if the health
    # guard regresses. Healthy admission must reach the assignment fence.
    start = {'childId': child, 'realm': 'dev', 'schedulerAttempt': 1,
             'schedulerNodeId': 'cluster-b-dsh-1', 'prompt': [], 'descriptor': {},
             'parent': {'sessionId': 'fault-parent-' + uuid.uuid4().hex, 'delegationDepth': 0},
             'callbackUrl': f'http://cluster-b-dsh-0:8092/subagent/result/{child}/' + uuid.uuid4().hex}
    for service in EXECUTION_NODES:
        assert node_fetch(service, '/readyz')['status'] == 200, f'{service}: not ready before PostgreSQL pause'
    healthy = node_fetch('cluster-b-dsh-1', '/subagent/start', 'POST', start)
    assert healthy['status'] == 403 and 'assignment' in healthy['body'], 'start probe did not reach the assignment fence'
    probes = [child]
    # Failed host lease renewal permanently fences that process. Explicitly
    # restart both execution hosts after PG returns; never silently re-admit it.
    RESTART_NODES.update(EXECUTION_NODES)
    with paused('postgres'):
        for service in EXECUTION_NODES:
            eventually(f'{service} readiness closes during PostgreSQL pause',
                       lambda service=service: node_admission_closed(service), timeout=60)
            assert node_fetch(service, '/healthz')['status'] == 200, 'PostgreSQL outage incorrectly failed process liveness'
        rejected = node_fetch('cluster-b-dsh-1', '/subagent/start', 'POST', start)
        assert rejected['status'] == 503, f'PostgreSQL outage did not close start admission: {rejected}'
        task = 'fault-pg-placement-' + uuid.uuid4().hex
        probes.append(task)
        assert_rejected(http_response(PORTS[holder], '/v1/placements',
            {'task_id': task, 'cluster_id': 'cluster-b', 'requires': [{'key': 'subagent'}]}),
            'PostgreSQL placement admission', allow_timeout=True)
    eventually('PostgreSQL responds after unpause', lambda: sql('SELECT 1') == '1')
    assert_probes_unadmitted(probes, slots_before)
    EVENTS.append({'assertion': 'PostgreSQL outage rejects readiness/start/new placement without new durable admissions or slots', 'seconds': 0})
    for service in EXECUTION_NODES:
        compose('restart', service)
        eventually(f'{service} obtains a fresh process lease after PostgreSQL recovery',
                   lambda service=service: node_fetch(service, '/readyz')['status'] == 200, timeout=120)
        RESTART_NODES.remove(service)
    eventually('execution directory recovers after PostgreSQL outage',
               lambda: set(EXECUTION_NODES) <= {n['node_id'] for n in nodes()}, timeout=120)


def metric_value(text, name):
    for line in text.splitlines():
        if line.startswith(name + ' '):
            return float(line.split()[-1])
    raise ValueError(f'missing metric: {name}')


def catalog_metrics(port):
    response = http_response(port, '/metrics')
    if response['status'] != 200:
        raise RuntimeError('scheduler metrics endpoint unavailable')
    return (metric_value(response['body'], 'lumo_scheduler_catalog_ok'),
            metric_value(response['body'], 'lumo_scheduler_catalog_snapshot_age_seconds'))


def nacos_outage():
    holder, _ = eventually('global lease ready before Nacos pause', lease)
    port = PORTS[holder]
    eventually('fresh discovery metrics before Nacos pause', lambda: catalog_metrics(port)[0] == 1)
    slots_before = active_slots()
    probes = []
    with paused('nacos'):
        # Catalog.List queries Nacos on every admission; it never admits from
        # the old metric snapshot. Age verifies that discovery really became
        # stale while that old snapshot remains available for diagnostics.
        def stale_directory():
            ok, age = catalog_metrics(port)
            return ok == 0 and age >= 5
        eventually('Nacos outage exposes stale discovery instead of a fresh empty directory', stale_directory, timeout=60)
        for name, entry in PORTS.items():
            task = 'fault-nacos-' + uuid.uuid4().hex
            probes.append(task)
            cluster = 'cluster-b' if name.endswith('cluster-b') else 'cluster-a'
            assert_rejected(http_response(entry, '/v1/placements',
                {'task_id': task, 'cluster_id': cluster, 'requires': [{'key': 'subagent'}]}),
                f'{name} Nacos placement admission')
        assert_probes_unadmitted(probes, slots_before)
    eventually('Nacos directory restores both execution clusters',
               lambda: set(EXECUTION_NODES) <= {n['node_id'] for n in nodes()}, timeout=120)
    holder, _ = lease()
    eventually('Nacos recovery refreshes discovery metrics', lambda: catalog_metrics(PORTS[holder])[0] == 1)
    assert_probes_unadmitted(probes, slots_before)


def cleanup_runtime():
    """Attempt every restoration even when one Docker operation fails."""
    failures = []
    for service in list(PAUSED):
        try:
            unpause(service)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            failures.append({'service': service, 'action': 'unpause', 'type': type(error).__name__})
    for service in list(STOPPED):
        try:
            restore_crashed(service)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            failures.append({'service': service, 'action': 'start-and-restore-policy', 'type': type(error).__name__})
    for service in DRAINED | RESTART_NODES:
        try:
            compose('restart', service)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            failures.append({'service': service, 'action': 'restart', 'type': type(error).__name__})
    return failures


def main():
    assert os.environ.get('LUMO_ALLOW_FAULT_INJECTION') == '1', 'explicit isolated-test fault injection opt-in required'
    project = os.environ.get('COMPOSE_PROJECT_NAME', '')
    assert project and project not in {'lumo-platform', 'lumo-platform-cluster', 'lumo-platform-standalone'}, 'set an explicit isolated COMPOSE_PROJECT_NAME'
    assert TOKEN, 'control-plane token is required'
    assert os.environ.get('LUMO_CLUSTER_TOPOLOGY', 'full') == 'full', 'fault injection requires full topology'
    api = compose('ps', '-q', 'api-bundle')
    cmd = json.loads(command('docker', 'inspect', '--format', '{{json .Config.Cmd}}', api))
    assert cmd[-1] == 'api', 'full topology must not duplicate scheduler identities inside api-bundle'
    eventually('both real execution clusters register', lambda: {'cluster-a','cluster-b'} <= {n['cluster_id'] for n in nodes()})
    before = eventually('global scheduler lease exists', lease)
    assert before[0] in PORTS, 'unexpected leader identity'
    crash(before[0])
    def taken_over():
        current = lease()
        return current if current[0] != before[0] and current[1] > before[1] else None
    after = eventually('crashed leader replaced with higher fencing token', taken_over)
    # A single durable placement survives retries through the new leader. The
    # terminal report is deliberately submitted twice to test idempotence; it
    # is a scheduler contract check, not a claim that an Agent turn ran.
    task = 'fault-gate-' + uuid.uuid4().hex
    port = PORTS[after[0]]
    payload = {'task_id': task, 'cluster_id': 'cluster-a', 'requires': [{'key':'subagent'}]}
    placed = http(port, '/v1/placements', payload)
    assert placed['node_id'] and placed['attempt'] > 0, 'placement not assigned'
    repeated = http(port, '/v1/placements', payload)
    assert (placed['node_id'], placed['attempt']) == (repeated['node_id'], repeated['attempt']), 'placement replay created another attempt'
    terminal = {'state':'COMPLETED','attempt':placed['attempt'],'node_id':placed['node_id']}
    for _ in range(2):
        http(port, f'/v1/tasks/{task}/result', terminal)
    assert sql(f"SELECT count(*) FROM scheduler_tasks WHERE task_id='{task}' AND state='COMPLETED'") == '1'
    EVENTS.append({'assertion':'placement replay and duplicate terminal report converge to one task','seconds':0})
    restore_crashed(before[0])
    victim = 'cluster-b-dsh-1'
    crash(victim)
    eventually('crashed node removed from real Nacos discovery', lambda: all(n['node_id'] != victim for n in nodes()))
    assert any(n['cluster_id'] == 'cluster-a' for n in nodes()), 'other cluster lost capacity'
    restore_crashed(victim)
    eventually('restarted node re-registers', lambda: any(n['node_id'] == victim for n in nodes()))
    assert node_fetch(victim, '/healthz')['status'] == 200
    assert node_fetch(victim, '/readyz')['status'] == 200
    DRAINED.add(victim)
    drained = node_fetch(victim, '/drain', 'POST', {'timeout_ms':10000})
    assert drained['status'] == 200, 'drain did not complete'
    assert node_fetch(victim, '/readyz')['status'] == 503, 'drained node remains ready'
    assert node_fetch(victim, '/healthz')['status'] == 200, 'drain incorrectly failed liveness'
    eventually('draining node loses scheduling eligibility', lambda: all(n['node_id'] != victim for n in nodes()))
    EVENTS.append({'assertion':'drain separates liveness/readiness and scheduler admission','seconds':0})
    compose('restart', victim)
    eventually('drained node returns only after restart', lambda: any(n['node_id'] == victim for n in nodes()))
    DRAINED.remove(victim)
    postgres_outage()
    nacos_outage()


if __name__ == '__main__':
    status = 'failed'
    failure = None
    try:
        main(); status = 'passed'
    except Exception as error:
        failure = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        cleanup_failures = cleanup_runtime()
        if cleanup_failures and status == 'passed':
            status = 'failed'
            failure = {'type': 'CleanupFailure', 'message': 'Docker fault restoration failed; inspect cleanup_failures'}
        (REPORT / 'fault-injection.json').write_text(json.dumps({'status':status,'failure':failure,'assertions':EVENTS,
            'cleanup_failures': cleanup_failures,
            'scope':'real scheduler/Nacos/PostgreSQL/node admission and lifecycle; no Agent or LLM execution; durable recovery is tested separately'}, indent=2)+'\n')
        if failure and failure['type'] == 'CleanupFailure':
            raise RuntimeError(failure['message'])
