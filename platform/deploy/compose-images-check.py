#!/usr/bin/env python3
"""检查 compose 拓扑里的**镜像引用**是否同源同版本，且没有浮动 tag。

## 为什么需要它

这不是 compose 的配置错误：`docker compose config` 能通过，`up --dry-run` 也能通过，
失败发生在**容器真正去拉镜像**的那一刻：

    Error response from daemon: pull access denied for minio/minio,
    repository does not exist or may require 'docker login'

2026-09-20 就踩到一次，而且这已经是**第二次**踩同一个位置：09-16 两处都写
`minio/minio:latest` 拉不到，于是「钉具体版本」改成 `RELEASE.2025-04-22T22-12-26Z` ——
但钉的还是 Docker Hub 上那个仓库，而**整个仓库随后下线了**，于是连同一个版本号也不可拉。
两次的根因是同一件事：**镜像引用有两个自由度（registry 与 tag），只钉其中一个等于没钉。**

同一份拓扑还有第二个错法：两份 compose 各写各的版本。`compose.cluster.yml` 的 `redis:7`
与 `compose.standalone.yml` 的 `redis:7-alpine` 就是这么来的——两个文件各自都能起来，
**只有放在一起看才是错的**，而「standalone 能起的拓扑在 cluster 里起不来」正是本仓库
反复出现的形态。两个 compose 的注释里写着「版本必须一致」，但注释不是门禁。

## 判据

* **浮动 tag**：镜像的 tag 是 `latest`、或**根本没有 tag**，判 `floating-tag`。
  `:dev` 不算——那是本仓库自建镜像的本地 tag（`lumo/*:dev`、`${LUMO_DSH_IMAGE:-lumo/dsh-node:dev}`），
  它由本地构建决定，不是「上游随时会动」。带 `@sha256:` 摘要的引用天然钉死，不算浮动。
* **跨形态分歧**：同一个服务名在 ≥2 个形态里解析出的镜像不同，判 `shape-divergence`。
  只比**同名服务**——`dsh-node`（standalone）与 `dsh-web`/`cluster-a-dsh-0`（cluster）是
  形态差异，不是分歧。
* 镜像值写成不带默认值的 `${VAR}` 时无法静态判定，**单独提示**而不是静默跳过：
  否则「无法判定」与「一致」在输出上长得一样。
* 注释行里的 `image:` **不算**：`compose.standalone.yml` 里留着一行注释掉的
  `#   image: milvusdb/milvus:latest`，把它当真会得到一个永远修不掉的假阳性。
* overlay（`*.acceptance.yml` / `*.devices.yml`）**按约定不定义镜像**，只加 `ports:` 之类。
  本检查器把这条约定变成断言：overlay 里出现 `image:` 就报 `overlay-defines-image`，
  因为那会让「形态」集合悄悄多出一个不该存在的自由度，而本门禁不会去合并它。

## 为什么自己解析文本而不是调 `docker compose config`

同 `compose-ports-check.py`：不引入 docker 依赖，且 `config` 的结果受 `profiles:` 与
环境变量影响（实测 standalone 的 `provisioner` / `artifact-runtime` 在带 profile 时不会
出现在 `config --services` 里），静态门禁要的是**文件里写了什么**，不是**当前环境会起什么**。

## 用法

    compose-images-check.py --shape compose.standalone.yml --shape compose.cluster.yml \\
        [--shape compose.local.yml] [--overlay compose.cluster.acceptance.yml ...]

每个 `--shape` 是一个可独立启动的拓扑；同名服务之间的镜像必须相同。
"""

import argparse
import os
import re
import sys

# 服务名后面**允许跟行内注释**：`  postgres:      # pgvector 一处同理…` 这种写法在
# 本仓库很常见，而漏掉它会让 `current` 停在上一个服务上——症状是**镜像被错误归属**，
# 于是跨形态比对拿两个不同服务的镜像去比，报出一堆看似合理、实则无关的「分歧」。
# （首版就是漏了这个后缀，实测把 `compose.local` 的 `redis:7-alpine` 归给了 `postgres`。）
SERVICE_BLOCK_RE = re.compile(r"^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$")
SERVICE_FLOW_RE = re.compile(r"^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*\{(.*)$")
IMAGE_KEY_RE = re.compile(r"^\s+image:\s*(.*)$")
# flow 写法（`vault: { image: "hashicorp/vault:latest", cap_add: [...] }`）里的 image：
# 前面必须有一个分隔符，否则 `some-image:` 之类会被误当成 image 键。
IMAGE_IN_FLOW_RE = re.compile(r"(?:^|[,\s{])image:\s*(.*)$")
TOPLEVEL_RE = re.compile(r"^[a-z]")

