# 连接器网关镜像（§10.1）。多阶段构建：编译期完整工具链，运行期最小面。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0：纯 Go，无 FFI 依赖。
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/connector-gateway ./cmd/connector-gateway

FROM alpine:3.20
# 出站要校验上游 TLS 证书，scratch/alpine 默认不带根证书 —— 少了它所有 https 调用都会失败
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 lumo
COPY --from=build /out/connector-gateway /usr/local/bin/connector-gateway
USER lumo
EXPOSE 8082
ENTRYPOINT ["/usr/local/bin/connector-gateway"]
