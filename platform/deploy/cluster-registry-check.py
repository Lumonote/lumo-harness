#!/usr/bin/env python3
"""联邦注册表的**静态**一致性检查：开了判定，就真的有上报方。

## 它要防的是什么

`LUMO_CLUSTER_ENFORCE=true` 让调度器开始按自报判集群存活：可疑/下线的集群不再接受
新放置。这套机制的全部输入是「有人自报」——而**判定开着、没人自报**在面板上与
「所有集群都健康」长得一模一样：

  * 一个集群从没被登记过 → 状态是 `unregistered` → 闸门**放行**（`BlocksPlacement`
    只拦 suspect/down）。于是判定看起来生效了，实际上一分钱的作用都没有；
  * 一个集群被登记过又停了自报 → 走到 `down` → 它的新放置全被拒。而如果上报方是
    **不该代报**的进程（控制台、父节点），那么承载节点全挂、只剩控制台时集群照样
    显示健康——调度器把任务放进去，然后卡在无人执行。

两者都是「配置看起来对、语义是错的」，只有跨文件对照才能发现：判定开关在
`compose.cluster.yml` 的 scheduler 服务上，而**上报方**在 dsh-node 服务上，测试
谁都不管这件事。所以这个检查存在，与 `helm-verify.sh` / `alerts-verify.sh` 同源。

## 规则（每条都有配对的缺陷用例，见 cluster-registry-verify.sh）

1. `topology-not-parsed` —— **计数守卫**。什么也没解析出来时不许「通过」：一个
   解析失败的门禁与一个通过的门禁无法区分，这正是本仓库在 CI 上踩过的坑。
2. `deployment-mode-values` —— 形态取值必须是小写规范值，且与文件该是哪种形态一致。
   `cluster` 写成 `Cluster` 会让 dsh-node 的上报方**静默关闭**（它是精确比较）。
3. `invalid-enforce-value` —— 存活判定开关只认三态；打错字（`ture`）必须报错而不是当 false。
4. `invalid-version-gate-value` —— 版本闸门开关同理。
5. `version-gate-without-declarer` —— 版本闸门开着，而整个拓扑没有任何服务声明
   `LUMO_CLUSTER_VERSION`。这是版本闸门的**同一种静默失效**：判定集合里一个声明都没有
   → `VersionConsistency.Declared == 0` → 判定为「一致」→ 闸门恒放行。开关看起来生效了，
   一分钱的作用都没起（`version_declared_clusters` 会是 0，只有真去读那个响应才看得出来）。
6. `version-gate-split-fleet` —— 闸门开着，而拓扑里**静态写死了两个不同版本**。
   这不是「配置错了」而是「此刻的配置会让全局放置一直排队」：版本分叉时闸门按设计
   **整体拒绝**（§7.4.1「先完成全集群分发」）。它在面板上与「没有容量」完全同形
   （都是 202 + PENDING），只有 `lumo_scheduler_placement_version_blocked` 与
   `fleet_version` 能分开。滚动升级途中的中间状态确实长这样，那就把这次提交当成
   「还没升完」——或者先别开闸门。
7. `enforce-without-reporter` —— 存活判定开着却整个拓扑没有任何上报方。
8. `cluster-without-reporter` —— 某个集群的承载节点不能自报（缺地址/缺令牌）。该集群
   永远不会被登记，于是它的放置永远不受闸门约束——「部分生效」读起来像「生效」。

## 依赖

只用标准库（与 `alerts-verify.sh` 的口径一致：**不 import 任何第三方库**）。
所以 YAML 是按行读的，不是真解析。为此专门加了规则 1 的计数守卫：行读法一旦失效，
守卫会先炸，而不是安静地放行。

用法：
  cluster-registry-check.py --kind compose --file <compose.yml> --expect-mode cluster
  cluster-registry-check.py --kind helm    --file <rendered.yaml> --expect-mode base
"""

import argparse
import os
import re
import sys

VALID_MODES = {"local", "standalone", "cluster"}
TRUE_WORDS = {"true", "1", "yes"}
FALSE_WORDS = {"false", "0", "no"}
VALID_ENFORCE = TRUE_WORDS | FALSE_WORDS

