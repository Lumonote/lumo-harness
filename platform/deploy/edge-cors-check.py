#!/usr/bin/env python3
"""边缘网关 CORS 接线的一致性检查：部署侧声明的名字必须是代码真正读的那个名字。

## 它要防的是什么

edge-gateway 上有**两层 CORS**，语义不同：

  * `gate.CORS`（`internal/gate`）—— 边缘自己的白名单，按**请求的 Origin** 裁决。
    变量名由 `cmd/edge-gateway/main.go` 的 `--cors-origins` 旗标决定
    （当前是 `LUMO_EDGE_CORS_ORIGINS`）。
  * `observability.Middleware` —— 按**配置的来源**把 `Access-Control-Allow-Origin`
    写死（当前是 `LUMO_CORS_ORIGIN`）。`gate.go:122-124` 明确要求部署 edge-gateway 时
    **不要再设**它，否则两套头叠在同一个响应上，行为取决于哪一层写在后面。

两件事各自都对，错法只出现在跨文件对照上，而且**症状是「能用」**：2026-09-16 实测
`compose.cluster.yml` 与 `compose.standalone.yml` 给 edge-gateway 设的正是
`LUMO_CORS_ORIGIN`，于是边缘白名单一直是空的、边缘层根本没在管事——中间件那一层替它把
preflight 答了，curl 与手测全都正常，没有任何静态检查会拦住它。这与 `cluster-registry`
的「判定开着却没人自报」是同一种病：配置看起来对、语义是错的。

## 判据从代码推导，不是写死的字符串

「部署里有没有 `LUMO_EDGE_CORS_ORIGINS`」是错的判据：代码把旗标改个名，门禁会继续绿，
而部署侧那一行就成了废配置。所以这里先读源码推导出两个变量名，推导不出来就报
`cors-rule-not-derived`**而不是放行**（一个失效的门禁与一个通过的门禁无法区分）。

推导规则：
  * 白名单变量 = `*/cmd/*/main.go` 里含 `"cors-origins"` 的那一行上的 `envOr("X", ...)`。
    每个这样的服务都是一个「自带 CORS 白名单的网关」。
  * 中间件变量 = `observability/metrics.go` 里写 `Access-Control-Allow-Origin` 的那一处
    往上最近的一个 `os.Getenv("X")`；必须**恰好一个**，多于一个说明锚点漂了，报错而不是猜。

## 规则

1. `required-service-absent` —— `--require-gateways` 时，推导出的网关服务必须出现在本面里。
   拓扑把一个入口网关删掉/改名，别的地方不会红，只有这里会。
2. `gateway-cors-missing` —— 白名单变量缺失、解析为空、或不可判定（`<unresolved>`）。
   空白名单 = 边缘 CORS 层静默失效，而中间件那一层会把它盖住，症状是「一切正常」。
3. `dual-cors-source` —— 同一个容器上中间件那个变量被设成了**非空值**：两套 CORS 头叠加。
   注意判据是「非空」而不是「不出现」：Helm 侧的正确写法恰恰是把它显式设成空串让中间件
   整条跳过（它判 `!= ""`），把这一写法判成违规等于逼人删掉正确的覆盖。
4. `cors-rule-not-derived` / `topology-not-parsed` —— 计数守卫。解析不出服务、或推导不出
   规则名时一律失败，不许「什么都没发现所以通过」。

Helm 面多一条（`envFrom` 注入）：共享 ConfigMap 会把中间件那个变量注入**每个**服务，所以
容器必须用空值覆盖它。判据是「ConfigMap 里非空 **且** 容器没有覆盖成空」才报——单看容器
会把「没覆盖」漏掉（那行空串存在的理由正是这个），单看 ConfigMap 会把正确的覆盖判成违规。

## 形态差异（为什么非空要求不是无条件的）

  * compose 的 dev 拓扑显式钉了开发来源，所以 `--require-gateways` 下白名单必须**非空**；
  * Helm 基础 profile 默认 `console.corsOrigin: ""`，渲染出的白名单是空串——那是
    「没配来源 = 不放行任何跨域」的 fail-closed 默认，**不是**缺陷。所以 Helm 面的非空
    要求绑定在「共享 ConfigMap 里的中间件来源非空」这个**配置事实**上，而不是无条件要求
    非空；两种情形各自打印 OK 行，避免「通过」等于沉默。

## 依赖

只用标准库（与 `alerts-verify.sh` / `cluster-registry-check.py` 同一口径：不 import 任何
第三方库）。YAML 按行读，所以上面的计数守卫是必需品，不是装饰。

用法：
  edge-cors-check.py --kind compose --file <compose.yml> [--require-gateways]
  edge-cors-check.py --kind helm    --file <rendered.yaml> [--require-gateways]
"""

