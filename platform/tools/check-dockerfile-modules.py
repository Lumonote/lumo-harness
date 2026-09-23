#!/usr/bin/env python3
"""每个控制面 Dockerfile 必须 COPY 它 go.mod 里 `replace` 到的**全部**兄弟模块。

## 它要防的是什么

控制面的 12 个 Go 模块彼此用 `replace ... => ../<name>` 引用（heartbeat / observability /
ratelimit）。镜像构建的上下文是 `platform/control-plane`，而 Dockerfile 逐个 COPY ——
**漏一个的后果不是「慢」，而是那个镜像根本建不出来**：

    go: github.com/lumo-harness/platform/heartbeat@v0.0.0 (replaced by ../heartbeat):
        reading /heartbeat/go.mod: open /heartbeat/go.mod: no such file or directory

2026-09-17 实测：12 个模块里 **9 个**漏了（8 个漏 heartbeat，connector-gateway 还漏 ratelimit），
于是 `build.sh --targets images` 只能产出 3 个镜像，而它是**发布路径**
（`.github/workflows/release.yml` 走它）。

## 为什么必须有静态门禁

这个缺陷要跑到 Docker 里、下完依赖、构建到第 5 层才暴露，一次十几分钟；而判据本身
只是「两个集合相等」——纯静态、秒级。更重要的是它**只在发布时才被踩到**：
开发者本地不建镜像就永远看不到。同 `helm-verify.sh` / `alerts-verify.sh` 的理由：
能被静态判定的事，不该等到运行期才发现。

## 它背后那条规则（下一个人的检索入口）

本文件查的是 Go 那一份，但缺陷的形状是通用的：

  **下依赖/构建的那一步所需的输入，必须在那一步之前就位。**

2026-09-17 一天里它在三个地方各出现一次，每次的报错都指向一个具体文件或程序：

  * 控制面 Go 模块：`replace ../<兄弟模块>` → 本文件（缺 COPY / COPY 太靠后 / 落点不一致）
  * dsh-node 的 pnpm：`pnpm-workspace.yaml` 的 `patchedDependencies` 指向 `patches/`，
    而 `patches/` 跟着整树 COPY 一起、排在 `pnpm fetch` **之后** → `ERR_PNPM_PATCH_NOT_FOUND`
  * dsh-node 的原生插件：构建要 `cc`，而 node 基镜像不带工具链 → `spawnSync cc ENOENT`

后两条在 `platform/data-plane/dsh-node/Dockerfile` 里，目前只有注释说明、没有静态门禁——
它们的判据更依赖具体工具链，写通用版容易过度拟合。**若哪天再出现第四次，就该把它抽成
一条通用的「这一步需要的东西到了吗」检查，而不是再补一段注释。**

用法：
  check-dockerfile-modules.py <control-plane 目录>      # 通过退出 0，缺陷退出 1
  check-dockerfile-modules.py --self-test               # 自证：坏样本必报、好样本必过
"""

import glob
import os
import re
import sys

REPLACE_RE = re.compile(r"replace\s+github\.com/lumo-harness/platform/(\S+)\s+=>\s+\.\./(\S+)")
COPY_RE = re.compile(r"COPY\s+([a-zA-Z0-9_-]+)\s+/")


