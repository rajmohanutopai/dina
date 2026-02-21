# dina-core: Go identity, vault, crypto, transport
FROM golang:1.23-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 go build -o /dina-core ./cmd/core

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /dina-core /usr/local/bin/dina-core

EXPOSE 8300
ENTRYPOINT ["dina-core"]
