# 协作服务镜像（§5.4.7）。多阶段构建：编译期完整工具链，运行期最小面。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0：当前为纯 Go（占位合并内核）。
# 接入 y-crdt (Rust) FFI 后此处改为 CGO_ENABLED=1 并引入交叉编译工具链。
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/collaborator ./cmd/collaborator

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/collaborator /usr/local/bin/collaborator
USER lumo
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/collaborator"]