def check(root):
    problems = []
    checked = 0
    for entry in sorted(os.listdir(root)):
        module_dir = os.path.join(root, entry)
        gomod = os.path.join(module_dir, "go.mod")
        if not os.path.isfile(gomod):
            continue
        with open(gomod, encoding="utf-8") as handle:
            replaced = {m.group(2) for line in handle for m in [REPLACE_RE.search(line)] if m}
        if not replaced:
            continue
        # **所有 `Dockerfile*`**，不只是恰好叫 `Dockerfile` 的那个。第一版只查 `Dockerfile`，
        # 于是 `registry/Dockerfile.provisioner` 整份漏检——而它带的是同一个缺陷（go.mod
        # replace 了 heartbeat，Dockerfile 只 COPY 了 observability），要到 docker 里下完
        # 依赖才炸。判据要覆盖**全部**构建入口，否则「没检到」会被读成「没问题」。
        for dockerfile in sorted(glob.glob(os.path.join(module_dir, "Dockerfile*"))):
            checked += 1
            where = os.path.relpath(dockerfile, root)
            with open(dockerfile, encoding="utf-8") as handle:
                lines = handle.read().splitlines()
            copied, positions = set(), {}
            for index, line in enumerate(lines):
                match = COPY_RE.match(line)
                if match:
                    copied.add(match.group(1))
                    positions.setdefault(match.group(1), index)
            missing = sorted(replaced - copied)
            if missing:
                problems.append(
                    f"{where} 缺少 COPY：{'、'.join(missing)} —— 它的 go.mod 里 replace 了这些"
                    f"兄弟模块，而构建上下文里没有它们，镜像会在 `go mod download` 处失败"
                    f"（错误长这样：reading /heartbeat/go.mod: no such file or directory）"
                )
                continue
            # 只认**真正的 RUN 行**，不认注释里提到它的行：给 terminal-gateway 加说明时注释里
            # 写了「在 `go mod download` 处失败」，而注释排在 COPY 之前，检查器于是把下载步骤
            # 判在了 COPY 前面、反过来报「COPY 太靠后」——一个被自己的注释触发的假警报。
            download_at = next(
                (i for i, line in enumerate(lines)
                 if line.strip().startswith("RUN") and "go mod download" in line),
                None,
            )
            if download_at is not None:
                late = sorted(d for d in replaced if positions[d] > download_at)
                if late:
                    problems.append(
                        f"{where} 的 COPY 位置在 `go mod download` 之后：{'、'.join(late)} —— "
                        f"依赖已经下完了，这一行帮不上忙，镜像仍然建不出来。"
                    )
            # **落点也要查**：go.mod 落在子目录而兄弟模块落在根时，`replace ../x` 会解析到
            # 另一个位置——文件拷进来了却找不到。terminal-gateway 2026-09-17 就是这个形态。
            # `COPY <源…> <目标>` 的源可以有多个（`go.mod go.sum`），解析必须认多源：第一版
            # 只认单源，于是 go.mod 那行根本没被解析、整段对齐检查**静默跳过**。
            workdir, gomod_dest, sibling_dest = "/", None, {}
            copy_multi = re.compile(r"COPY\s+(.+?)\s+(\S+)\s*$")
            for line in lines:
                head = line.strip()
                if head.startswith("#"):
                    continue
                if head.startswith("WORKDIR "):
                    workdir = head.split(None, 1)[1].strip()
                    continue
                match = copy_multi.match(head)
                if not match:
                    continue
                sources, dest = match.group(1).split(), match.group(2)
                if any(source.endswith("/go.mod") for source in sources):
                    gomod_dest = dest
                elif len(sources) == 1 and sources[0] in replaced:
                    sibling_dest.setdefault(sources[0], dest)
            if gomod_dest is None:
                continue
            module_root = os.path.normpath(os.path.join(workdir, gomod_dest))
            parent = os.path.dirname(module_root)
            for name, dest in sorted(sibling_dest.items()):
                actual = os.path.normpath(dest if dest.startswith("/") else os.path.join(workdir, dest))
                want = os.path.normpath(os.path.join(parent, name))
                if actual != want:
                    problems.append(
                        f"{where} 的兄弟模块落点与模块根不一致：{name} 拷到 {actual}，而 go.mod 落在 "
                        f"{module_root}（{gomod_dest}），所以 `replace ../{name}` 会去找 {want} —— "
                        f"文件拷进来了却找不到，镜像在 `go mod download` 处失败。"
                    )
    return checked, problems


SERVICES_ENV_RE = re.compile(r'^ENV\s+LUMO_CONTROL_PLANE_SERVICES="(.*)"\s*$')

# 「会走网络的步骤」：这些命令的调用行必须走 `retry`。见 network_step_invocations 的注释。
# 目前两个：Go 的模块下载，与 cargo 的构建（后者会去 crates.io 取 registry index 与 crate 包
# —— 仓库里没有 `vendor/`，也没有 `.cargo/config`）。
NETWORK_STEPS = ("go mod download", "cargo build")

# 「下载走了重试」的判据：调用行里必须出现 `retry`。
RETRY_RE = re.compile(r"\bretry\b")


def network_step_invocations(lines, steps=NETWORK_STEPS):
    """真正**调用**某个网络步骤的行（去掉注释，以及 `echo "== go mod download: …"` 这类回显）。

    回显行必须排除，而且这一条不是洁癖：Dockerfile 里为了日志可读性写着
    `echo "== go mod download: $module"`，它排在真正调用（下一行的 `retry go mod download`）
    **之前**。第一版判据取「第一处出现 `go mod download` 的行」，于是去检查了那行回显——
    它当然没有 `retry`，**正确的 Dockerfile 也红**。判据指向「提到它的行」而不是「调用它的
    行」，就会变成这种假警报（本文件 `check()` 里那条 `download_at` 也踩过同一个坑，那次是
    被自己的注释触发的）。

    返回 `(步骤, 行)` 的列表。
    """
    out = []
    for line in lines:
        head = line.strip()
        if head.startswith("#") or head.startswith(("echo ", "printf ")):
            continue
        for step in steps:
            if step in head:
                out.append((step, head))
    return out


