# 控制面多二进制镜像：一个镜像装 12 个服务二进制，由部署形态用 `command:` 选。
#
# ## 为什么合并（2026-09-20）
#
# 此前每个服务一份 Dockerfile，12 份互差只有三处：模块名、二进制名、EXPOSE 端口。
# 代价不是「文件多」，而是**同一份工作做 12 遍**——每份都要把 heartbeat / observability /
# ratelimit 重新 COPY 一遍、重新 `go mod download` 一遍、重新编译一遍同一批包。
#
# 合并**不动进程边界**：compose / helm 里每个服务仍是各自的容器，只是从同一镜像启动。
# §3.1 的「基础设施是独立服务」讲的是进程、故障域与伸缩粒度，不是镜像份数。这也不是新
# 花样——`registry/Dockerfile.provisioner` 早就是一个镜像装两个二进制（provisioner +
# artifact-runtime），本文件把同一件事做到全部控制面服务。
#
# **代价也要说清**：12 个服务从此共享一次构建，任一模块编译失败则 12 个镜像全部产不出来
# （合并前只坏那一个）。CI 的 `control-plane-go` matrix 逐个模块跑测试，是这条的补偿。
#
# ## 调用约定
#
# 镜像**故意不写 ENTRYPOINT、不写 EXPOSE**：一个镜像服务 12 个端口、12 个入口，写死任意
# 一个都是错的，而写 12 行 `entrypoint` 等于把旧 Dockerfile 抄进来。入口归部署形态：
# compose 的 `command:`、k8s 的 `args:`。没给 `command` 时 docker 会直接报「no command
# specified」——响亮地失败，好过默默跑错的那个服务。
#
# ## 构建上下文
#
# `platform/control-plane`（与原来一致）。整树进去、**不做逐模块挑着 COPY**：12 个模块
# 互相 `replace ../heartbeat` 之类，挑着 COPY 正是 2026-09-17 那次「12 个模块里 9 个各漏
# 一个兄弟模块、发布路径只能产出 3 个镜像」的来源（见 platform/tools/
# check-dockerfile-modules.py）。一个镜像里没有「挑」的必要——全都要。
#
# 同目录的 `.dockerignore` 是这份约定的另一半：整树进 = 连**本机产物**一起进，而
# `collaborator/yrs-kernel/target/` 实测 154MB（占上下文 158MB 的 97%，且随本机有没有
# 跑过 cargo 而变）。理由与「为什么只挡那两条」写在那个文件里。

# yrs 内核（协作服务 §5.4.7 的语义合并）：Rust 侧单独一阶段，产物只给 collaborator 用。
#
# 这条 `cargo build` 与下面 `build` 阶段那条 `go mod download` 是**同一个缺陷类**：它要联网
# （crates.io 的 registry index 与 crate 包——仓库里没有 `vendor/`，也没有 `.cargo/config`），
# 而原来既没有重试也没有缓存。实测（2026-09-21 完整镜像构建）：**104s 里有 95.8s 是这一阶段**，
# 它是整次构建的大头；而改一个 `src/` 文件就会让这一层失效 → 重新下 registry、重新编译全部依赖。
# 所以这里做与 Go 那边同样的三件事：重试、registry 缓存、编译产物缓存。
#
# **`target/` 挂成 cache 之后，产物必须显式搬出来。** cache mount 的内容**不进镜像层**——实测：
# `COPY --from` 直接指向挂载路径会以
# `failed to walk …/target: lstat …: no such file or directory` 失败（同一个探针里，从挂载
# 路径 `cp` 到普通路径再 `COPY --from` 就正常）。所以这条 RUN 的最后一步把二进制搬到
# `/yrs/lumo-yrs-kernel`（一个不在挂载点上的路径），最终阶段从那里取。
#
# `retry` 这个 4 行函数在 `build` 阶段又写了一遍：两个阶段是两张镜像，shell 函数没法共享。
# 刻意**不**抽成 COPY 进来的脚本——那会给构建多一个「输入可能不在」的面，而本仓库已经在
# 那上面栽过（见 platform/tools/check-dockerfile-modules.py）。
FROM rust:1.98-alpine AS yrs-build
WORKDIR /yrs
RUN apk add --no-cache musl-dev
COPY collaborator/yrs-kernel/Cargo.toml ./yrs-kernel/Cargo.toml
COPY collaborator/yrs-kernel/Cargo.lock ./yrs-kernel/Cargo.lock
COPY collaborator/yrs-kernel/src ./yrs-kernel/src
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/yrs/yrs-kernel/target,sharing=shared \
    set -eu; \
    retry() { attempt=0; until "$@"; do attempt=$((attempt + 1)); \
      if [ "$attempt" -ge 3 ]; then echo "!! 连续 3 次失败，放弃：$*" >&2; return 1; fi; \
      echo "== 重试第 $attempt 次：$*"; done; }; \
    retry cargo build --release --manifest-path yrs-kernel/Cargo.toml; \
    cp yrs-kernel/target/release/lumo-yrs-kernel /yrs/lumo-yrs-kernel; \
    ls -l /yrs/lumo-yrs-kernel

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY . /src

