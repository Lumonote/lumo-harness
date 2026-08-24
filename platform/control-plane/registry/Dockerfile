FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/registry ./cmd/registry

FROM alpine:3.20
# 与 scheduler 的差别：registry 会以 HTTPS 连对象存储，缺根证书会在
# NewS3Store 探桶时直接 Fatal，且错误信息看不出是证书问题。
RUN apk add --no-cache ca-certificates
COPY --from=build /out/registry /usr/local/bin/registry
EXPOSE 8084
ENTRYPOINT ["registry"]