SCHEDULER_MODE_KEYS = ("LUMO_SCHEDULER_URL", "LUMO_SCHEDULER_API_URL")
# 服务名后面**允许**跟行内注释。首版写成 `:\s*$`，于是 `  cluster-b-dsh-0:   # 承载节点`
# 不被认成服务键——而它的整段 environment 会被并进**前一个**服务（见 parse_compose 的
# `current` 游标），不是被丢掉。方向是 fail-open，且后果正好落在本检查器存在的理由上：
# 实测同一份拓扑（cluster-b 唯一承载节点缺 LUMO_CONTROL_PLANE_TOKEN）去掉行内注释报
# `cluster-without-reporter`，加上行内注释就**通过**——被污染的宿主节点继承了
# LUMO_ROLE=node 与前一个服务的令牌，替 cluster-b 假冒了一个上报方。
# `edge-cors-check.py` / `compose-ports-check.py` / `compose-images-check.py` 都已收敛到
# 这个写法；本条是同一个盲区在集群侧的最后一处。
SERVICE_KEY_RE = re.compile(r"^  ([a-z0-9][a-z0-9_-]*):\s*(?:#.*)?$")
ENV_ASSIGN_RE = re.compile(r"^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
# compose 里两种写法都要认：裸的 `- K=V` 与带引号的 `- "K=V"`。只认前者会让
# `- "LUMO_CONTROL_PLANE_TOKEN=${...}"` 静默消失，于是检查器把「配了令牌」读成
# 「没配令牌」——一个说反了的门禁比没有门禁更糟。
ENV_ASSIGN_QUOTED_RE = re.compile(r"^\s*-\s*([\"'])([A-Za-z_][A-Za-z0-9_]*)=(.*)\1\s*$")
ENV_MAPPING_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$")
ENV_BARE_RE = re.compile(r"^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*$")
ENVFILE_RE = re.compile(r"env_file:\s*\[(.*?)\]")
INLINE_ENV_RE = re.compile(r"^\s*-?\s*environment:\s*\[(.*)\]\s*$")
ENVFILE_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
INTERP_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])([^}]*)\}")
HELM_CONTAINER_RE = re.compile(r"^\s*-\s*name:\s*(\S+)\s*$")
HELM_ENV_NAME_RE = re.compile(r"^\s*-\s*name:\s*([A-Z][A-Z0-9_]*)\s*$")
HELM_VALUE_RE = re.compile(r"^\s*value:\s*(.*)$")


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def resolve(value):
    """把 compose 的变量插值折叠成一个可判定的值。

    只看**结构**，不看宿主环境：`${VAR:-default}` 取 default；`${VAR:?msg}` 是
    「必须由宿主提供」，按已知非空算；`${VAR}` 与 `${VAR:-}` 无法判定，折叠成
    `<unresolved>`。区分这两种情况是必要的——把「宿主必须提供」读成「空」会让门禁
    报出一堆不存在的缺配，而把「无法判定」读成「非空」会让它漏掉真缺配。
    """

    def substitute(match):
        _, operator, argument = match.group(1), match.group(2), match.group(3)
        if operator == ":-":
            return argument if argument else "<unresolved>"
        if operator == ":?":
            return "<from-environment>"
        return "<unresolved>"

    return INTERP_RE.sub(substitute, value)


class Service:
    def __init__(self, name):
        self.name = name
        self.env = {}
        self.env_files = []


def parse_env_file(path, cache):
    if path in cache:
        return cache[path]
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.rstrip("\n")
                if line.strip() == "" or line.lstrip().startswith("#"):
                    continue
                match = ENVFILE_LINE_RE.match(line)
                if match:
                    values[match.group(1)] = unquote(match.group(2))
    except OSError:
        values = {}
    cache[path] = values
    return values