import argparse
import glob
import os
import re
import sys

SERVICE_KEY_RE = re.compile(r"^  ([a-z0-9][a-z0-9_-]*):\s*(?:#.*)?$")
# 单行内联映射形态：`vault: { image: "...", environment: ["K=V"], command: [...] }`。
# 这个形态真实存在于 compose.cluster.yml，**必须**能读：漏掉它不只是少一个服务，
# 而是「这个服务有没有受检网关的接线」永远没人看。
SERVICE_INLINE_RE = re.compile(r"^  ([a-z0-9][a-z0-9_-]*):\s*\{(.*)\}\s*$")
# 形如服务键但没被上面两种收下的行。漏掉服务键的后果是**静默**的：门禁少看一个服务
# 与那个服务没问题在退出码上一样，所以这里主动报出来。
# 2026-09-16 实测：`  embedding:   # 尾随注释` 就因为 `$` 卡在冒号后面而被整条漏掉，
# 而那条拓扑里恰好没有受检网关，于是「漏看」与「没问题」完全无法区分。
SERVICE_LIKE_RE = re.compile(r"^  ([a-z0-9][a-z0-9_-]*):")
INLINE_ENV_RE = re.compile(r"^\s*-?\s*environment:\s*\[(.*)\]\s*$")
ENV_MAPPING_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$")
ENV_ASSIGN_RE = re.compile(r"^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
INTERP_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?]?)([^}]*)\}")

HELM_CONTAINER_RE = re.compile(r"^\s*-\s*name:\s*(\S+)\s*$")
HELM_ENV_NAME_RE = re.compile(r"^\s*-\s*name:\s*([A-Z][A-Z0-9_]*)\s*$")
HELM_VALUE_RE = re.compile(r"^\s*value:\s*(.*)$")
HELM_DOC_KIND_RE = re.compile(r"^kind:\s*(\S+)\s*$")
HELM_META_NAME_RE = re.compile(r"^  name:\s*(\S+)\s*$")
HELM_CM_DATA_RE = re.compile(r"^  ([A-Z][A-Z0-9_]*):\s*(.*)$")
HELM_CONFIGMAP_REF_RE = re.compile(r"configMapRef:\s*\{\s*name:\s*([^,}]+?)\s*\}")

# 代码侧的三个锚点。任何一个漂了都要报错，不能静默降级成「没有规则要查」。
CORS_FLAG_RE = re.compile(r'"cors-origins"')
ENVOR_RE = re.compile(r'envOr\("([A-Z][A-Z0-9_]*)"')
ACAO_RE = re.compile(r"Access-Control-Allow-Origin")
GETENV_RE = re.compile(r'os\.Getenv\("([A-Z][A-Z0-9_]*)"\)')
# ACAO 写入点与它读的那个变量最多隔多少行。上限写死是刻意的：锚点漂远之后
# 「找不到变量」比「找到隔壁函数的变量」安全。
ACAO_LOOKBACK = 15

