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


def main():
    if len(sys.argv) != 2:
        print("usage: check-dockerfile-modules.py <control-plane 目录>", file=sys.stderr)
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        print(f"FAIL: 目录不存在：{root}", file=sys.stderr)
        return 2
    checked, problems = check(root)
    if checked == 0:
        # 计数守卫：一个都没查到与「全都对」无法区分，而这正是本仓库在 CI 上吃过的亏。
        print("FAIL: 没有找到任何「有 replace 的控制面模块」——判据本身失效了（路径写错了？）", file=sys.stderr)
        return 1
    if problems:
        for problem in problems:
            print(f"FAIL: {problem}", file=sys.stderr)
        return 1
    print(f"dockerfile-modules: OK（{checked} 个模块的 replace 全部被对应 Dockerfile COPY）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
