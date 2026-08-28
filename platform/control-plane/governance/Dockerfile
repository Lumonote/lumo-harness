FROM golang:1.25-alpine AS build
WORKDIR /src
COPY governance/go.mod governance/go.sum ./
COPY observability /observability
RUN go mod download
COPY governance .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/governance ./cmd/governance

FROM alpine:3.20
RUN adduser -D -u 10001 lumo
COPY --from=build /out/governance /usr/local/bin/governance
USER lumo
EXPOSE 8089
ENTRYPOINT ["/usr/local/bin/governance"]
