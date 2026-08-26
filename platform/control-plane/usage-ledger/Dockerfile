# 计量台账传输服务镜像（§6.4 异步削峰，设计说明 2026-08-26）。多阶段构建，
# 与 collaborator/scheduler 同惯例：编译期完整工具链，运行期最小面。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/usage-ledger ./cmd/usage-ledger

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/usage-ledger /usr/local/bin/usage-ledger
USER lumo
EXPOSE 8085
ENTRYPOINT ["/usr/local/bin/usage-ledger"]
