# 协作服务镜像（§5.4.7）。多阶段构建：编译期完整工具链，运行期最小面。
FROM rust:1.98-alpine AS yrs-build
WORKDIR /yrs
RUN apk add --no-cache musl-dev
COPY collaborator/yrs-kernel/Cargo.toml ./yrs-kernel/Cargo.toml
COPY collaborator/yrs-kernel/Cargo.lock ./yrs-kernel/Cargo.lock
COPY collaborator/yrs-kernel/src ./yrs-kernel/src
RUN cargo build --release --manifest-path yrs-kernel/Cargo.toml

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY collaborator/go.mod collaborator/go.sum ./
COPY observability /observability
COPY heartbeat /heartbeat
RUN go mod download
COPY collaborator .
# CGO_ENABLED=0：语义合并由同镜像内的 yrs 进程提供，不依赖 cgo。
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/collaborator ./cmd/collaborator

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/collaborator /usr/local/bin/collaborator
COPY --from=yrs-build /yrs/yrs-kernel/target/release/lumo-yrs-kernel /usr/local/bin/lumo-yrs-kernel
ENV LUMO_YRS_KERNEL=/usr/local/bin/lumo-yrs-kernel
USER lumo
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/collaborator"]
