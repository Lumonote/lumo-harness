# 边缘网关镜像（§12.1 南北向的「门」）。多阶段构建，同控制面其他服务惯例：
# build context 是 control-plane 目录，共享模块按相对路径 COPY 进去。
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY edge-gateway/go.mod edge-gateway/go.sum ./
COPY observability /observability
COPY heartbeat /heartbeat
COPY ratelimit /ratelimit
RUN go mod download
COPY edge-gateway .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/edge-gateway ./cmd/edge-gateway

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/edge-gateway /usr/local/bin/edge-gateway
USER lumo
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/edge-gateway"]
