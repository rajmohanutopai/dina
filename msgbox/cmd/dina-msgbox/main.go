// dina-msgbox — Dina D2D encrypted mailbox.
//
// A lightweight msgbox that forwards NaCl-encrypted blobs between
// DID-identified Home Nodes. Never decrypts. Durably buffers messages
// for offline recipients (SQLite WAL, 24h TTL, 100 msg / 10 MiB cap).
//
// Home nodes connect via outbound WebSocket, authenticate with Ed25519.
// Senders POST encrypted blobs with authenticated requests.
//
//	Endpoints:
//	  WS   /ws       — Home Node persistent connection (auth + receive)
//	  POST /forward  — Authenticated message submission (Ed25519 signed)
//	  GET  /healthz  — Liveness probe
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	msgbox "github.com/rajmohanutopai/dina/msgbox/internal"
)

func main() {
	// Configuration from environment.
	addr := envOr("MSGBOX_LISTEN_ADDR", ":7700")
	logLevel := envOr("MSGBOX_LOG_LEVEL", "info")
	dataDir := envOr("MSGBOX_DATA_DIR", "./data")

	// Structured logging.
	var level slog.Level
	switch logLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	// Ensure data directory exists.
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		slog.Error("msgbox.data_dir", "error", err)
		os.Exit(1)
	}

	// Durable buffer (SQLite).
	dbPath := filepath.Join(dataDir, "mailbox.db")
	buf, err := msgbox.NewBuffer(dbPath)
	if err != nil {
		slog.Error("msgbox.buffer_init", "error", err, "path", dbPath)
		os.Exit(1)
	}
	defer buf.Close()

	hub := msgbox.NewHub(buf)
	handler := msgbox.NewHandler(hub)

	// HTTP mux.
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.HandleWebSocket)
	mux.HandleFunc("/forward", handler.HandleForward)
	mux.HandleFunc("/healthz", handler.HandleHealth)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// TTL cleanup goroutine.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if n := buf.ExpireTTL(); n > 0 {
					slog.Info("msgbox.expired", "count", n)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Start server.
	slog.Info("msgbox.starting", "addr", addr, "db", dbPath)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("msgbox.listen_failed", "error", err)
			os.Exit(1)
		}
	}()

	// Wait for shutdown signal.
	<-ctx.Done()
	slog.Info("msgbox.shutting_down")

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	srv.Shutdown(shutCtx)

	slog.Info("msgbox.stopped")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