def check_merged(root, problems):
    """合并镜像 `control-plane/Dockerfile` 的三条断言。

    2026-09-20 起控制面 12 个服务共用一个镜像（多二进制 + 部署形态用 `command:` 选入口），
    逐模块 Dockerfile 不再存在，于是上面那份「按模块查 COPY」的判据对它们**看不见**了——
    换成下面三条，覆盖同一件事的三个新形态：

      1) 构建那一步（`go mod download`）之前，整棵树必须已经在镜像里。
         合并镜像里逐个挑着 COPY 没有意义（全都要），而挑漏的形态就是本文件开头记的那次
         事故（12 个模块里 9 个各漏一个兄弟模块）。
      2) 镜像的服务清单（`ENV LUMO_CONTROL_PLANE_SERVICES`）必须与「有 `cmd/<模块名>` 的
         模块」逐一相等。少了 → 镜像里根本没有那个二进制，容器起来才报 no such file；
         多了 → 清单指向一个不存在的入口。两边都是**只在运行期暴露**的缺陷。
      3) （2026-09-21 加）**会走网络的步骤必须走重试**（目前两个：`go mod download` 与
         `cargo build`，见 NETWORK_STEPS）。触发它的是发布路径上一次真实的失败：
         `go mod download: collaborator`（12 个模块里的**第一个**）在第 61 秒拿到
         `unexpected EOF`，而当时的循环没有重试——一次瞬时抖动废掉整次 12 模块构建，且
         失败点在第一个模块，等于每次都得从头再来。同一形态在 Rust 阶段也有（crates.io，
         仓库里没有 vendor/），所以判据按「步骤」而不是按「那一条 Go 命令」来写。

    **第 3 条能证明什么、不能证明什么**：它只证明「重试没被删掉」。重试本身有效与否没法
    静态判定（有效性由 Dockerfile 里 2026-09-21 那段记的实跑结论负责）。它守的是**回归**：
    后来的人看到 `retry` 觉得是噪音、顺手抹平，构建就悄悄变回「一抖就废」——而那个缺陷
    只在网络抖动时出现，本地连跑十次都可能看不见。

    它**不**管、也**不该**管的一件事：把 cache mount 的目录直接拿去 `COPY --from`。那个错误
    是**响**的（`failed to walk …: no such file or directory`，2026-09-21 实测），而能被静态
    判定、又不会安静通过的缺陷，不需要门禁——加了只会是噪音。
    """
    merged = os.path.join(root, "Dockerfile")
    if not os.path.isfile(merged):
        return 0
    checked = 0
    with open(merged, encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    checked += 1
    whole_tree = next(
        (i for i, line in enumerate(lines)
         if re.match(r"COPY\s+\.\s+/", line.strip())),
        None,
    )
    # `go mod download` 只认**真行**，不认注释：本文件的头注释里就写着这几个字（「重新
    # `go mod download` 一遍」），而注释排在最前面——把注释当成下载步骤会让排序断言恒真。
    # 也不要求这一行以 `RUN` 开头：它在 `RUN set -eu; \` 的**续行**上（2026-09-20 实测，
    # 只认 `^RUN` 的版本因此找不到它，排序断言被整条跳过）。
    download_at = next(
        (i for i, line in enumerate(lines)
         if not line.strip().startswith("#") and "go mod download" in line),
        None,
    )
    if whole_tree is None:
        problems.append(
            f"{os.path.basename(merged)} 没有整树 COPY（`COPY . /src`）：逐模块挑着 COPY 就是"
            f" 2026-09-17 那次 9/12 漏兄弟模块的形态，而合并镜像里没有「挑」的必要"
        )
    elif download_at is not None and whole_tree > download_at:
        problems.append(
            f"{os.path.basename(merged)} 的整树 COPY 排在 `go mod download` 之后：依赖已经下完了"
            f"，这一行帮不上忙，12 个二进制一个也建不出来"
        )

    checked += 1
    declared = next(
        (SERVICES_ENV_RE.match(line).group(1).split() for line in lines
         if SERVICES_ENV_RE.match(line)),
        None,
    )
    if declared is None:
        problems.append(
            f"{os.path.basename(merged)} 里找不到 ENV LUMO_CONTROL_PLANE_SERVICES —— "
            f"判据失效（改名了？），而不能与「哪些模块有 cmd」比对"
        )
    else:
        in_tree = sorted(
            entry for entry in os.listdir(root)
            if os.path.isfile(os.path.join(root, entry, "go.mod"))
            and os.path.isdir(os.path.join(root, entry, "cmd", entry))
        )
        if sorted(declared) != in_tree:
            missing = sorted(set(in_tree) - set(declared))
            extra = sorted(set(declared) - set(in_tree))
            detail = []
            if missing:
                detail.append(f"镜像里没有它们：{'、'.join(missing)}")
            if extra:
                detail.append(f"清单里的这些模块没有 cmd/<同名>：{'、'.join(extra)}")
            problems.append(
                "ENV LUMO_CONTROL_PLANE_SERVICES 与「有 cmd/<模块名> 的模块」不相等——"
                + "；".join(detail)
            )

    checked += 1
    invocations = network_step_invocations(lines)
    if not invocations:
        # 计数守卫（同 main() 里那条）：判据作用在「调用网络步骤的行」上，而这种行一行为零时，
        # 「全都有重试」与「根本没在查」在输出上必须不同。
        problems.append(
            f"{os.path.basename(merged)} 里找不到任何网络步骤（{'、'.join(NETWORK_STEPS)}）的调用行"
            f" —— 判据失效（改名或挪走了？），而不是「没问题」"
        )
    else:
        for step, head in invocations:
            if not RETRY_RE.search(head):
                problems.append(
                    f"{os.path.basename(merged)} 的 `{step}` 没有走重试：{head} —— 2026-09-21 实测过，"
                    f"一次瞬时抖动就废掉整次构建：Go 侧那次是 `unexpected EOF`，而失败点还在 12 个"
                    f"模块里的**第一个**；Rust 侧那条 `cargo build` 占整次构建的 95.8s/104s，且改一个"
                    f"src 文件就会让它重新下 registry。写成 `retry {step} …`（retry 定义在同一条 RUN 里）"
                )
    return checked


# `--self-test` 的样本：第 3 条判据作用在**单行**上（调用网络步骤的那一行），所以样本就是一行。
# 两类最容易写错的样本都在里面：**回显行**必须被排除（否则正确的 Dockerfile 也红——第一版判据
# 的错法，写在 network_step_invocations 的注释里），以及**每个步骤各自**都要走 retry
# （只给 Go 那条加、忘了 cargo 那条，是最可能的漏法）。
NETWORK_GOOD_LINES = [
    '      (cd "/src/$module" && retry go mod download); \\',
    '      echo "== go mod download: $module"; \\',
    '    retry cargo build --release --manifest-path yrs-kernel/Cargo.toml; \\',
]
NETWORK_BAD_LINES = [
    '      (cd "/src/$module" && go mod download); \\',
    '      for module in $LUMO_CONTROL_PLANE_SERVICES; do go mod download; done; \\',
    '    cargo build --release --manifest-path yrs-kernel/Cargo.toml; \\',
]


def unretried(lines):
    """样本级的小工具：返回「调用了网络步骤却没走 retry」的那些行。"""
    return [head for _, head in network_step_invocations(lines) if not RETRY_RE.search(head)]


def self_test():
    """自证：判据被删空/被收窄时先在这里红，而不是在真实 Dockerfile 上安静地绿下去。"""
    failures = 0
    for sample in NETWORK_GOOD_LINES:
        caught = unretried([sample])
        if caught:
            print(f"self-test: FAIL: 好样本被误报：{sample!r} -> {caught}", file=sys.stderr)
            failures += 1
    for sample in NETWORK_BAD_LINES:
        if not unretried([sample]):
            print(f"self-test: FAIL: 坏样本没被抓住：{sample!r}", file=sys.stderr)
            failures += 1
    if failures:
        return 1
    print(f"check-dockerfile-modules: self-test 通过（{len(NETWORK_GOOD_LINES)} 个好样本不报、"
          f"{len(NETWORK_BAD_LINES)} 个坏样本必报）")
    return 0


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()
    if len(sys.argv) != 2:
        print("usage: check-dockerfile-modules.py <control-plane 目录> | --self-test", file=sys.stderr)
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        print(f"FAIL: 目录不存在：{root}", file=sys.stderr)
        return 2
    checked, problems = check(root)
    checked_merged = check_merged(root, problems)
    if checked + checked_merged == 0:
        # 计数守卫：一个都没查到与「全都对」无法区分，而这正是本仓库在 CI 上吃过的亏。
        print("FAIL: 没有找到任何「有 replace 的控制面模块」——判据本身失效了（路径写错了？）", file=sys.stderr)
        return 1
    if problems:
        for problem in problems:
            print(f"FAIL: {problem}", file=sys.stderr)
        return 1
    print(f"dockerfile-modules: OK（{checked} 个模块的 replace 被对应 Dockerfile COPY，"
          f"{checked_merged} 条合并镜像断言）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
