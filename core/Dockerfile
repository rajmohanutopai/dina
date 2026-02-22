# Stage 1: Build
FROM golang:1.23-alpine AS builder

# Install build dependencies (CGO needed for SQLCipher in the future).
RUN apk add --no-cache git ca-certificates

WORKDIR /build

# Copy go.mod and go.sum first for dependency caching.
COPY go.mod go.sum ./
RUN go mod download

# Copy source code.
COPY . .

# Build the binary.
# CGO_ENABLED=0 for now (pure Go); will change when SQLCipher is added.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-s -w" \
    -o /dina-core \
    ./cmd/dina-core/

# Stage 2: Runtime
FROM alpine:3.21

# Security: run as non-root user.
RUN addgroup -g 10001 dina && \
    adduser -u 10001 -G dina -s /bin/sh -D dina

# Install runtime dependencies.
RUN apk add --no-cache ca-certificates

# Create data directories with correct ownership.
RUN mkdir -p /data/vault /data/spool /data/config && \
    chown -R dina:dina /data

# Copy the binary from the builder stage.
COPY --from=builder /dina-core /usr/local/bin/dina-core

# Switch to non-root user.
USER dina

# Expose the core HTTP port.
EXPOSE 8100

# Health check per §17: /healthz must return 200.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8100/healthz || exit 1

# Persistent volume for vault data.
VOLUME ["/data"]

# Environment defaults.
ENV DINA_LISTEN_ADDR=":8100" \
    DINA_ADMIN_ADDR=":8200" \
    DINA_VAULT_PATH="/data/vault" \
    DINA_SECURITY_MODE="standard"

ENTRYPOINT ["dina-core"]