def parse_compose(path):
    """按行收集每个服务的环境变量。后出现的覆盖先出现的（compose 自身语义）。"""
    services = {}
    current = None
    in_services = False
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            stripped = line.strip()
            if stripped == "" or stripped.startswith("#"):
                continue
            if re.match(r"^[A-Za-z]", line):
                in_services = stripped == "services:"
                current = None
                continue
            if not in_services:
                continue
            match = SERVICE_KEY_RE.match(line)
            if match:
                current = match.group(1)
                services.setdefault(current, Service(current))
                continue
            if current is None:
                continue
            service = services[current]
            match = ENVFILE_RE.search(line)
            if match:
                for entry in match.group(1).split(","):
                    entry = unquote(entry)
                    if entry:
                        service.env_files.append(entry)
                continue
            match = INLINE_ENV_RE.match(line)
            if match:
                for pair in re.findall(r'"([^"]+)"', match.group(1)):
                    key, _, value = pair.partition("=")
                    service.env[key.strip()] = resolve(unquote(value))
                continue
            match = ENV_ASSIGN_RE.match(line) or ENV_ASSIGN_QUOTED_RE.match(line)
            if match:
                key, value = match.group(1), match.group(2)
                if key.startswith(("'", '"')):
                    key, value = match.group(2), match.group(3)
                service.env[key] = resolve(unquote(value))
                continue
            match = ENV_BARE_RE.match(line)
            if match:
                # 只在环境段里出现的最简形式；值由运行环境提供（不可知，按非空算）。
                service.env.setdefault(match.group(1), "<from-environment>")
                continue
            match = ENV_MAPPING_RE.match(line)
            if match and match.group(1).isupper():
                service.env[match.group(1)] = resolve(unquote(match.group(2)))
    return services


def parse_helm(path):
    """把一个渲染好的清单里的每个容器当成一个「服务」。

    容器名与 env 名靠形状区分：env 名是全大写+下划线，容器名不是。但**只靠形状不够**：
    `ports:` 里也有 `- name: http` 这样的项，它不是容器，却会把「当前容器」抢走，
    于是紧随其后的整段 env 会被记到 `http` 名下——一个把环境变量记错归属的检查器会
    报出根本不存在的缺配（或者更糟：漏掉真的缺配）。

    所以容器认定加一条结构条件：**该 `- name:` 的下一个非空行必须是 `image:`**。
    本 chart 的每个容器都紧接 `image:`，而端口/卷/卷挂载的 `- name:` 都不是。
    形状再变时，规则 1 的计数守卫会先炸，而不是安静地记错归属。
    """
    lines = []
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            lines.append(raw.rstrip("\n"))
    services = {}
    current = None
    pending_key = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        match = HELM_ENV_NAME_RE.match(line)
        if match:
            pending_key = match.group(1)
            if current is not None:
                current.env.setdefault(pending_key, "")
            continue
        if pending_key is not None:
            value_match = HELM_VALUE_RE.match(line)
            if value_match:
                if current is not None:
                    current.env[pending_key] = unquote(value_match.group(1))
                pending_key = None
                continue
            if stripped.startswith("valueFrom:"):
                # 值来自 Secret/ConfigMap 引用：存在但不可知，按非空算，避免把
                # 「引用了一个 Secret」误判成「没配」。
                if current is not None:
                    current.env[pending_key] = "<from-ref>"
                pending_key = None
                continue
        match = HELM_CONTAINER_RE.match(line)
        if match and next_non_empty(lines, index).strip().startswith("image:"):
            name = match.group(1).strip("\"'")
            current = Service(name)
            services.setdefault(name, current)
    return services


def next_non_empty(lines, index):
    for line in lines[index + 1:]:
        if line.strip():
            return line
    return ""


class Report:
    def __init__(self):
        self.problems = []
        self.checks = 0

    def ok(self, message):
        self.checks += 1
        print(f"cluster-registry: OK: {message}")

    def fail(self, rule, message):
        self.checks += 1
        self.problems.append((rule, message))
        print(f"cluster-registry: FAIL: {rule}: {message}")


