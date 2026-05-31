# Stage 1: Build Go binary with CGO (SQLCipher only)
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

# Read version from VERSION file (project root passed via additional_contexts).
ARG DINA_VERSION=dev
# Build with CGO enabled for SQLCipher.
RUN CGO_ENABLED=1 go build \
    -tags fts5 \
    -ldflags="-s -w -X github.com/rajmohanutopai/dina/core/internal/handler.Version=${DINA_VERSION}" \
    -o /dina-core \
    ./cmd/dina-core/

# Stage 2: Build dina-admin wheel
FROM python:3.12-slim-bookworm AS admin-builder

WORKDIR /build
COPY --from=admin-cli . .
RUN pip install --no-cache-dir build && python -m build --wheel --outdir /dist

# Stage 3: Minimal runtime (no compiler, no headers)
FROM debian:bookworm-slim

# Security: run as non-root user.
RUN groupadd -g 10001 dina && \
    useradd -u 10001 -g dina -s /bin/sh -M dina

# Install only runtime shared libraries (no -dev packages).
# gosu: lightweight setuid tool for dropping privileges in entrypoint.
# python3 + pip: for dina-admin CLI (admin runs inside the container).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlcipher0 \
    ca-certificates \
    wget \
    gosu \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create data directories with correct ownership.
# /data/run holds the admin Unix socket (container-internal, 0600).
RUN mkdir -p /data/vault /data/spool /data/config /data/run && \
    chown -R dina:dina /data

# Copy the Go binary from the builder stage.
COPY --from=builder /dina-core /usr/local/bin/dina-core

# Install dina-admin CLI inside the container.
# Socket access = admin auth — no token needed.
COPY --from=admin-builder /dist/*.whl /tmp/
RUN pip3 install --no-cache-dir --break-system-packages /tmp/*.whl && rm -f /tmp/*.whl

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
    DINA_SECURITY_MODE="standard" \
    DINA_ADMIN_SOCKET="/data/run/admin.sock"

ENTRYPOINT ["entrypoint.sh"]
CMD ["dina-core"]
