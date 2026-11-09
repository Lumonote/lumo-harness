#!/usr/bin/env python3
"""只读统计展开的桌面 runtime；不跟随符号链接，不删除或修改输入。"""

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


TARGETS = {
    'darwin-arm64': ('darwin', 'arm64'),
    'darwin-x64': ('darwin', 'x64'),
    'win-x64': ('win32', 'x64'),
}


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def matches(values, target):
    if not isinstance(values, list) or not values:
        return True
    positive = [value for value in values if not value.startswith('!')]
    return '!' + target not in values and (not positive or target in positive)


def locate_runtime(root):
    for candidate in [root / 'Contents/Resources/runtime', root / 'resources/runtime', root / 'runtime', root]:
        if (candidate / 'runtime-manifest.json').is_file():
            return candidate
    raise ValueError('找不到 runtime-manifest.json；传入展开的 .app、安装目录或 runtime 目录')


def audit(runtime, target, hash_duplicates):
    files = []
    symlinks = 0
    pending = [runtime]
    # Windows 的 junction 也是链接；不能把用户目录里的挂载点递归算成第二份实体数据。
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            info = path.lstat()
            junction = getattr(info, 'st_reparse_tag', None) == getattr(stat, 'IO_REPARSE_TAG_MOUNT_POINT', 0xA0000003)
            if stat.S_ISLNK(info.st_mode) or junction:
                symlinks += 1
                continue
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
            elif stat.S_ISREG(info.st_mode):
                files.append((path, info))

    def totals(entries):
        unique = {}
        for path, info in entries:
            identity = (info.st_dev, info.st_ino) if info.st_ino else str(path)
            unique[identity] = info
        allocated_known = all(hasattr(info, 'st_blocks') for info in unique.values())
        return {
            'files': len(entries),
            'logicalBytes': sum(info.st_size for _, info in entries),
            'uniqueFileBytes': sum(info.st_size for info in unique.values()),
            # st_blocks 不包含目录、扩展属性；Windows 无该值时返回 null，不伪造占用。
            'allocatedFileBytes': sum(info.st_blocks * 512 for info in unique.values()) if allocated_known else None,
            'filesBelow4KiB': sum(info.st_size < 4096 for _, info in entries),
        }

    components = collections.defaultdict(list)
    for path, info in files:
        components[path.relative_to(runtime).parts[0]].append((path, info))

    packages = []
    for path, _ in files:
        rel = path.relative_to(runtime)
        if rel.parts[0] != 'node_modules' or path.name != 'package.json':
            continue
        manifest = read_json(path)
        if not isinstance(manifest, dict) or not manifest.get('name'):
            continue
        packages.append((path.parent, manifest))

    candidates = []
    if target:
        platform, arch = TARGETS[target]
        for directory, manifest in packages:
            if matches(manifest.get('os'), platform) and matches(manifest.get('cpu'), arch):
                continue
            # 这是清单不匹配的候选列表；通用 WASM fallback 等仍需单独验证。
            prefix = str(directory) + os.sep
            own_files = [(p, s) for p, s in files if str(p).startswith(prefix) and 'node_modules' not in p.relative_to(directory).parts]
            candidates.append({
                'name': manifest['name'], 'version': manifest.get('version'),
                'path': str(directory.relative_to(runtime)),
                'os': manifest.get('os'), 'cpu': manifest.get('cpu'),
                **totals(own_files),
            })

    duplicate_groups = []
    if hash_duplicates:
        by_size = collections.defaultdict(list)
        for path, info in files:
            if info.st_size >= 1024 * 1024:
                by_size[info.st_size].append((path, info))
        for size, entries in by_size.items():
            if len(entries) < 2:
                continue
            by_hash = collections.defaultdict(list)
            for path, info in entries:
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                by_hash[digest.hexdigest()].append((path, info))
            for digest, identical in by_hash.items():
                if len(identical) < 2:
                    continue
                identities = {(s.st_dev, s.st_ino) if s.st_ino else str(p) for p, s in identical}
                duplicate_groups.append({
                    'sha256': digest, 'bytesEach': size,
                    'paths': [str(p.relative_to(runtime)) for p, _ in identical],
                    'distinctInodes': len(identities),
                    # 仅为内容相同的独立文件字节，不宣称 APFS clone 实际可回收这么多。
                    'extraLogicalBytes': max(0, len(identities) - 1) * size,
                })

    return {
        'runtime': str(runtime), 'manifest': read_json(runtime / 'runtime-manifest.json'),
        'target': target, **totals(files), 'linksSkipped': symlinks,
        'components': {name: totals(entries) for name, entries in sorted(components.items())},
        'largestFiles': [
            {'path': str(p.relative_to(runtime)), 'bytes': s.st_size}
            for p, s in sorted(files, key=lambda item: item[1].st_size, reverse=True)[:30]
        ],
        'offTargetPackageCandidates': sorted(candidates, key=lambda item: item['logicalBytes'], reverse=True),
        'duplicateFilesAtLeast1MiB': sorted(duplicate_groups, key=lambda item: item['extraLogicalBytes'], reverse=True),
        'notes': [
            '只统计普通文件；不跟随 symlink/junction。uniqueFileBytes、allocatedFileBytes 按 inode 去重；后者不含目录和扩展属性。',
            '分组内单独去重；跨分组硬链接可能使分组之和大于全树。inode 不可用时按路径统计，无法保证硬链接去重；Windows 无 st_blocks 时不提供分配占用。',
            '不匹配目标的包只是裁剪候选；未验证 import、fallback 或嵌套版本，工具不自动裁剪。',
            '哈希只覆盖至少 1 MiB 的同尺寸文件；APFS clone、稀疏文件、压缩和硬链接会影响真实可回收空间。',
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='展开后的 .app、安装目录或 runtime 目录')
    parser.add_argument('--target', choices=TARGETS, help='默认读取 runtime-manifest.json 的 target')
    parser.add_argument('--hash-duplicates', action='store_true', help='额外读取大文件，核验相同内容的独立副本')
    args = parser.parse_args()
    try:
        runtime = locate_runtime(args.root.resolve(strict=True))
        manifest = json.loads((runtime / 'runtime-manifest.json').read_text(encoding='utf-8'))
        if not isinstance(manifest, dict):
            raise ValueError('runtime-manifest.json 必须是 JSON 对象')
        target = args.target or manifest.get('target')
        if target is not None and target not in TARGETS:
            raise ValueError('未知 target；使用 --target 指定支持的桌面平台')
        print(json.dumps(audit(runtime, target, args.hash_duplicates), ensure_ascii=False, indent=2))
    except (OSError, ValueError) as error:
        print(f'体积审计失败：{error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