def load_services(kind, path):
    if kind == "compose":
        services = parse_compose(path)
        cache = {}
        base_dir = os.path.dirname(os.path.abspath(path))
        for service in services.values():
            for name in service.env_files:
                for key, value in parse_env_file(os.path.join(base_dir, name), cache).items():
                    service.env.setdefault(key, value)
        return services
    return parse_helm(path)


def check(services, expect_mode, report, kind):
    envs = {name: service.env for name, service in services.items()}
    key_count = sum(1 for env in envs.values() if any(k.startswith("LUMO_") for k in env))
    hosts = {n: e for n, e in envs.items() if e.get("LUMO_ROLE", "").strip() == "node"}
    clusters = sorted({e["LUMO_CLUSTER_ID"].strip() for e in envs.values() if e.get("LUMO_CLUSTER_ID", "").strip()})
    identity = [n for n, e in envs.items() if e.get("LUMO_SCHEDULER_CLUSTER_ID", "").strip()]

    # --- 1. 计数守卫：解析不出东西时必须失败，不能「因为没有发现而通过」---------
    if key_count == 0:
        report.fail("topology-not-parsed", f"{len(services)} 个服务里没有任何 LUMO_* 环境变量（解析失效？）")
        return
    report.ok(f"解析出 {len(services)} 个服务、{key_count} 个带 LUMO_* 变量的服务")
    if expect_mode == "cluster" and not hosts:
        report.fail("topology-not-parsed", "cluster 形态里找不到任何 LUMO_ROLE=node 的承载节点（解析失效或拓扑被删空）")
    if expect_mode == "cluster" and not clusters:
        report.fail("topology-not-parsed", "cluster 形态里找不到任何 LUMO_CLUSTER_ID（解析失效或拓扑被删空）")
    if not clusters and not identity and expect_mode == "cluster":
        report.fail("topology-not-parsed", "既没有 LUMO_CLUSTER_ID 也没有 LUMO_SCHEDULER_CLUSTER_ID，无从判断谁属于谁")

    # --- 0. 降级路径必须可达 -------------------------------------------------
    # 「代码、测试、指标、告警全都齐全，而那条路径在任何拓扑里都走不到」是本仓库
    # 记过多次的一种病（C1 自报那轮、C3/C4 不在 chart 里那轮）。降级放置的准入判据
    # 第一条就是「本实例有集群身份」，而身份只来自 LUMO_SCHEDULER_CLUSTER_ID——
    # 集群形态里一个都没有，那条路径就是死的，且死在静默里：它只是永远走不到而已。
    #
    # 这不是在要求「必须有降级」，而是在要求**这个选择必须被做出来**：要么拓扑里有
    # 每集群的调度实例，要么把这条判据删掉。两者之间没有第三种状态。
    if expect_mode == "cluster" and not identity:
        report.fail("degradation-unreachable",
                    "集群形态里没有任何服务带 LUMO_SCHEDULER_CLUSTER_ID —— "
                    "集群本地放置降级（architecture §7.4.1）的准入判据第一条恒不成立，"
                    "那条路径在任何拓扑里都走不到。要么给每个集群一个调度实例，要么删掉那条判据")
    # 只有「一个变量都没解析出来」才提前返回（上面已 return）。其余的守卫失败继续
    # 往下跑：解析层失效与语义层不一致是两类问题，只报前者会让人以为改完解析就好了。

    # --- 2. 部署形态取值 ---------------------------------------------------
    modes = {}
    for name, env in envs.items():
        raw = env.get("LUMO_DEPLOYMENT_MODE")
        if raw is None:
            continue
        value = raw.strip()
        modes[name] = value
        if value not in VALID_MODES:
            report.fail("deployment-mode-values",
                        f"{name}: LUMO_DEPLOYMENT_MODE={raw!r} 不是 "
                        f"{sorted(VALID_MODES)} 之一；取值不精确会让 dsh-node 的上报方静默关闭（精确比较）")
    if modes:
        distinct = sorted(set(modes.values()))
        report.ok(f"部署形态取值：{distinct}")
        if expect_mode in VALID_MODES and any(m != expect_mode for m in distinct):
            report.fail("deployment-mode-values",
                        f"该拓扑自称 {expect_mode}，但有服务声明为 {distinct}；"
                        "形态不一致会让一部分进程按另一种形态装配")
    elif expect_mode in VALID_MODES:
        # 形态变量可缺失（默认 standalone），但那意味着明确期望 cluster 的拓扑没有声明集群形态。
        report.fail("deployment-mode-values",
                    f"该拓扑期望 {expect_mode} 形态，却没有任何服务声明 LUMO_DEPLOYMENT_MODE")

    # --- 3. 两个闸门的开关取值 ---------------------------------------------
    # 两个开关都是三态（未设 / true / false），打错字一律报错。它们是**独立的**：
    # 存活闸门拦「它可能不在了」，版本闸门拦「它可能版本不对」，可以只开一个。
    enforce_on = False
    for name, env in envs.items():
        raw = env.get("LUMO_CLUSTER_ENFORCE")
        if raw is None:
            continue
        value = raw.strip().lower()
        if value == "":
            continue
        if value not in VALID_ENFORCE:
            report.fail("invalid-enforce-value",
                        f"{name}: LUMO_CLUSTER_ENFORCE={raw!r} 不是 true/false（留空=由身份派生）；"
                        "打错字会让判定悄悄关掉，而『判定关着』与『全都健康』长得一样")
            continue
        if value in TRUE_WORDS:
            enforce_on = True

    version_gate_on = False
    for name, env in envs.items():
        raw = env.get("LUMO_CLUSTER_VERSION_GATE")
        if raw is None:
            continue
        value = raw.strip().lower()
        if value == "":
            continue
        if value not in VALID_ENFORCE:
            report.fail("invalid-version-gate-value",
                        f"{name}: LUMO_CLUSTER_VERSION_GATE={raw!r} 不是 true/false（留空=关闭）；"
                        "打错字会让闸门悄悄关掉，而『闸门关着』与『版本本来就一致』长得一样")
            continue
        if value in TRUE_WORDS:
            version_gate_on = True

    # --- 4. 版本闸门：开了就必须有人声明版本 -------------------------------
    # 与存活闸门**不同**：它不需要「上报方」，它需要的是「有人说出自己是什么版本」。
    # 一个都没说时 `VersionConsistency.Declared == 0` 被判定为「一致」（无信息 ≠ 矛盾），
    # 闸门恒放行 —— 开关是开的，作用为零。
    if version_gate_on:
        declarers = {n: e["LUMO_CLUSTER_VERSION"].strip()
                     for n, e in envs.items() if e.get("LUMO_CLUSTER_VERSION", "").strip()}
        if not declarers:
            report.fail("version-gate-without-declarer",
                        "LUMO_CLUSTER_VERSION_GATE 已开启，但整个拓扑没有任何服务声明 "
                        "LUMO_CLUSTER_VERSION：判定集合里一个声明都没有 → 视为『无信息一致』"
                        "→ 闸门恒放行。开关看起来生效了，实际上一分作用都没有")
        else:
            report.ok(f"版本声明方：{', '.join(f'{n}={v}' for n, v in sorted(declarers.items()))}")
            distinct = sorted(set(declarers.values()))
            if len(distinct) > 1:
                report.fail("version-gate-split-fleet",
                            f"版本闸门已开启，而拓扑里写死了 {len(distinct)} 个不同版本 "
                            f"{distinct}：按设计（§7.4.1『先完成全集群分发』）闸门会**整体**拒绝"
                            "全局放置，而它与『没有容量』同形（都是 202 + PENDING）。"
                            "滚动升级的中间状态就是这样——那就等升完再开闸门，或先把版本改齐")
    else:
        report.ok("本拓扑未开启版本一致性前置（全局放置不受版本约束）")

    if not enforce_on:
        # 没开存活判定就没有上报方的义务。但这要说出来，否则「门禁通过」会被读成
        # 「准入已经生效」。
        report.ok("本拓扑未开启集群失联判定（闸门恒放行），无需上报方")
        return
    report.ok("本拓扑开启了集群失联判定，开始核对上报方")

    # 谁真的能自报：**承载节点**（代码里 LUMO_ROLE != node 一律不报，见
    # cluster-reporter.ts 的理由——控制台/父节点代报会把「承载节点全挂」伪装成健康），
    # 外加显式认领了身份的调度实例。
    def reporter_blockers(env, mode_ok):
        blockers = []
        if not env.get("LUMO_CLUSTER_ID", "").strip():
            blockers.append("缺 LUMO_CLUSTER_ID")
        if not any(env.get(key, "").strip() for key in SCHEDULER_MODE_KEYS):
            blockers.append("缺 LUMO_SCHEDULER_URL")
        if not env.get("LUMO_CONTROL_PLANE_TOKEN", "").strip():
            blockers.append("缺 LUMO_CONTROL_PLANE_TOKEN（注册端点 503）")
        if not mode_ok:
            blockers.append(f"形态={env.get('LUMO_DEPLOYMENT_MODE', '(未声明)')}（非 cluster 一律关闭）")
        return blockers

    def is_cluster_mode(env):
        declared = env.get("LUMO_DEPLOYMENT_MODE", "").strip()
        return declared == "cluster" if declared else (expect_mode == "cluster")

    reporters = []
    for name, env in hosts.items():
        if not reporter_blockers(env, is_cluster_mode(env)):
            reporters.append(name)
    if identity:
        # 认领了身份的调度实例也会自报（RunClusterReporter），但它自报的只有它认领的
        # 那一个集群，覆盖面以声明的身份为准。
        reporters.append(f"{identity[0]}(LUMO_SCHEDULER_CLUSTER_ID)")

    # --- 7. 存活判定开着却没有任何上报方 -----------------------------------
    if not reporters:
        report.fail("enforce-without-reporter",
                    "LUMO_CLUSTER_ENFORCE 已开启，但整个拓扑没有任何上报方："
                    "所有集群都会停在 unregistered，闸门恒放行——判定看起来生效了，实际上一分作用都没有")
    else:
        report.ok(f"上报方：{', '.join(sorted(reporters))}")

    # --- 8. 每个集群的承载节点都必须能自报 ---------------------------------
    # 这一条才是要命的那个：一个永远不被登记的集群，其放置永远不受闸门约束，
    # 而它自己的承载节点会被当成「没问题的」照常接活。
    covered = set()
    for name in identity:
        covered.add(envs[name].get("LUMO_SCHEDULER_CLUSTER_ID", "").strip())
    for name, env in hosts.items():
        if reporter_blockers(env, is_cluster_mode(env)):
            continue
        covered.add(env.get("LUMO_CLUSTER_ID", "").strip())
    for cluster in clusters:
        if cluster in covered:
            continue
        # 找一个同集群的承载节点，把缺的东西点名出来，好让人知道去改哪一行。
        same = {n: e for n, e in hosts.items() if e.get("LUMO_CLUSTER_ID", "").strip() == cluster}
        if not same:
            detail = "该集群没有任何 LUMO_ROLE=node 的承载节点（谁在替它宣称存活？）"
        else:
            detail = "; ".join(
                f"{n}: {'、'.join(reporter_blockers(e, is_cluster_mode(e)))}" for n, e in same.items())
        report.fail("cluster-without-reporter",
                    f"集群 {cluster} 没有可用的上报方 —— {detail}；"
                    "它会停在 unregistered，新放置永远不受闸门约束")


def main():
    parser = argparse.ArgumentParser(description="联邦注册表静态一致性检查")
    parser.add_argument("--kind", choices=("compose", "helm"), required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--expect-mode", default=None,
                        help="cluster | standalone | local | base（base=不核对形态）")
    args = parser.parse_args()

    if not os.path.isfile(args.file):
        print(f"cluster-registry: FAIL: missing-file: {args.file}")
        return 1

    report = Report()
    services = load_services(args.kind, args.file)
    check(services, args.expect_mode, report, args.kind)
    if report.problems:
        print(f"cluster-registry: {len(report.problems)} 个不一致（共 {report.checks} 项检查）")
        return 1
    print(f"cluster-registry: {args.file} 通过（{report.checks} 项检查）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
