# syntax=docker/dockerfile:1
#
# connectors service (Go). Build from its own directory:
#   docker build --tag libredi/connectors services/connectors

FROM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/connectors ./cmd/connectors

# No shell, no package manager: only the static binary and CA certificates.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
LABEL org.opencontainers.image.title="libredi-connectors" \
      org.opencontainers.image.description="Libredi connectors service" \
      org.opencontainers.image.source="https://github.com/imapanda/libredi" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV PORT=8080
COPY --from=build /out/connectors /connectors
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/connectors", "healthcheck"]
ENTRYPOINT ["/connectors"]
