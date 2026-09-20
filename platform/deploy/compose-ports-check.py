#!/usr/bin/env python3
"""检查 compose 拓扑里的**宿主端口**是否被两个服务同时声明。

## 为什么需要它

这不是 compose 的配置错误：`docker compose config` 能通过，失败发生在容器真正启动的
那一刻（`Bind for 0.0.0.0:18090 failed: port is already allocated`）。所以它**没有任何
静态检查会拦住**，只能靠人记住。

2026-09-16 就踩到一次：`compose.cluster.yml` 给 terminal-gateway 写了宿主 18090，而可选
overlay `compose.cluster.devices.yml` 早已把 18090 给了 governance 容器里的设备网关
（TLS passthrough，见 docs/desktop-devices.md）。两个文件各自都对，**只有合并起来才是错的**：

    docker compose -f compose.cluster.yml -f compose.cluster.devices.yml up

于是后起来的那个容器直接起不来。这正是本仓库反复出现的形态——单个文件里正确，错法只在
跨文件对照上——所以补的是门禁而不是注释。

## 判据

* 只解析**服务下的 `ports:` 键**。`expose:`（仅容器内可见）不算，env 值里的
  `LUMO_LISTEN=:8083` 之类更不算——第一版就是没限定作用域，把 env 文本当成了端口映射，
  于是报出 26 个「不可静态判定」的假映射。限定作用域这件事本身也要有守卫（见下）。
* 容器端口（`:` 右边那个）**不参与判定**：每个容器有独立网络命名空间，重复无害。
* 宿主端口按**端口号**比，不区分 bind 地址。`0.0.0.0:18090` 与 `127.0.0.1:18090` 在实机上
  依然互斥，而「绑定地址不同所以不冲突」是需要逐案论证的判断，不适合放进门禁
  （宁可 fail-closed 让人显式确认）。
* 同一个服务出现两次不算冲突：compose 合并 `ports` 时按**容器端口**去重，同服务同 target
  是覆盖而非追加（overlay 正是靠这一条工作）。
* 宿主端口写成不带默认值的 `${VAR}` 时无法静态判定，**单独列出**而不是静默忽略——
  否则「无法判定」与「没有映射」在输出上长得一样。
* 解析不出来的条目（例如长语法 `target:`/`published:`）**必须报错**，不能跳过：
  门禁的价值全在「发现冲突」，任何解析盲区都会让它退化成「没有冲突」。
* 服务名**允许跟行内注释**（`  postgres:      # pgvector 一处同理…`，本仓库很常见）。
  2026-09-20 修：首版的正则要求行尾没有别的东西，于是带行内注释的服务名不被识别，
  它的整段 `ports:` 被当成「不在服务区内」跳过 —— **方向是 fail-open**：真冲突会被放行。
  `compose.standalone.yml` 里当时有 8 个这样的服务（postgres / redis / minio / rocketmq /
  nacos / collaborator / connector-gateway / scheduler-0），而 cluster 一个都没有，
  所以这个盲区在本机只对 standalone 生效。反向用例见 `compose-ports-verify.sh`。

## 用法

    compose-ports-check.py --file compose.cluster.yml [--file compose.cluster.devices.yml ...]

多个 `--file` 表示**合并语义**（后者叠加在前者之上），这是本门禁真正要覆盖的场景。
"""

import argparse
import re
import sys

SERVICE_RE = re.compile(r"^  ([a-z0-9][a-z0-9-]*):\s*(?:#.*)?$")
PORTS_KEY_RE = re.compile(r"^(\s*)ports:\s*(.*)$")
TOPLEVEL_RE = re.compile(r"^[a-z]")
DIGITS_RE = re.compile(r"(\d+)")
PROTOCOL_RE = re.compile(r"/\w+$")
# `${VAR}`：不带默认值，运行时才定，静态判定不了。注意 `${VAR:-18090}` 不算——它有默认值，
# 会被 DIGITS_RE 取到数字，走正常判定。
DYNAMIC_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")


class Mapping:
    def __init__(self, service, host_port, container_port, text, where):
        self.service = service
        self.host_port = host_port  # None = 动态（无默认值），无法静态判定
        self.container_port = container_port
        self.text = text
        self.where = where

    def __repr__(self):
        return f"<{self.service} {self.text} @{self.where}>"


def parse_entry(service, text, where):
    """把一条短语法端口项解析成 Mapping；判不出来时返回 (None, 原因)。

    短语法形如 `18090:8090`、`127.0.0.1:18090:8090`、`${B:-127.0.0.1}:${P:-18090}:8090/udp`。
    以**最后两段**为准：末段恒为容器端口，倒数第二段为宿主端口——这样前面有几段
    （bind 地址、甚至 IPv6 的方括号写法）都不影响定位。
    """
    text = PROTOCOL_RE.sub("", text.strip())
    if not text:
        return None, "空条目"
    parts = text.split(":")
    if len(parts) == 1:
        # `- 8090`：只写容器端口、不绑宿主端口，不产生冲突面。
        return None, None
    container_part = parts[-1]
    if not DIGITS_RE.search(container_part):
        return None, f"末段不是容器端口: {text!r}"
    host_part = parts[-2]
    host_digits = DIGITS_RE.search(host_part)
    if host_digits:
        return Mapping(service, host_digits.group(1), container_part, text, where), None
    if DYNAMIC_RE.match(host_part):
        return Mapping(service, None, container_part, text, where), None
    # 宿主那一段既不是数字、也不是「运行时才知道的变量」——那只能是**我们不认识的写法**
    # （长语法 `- target: 9999` / `- published: "18090"` 就会落在这一支）。这里必须报错而
    # 不是记成「动态端口」：后者会一路走到「无冲突」，于是解析盲区长得和「真的没冲突」
    # 一模一样，而门禁的全部价值就是发现冲突。
    return None, f"宿主端口段无法识别（长语法或写错？）: {text!r}"


