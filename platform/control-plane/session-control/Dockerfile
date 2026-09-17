# 共享执行控制镜像（§8.4，缺口 C5）。多阶段构建，同控制面其他服务惯例：
# build context 是 control-plane 目录，共享模块按相对路径 COPY 进去。
#
# 与 edge-gateway 的差别只有两点：不需要 ratelimit（它不做限流），
# 但需要 heartbeat（E4 要求每个控制面服务发布心跳，go.mod 里已 replace）。
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY session-control/go.mod session-control/go.sum ./
COPY observability /observability
COPY heartbeat /heartbeat
RUN go mod download
COPY session-control .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/session-control ./cmd/session-control

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/session-control /usr/local/bin/session-control
USER lumo
# 与 compose 里的 LUMO_LISTEN=:8092 一致。刻意不是 8091：宿主端口按「18000+容器端口」
# 映射时 18091 已被 terminal-gateway 占用，端口规则只有一处例外就够了。
EXPOSE 8092
ENTRYPOINT ["/usr/local/bin/session-control"]