UNRESOLVED = "<unresolved>"
FROM_ENV = "<from-environment>"


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def resolve(value):
    """把 compose 的变量插值折叠成一个可判定的值（口径同 cluster-registry-check.py）。

    `${VAR:-default}` 取 default；`${VAR:?msg}` 是「必须由宿主提供」，按已知非空算；
    `${VAR}` / `${VAR:-}` 无法判定，折叠成 `<unresolved>`。分这三种是必要的：把「宿主
    必须提供」读成空会报出一堆不存在的缺配，而把「无法判定」读成非空会让真缺配溜过去——
    对本检查而言后者更危险，因为白名单为空正是那个静默失效形态。
    """

    def substitute(match):
        operator, argument = match.group(2), match.group(3)
        if operator in (":-", "-"):
            return argument if argument else UNRESOLVED
        if operator in (":?", "?"):
            return FROM_ENV
        return UNRESOLVED

    return INTERP_RE.sub(substitute, value)


def whitelist_is_wired(value):
    """白名单变量的值算不算「真的接线了」。空与不可判定都不算。"""
    return value is not None and value.strip() not in ("", UNRESOLVED)


def env_is_nonempty(value):
    """中间件变量是否被设成了非空值——只有这一种情况才是「两套 CORS 叠加」。"""
    return value is not None and value.strip() != ""


def parse_compose(path):
    """按行收集每个服务的环境变量。后出现的覆盖先出现的（compose 自身语义）。

    统一成 `{name: {"env": {...}, "config_maps": []}}`：compose 侧没有 envFrom 这一层，
    config_maps 恒空，好让检查主体只有一份。
    """
    services = {}
    unparsed = []
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
                services.setdefault(current, {"env": {}, "config_maps": []})
                continue
            match = SERVICE_INLINE_RE.match(line)
            if match:
                current = match.group(1)
                inline = services.setdefault(current, {"env": {}, "config_maps": []})
                for pair in re.findall(r'"([^"]+)"', match.group(2)):
                    # 内联体里还有 image/command 这类带引号但不带 `=` 的项；只认 K=V 形状，
                    # 否则 env 里会多出 `hashicorp/vault:latest` 这样的假键。
                    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", pair):
                        key, _, value = pair.partition("=")
                        inline["env"][key] = resolve(unquote(value))
                continue
            if SERVICE_LIKE_RE.match(line):
                unparsed.append(stripped)
                continue
            if current is None:
                continue
            env = services[current]["env"]
            match = INLINE_ENV_RE.match(line)
            if match:
                for pair in re.findall(r'"([^"]+)"', match.group(1)):
                    key, _, value = pair.partition("=")
                    env[key.strip()] = resolve(unquote(value))
                continue
            match = ENV_ASSIGN_RE.match(line)
            if match:
                env[match.group(1)] = resolve(unquote(match.group(2)))
                continue
            match = ENV_MAPPING_RE.match(line)
            if match and match.group(1).isupper():
                env[match.group(1)] = resolve(unquote(match.group(2)))
                continue
    return services, unparsed