# `${VAR:-默认值}` / `${VAR-默认值}`：取默认值参与判定。
ENV_DEFAULT_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-)(.*)\}$")
# `${VAR}` / `${VAR:?报错文案}`：运行时才定，静态判不了。
ENV_BARE_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*(?::\?[^}]*)?\}$")

FLOATING_TAGS = {"latest"}


class Reference:
    def __init__(self, service, image, where, undecidable=False):
        self.service = service
        self.image = image          # 解析后的镜像名（含 tag）
        self.where = where          # 形态名 + 行号
        self.undecidable = undecidable

    def __repr__(self):
        return f"<{self.service} {self.image} @{self.where}>"


def extract_value(raw):
    """从 `image:` 后面那一段里取出镜像值。

    flow 写法下这一段还挂着后面的键（`"hashicorp/vault:latest", cap_add: [...]`），
    所以要按引号 / 逗号 / 右括号截断。
    """
    raw = raw.strip()
    if not raw:
        return ""
    if raw[0] in "\"'":
        closing = raw.find(raw[0], 1)
        return raw[1:closing] if closing > 0 else raw[1:]
    for char in ",}]":
        index = raw.find(char)
        if index >= 0:
            raw = raw[:index]
    return raw.strip()


def split_tag(image):
    """返回 (去掉 tag 的仓库名, tag 或 None, 是否带摘要)。

    只看**最后一段**里有没有 `:` —— 否则 `registry.internal:5000/lumo/x` 的端口号
    会被当成 tag。
    """
    if "@" in image:
        return image.split("@", 1)[0], None, True
    last = image.rsplit("/", 1)[-1]
    if ":" in last:
        repo, tag = image.rsplit(":", 1)
        return repo, tag, False
    return image, None, False


def resolve(raw, service, where, problems):
    """把 `image:` 的原始文本解析成 Reference；判不出来时记 problem 并返回 None。"""
    value = extract_value(raw)
    if not value:
        problems.append(f"image-entry-unparsed: {where} 服务 {service} 的 image 是空的")
        return None
    if value.startswith(("[", "{")):
        problems.append(f"image-entry-unparsed: {where} 服务 {service} 的 image 不是标量: {value!r}")
        return None

    env = ENV_DEFAULT_RE.match(value)
    if env:
        inner = env.group(1)
        if not inner:
            problems.append(f"image-entry-unparsed: {where} 服务 {service} 的 image 默认值为空: {value!r}")
            return None
        value = inner
    elif ENV_BARE_RE.match(value):
        return Reference(service, value, where, undecidable=True)

    if "/" not in value and ":" not in value:
        problems.append(f"image-entry-unparsed: {where} 服务 {service} 的 image 不像镜像名: {value!r}")
        return None
    return Reference(service, value, where)


def parse(path, shape, problems):
    """解析一个 compose 文件，返回 [Reference]。"""
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().split("\n")
    except OSError as exc:
        problems.append(f"topology-unreadable: 无法读取 {path}: {exc}")
        return []

    found = []
    current = None
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        # 注释整行跳过 —— 注释掉的 `#   image: milvusdb/milvus:latest` 不是引用。
        if stripped.startswith("#"):
            index += 1
            continue

        block = SERVICE_BLOCK_RE.match(line)
        if block:
            current = block.group(1)
            index += 1
            continue

        flow = SERVICE_FLOW_RE.match(line)
        if flow:
            current = flow.group(1)
            # 花括号体可能跨行；拼到闭合的那一行为止。
            body = flow.group(2)
            cursor = index
            while "}" not in body and cursor + 1 < len(lines):
                cursor += 1
                body += " " + lines[cursor].strip()
            hit = IMAGE_IN_FLOW_RE.search(body)
            if hit:
                reference = resolve(hit.group(1), current, f"{shape}:{index + 1}", problems)
                if reference is not None:
                    found.append(reference)
            index = cursor + 1
            continue

        if line and not line.startswith(" ") and TOPLEVEL_RE.match(line):
            current = None  # 回到顶层键，离开服务区
            index += 1
            continue

        key = IMAGE_KEY_RE.match(line)
        if key and current is not None:
            reference = resolve(key.group(1), current, f"{shape}:{index + 1}", problems)
            if reference is not None:
                found.append(reference)
        index += 1
    return found


