#!/usr/bin/env python3
"""Validate real YAML structure, selector isolation and durable workload wiring."""
import argparse
from pathlib import Path
import yaml


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f"duplicate YAML key {key!r} at line {key_node.start_mark.line + 1}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def check(path, release):
    documents = [doc for doc in yaml.load_all(Path(path).read_text(), Loader=UniqueLoader) if doc]
    workloads = [doc for doc in documents if doc['kind'] in ('Deployment', 'StatefulSet')]
    services = {doc['metadata']['name']: doc for doc in documents if doc['kind'] == 'Service'}
    assert workloads, 'chart rendered no workloads'
    pods = []
    for doc in workloads:
        name, spec = doc['metadata']['name'], doc['spec']
        labels = spec['template']['metadata']['labels']
        assert labels.get('app.kubernetes.io/instance') == release, f'{name}: missing release pod label'
        selector = spec['selector']['matchLabels']
        assert selector.get('app.kubernetes.io/instance') == release, f'{name}: unsafe workload selector'
        assert all(labels.get(k) == v for k, v in selector.items()), f'{name}: selector does not match pods'
        pod = spec['template']['spec']
        volumes = {v['name'] for v in pod.get('volumes', [])}
        claims = {v['metadata']['name'] for v in spec.get('volumeClaimTemplates', [])}
        assert len(volumes) == len(pod.get('volumes', [])), f'{name}: duplicate volume'
        assert len(claims) == len(spec.get('volumeClaimTemplates', [])), f'{name}: duplicate PVC template'
        assert volumes.isdisjoint(claims), f'{name}: volume and PVC names overlap'
        for volume in pod.get('volumes', []):
            assert len(set(volume) - {'name'}) == 1, f'{name}: invalid volume source {volume}'
        for container in pod['containers'] + pod.get('initContainers', []):
            for mount in container.get('volumeMounts', []):
                assert mount['name'] in volumes | claims, f'{name}: volume {mount["name"]} is not defined'
            env = {e['name']: e for e in container.get('env', [])}
            assert len(env) == len(container.get('env', [])), f'{name}: duplicate environment variable'
            if container['name'] in ('dsh-node', 'dsh-web'):
                mounts = {m['name']: m for m in container.get('volumeMounts', [])}
                assert env.get('DSH_HOME', {}).get('value') == '/root/.dsh', f'{name}: wrong Harness home'
                assert mounts.get('harness-home', {}).get('mountPath') == '/root/.dsh', f'{name}: home not mounted'
                if 'harness-home' in claims:
                    assert doc['kind'] == 'StatefulSet', f'{name}: persistent home needs per-pod PVC'
                else:
                    home = next(v for v in pod['volumes'] if v['name'] == 'harness-home')
                    assert 'emptyDir' in home, f'{name}: ephemeral home must be private to this Pod'
                if 'harness-config' in volumes:
                    mount = mounts.get('harness-config', {})
                    assert mount.get('mountPath') == '/root/.dsh/cordis.patch.yml', f'{name}: wrong native patch path'
                    assert mount.get('readOnly') and mount.get('subPath') == 'cordis.patch.yml', f'{name}: patch mount must be read-only'
                    config = next(v for v in pod['volumes'] if v['name'] == 'harness-config')['configMap']
                    assert config['items'][0]['path'] == 'cordis.patch.yml', f'{name}: ConfigMap key mapping mismatch'
            if container['name'] == 'flows':
                prefix = name.removesuffix('flows')
                for variable, target in {
                    'LUMO_LLM_GATEWAY_URL': 'llm-gateway',
                    'LUMO_CONNECTOR_GATEWAY_URL': 'connector-gateway',
                    'LUMO_PROJECTS_URL': 'projects',
                    'LUMO_GOVERNANCE_URL': 'governance',
                    'LUMO_KNOWLEDGE_SEAM_URL': 'dsh-node',
                }.items():
                    service = services.get(prefix + target)
                    if service:
                        port = next(p['port'] for p in service['spec']['ports'] if p['name'] == ('seam' if target == 'dsh-node' else 'http'))
                        expected = f'http://{prefix}{target}:{port}'
                        assert env.get(variable, {}).get('value') == expected, f'{name}: {variable} must use this release service {expected}'
                    else:
                        assert variable not in env, f'{name}: {variable} points at a disabled service'
            if 'LUMO_SESSION_LOG_SPOOL_DIR' in env:
                assert doc['kind'] == 'StatefulSet' and 'session-spool' in claims, f'{name}: spool lacks per-pod PVC'
                assert any(m['name'] == 'session-spool' for m in container['volumeMounts']), f'{name}: spool not mounted'
        pods.append(labels)
    for doc in documents:
        kind, spec = doc['kind'], doc.get('spec', {})
        if kind == 'Service':
            assert spec['selector'].get('app.kubernetes.io/instance') == release, f'{doc["metadata"]["name"]}: unscoped Service'
            assert any(all(pod.get(k) == v for k, v in spec['selector'].items()) for pod in pods), 'Service matches no workload'
        if kind in ('PodDisruptionBudget', 'PeerAuthentication', 'AuthorizationPolicy'):
            assert spec['selector']['matchLabels'].get('app.kubernetes.io/instance') == release, f'{kind}: unscoped selector'
        if kind == 'HorizontalPodAutoscaler':
            target = spec['scaleTargetRef']
            assert any(w['kind'] == target['kind'] and w['metadata']['name'] == target['name'] for w in workloads), 'HPA target missing'
            assert spec['metrics'], 'HPA has no scaling metric'
            for metric in spec['metrics']:
                if metric['type'] == 'External':
                    assert metric['external']['metric']['selector']['matchLabels']['release'] == release
        if kind == 'NetworkPolicy':
            assert spec['podSelector']['matchLabels']['app.kubernetes.io/instance'] == release
    return pods


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    parser.add_argument('release')
    parser.add_argument('--other-file')
    parser.add_argument('--other-release')
    args = parser.parse_args()
    first = check(args.file, args.release)
    if args.other_file:
        second = check(args.other_file, args.other_release)
        assert not any(a['app.kubernetes.io/instance'] == b['app.kubernetes.io/instance'] for a in first for b in second), 'releases overlap'
    print(f'chart-structure: {args.file}: valid YAML, scoped selectors and persistent spool wiring')


if __name__ == '__main__':
    main()
