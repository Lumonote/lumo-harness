# 第五类制品（用户自定义流程）服务镜像（§11 后半）。多阶段构建，与 projects/
# usage-ledger 同惯例。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/flows ./cmd/flows

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/flows /usr/local/bin/flows
USER lumo
EXPOSE 8087
ENTRYPOINT ["/usr/local/bin/flows"]
