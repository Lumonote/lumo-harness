#!/usr/bin/env python3
"""检查 shell 脚本里「变量展开之后紧贴全角标点」的写法。

## 为什么需要它

    fail "$name：缺陷没有被抓住"
              ^^ U+FF1A 全角冒号

这是**合法语法**，`bash -n` 与 shellcheck 都不会报，任何静态检查都拦不住——它只在
运行到那一行时炸，而且炸法取决于 bash 版本与所处位置：

* **bash 5（CI 的 ubuntu）**：`$name` 正常展开，全角冒号原样输出。一切正常。
* **bash 3.2（macOS 自带 `/bin/bash`）**：标识符扫描不认多字节边界，把 `name：` 当成
  一个变量名 → `set -u` 下 `unbound variable`。更坏的分支是**它出现在函数内部时**：
  bash 3.2 不让脚本退出、也不置非零状态，函数静默返回，脚本继续往下跑并**退 0**。

2026-09-16 实测到最后一支的后果：`compose-ports-verify.sh` / `edge-routes-verify.sh` /
`cluster-registry-verify.sh` 三个「反例自证」门禁在本机（macOS）打印完正向用例的 OK 之后
静默跳过**全部**反例、连最后的汇总行都不打，而退出码是 0。即：本机看到的是假绿，
CI 上是正常的——本仓库最忌讳的那种形态（退码相同、结论相反）。

## 判据

只抓「`$name` 后面**紧跟**全角标点」，且 `$name` 不带花括号。修法一律是写成 `${name}：`。

* 已经写了 `${name}：` 的**不算**——花括号是显式的名字终点，扫描不会误报；
* `$name` 后面跟 ASCII 标点/空格的不算（那本来就是对的写法）；
* shell 脚本里的**注释不豁免**：扫描不解析 shell 语法（那要用 bash 自己的解析器，
  而这里要抓的恰恰是解析器不报错的形态），所以脚本注释里出现该形态也报——注释里
  举例请写成 `${name}：`。代价很小，而漏报的代价是假绿。
  （本文件是 python，不在扫描目标里，所以上面那段示意不会自己命中自己。）

刻意**不做**「整行看起来像字符串字面量才报」之类的收窄：收窄的每一步都会留下一个
「恰好没被覆盖」的写法，而门禁的全部价值就是覆盖。

## 用法

    shell-portability-check.py --root <仓库根>      # 扫描 platform/deploy/*.sh、platform/deploy/lib/*.sh 与 platform/build.sh
    shell-portability-check.py --self-test         # 自证：坏样本必报、好样本必过
"""

import argparse
import glob
import os
import re
import sys

# 变量展开（不带花括号）后面紧贴这些全角标点。逐字符写出来，不用区间——
# 区间会把全角引号之类也吞进来，而它们同样会破坏标识符扫描，值得逐个显式列出。
FULLWIDTH = "（）［］｛｝：；，。、？！《》“”‘’"
PATTERN = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*(?=[" + re.escape(FULLWIDTH) + "])")

REQUIRED_GLOBS = [
    "platform/deploy/*.sh",
    # shared lib 也要扫。2026-09-16 补：此前只管 `deploy/*.sh`，而 `lib/` 下的脚本
    # **更容易**带上全角中文（它们几乎全是中文注释与中文报错文案），却不在目标里——
    # 门禁的覆盖范围本身就是一个「没人会发现的缺口」。同一次还顺带把 `lib/probes.sh`
    # 里那两处捞出来（`$env_file）` / `$topology（`），其中后一处正是本机实测到的
    # `topology（: unbound variable`。
    "platform/deploy/lib/*.sh",
]
REQUIRED_EXTRA = ["platform/build.sh"]

GOOD_SAMPLES = [
    'fail "${name}：本该通过，实际失败了"',
    'fail "$name: 本该通过"',
    'printf "%s\n" "$name"',
    'echo "${ts_note:+${ts_note}；}vitest 退出码非 0"',
]

BAD_SAMPLES = [
    'fail "$name：本该通过"',
    'echo "缺少 $lib；请补上"',
    'ok "$name（$want）"',
    'echo "依赖：$services_csv；跑完已清理"',
]


def scan_file(path):
    """返回该文件里命中问题的行号列表。"""
    hits = []
    with open(path, encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, 1):
            if PATTERN.search(line):
                hits.append(lineno)
    return hits


def run(root):
    targets = []
    for pattern in REQUIRED_GLOBS:
        matched = sorted(glob.glob(os.path.join(root, pattern)))
        if not matched:
            # 每个 glob 单独守卫：「这一类文件一个都没扫到」与「扫了、没问题」在输出上
            # 必须分得开。少了这条，把 lib 目录改名就等于让 lib 永久退出扫描而没人知道。
            print(f"shell-portability-check: FAIL: glob {pattern} 一个文件都没匹配到"
                  f"（目录被改名？路径写错？）—— 这一类脚本目前**没有被扫**",
                  file=sys.stderr)
            return 1
        targets += matched
    targets += [os.path.join(root, name) for name in REQUIRED_EXTRA]
    targets = [path for path in targets if os.path.isfile(path)]
    if not targets:
        # 计数守卫：扫描目标为空时，「没有问题」与「根本没在扫」在输出上必须不同。
        print("shell-portability-check: FAIL: 一个脚本都没扫到（路径写错？glob 失效？）", file=sys.stderr)
        return 1

    problems = []
    for path in targets:
        for lineno in scan_file(path):
            problems.append(f"{os.path.relpath(path, root)}:{lineno}")
    if problems:
        for item in problems:
            print(f"shell-portability-check: FAIL: {item} 变量展开后紧贴全角标点 —— "
                  f"bash 3.2 下会被当成变量名的一部分（函数内部时静默跳过并退 0）；"
                  f"写成 ${{var}}：的形式", file=sys.stderr)
        print(f"shell-portability-check: {len(problems)} 处（扫描 {len(targets)} 个脚本）", file=sys.stderr)
        return 1
    print(f"shell-portability-check: 通过（扫描 {len(targets)} 个脚本，无变量展开紧贴全角标点的写法）")
    return 0


def self_test():
    """自证：门禁被删空/被收窄时会在这里先红，而不是在真实文件上安静地绿下去。"""
    failures = 0
    for sample in GOOD_SAMPLES:
        if PATTERN.search(sample):
            print(f"self-test: FAIL: 好样本被误报：{sample!r}", file=sys.stderr)
            failures += 1
    for sample in BAD_SAMPLES:
        if not PATTERN.search(sample):
            print(f"self-test: FAIL: 坏样本没被抓住：{sample!r}", file=sys.stderr)
            failures += 1
    if failures:
        return 1
    print(f"shell-portability-check: self-test 通过（{len(GOOD_SAMPLES)} 个好样本不报、"
          f"{len(BAD_SAMPLES)} 个坏样本必报）")
    return 0


def main():
    parser = argparse.ArgumentParser(description="shell 全角标点紧贴变量展开检查")
    parser.add_argument("--root", default=".", help="仓库根目录")
    parser.add_argument("--self-test", action="store_true", help="只跑内建的样本自证")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    return run(args.root)


if __name__ == "__main__":
    sys.exit(main())
