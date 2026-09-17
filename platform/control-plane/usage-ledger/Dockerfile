# 计量台账传输服务镜像（§6.4 异步削峰，设计说明 2026-08-26）。多阶段构建，
# 与 collaborator/scheduler 同惯例：编译期完整工具链，运行期最小面。
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY usage-ledger/go.mod usage-ledger/go.sum ./
# The RocketMQ client pulls a few large indirect compression modules. Retry
# transient proxy EOFs so a parallel Compose build does not fail the whole
# topology on one interrupted download.
COPY observability /observability
COPY heartbeat /heartbeat
RUN for attempt in 1 2 3 4 5; do go mod download && exit 0; echo "go mod download attempt ${attempt} failed; retrying" >&2; sleep 5; done; exit 1
COPY usage-ledger .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/usage-ledger ./cmd/usage-ledger

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/usage-ledger /usr/local/bin/usage-ledger
USER lumo
EXPOSE 8085
ENTRYPOINT ["/usr/local/bin/usage-ledger"]