def parse_helm(path):
    """把渲染结果里的容器当成「服务」，同时把 ConfigMap 的 data 收出来。

    容器认定与 cluster-registry-check.py 同一口径：`- name: X` 的下一个非空行必须是
    `image:`。只靠「名字是全大写」区分不行——`ports:` / `volumes:` 里也有 `- name:`，
    它们会把「当前容器」抢走，于是后面整段 env 记到别的名字下（报出不存在的缺配，
    或者更糟：漏掉真的缺配）。
    """
    with open(path, "r", encoding="utf-8") as handle:
        lines = [line.rstrip("\n") for line in handle]

    services = {}
    config_maps = {}
    current = None
    pending_key = None
    kind = None
    cm_name = None
    in_cm_data = False

    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("---"):
            current, pending_key, kind, cm_name, in_cm_data = None, None, None, None, False
            continue
        match = HELM_DOC_KIND_RE.match(line)
        if match:
            kind = match.group(1)
            in_cm_data = False
            continue
        if kind == "ConfigMap":
            if cm_name is None:
                match = HELM_META_NAME_RE.match(line)
                if match:
                    cm_name = match.group(1).strip("\"'")
                    config_maps.setdefault(cm_name, {})
                    continue
            if stripped == "data:":
                in_cm_data = True
                continue
            if in_cm_data:
                match = HELM_CM_DATA_RE.match(line)
                if match:
                    config_maps[cm_name][match.group(1)] = unquote(match.group(2))
                continue
            continue

        match = HELM_ENV_NAME_RE.match(line)
        if match:
            pending_key = match.group(1)
            if current is not None:
                current["env"].setdefault(pending_key, "")
            continue
        if pending_key is not None:
            match = HELM_VALUE_RE.match(line)
            if match:
                if current is not None:
                    current["env"][pending_key] = unquote(match.group(1))
                pending_key = None
                continue
            if stripped.startswith("valueFrom:"):
                # 值来自 Secret/ConfigMap 引用：存在但不可知，按非空算，免得把
                # 「引用了一个 Secret」误判成「没配」。
                if current is not None:
                    current["env"][pending_key] = FROM_ENV
                pending_key = None
                continue
        match = HELM_CONFIGMAP_REF_RE.search(line)
        if match and current is not None:
            ref = match.group(1).strip("\"'")
            if ref not in current["config_maps"]:
                current["config_maps"].append(ref)
        match = HELM_CONTAINER_RE.match(line)
        if match and next_non_empty(lines, index).strip().startswith("image:"):
            name = match.group(1).strip("\"'")
            current = services.setdefault(name, {"env": {}, "config_maps": []})
    return services, config_maps


def next_non_empty(lines, index):
    for line in lines[index + 1:]:
        if line.strip():
            return line
    return ""


