# LLM 网关镜像（§12 四门之一，P2a 起始项）。多阶段构建，同惯例。
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/llm-gateway ./cmd/llm-gateway

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/llm-gateway /usr/local/bin/llm-gateway
USER lumo
EXPOSE 8088
ENTRYPOINT ["/usr/local/bin/llm-gateway"]
