FROM golang:1.25-alpine AS builder
RUN apk add --no-cache gcc musl-dev sqlite-dev
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -ldflags="-s -w" -o /dina-msgbox ./cmd/dina-msgbox/

FROM alpine:3.21
RUN apk add --no-cache sqlite-libs
RUN addgroup -g 10001 dina && adduser -u 10001 -G dina -D dina
COPY --from=builder /dina-msgbox /usr/local/bin/dina-msgbox
RUN mkdir -p /data && chown dina:dina /data
WORKDIR /data
USER dina
ENV MSGBOX_DATA_DIR=/data
EXPOSE 7700
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:7700/healthz || exit 1
CMD ["dina-msgbox"]
