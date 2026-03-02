# Stage 1: Build with CGO (SQLCipher only)
FROM golang:1.25-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlcipher-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy go.mod and go.sum first for dependency caching.
COPY go.mod go.sum ./
RUN go mod download

# Copy source code.
COPY . .

# Build with CGO enabled for SQLCipher.
RUN CGO_ENABLED=1 go build \
    -tags fts5 \
    -ldflags="-s -w" \
    -o /dina-core \
    ./cmd/dina-core/

# Stage 2: Minimal runtime (no compiler, no headers)
FROM debian:bookworm-slim

# Security: run as non-root user.
RUN groupadd -g 10001 dina && \
    useradd -u 10001 -g dina -s /bin/sh -M dina

# Install only runtime shared libraries (no -dev packages).
# gosu: lightweight setuid tool for dropping privileges in entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlcipher0 \
    ca-certificates \
    wget \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Create data directories with correct ownership.
RUN mkdir -p /data/vault /data/spool /data/config && \
    chown -R dina:dina /data

# Copy the binary from the builder stage.
COPY --from=builder /dina-core /usr/local/bin/dina-core

# Copy entrypoint script (reads Docker secrets as root, then drops to dina user).
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# NOTE: No USER directive — entrypoint runs as root to copy /run/secrets/*
# into dina-owned files, then drops to UID 10001 via gosu before exec'ing the binary.

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

ENTRYPOINT ["entrypoint.sh"]
CMD ["dina-core"]