def collect_entries(lines, start, key_indent):
    """从 `ports:` 那一行开始收集条目。返回 (inline_entries 或 None, 条目行列表, 结束下标)。

    支持两种形态：`ports: ["a:b", "c:d"]` 与 `ports:` 后跟若干 `- "a:b"` 行。
    """
    inline = lines[start].split("ports:", 1)[1].strip()
    if inline.startswith("["):
        body = inline.strip("[]")
        return [item.strip() for item in body.split(",") if item.strip()], [], start
    entries = []
    index = start + 1
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= key_indent or not stripped.startswith("-"):
            break
        entries.append(stripped[1:].strip())
        index += 1
    return None, entries, index - 1


def unquote(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def parse(path, problems):
    """解析一个 compose 文件，返回 (服务数, [Mapping], 采集到的条目数)。"""
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().split("\n")
    except OSError as exc:
        problems.append(f"topology-unreadable: 无法读取 {path}: {exc}")
        return 0, [], 0

    service_count = 0
    current = None
    found = []
    entry_count = 0
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        match = SERVICE_RE.match(line)
        if match:
            current = match.group(1)
            service_count += 1
            index += 1
            continue
        if line and not line.startswith(" ") and TOPLEVEL_RE.match(line):
            current = None  # 回到顶层键，离开服务区
            index += 1
            continue
        if current is None or stripped.startswith("#"):
            index += 1
            continue
        key = PORTS_KEY_RE.match(line)
        if key:
            inline, entries, last = collect_entries(lines, index, len(key.group(1)))
            raw = inline if inline is not None else entries
            for item in raw:
                entry_count += 1
                mapping, reason = parse_entry(current, unquote(item), f"{path}:{index + 1}")
                if reason:
                    problems.append(f"port-entry-unparsed: {path}:{index + 1} "
                                    f"{reason}（服务 {current}）")
                elif mapping is not None:
                    found.append(mapping)
            index = last + 1
            continue
        index += 1
    return service_count, found, entry_count


def run(files):
    problems = []
    all_mappings = []
    total_entries = 0
    for path in files:
        _, mappings, entries = parse(path, problems)
        all_mappings.extend(mappings)
        total_entries += entries

    # --- 计数守卫 ---------------------------------------------------------------
    # 本门禁的全部价值在于「发现冲突」，而任何解析失效都会让它退化成「没有冲突」。
    # 所以「一个 ports 条目都没看到」必须失败，而不是安静地通过。
    if total_entries == 0:
        problems.append(
            "topology-not-parsed: 所有文件加起来一个 ports 条目都没采集到（解析器失效？拓扑被删空？）")
        return problems, 0, 0, []

    # --- 冲突判定 ---------------------------------------------------------------
    owners = {}
    for mapping in all_mappings:
        if mapping.host_port is None:
            continue
        owners.setdefault(mapping.host_port, []).append(mapping)

    for host_port in sorted(owners, key=int):
        claims = owners[host_port]
        services = {claim.service for claim in claims}
        if len(services) < 2:
            continue
        detail = "、".join(f"{c.service}（{c.where}）" for c in claims)
        problems.append(f"port-collision: 宿主端口 {host_port} 被 {len(services)} 个服务同时声明：{detail}")

    undecidable = [m for m in all_mappings if m.host_port is None]
    return problems, len(all_mappings), total_entries, undecidable


def main():
    parser = argparse.ArgumentParser(description="compose 宿主端口冲突检查")
    parser.add_argument("--file", action="append", default=[], required=True,
                        help="compose 文件；多个表示合并语义（后者叠加在前者之上）")
    args = parser.parse_args()

    problems, mapping_count, entry_count, undecidable = run(args.file)
    for path in args.file:
        print(f"compose-ports-check: 读取 {path}")
    for mapping in undecidable:
        print(f"compose-ports-check: 提示：宿主端口不可静态判定"
              f"（{mapping.service} {mapping.text} @{mapping.where}）—— 该变量无默认值，"
              f"冲突只能到运行时才暴露")

    if problems:
        for problem in problems:
            print(f"compose-ports-check: FAIL: {problem}", file=sys.stderr)
        print(f"compose-ports-check: {len(problems)} 个问题；采集 {entry_count} 个 ports 条目，"
              f"其中宿主端口映射 {mapping_count} 个", file=sys.stderr)
        return 1

    print(f"compose-ports-check: 通过（采集 {entry_count} 个 ports 条目，宿主端口映射 "
          f"{mapping_count} 个，不可静态判定 {len(undecidable)} 个；无冲突）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
