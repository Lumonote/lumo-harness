FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/scheduler ./cmd/scheduler

FROM alpine:3.20
COPY --from=build /out/scheduler /usr/local/bin/scheduler
EXPOSE 8083
ENTRYPOINT ["scheduler"]
