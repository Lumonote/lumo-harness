#!/usr/bin/env python3
"""Opt-in, disposable Docker PostgreSQL logical-backup recovery drill.

No production DSN, existing container, volume or deletion target is accepted.
Default execution prints a plan without contacting Docker. Credentials and dump
bytes stay in a private temporary directory; reports contain no credentials.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import subprocess
import sys
import tempfile
import time


IMAGE = 'pgvector/pgvector:pg16'
LABEL = 'io.lumo.recovery-drill'
MAX_CAPTURE = 16 * 1024 * 1024
DATABASE = 'recovery_drill'


class DrillError(Exception):
    """Only fixed, non-sensitive diagnostic codes leave command boundaries."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def instant(value):
    if not isinstance(value, str):
        raise DrillError('invalid_database_timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise DrillError('invalid_database_timestamp') from None
    if parsed.tzinfo is None:
        raise DrillError('database_timestamp_has_no_timezone')
    return parsed.astimezone(timezone.utc)


def milliseconds(later, earlier):
    delta = instant(later) - instant(earlier)
    micros = (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds
    if micros < 0:
        raise DrillError('database_clock_order_invalid')
    return micros / 1000


def data_summary(data):
    """Fingerprint all rows, including full content, before reducing the report."""
    if not isinstance(data, dict) or set(data) != {'markers', 'documents', 'links', 'checks'}:
        raise DrillError('invalid_data_projection')
    for table in ('markers', 'documents', 'links'):
        if not isinstance(data[table], list):
            raise DrillError('invalid_data_rows')
    checks = data['checks']
    if checks != {'foreign_keys': 2, 'orphan_documents': 0, 'orphan_links': 0, 'bad_content_sha': 0}:
        raise DrillError('restored_integrity_check_failed')
    marker_ids = []
    for row in data['markers']:
        if not isinstance(row, list) or len(row) != 2 or not isinstance(row[0], str):
            raise DrillError('invalid_marker_projection')
        instant(row[1])
        marker_ids.append(row[0])
    if len(set(marker_ids)) != len(marker_ids):
        raise DrillError('duplicate_marker')
    document_ids = set()
    for row in data['documents']:
        if not isinstance(row, list) or len(row) != 4 or not all(isinstance(v, str) for v in row) or row[0] in document_ids or row[1] not in marker_ids:
            raise DrillError('invalid_document_or_foreign_key')
        try:
            body = bytes.fromhex(row[2])
        except ValueError:
            raise DrillError('invalid_document_bytes') from None
        if hashlib.sha256(body).hexdigest() != row[3]:
            raise DrillError('content_sha_mismatch')
        document_ids.add(row[0])
    link_ids = set()
    for row in data['links']:
        if not isinstance(row, list) or len(row) != 2 or not all(isinstance(v, str) for v in row) or row[0] in link_ids or row[1] not in document_ids:
            raise DrillError('invalid_link_or_foreign_key')
        link_ids.add(row[0])
    return {'fingerprint_sha256': digest(data), 'rows': {table: len(data[table]) for table in ('markers', 'documents', 'links')}, 'marker_ids': marker_ids, 'integrity': checks}


def analyze_recovery(snapshot_data, restored_data, source_commits, cutoff_at):
    expected, recovered = data_summary(snapshot_data), data_summary(restored_data)
    if recovered['fingerprint_sha256'] != expected['fingerprint_sha256']:
        raise DrillError('snapshot_fingerprint_mismatch')
    if not isinstance(source_commits, list) or not source_commits:
        raise DrillError('source_commit_evidence_missing')
    commits = {}
    for row in source_commits:
        if not isinstance(row, dict) or set(row) != {'marker', 'committed_at'} or not isinstance(row['marker'], str) or row['marker'] in commits:
            raise DrillError('invalid_source_commit_evidence')
        instant(row['committed_at'])
        milliseconds(cutoff_at, row['committed_at'])
        commits[row['marker']] = row['committed_at']
    restored = set(recovered['marker_ids'])
    if not restored or not restored.issubset(commits):
        raise DrillError('restored_marker_not_in_source_evidence')
    latest_recovered = max((commits[marker] for marker in restored), key=instant)
    latest_ack = max(commits.values(), key=instant)
    missing = sorted(set(commits) - restored)
    return {
        'snapshot': expected, 'recovered': recovered,
        'rpo': {
            'scope': 'isolated_pg_logical_snapshot_only_not_production_pitr',
            'source_cutoff_at': cutoff_at,
            'latest_recovered_original_commit_at': latest_recovered,
            'latest_acknowledged_source_commit_at': latest_ack,
            'recoverable_point_age_at_cutoff_ms': milliseconds(cutoff_at, latest_recovered),
            'acknowledged_data_loss_window_ms': milliseconds(latest_ack, latest_recovered) if missing else 0,
            'missing_transaction_markers': missing,
        },
    }


class Docker:
    def __init__(self, timeout=120):
        self.timeout = timeout

    def call(self, args, *, input_bytes=None, output=None, timeout=None):
        try:
            result = subprocess.run(['docker', *args], input=input_bytes,
                                    stdout=output if output is not None else subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout or self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise DrillError('docker_command_unavailable_or_timed_out') from None
        if result.returncode:
            # Do not reflect Docker/psql stderr, command arguments, env or paths.
            raise DrillError('docker_command_failed')
        if result.stdout is not None and len(result.stdout) > MAX_CAPTURE:
            raise DrillError('docker_response_exceeds_limit')
        return result.stdout or b''

    def json(self, args):
        try:
            return json.loads(self.call(args))
        except (ValueError, TypeError):
            raise DrillError('invalid_docker_json') from None


class OwnedResources:
    """Only successful creates from this instance enter the deletion registry.

    Container IDs, generated names AND exact run labels must still agree before
    stop/kill/remove. No list/prune/Compose-down or caller deletion target exists.
    """
    def __init__(self, docker):
        self.docker = docker
        self.run_id = secrets.token_hex(12)
        self.resources = []
        self.unconfirmed = []

    def name(self, role, kind):
        if role not in ('source', 'target') or kind not in ('container', 'volume'):
            raise DrillError('invalid_generated_resource_role')
        return f'lumo-recovery-drill-{self.run_id}-{role}-{kind}'

    def labels(self, role):
        return {LABEL + '.run': self.run_id, LABEL + '.owner': 'recovery-drill.py', LABEL + '.role': role}

    def label_args(self, role):
        return [arg for key, value in self.labels(role).items() for arg in ('--label', key + '=' + value)]

    def volume(self, role):
        name = self.name(role, 'volume')
        # volume create can reuse an existing volume. Refuse that behavior even
        # for an extraordinarily unlikely random-name collision.
        existing = self.docker.call(['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'])
        if existing.strip():
            raise DrillError('generated_volume_already_exists')
        pending = {'kind': 'volume', 'name': name}
        self.unconfirmed.append(pending)
        result = self.docker.call(['volume', 'create', *self.label_args(role), name]).decode().strip()
        if result != name:
            raise DrillError('created_volume_identity_invalid')
        resource = {'kind': 'volume', 'id': name, 'name': name, 'role': role}
        self.resources.append(resource)
        self.unconfirmed.remove(pending)
        self.verify(resource)
        return resource

    def container(self, role, volume, password_file):
        self.verify(volume)
        name = self.name(role, 'container')
        pending = {'kind': 'container', 'name': name}
        self.unconfirmed.append(pending)
        identity = self.docker.call([
            'create', '--pull=never', '--name', name, *self.label_args(role),
            '--network', 'none', '--restart', 'no', '--security-opt', 'no-new-privileges:true',
            '--mount', f'type=volume,source={volume["name"]},target=/var/lib/postgresql/data',
            '--mount', f'type=bind,source={password_file},target=/run/secrets/pg-password,readonly',
            '--env', 'POSTGRES_PASSWORD_FILE=/run/secrets/pg-password',
            '--env', 'POSTGRES_DB=' + DATABASE,
            '--env', 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=scram-sha-256',
            IMAGE, 'postgres', '-c', 'track_commit_timestamp=on', '-c', 'timezone=UTC',
        ]).decode().strip()
        if not re.fullmatch(r'[a-f0-9]{64}', identity):
            raise DrillError('created_container_identity_invalid')
        resource = {'kind': 'container', 'id': identity, 'name': name, 'role': role}
        self.resources.append(resource)
        self.unconfirmed.remove(pending)
        self.verify(resource)
        self.docker.call(['start', identity])
        return resource

    def verify(self, resource):
        # Identity equality alone is not authority: reject externally supplied
        # or copied dicts even if their fields name one of this run's resources.
        if not any(item is resource for item in self.resources):
            raise DrillError('resource_not_created_by_this_run')
        kind = resource['kind']
        inspected = self.docker.json([kind, 'inspect', resource['id']])
        if not isinstance(inspected, list) or len(inspected) != 1:
            raise DrillError('resource_inspection_invalid')
        info = inspected[0]
        if kind == 'container':
            labels = info.get('Config', {}).get('Labels') or {}
            valid = info.get('Id') == resource['id'] and info.get('Name') == '/' + resource['name']
        else:
            labels = info.get('Labels') or {}
            valid = info.get('Name') == resource['name']
        own_labels = {key: value for key, value in labels.items() if key.startswith(LABEL + '.')}
        if not valid or own_labels != self.labels(resource['role']) or resource['name'] != self.name(resource['role'], kind):
            raise DrillError('resource_ownership_changed_cleanup_refused')

    def kill_source(self, resource):
        self.verify(resource)
        if resource['kind'] != 'container' or resource['role'] != 'source':
            raise DrillError('fault_target_must_be_own_source')
        self.docker.call(['kill', '--signal=KILL', resource['id']])

    def cleanup(self):
        results = []
        # Containers first, so their volumes are no longer attached. Continue
        # checking the rest even if one deletion fails or must be refused.
        ordered = sorted(self.resources, key=lambda r: 0 if r['kind'] == 'container' else 1)
        for resource in ordered:
            record = {'kind': resource['kind'], 'name': resource['name']}
            try:
                self.verify(resource)
                args = ['rm', '--force', resource['id']] if resource['kind'] == 'container' else ['volume', 'rm', resource['id']]
                self.docker.call(args)
                record['status'] = 'removed'
            except (DrillError, ValueError, TypeError, KeyError):
                record['status'] = 'retained_or_unverified'
            results.append(record)
        return {'complete': not self.unconfirmed and all(row['status'] == 'removed' for row in results), 'resources': results,
                'unconfirmed_creates_retained': self.unconfirmed}


DATA_SQL = """
SELECT json_build_object(
 'markers',COALESCE((SELECT json_agg(json_build_array(id,inserted_at) ORDER BY id) FROM drill_markers),'[]'::json),
 'documents',COALESCE((SELECT json_agg(json_build_array(id,marker_id,encode(body,'hex'),sha256) ORDER BY id) FROM drill_documents),'[]'::json),
 'links',COALESCE((SELECT json_agg(json_build_array(id,document_id) ORDER BY id) FROM drill_links),'[]'::json),
 'checks',json_build_object(
  'foreign_keys',(SELECT count(*) FROM pg_constraint WHERE contype='f' AND convalidated AND conrelid IN ('drill_documents'::regclass,'drill_links'::regclass)),
  'orphan_documents',(SELECT count(*) FROM drill_documents d LEFT JOIN drill_markers m ON m.id=d.marker_id WHERE m.id IS NULL),
  'orphan_links',(SELECT count(*) FROM drill_links l LEFT JOIN drill_documents d ON d.id=l.document_id WHERE d.id IS NULL),
  'bad_content_sha',(SELECT count(*) FROM drill_documents WHERE sha256<>encode(digest(body,'sha256'),'hex'))))
"""
COMMIT_SQL = """SELECT json_build_object('at',clock_timestamp(),'commits',
 (SELECT json_agg(json_build_object('marker',id,'committed_at',pg_xact_commit_timestamp(xmin)) ORDER BY id) FROM drill_markers))"""
CONSTRAINT_PROBE_SQL = """DO $$
BEGIN
 BEGIN
  INSERT INTO drill_documents VALUES('probe-orphan','missing-marker',convert_to('probe','UTF8'),encode(digest(convert_to('probe','UTF8'),'sha256'),'hex'));
  RAISE EXCEPTION 'missing marker FK was not enforced';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO drill_links VALUES('probe-link','missing-document');
  RAISE EXCEPTION 'missing document FK was not enforced';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO drill_documents VALUES('probe-sha','baseline',convert_to('probe','UTF8'),repeat('0',64));
  RAISE EXCEPTION 'content SHA constraint was not enforced';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$"""


class RecoveryDrill:
    def __init__(self, docker, rows=64):
        self.docker = docker
        self.owned = OwnedResources(docker)
        self.rows = rows
        self.stage = 'preflight'
        self.timings = {}
        self.started = time.monotonic()

    def stamp(self, name):
        self.timings[name] = round((time.monotonic() - self.started) * 1000, 3)

    def psql_args(self, container):
        self.owned.verify(container)
        return ['exec', '--user', 'postgres', '-i', container['id'], 'psql', '-X', '-qAt', '--set=ON_ERROR_STOP=1', '-U', 'postgres', '-d', DATABASE]

    def sql(self, container, query):
        return self.docker.call(self.psql_args(container), input_bytes=(query + ';\n').encode())

    def sql_json(self, container, query):
        try:
            return json.loads(self.sql(container, query))
        except (ValueError, TypeError):
            raise DrillError('invalid_database_json') from None

    def ready(self, container):
        deadline = time.monotonic() + self.docker.timeout
        while time.monotonic() < deadline:
            try:
                if self.sql(container, 'SELECT 1').strip() == b'1':
                    return
            except DrillError:
                pass
            time.sleep(0.25)
        raise DrillError('postgres_readiness_timed_out')

    def marker(self, source, marker, rows):
        if marker not in ('baseline', 'post-snapshot', 'post-fault-declared') or not isinstance(rows, int) or not 1 <= rows <= 1000:
            raise DrillError('invalid_drill_transaction')
        self.sql(source, f"""BEGIN;
 INSERT INTO drill_markers(id) VALUES('{marker}');
 INSERT INTO drill_documents(id,marker_id,body,sha256)
 SELECT '{marker}-'||n,'{marker}',convert_to(repeat('controlled-body-'||n||'-',16),'UTF8'),
 encode(digest(convert_to(repeat('controlled-body-'||n||'-',16),'UTF8'),'sha256'),'hex') FROM generate_series(1,{rows}) n;
 INSERT INTO drill_links(id,document_id) SELECT 'link-'||id,id FROM drill_documents WHERE marker_id='{marker}';
 COMMIT""")

    @contextmanager
    def snapshot(self, source):
        args = ['docker', *self.psql_args(source)]
        process = None
        try:
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            query = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object('snapshot_id',pg_export_snapshot(),'snapshot_export_observed_at',clock_timestamp(),'mvcc_snapshot',pg_current_snapshot()::text,'wal_lsn',pg_current_wal_lsn()::text,'data',(" + DATA_SQL + "));\n"
            process.stdin.write(query.encode()); process.stdin.flush()
            raw = bytearray()
            deadline = time.monotonic() + self.docker.timeout
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while b'\n' not in raw:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise DrillError('exported_snapshot_timed_out')
                    block = os.read(process.stdout.fileno(), 65536)
                    if not block:
                        raise DrillError('exported_snapshot_session_ended')
                    raw.extend(block)
                    if len(raw) > MAX_CAPTURE:
                        raise DrillError('exported_snapshot_exceeds_limit')
            value = json.loads(bytes(raw).strip())
            if not re.fullmatch(r'[A-Fa-f0-9]{8}-[A-Fa-f0-9]{8}-[0-9]+', value.get('snapshot_id', '')):
                raise DrillError('exported_snapshot_identity_invalid')
            instant(value['snapshot_export_observed_at'])
            yield value
            process.stdin.write(b'COMMIT;\n'); process.stdin.flush(); process.stdin.close(); process.stdin = None
            process.communicate(timeout=self.docker.timeout)
            if process.returncode:
                raise DrillError('exported_snapshot_commit_failed')
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            raise DrillError('exported_snapshot_failed') from None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)

    def execute(self, directory):
        image_id = self.docker.call(['image', 'inspect', '--format', '{{.Id}}', IMAGE]).decode().strip()
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
            raise DrillError('local_image_identity_invalid')
        self.stage = 'source-provision'
        source_volume = self.owned.volume('source')
        password_files = {}
        for role in ('source', 'target'):
            path = directory / (role + '.password')
            with path.open('x', encoding='ascii') as stream:
                # The host parent is 0700. The mounted file must be readable by
                # the image's postgres UID after the entrypoint drops root.
                os.chmod(path, 0o644); stream.write(secrets.token_urlsafe(36) + '\n')
            password_files[role] = path
        source = self.owned.container('source', source_volume, password_files['source'])
        self.ready(source)
        self.stage = 'seed-source'
        self.sql(source, """CREATE EXTENSION pgcrypto;
 CREATE TABLE drill_markers(id TEXT PRIMARY KEY,inserted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
 CREATE TABLE drill_documents(id TEXT PRIMARY KEY,marker_id TEXT NOT NULL REFERENCES drill_markers(id),body BYTEA NOT NULL,
 sha256 TEXT NOT NULL CHECK(sha256=encode(digest(body,'sha256'),'hex')));
 CREATE TABLE drill_links(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES drill_documents(id))""")
        self.marker(source, 'baseline', self.rows)
        self.stage = 'export-and-dump'
        dump_path = directory / 'snapshot.dump'
        self.stamp('snapshot_export_started')
        with self.snapshot(source) as exported:
            self.stamp('snapshot_export_received')
            snapshot_data = exported.pop('data')
            if data_summary(snapshot_data)['marker_ids'] != ['baseline']:
                raise DrillError('baseline_snapshot_unexpected')
            # The later acknowledged write must be excluded even though it
            # commits before pg_dump starts; --snapshot is part of the contract.
            self.marker(source, 'post-snapshot', 1)
            self.owned.verify(source)
            self.stamp('dump_started')
            with dump_path.open('xb') as stream:
                os.chmod(dump_path, 0o600)
                self.docker.call(['exec', '--user', 'postgres', source['id'], 'pg_dump', '-U', 'postgres', '-d', DATABASE,
                                  '--format=custom', '--no-owner', '--no-privileges', '--snapshot=' + exported['snapshot_id']], output=stream)
            self.stamp('dump_completed')
        dump_size = dump_path.stat().st_size
        if dump_size < 1:
            raise DrillError('empty_dump')
        dump_sha = hashlib.sha256(dump_path.read_bytes()).hexdigest()
        self.stage = 'fault-boundary'
        fault_started = time.monotonic()
        self.stamp('fault_declared')
        declaration = self.sql_json(source, COMMIT_SQL)
        self.marker(source, 'post-fault-declared', 1)
        source_evidence = self.sql_json(source, COMMIT_SQL)
        late = next((row for row in source_evidence['commits'] if row['marker'] == 'post-fault-declared'), None)
        if not late or milliseconds(late['committed_at'], declaration['at']) <= 0:
            raise DrillError('post_boundary_commit_not_observed')
        self.owned.kill_source(source)
        self.stamp('source_killed')
        self.stage = 'target-provision'
        target_volume = self.owned.volume('target')
        target = self.owned.container('target', target_volume, password_files['target'])
        self.ready(target)
        self.stamp('target_ready')
        self.stage = 'restore'
        self.owned.verify(target)
        # input is bounded drill data and private; no password enters argv/env.
        self.docker.call(['exec', '--user', 'postgres', '-i', target['id'], 'pg_restore', '-U', 'postgres', '-d', DATABASE,
                          '--exit-on-error', '--no-owner', '--no-privileges'], input_bytes=dump_path.read_bytes())
        self.stamp('restore_completed')
        self.stage = 'validate-recovery'
        self.sql(target, CONSTRAINT_PROBE_SQL)
        restored = self.sql_json(target, DATA_SQL)
        analysis = analyze_recovery(snapshot_data, restored, source_evidence['commits'], source_evidence['at'])
        if analysis['rpo']['missing_transaction_markers'] != ['post-fault-declared', 'post-snapshot']:
            raise DrillError('missing_transaction_set_unexpected')
        self.stamp('recovery_validated')
        elapsed = round((time.monotonic() - fault_started) * 1000, 3)
        return {
            'image': {'reference': IMAGE, 'local_id': image_id, 'pull_performed': False},
            'exported_snapshot': exported, 'dump': {'format': 'pg_dump-custom', 'bytes': dump_size, 'sha256': dump_sha},
            'fault': {'declared_at': declaration['at'], 'source_cutoff_observed_at': source_evidence['at'],
                      'post_declaration_commit_at': late['committed_at'], 'method': 'SIGKILL_own_source_container'},
            'source_acknowledged_transactions': source_evidence['commits'], **analysis,
            'rto': {'measured_ms': elapsed, 'start': 'fault_declaration_before_controlled_late_commit', 'end': 'restored_sql_fk_sha_and_fingerprint_verified',
                    'includes': ['fault_declaration_query', 'controlled_late_commit', 'source_kill', 'fresh_target_volume_and_container', 'postgres_readiness', 'pg_restore', 'sql_integrity_verification'],
                    'excludes': ['source_seed', 'backup_creation', 'cleanup', 'application_service_or_traffic_recovery']},
            'stage_offsets_ms': self.timings,
        }


def arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--execute', action='store_true', help='create only this run\'s disposable source and target resources')
    mode.add_argument('--check', action='store_true', help='print plan only; never contact Docker (default)')
    mode.add_argument('--dry-run', action='store_true', help='alias for plan-only check')
    parser.add_argument('--rows', type=int, default=64, help='baseline document count, 1..1000')
    parser.add_argument('--timeout', type=int, default=120, help='per-command/readiness timeout seconds, 1..600')
    options = parser.parse_args(argv)
    if not 1 <= options.rows <= 1000 or not 1 <= options.timeout <= 600:
        parser.error('rows must be 1..1000; timeout must be 1..600')
    return options


def main(argv=None):
    options = arguments(argv)
    report = {'schema_version': 'lumo-recovery-drill/v1', 'executed': options.execute,
              'scope': 'disposable_postgresql_logical_snapshot_not_production_pitr_or_ha',
              'plan': {'image': IMAGE, 'baseline_documents': options.rows, 'containers': 2, 'volumes': 2,
                       'network': 'none', 'published_ports': [], 'existing_resources_accepted': False,
                       'cleanup': 'only_in_process_created_resources_with_exact_identity_and_run_labels'}}
    if not options.execute:
        report['status'] = 'dry-run'
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    drill = RecoveryDrill(Docker(options.timeout), options.rows)
    report['run_id'] = drill.owned.run_id
    status = 1
    previous_term = signal.getsignal(signal.SIGTERM)
    previous_int = signal.getsignal(signal.SIGINT)
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    try:
        with tempfile.TemporaryDirectory(prefix='lumo-recovery-drill-') as temp:
            os.chmod(temp, 0o700)
            report['measurement'] = drill.execute(Path(temp))
        report['status'] = 'passed'
        status = 0
    except KeyboardInterrupt:
        report['status'] = 'interrupted'; report['failed_stage'] = drill.stage; status = 130
    except Exception as error:
        report['status'] = 'failed'; report['failed_stage'] = drill.stage
        report['error_code'] = str(error) if isinstance(error, DrillError) else 'unexpected_' + type(error).__name__
    finally:
        # A second termination still must not redirect deletion to unrelated
        # resources. Each deletion independently checks its original identity.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            report['cleanup'] = drill.owned.cleanup()
        except Exception:
            report['cleanup'] = {'complete': False, 'error_code': 'cleanup_interrupted_or_unavailable'}
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)
        if not report['cleanup']['complete']:
            report['status'] = 'failed'; status = 1
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return status


if __name__ == '__main__':
    sys.exit(main())
