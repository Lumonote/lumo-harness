# MinIO no longer serves this release from its public container and binary
# registries. Build the same upstream release from its archived source tag.
FROM golang:1.26.5-bookworm AS build

ARG MINIO_TAG=RELEASE.2025-04-22T22-12-26Z
ARG MINIO_COMMIT=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e

RUN git clone --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git /src \
    && test "$(git -C /src rev-parse HEAD)" = "$MINIO_COMMIT"

WORKDIR /src
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -tags kqueue -trimpath \
      -ldflags="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" -o /out/minio .

FROM alpine:3.22
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /usr/share/licenses/minio/LICENSE
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