def derive_gateway_whitelist_envs(code_root):
    """哪些服务自带 CORS 白名单，以及它读的变量名——从**代码**推，不是写死的常量。"""
    found = {}
    for main in sorted(glob.glob(os.path.join(code_root, "*", "cmd", "*", "main.go"))):
        # 服务名取相对 code_root 的第一段（`<service>/cmd/<binary>/main.go`）。用相对路径
        # 而不是 dirname 套几层：层数写错一次就会把服务名读成 `cmd`，而那种错误的表现是
        # 「每个部署面都缺一个叫 cmd 的服务」——看起来像拓扑问题，不像推导问题。
        service = os.path.relpath(main, code_root).split(os.sep)[0]
        try:
            with open(main, "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError:
            continue
        for line in text.splitlines():
            if not CORS_FLAG_RE.search(line):
                continue
            match = ENVOR_RE.search(line)
            if match:
                found.setdefault(service, match.group(1))
    return found


def derive_middleware_env(code_root):
    """中间件的 CORS 来源变量名：从 ACAO 的写入点往上找最近的一个 os.Getenv。"""
    path = os.path.join(code_root, "observability", "metrics.go")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = [line.rstrip("\n") for line in handle]
    except OSError:
        return []
    names = []
    for index, line in enumerate(lines):
        if not ACAO_RE.search(line):
            continue
        for back in range(index, max(-1, index - ACAO_LOOKBACK) - 1, -1):
            match = GETENV_RE.search(lines[back])
            if match:
                names.append(match.group(1))
                break
    return sorted(set(names))


class Report:
    def __init__(self):
        self.problems = []
        self.checks = 0

    def ok(self, message):
        self.checks += 1
        print(f"edge-cors: OK: {message}")

    def fail(self, rule, message):
        self.checks += 1
        self.problems.append((rule, message))
        print(f"edge-cors: FAIL: {rule}: {message}")


def check_surface(services, config_maps, gateways, middleware_envs, require_gateways, report, label):
    """config_maps 为 None 表示 compose 面（没有 envFrom 注入这一层），否则是 dict。"""
    # --- 计数守卫 ---------------------------------------------------------
    if not services:
        report.fail("topology-not-parsed", f"{label} 里一个服务也没解析出来（解析失效？）")
        return
    if not middleware_envs:
        report.fail("cors-rule-not-derived",
                    "observability 的 ACAO 写入点读的是哪个变量推导不出来——锚点漂了？"
                    "推导不出就必须报错：没有规则要查与规则全都通过，退出码完全一样")
        return
    if len(middleware_envs) > 1:
        report.fail("cors-rule-not-derived",
                    f"ACAO 写入点附近出现多个 os.Getenv 变量 {middleware_envs}，无法确定哪个是 CORS 来源；"
                    "猜一个等于拿一个可能错的判据继续放行")
        return
    if not gateways:
        report.fail("cors-rule-not-derived",
                    "代码里没有任何 `--cors-origins` 旗标——边缘网关的 CORS 白名单变量名无从推导"
                    "（旗标被改名/删除，部署侧写的那一行也就成了废配置）")
        return

    middleware_env = middleware_envs[0]
    report.ok(f"{label}：解析出 {len(services)} 个服务；代码侧——白名单变量="
              f"{ {k: v for k, v in sorted(gateways.items())} }、中间件来源变量={middleware_env}")

    checked = 0
    for gateway, whitelist_env in sorted(gateways.items()):
        service = services.get(gateway)
        if service is None:
            if require_gateways:
                report.fail("required-service-absent",
                            f"{label} 里没有 {gateway} 服务，而它自带 CORS 白名单（{whitelist_env}）"
                            "——入口网关被删掉或改名了？")
            continue
        checked += 1
        env = service["env"]

        # --- 先看部署里有没有「配了来源」这个事实 ---------------------------
        # 它同时决定两件事：白名单该不该非空、以及中间件那层是否已经开着。
        # 注意「配了来源」的证据**只能**取自共享 ConfigMap（运维的旋钮）：容器里那行空串
        # 是**覆盖**，不是「没配来源」的证据——把覆盖读成「没配」会让「模板丢了来源回退、
        # 渲染出空白名单而中间件那层仍开着」这种真实缺陷被判成 fail-closed 默认（实测过）。
        cm_sources = []
        if config_maps is not None:
            for ref in service["config_maps"]:
                from_cm = (config_maps.get(ref) or {}).get(middleware_env)
                if env_is_nonempty(from_cm):
                    cm_sources.append((ref, from_cm.strip()))
        middleware_declared = env.get(middleware_env)
        origin_configured = bool(cm_sources) or env_is_nonempty(middleware_declared)
        # 只有「容器完全没声明」时，envFrom 的注入才会真的生效——容器声明了空值就是
        # **正确的覆盖**，把它也算成注入等于逼人删掉那行空串。
        injected = [] if middleware_declared is not None else cm_sources

        # --- 1. 白名单必须真的接线了 --------------------------------------
        value = env.get(whitelist_env)
        wired = whitelist_is_wired(value)
        if config_maps is None:
            # compose 的 dev 拓扑由构造保证非空（`${LUMO_CORS_ORIGIN:-<dev 来源>}`），
            # 所以缺失/空值/不可判定一律是接线断了，没有「未配置」这一档。
            require_wired, why_not = True, ""
        else:
            # Helm 面：基础 profile 默认 console.corsOrigin=""，渲染出的白名单就是空串。
            # 那是「没配来源 = 不放行任何跨域」的 fail-closed 默认，与中间件那层的取值
            # 一致，不是缺陷；只有当部署里**确实配了来源**时，空白名单才是接线断了。
            require_wired = origin_configured
            why_not = ("部署里没有任何非空的 CORS 来源（console.corsOrigin 未设、"
                       "edgeGateway.corsOrigins 为空），容器也已把中间件那层设成空串："
                       "两侧一致地不放行跨域，这是 fail-closed 默认而不是接线断了")
        if wired:
            report.ok(f"{gateway}: {whitelist_env} 已接线（按请求 Origin 裁决的边缘白名单）")
        elif not require_wired:
            report.ok(f"{gateway}: {whitelist_env} 为空且允许为空 —— {why_not}")
        elif value is None:
            report.fail("gateway-cors-missing",
                        f"{gateway}: 未声明 {whitelist_env} —— 边缘白名单为空，"
                        f"{gateway} 的边缘 CORS 层等于不存在，而中间件那一层会把它盖住"
                        "（症状是「一切正常」）")
        elif value.strip() == UNRESOLVED:
            report.fail("gateway-cors-missing",
                        f"{gateway}: {whitelist_env} 的值无法静态判定（{value}）——按 fail-closed 处理："
                        "无法判定就不算接线，别让一个空白名单溜过门禁")
        else:
            report.fail("gateway-cors-missing",
                        f"{gateway}: {whitelist_env} 被设成了空值 —— 空白名单与「没声明」在实际行为上是"
                        "同一件事：边缘层不再放行任何跨域，却没有一行日志说它没在管事")

        # --- 2. 中间件那一层不得同时开着 -----------------------------------
        if injected:
            ref, value = injected[0]
            report.fail("dual-cors-source",
                        f"{gateway}: 共享 ConfigMap {ref} 注入 {middleware_env}={value!r}，"
                        "而容器没有用空值覆盖它 —— envFrom 的注入会被容器 env 覆盖，"
                        "所以容器里那行空串不是冗余，删掉就等于把中间件那层 CORS 又打开了；"
                        "两套头叠在同一个响应上，行为取决于哪一层写在后面")
        elif env_is_nonempty(middleware_declared):
            report.fail("dual-cors-source",
                        f"{gateway}: 容器自己把 {middleware_env} 设成了非空值 —— observability 中间件"
                        "按「配置的来源」写死 ACAO，边缘层按「请求的 Origin」裁决，两套头叠在同一个"
                        f"响应上，行为取决于哪一层写在后面（gate.go:122-124 要求部署 {gateway} 时不要设它）")
        else:
            why = ("容器未设该变量" if config_maps is None
                   else "容器已用空值覆盖它" if middleware_declared is not None
                   else "共享 ConfigMap 里它为空")
            report.ok(f"{gateway}: {middleware_env} 没有构成第二层 CORS（{why}）")

    if checked == 0 and not require_gateways:
        # 不是缺陷，但必须说出来：否则「通过」会被读成「这个面被核对过了」。
        report.ok(f"{label}：本面不含任何自带 CORS 白名单的网关（可选拓扑），未做网关检查")


def main():
    parser = argparse.ArgumentParser(description="边缘网关 CORS 接线一致性检查")
    parser.add_argument("--kind", choices=("compose", "helm"), required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--code-root",
                        default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                             os.pardir, "control-plane"))
    parser.add_argument("--require-gateways", action="store_true",
                        help="推导出的网关服务必须出现在本面里（入口网关不得被悄悄删掉）")
    args = parser.parse_args()

    if not os.path.isfile(args.file):
        print(f"edge-cors: FAIL: missing-file: {args.file}")
        return 1

    report = Report()
    gateways = derive_gateway_whitelist_envs(args.code_root)
    middleware_envs = derive_middleware_env(args.code_root)

    if args.kind == "compose":
        services, unparsed = parse_compose(args.file)
        config_maps = None
        if unparsed:
            # 先报这个再谈别的：漏看服务键会让后面的每一条结论都建立在残缺的拓扑上。
            report.fail("topology-not-parsed",
                        f"{os.path.basename(args.file)} 里这些形如服务键的行没被解析进来：{unparsed}"
                        "——漏看一个服务与那个服务没问题，在退出码上完全一样")
            print(f"edge-cors: {len(report.problems)} 个不一致（共 {report.checks} 项检查）")
            return 1
    else:
        services, config_maps = parse_helm(args.file)

    check_surface(services, config_maps, gateways, middleware_envs,
                  args.require_gateways, report, os.path.basename(args.file))

    if report.problems:
        print(f"edge-cors: {len(report.problems)} 个不一致（共 {report.checks} 项检查）")
        return 1
    print(f"edge-cors: {args.file} 通过（{report.checks} 项检查）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
