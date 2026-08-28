FROM golang:1.25-alpine AS build
WORKDIR /src
COPY scheduler/go.mod scheduler/go.sum ./
COPY observability /observability
RUN go mod download
COPY scheduler .
RUN CGO_ENABLED=0 go build -o /out/scheduler ./cmd/scheduler

FROM alpine:3.20
COPY --from=build /out/scheduler /usr/local/bin/scheduler
EXPOSE 8083
ENTRYPOINT ["scheduler"]
