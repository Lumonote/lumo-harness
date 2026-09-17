# 终端网关镜像（§8.2 多端落地 / 缺口 C4）。多阶段构建，与 llm-gateway / edge-gateway 同惯例。
# 注意 build context 是 control-plane 目录（同 llm-gateway/Dockerfile），因此 COPY 路径以
# control-plane 为根；observability / heartbeat 通过 replace 指向同级目录一起拷入。
FROM golang:1.25-alpine AS build
WORKDIR /src
# go.mod 落在 WORKDIR（`/src`）而不是子目录：下面的 `COPY terminal-gateway .` 与
# `go build ./cmd/terminal-gateway` 都按「模块根就是 /src」写，而兄弟模块又 COPY 到
# 根（`/heartbeat`）。原先这里写 `./terminal-gateway/` 会让模块根变成 /src/terminal-gateway，
# 于是 `replace ../heartbeat` 解析成 `/src/heartbeat`——文件在 `/heartbeat`，对不上，
# 镜像在 `go mod download` 处失败。三个路径必须指向同一个模块根，这里取与其余 11 个
# Dockerfile 一致的那一个。
COPY terminal-gateway/go.mod terminal-gateway/go.sum ./
COPY observability /observability
COPY heartbeat /heartbeat
RUN go mod download
COPY terminal-gateway .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/terminal-gateway ./cmd/terminal-gateway

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/terminal-gateway /usr/local/bin/terminal-gateway
USER lumo
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/terminal-gateway"]
