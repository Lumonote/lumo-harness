#!/usr/bin/env python3
"""corepack 解析出的 pnpm 版本必须是**钉死的**，不能交给运行期去取 latest。

## 它要防的是什么（2026-09-20 实测）

`lumo-platform-standalone-dsh-node-1` 无限重启，日志里是

    ERR_PNPM_BAD_PM_VERSION: This project is configured to use 11.7.0 of pnpm.
    Your current pnpm is v12.5.1

链条有三环，每一环单独看都像是对的：

1. 镜像里写的是 `corepack prepare pnpm@11.7.0` —— 而 corepack 0.3x 起 `prepare` **只把版本
   下进缓存、不再设默认版本**。缓存里躺着 11.7.0，但它不是默认。这行**看起来**钉住了版本。
2. 运行期 `profileManagerEnv` 导出 `COREPACK_ENABLE_PROJECT_SPEC=0`（本意：别让 corepack 去
   探测父项目的 packageManager），于是 corepack 既不读项目 pin、也没有默认版本可用。
3. 结果它去下 **latest**：容器日志里逐字是 `Downloading the pnpm 12.5.1 binary for linux-x64...`，
   而 pnpm 12.5.1 拿 dsh 根 `packageManager: pnpm@11.7.0` 一校验就退出。

**这是定时炸弹，不是回归**：latest 一直在运行期拉，只要它等于 pin 就相安无事，走到 pin 之外
的那天才响——与当天有没有改代码无关。所以判据不能是「今天能跑」，只能是「版本从哪来」。

## 三条判据

* R1 **禁止 `corepack prepare`**：它会让人以为钉住了版本。要设默认版本用 `corepack install
  --global`（`--activate` 亦可）。
* R2 **所有 pin 必须一致**：`packageManager: "pnpm@X"`（各 package.json）与
  `corepack install --global pnpm@Y`（镜像/脚本）里的 X、Y 必须相等。两份手抄的判据分叉时，
  症状是容器启动即 `ERR_PNPM_BAD_PM_VERSION`，而本地（不跑那个镜像）永远看不到。
* R3 **每个 corepack 入口都要装默认版本**：凡是自己 `export COREPACK_ENABLE_PROJECT_SPEC=0`
  的运行期入口（桌面 runtime），或自己 `corepack enable` 的镜像，都必须由**同一个文件**给出
  `corepack install --global pnpm@`。少了它，那个入口就会去下 latest。

## 扫的是**被跟踪的文件**，且**只看代码**

`git ls-files` 而不是遍历目录：desktop 的 `dist/`、`target/` 里躺着旧构建拷贝的 Dockerfile
（含旧的 `corepack prepare`），它们不是判据、还会天天变；被跟踪 = 人写的那份。

同样地，注释一律抹掉再看（见 `strip_comments`）：判据只该看代码，不该校对散文。这条与
「文档不算判据」同源——`ci.yml` 里解释 R1 由来的那段注释逐字写着 `corepack prepare`，
只按后缀扫就会报假警报，而正确的仓库永远红。

用法：`platform/tools/check-corepack-pin.py`（通过退出 0，缺陷退出 1）
"""

import os
import re
import subprocess
import sys

# 判据自己会出现这些字符串（R1 的正则就写着 `corepack prepare`），跳过自身。
SELF = os.path.abspath(__file__)

PREPARE_RE = re.compile(r"corepack\s+prepare\b")
INSTALL_RE = re.compile(r"corepack\s+install\s+(?:--global|-g|--activate)\s+pnpm@([^\s\"'\\]+)")
ENABLE_RE = re.compile(r"corepack\s+enable\b")
# 只认 shell 形式的 export：TS 里那个 `COREPACK_ENABLE_PROJECT_SPEC: '0'`（plugins.ts）是给
# 子进程的 env，它对应的默认版本在镜像的 Dockerfile 里，不在同一个文件——用同文件判据会误报。
EXPORT_PROJECT_SPEC_RE = re.compile(r"^\s*export\s+COREPACK_ENABLE_PROJECT_SPEC=0\b", re.MULTILINE)
PACKAGE_MANAGER_RE = re.compile(r'"packageManager"\s*:\s*"pnpm@([^"]+)"')

MAX_BYTES = 1 << 20  # 判据文件都是文本；1MB 以上的不当判据读，避免把二进制拖进来

# 只扫代码/构建文件。**文档不算判据**：`docs/implementation-status.md` 里就写着这次事故的
# 经过（含 `corepack prepare` 这几个字），把它当用法等于让门禁去校对散文——第一次跑就报了
# 两条假警报，而假警报的代价是下一个人把门禁改弱。
SCAN_SUFFIXES = (
    ".sh", ".bash", ".zsh", ".ps1", ".cmd", ".bat",
    ".mjs", ".cjs", ".js", ".ts", ".tsx", ".json",
    ".yml", ".yaml", ".toml", ".mk",
)


def is_scanned(rel):
    name = os.path.basename(rel)
    if name.startswith("Dockerfile") or name == "Makefile":
        return True
    return name.endswith(SCAN_SUFFIXES)