def run(shapes, overlays):
    problems = []
    by_shape = {}
    for shape, path in shapes:
        found = parse(path, shape, problems)
        by_shape[shape] = found

    for overlay, path in overlays:
        # overlay 按约定只加 ports / environment 之类，不定义镜像。定义了就必须喊：
        # 本门禁不会合并 overlay，所以那会是一个静默盲区。
        for reference in parse(path, overlay, problems):
            problems.append(f"overlay-defines-image: {reference.where} 服务 {reference.service} "
                            f"定义了 image {reference.image} —— overlay 不该定义镜像，"
                            f"本门禁不会合并它，这是个盲区")

    total = sum(len(items) for items in by_shape.values())
    if total == 0:
        problems.append("topology-not-parsed: 所有形态加起来一个 image 引用都没采集到"
                        "（解析器失效？拓扑被删空？）")
        return problems, {}, 0

    # --- 浮动 tag ---------------------------------------------------------------
    for shape, found in sorted(by_shape.items()):
        for reference in found:
            if reference.undecidable:
                continue
            _, tag, digested = split_tag(reference.image)
            if digested:
                continue
            if tag is None:
                problems.append(f"floating-tag: {reference.where} 服务 {reference.service} 的镜像"
                                f"没有 tag（{reference.image}）—— 上游一变就跟着变")
            elif tag in FLOATING_TAGS:
                problems.append(f"floating-tag: {reference.where} 服务 {reference.service} 用了 "
                                f"{tag} 标签（{reference.image}）—— 上游一变就跟着变")

    # --- 跨形态分歧 -------------------------------------------------------------
    owners = {}
    for shape, found in by_shape.items():
        for reference in found:
            owners.setdefault(reference.service, {})[shape] = reference

    divergence = 0
    for service in sorted(owners):
        per_shape = owners[service]
        if len(per_shape) < 2:
            continue
        decidable = {s: r for s, r in per_shape.items() if not r.undecidable}
        if len(decidable) < 2:
            continue
        images = {r.image for r in decidable.values()}
        if len(images) > 1:
            divergence += 1
            detail = "；".join(f"{shape} = {r.image}" for shape, r in sorted(decidable.items()))
            problems.append(f"shape-divergence: 服务 {service} 在不同形态里不同源：{detail}")
    return problems, by_shape, total


def main():
    parser = argparse.ArgumentParser(description="compose 镜像引用同源性与浮动 tag 检查")
    parser.add_argument("--shape", action="append", default=[], required=True, metavar="PATH",
                        help="可独立启动的拓扑；同名服务之间的镜像必须相同")
    parser.add_argument("--overlay", action="append", default=[], metavar="PATH",
                        help="只做叠加、按约定不定义镜像的文件")
    args = parser.parse_args()

    def named(path):
        return os.path.basename(path)[:-len(".yml")] if path.endswith(".yml") else os.path.basename(path)

    shapes = [(named(path), path) for path in args.shape]
    overlays = [(named(path), path) for path in args.overlay]

    problems, by_shape, total = run(shapes, overlays)

    for shape, path in shapes:
        print(f"compose-images-check: 读取 {path}（形态 {shape}）")
    for shape, path in overlays:
        print(f"compose-images-check: 读取 {path}（overlay {shape}，不定义镜像）")

    undecidable = [r for found in by_shape.values() for r in found if r.undecidable]
    for reference in undecidable:
        print(f"compose-images-check: 提示：镜像不可静态判定（{reference.service} "
              f"{reference.image} @{reference.where}）—— 该变量无默认值，同源性只能到运行时才暴露")

    services = {r.service for found in by_shape.values() for r in found}
    if problems:
        for problem in problems:
            print(f"compose-images-check: FAIL: {problem}", file=sys.stderr)
        print(f"compose-images-check: {len(problems)} 个问题；采集 {total} 个镜像引用，"
              f"覆盖 {len(services)} 个服务 / {len(shapes)} 个形态", file=sys.stderr)
        return 1

    print(f"compose-images-check: 通过（采集 {total} 个镜像引用，覆盖 {len(services)} 个服务 / "
          f"{len(shapes)} 个形态；无浮动 tag，同名服务跨形态同源，不可静态判定 {len(undecidable)} 个）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