# 服务清单是**一份**：下面下载依赖与编译都用它，加服务时只改这一行。
# 顺序 = 依赖在前、被依赖在后（这里用不上顺序，但排成字母序便于与 compose 对照）。
ENV LUMO_CONTROL_PLANE_SERVICES="collaborator connector-gateway edge-gateway flows governance llm-gateway projects registry scheduler session-control terminal-gateway usage-ledger"

# ## 这条 RUN 里的重试与两个 cache mount（2026-09-21）
#
# 触发这次改动的是发布路径上一次真实的失败：12 个模块里的**第一个**（collaborator）在第
# 61 秒报
#
#     go: golang.org/x/text@v0.21.0: read "https://proxy.golang.org/.../@v/v0.21.0.zip": unexpected EOF
#
# 同一时刻用 curl 直接拉那个 zip 是 200 / 9.2MB / 完整，`goproxy.cn` 0.155s —— 所以不是
# 「被墙」，是瞬时抖动。而原来的循环**没有任何重试**：一次抖动就废掉整次 12 模块构建，且
# 失败点在第一个模块，等于每次都得从头再来。重试只加在**会走网络**的两步（下载、编译）上，
# 因为只有它们会瞬时失败；真出现编译错误时重试三次也只多几秒（第二次起命中 build cache）。
#
# 两个 cache mount 让「重试」与「重跑」都便宜，并且把网络从热构建里彻底摘掉：
# `go mod download` 冷跑约 14s，挂载后第二次构建实测 **0.089s**，而且加 `--network=none`
# 断网也能跑完（模块缓存 49.6M，2026-09-21 实测）。于是网络再抖一次时，只要缓存是热的，
# 构建根本不会碰到网络。
#
# 两个 mount 必须与这两步在**同一条 RUN** 里：`--mount` 是 per-RUN 的，拆成两条 RUN 就是
# 两套互不相干的缓存（下载填的那个，编译那个读不到）。
#
# 别在这条 RUN 上加 `--no-cache`：实测它会把 cache mount 一起重置（同一份挂载连跑三次，
# 计数器恒为 1）—— 那样挂载看着还在、复用却是零。
RUN --mount=type=cache,target=/go/pkg/mod,sharing=shared \
    --mount=type=cache,target=/root/.cache/go-build,sharing=shared \
    set -eu; \
    retry() { attempt=0; until "$@"; do attempt=$((attempt + 1)); \
      if [ "$attempt" -ge 3 ]; then echo "!! 连续 3 次失败，放弃：$*" >&2; return 1; fi; \
      echo "== 重试第 $attempt 次：$*"; done; }; \
    for module in $LUMO_CONTROL_PLANE_SERVICES; do \
      echo "== go mod download: $module"; \
      (cd "/src/$module" && retry go mod download); \
    done; \
    for module in $LUMO_CONTROL_PLANE_SERVICES; do \
      echo "== go build: $module"; \
      (cd "/src/$module" && export CGO_ENABLED=0 && retry go build -trimpath -ldflags="-s -w" -o "/out/$module" "./cmd/$module"); \
    done; \
    ls -l /out

FROM alpine:3.20
# ca-certificates：出站要校验上游 TLS 证书，alpine 默认不带根证书——少了它所有 https
# 调用都会失败（原先只有 connector-gateway / registry 装了它，这里统一装上）。
# 用户统一成 10001：原先 10 个服务是 lumo、registry 与 scheduler 是 root，而那两位的
# 文件系统写入点都在别处（desktop-agent / artifact-runtime 等其它 cmd），服务本体只跟
# PG / MinIO 打交道，不需要 root。
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 lumo
COPY --from=build /out/ /usr/local/bin/
# 路径**不是** `yrs-kernel/target/release/…`：`target/` 在上一阶段是 cache mount，它的内容
# 不进层，所以那边最后把二进制搬到了 `/yrs/lumo-yrs-kernel`（见 yrs-build 那段注释）。
COPY --from=yrs-build /yrs/lumo-yrs-kernel /usr/local/bin/lumo-yrs-kernel
ENV LUMO_YRS_KERNEL=/usr/local/bin/lumo-yrs-kernel
USER lumo
