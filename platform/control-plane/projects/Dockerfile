# 项目工作区服务镜像（§11.1）。多阶段构建，与 collaborator/scheduler/usage-ledger
# 同惯例：编译期完整工具链，运行期最小面。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/projects ./cmd/projects

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/projects /usr/local/bin/projects
USER lumo
EXPOSE 8086
ENTRYPOINT ["/usr/local/bin/projects"]