# 注释也要抹掉，理由与上面「文档不算判据」完全相同：`ci.yml` 里那段解释 R1 由来的注释
# 逐字写着 `corepack prepare`，只按后缀扫就把它当成了用法——**门禁自己去校对散文**，
# 于是这份判据第一次跑就报假警报，而正确的仓库也永远红。假警报的代价是下一个人把门禁
# 改弱，所以这里必须按语言抹注释，而不是把 `ci.yml` 加进白名单（那是把整份 CI 配置移出
# 判据范围，而 CI 恰恰是 corepack 入口最集中的地方）。
#
# 抹成**等长空白**而不是删行：行号与偏移都不变，报错位置仍指向原文件。
JS_SUFFIXES = (".js", ".mjs", ".cjs", ".ts", ".tsx")
HASH_COMMENT_SUFFIXES = (
    ".sh", ".bash", ".zsh", ".ps1", ".yml", ".yaml", ".toml", ".mk",
)
HASH_COMMENT_RE = re.compile(r"(?:^|[ \t])#[^\n]*", re.MULTILINE)
# `(?<![:/])` 挡掉 `https://` 这类协议前缀，别把字符串里的 URL 之后整行当注释。
JS_LINE_COMMENT_RE = re.compile(r"(?<![:/])//[^\n]*")
JS_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)


def _blank(match):
    return re.sub(r"[^\n]", " ", match.group(0))


def strip_comments(text, rel):
    name = os.path.basename(rel)
    if name.endswith(JS_SUFFIXES):
        text = JS_BLOCK_COMMENT_RE.sub(_blank, text)
        return JS_LINE_COMMENT_RE.sub(_blank, text)
    if name.startswith("Dockerfile") or name == "Makefile" or name.endswith(HASH_COMMENT_SUFFIXES):
        return HASH_COMMENT_RE.sub(_blank, text)
    return text


def tracked_files(root):
    out = subprocess.run(
        ["git", "-C", root, "ls-files"], capture_output=True, text=True, check=True
    ).stdout
    return [line for line in out.split("\n") if line]


def read(path):
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return None
        with open(path, encoding="utf-8", errors="strict") as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError):
        return None


def main():
    if len(sys.argv) != 1:
        print("usage: check-corepack-pin.py", file=sys.stderr)
        return 2
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    try:
        files = tracked_files(root)
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        print(f"FAIL: 取不到被跟踪文件列表（{error}）——判据失效，不当作通过", file=sys.stderr)
        return 1

    problems = []
    pins = {}          # pin 值 -> [出处]
    prepare_sites = 0
    install_sites = 0
    entry_points = 0

    for rel in files:
        path = os.path.join(root, rel)
        if os.path.abspath(path) == SELF or not is_scanned(rel):
            continue
        text = read(path)
        if text is None:
            continue
        # 只看代码，不看注释：见 strip_comments 的说明。
        code = strip_comments(text, rel)

        for match in PREPARE_RE.finditer(code):
            line = code[: match.start()].count("\n") + 1
            prepare_sites += 1
            problems.append(
                f"{rel}:{line} 用了 `corepack prepare` —— corepack 0.3x 起它只把版本下进缓存、"
                f"**不设默认版本**。没有默认版本时，`COREPACK_ENABLE_PROJECT_SPEC=0` 的入口会去下"
                f" latest，而 latest 漂到 pin 之外那天就是 ERR_PNPM_BAD_PM_VERSION（2026-09-20 "
                f"dsh-node 实测）。改用 `corepack install --global pnpm@<pin>`。"
            )

        for match in INSTALL_RE.finditer(code):
            install_sites += 1
            pins.setdefault(match.group(1), []).append(rel)

        for match in PACKAGE_MANAGER_RE.finditer(code):
            pins.setdefault(match.group(1), []).append(rel)

        needs_default = False
        if EXPORT_PROJECT_SPEC_RE.search(code):
            needs_default = True
        if ENABLE_RE.search(code) and os.path.basename(rel).startswith("Dockerfile"):
            needs_default = True
        if needs_default:
            entry_points += 1
            if not INSTALL_RE.search(code):
                problems.append(
                    f"{rel} 是 corepack 的入口（自行 export COREPACK_ENABLE_PROJECT_SPEC=0 或 "
                    f"`corepack enable`），但同一个文件里没有 `corepack install --global pnpm@…`"
                    f" —— 它会以「没有默认版本」启动，第一次用到 pnpm 时去下 latest。"
                )

    # 计数守卫：一个都没扫到与「全都对」在退出码上一样，而这正是本仓库在 CI 上吃过的亏。
    if install_sites == 0:
        problems.append(
            "一个 `corepack install --global pnpm@…` 都没扫到 —— 判据本身失效了（改名？路径写错？），"
            "不当作通过"
        )
    if len(pins) > 1:
        detail = "；".join(f"{version}（{', '.join(sorted(set(sites)))}）" for version, sites in sorted(pins.items()))
        problems.append(
            f"pnpm 的 pin 不止一个版本：{detail}。两份手抄的判据分叉时，症状是容器启动即 "
            f"ERR_PNPM_BAD_PM_VERSION，而本地不跑那个镜像就看不到。"
        )

    if problems:
        for problem in problems:
            print(f"FAIL: {problem}", file=sys.stderr)
        return 1
    version = next(iter(pins), "?")
    print(
        f"corepack-pin: OK（pin={version}；{entry_points} 个入口都装了默认版本，"
        f"{install_sites} 处 install，0 处 prepare）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
