// Package ws — upgrader.go adds real WebSocket upgrade support using coder/websocket.
//
// coder/websocket (formerly nhooyr.io/websocket) provides:
//   - Native context.Context on every read/write (matches port interfaces)
//   - Automatic ping/pong (no manual ticker management)
//   - Graceful close with status codes
//
// It provides:
//   - Conn: a wrapper around *websocket.Conn with an outbound channel
//   - Upgrader: configurable HTTP-to-WebSocket upgrader
//   - ServeWS: upgrade + auth handshake + hub registration + read/write pump
package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
)

// Context keys read from the HTTP auth middleware.
// When the upgrade request is Ed25519-authenticated, these are set by the
// auth middleware and allow the WebSocket to skip the token handshake.
var (
	AgentDIDContextKey   = middleware.AgentDIDKey
	TokenKindContextKey  = middleware.TokenKindKey
	TokenScopeContextKey = middleware.TokenScopeKey
)

// ---------------------------------------------------------------------------
// Conn — wrapper around *websocket.Conn
// ---------------------------------------------------------------------------

// Conn wraps a coder/websocket connection. coder/websocket is concurrency-safe
// for writes (no mutex needed), and all operations accept context.Context.
type Conn struct {
	ws  *websocket.Conn
	out chan []byte // buffered channel for outbound messages
}

// NewConn wraps a coder/websocket connection.
// outBufSize controls the capacity of the outbound message channel.
func NewConn(ws *websocket.Conn, outBufSize int) *Conn {
	if outBufSize <= 0 {
		outBufSize = 256
	}
	return &Conn{
		ws:  ws,
		out: make(chan []byte, outBufSize),
	}
}

// Write sends a text message. Thread-safe via coder/websocket's internal locking.
func (c *Conn) Write(ctx context.Context, data []byte) error {
	return c.ws.Write(ctx, websocket.MessageText, data)
}

// WriteJSON marshals v to JSON and sends it as a text message.
func (c *Conn) WriteJSON(ctx context.Context, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.ws.Write(ctx, websocket.MessageText, data)
}

// Read reads a single message. Must be called from a single goroutine (read pump).
func (c *Conn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	return c.ws.Read(ctx)
}

// Close performs a graceful WebSocket close.
func (c *Conn) Close(status websocket.StatusCode, reason string) error {
	return c.ws.Close(status, reason)
}

// SendOutbound enqueues a message for the write pump. Non-blocking: if the
// channel is full the message is dropped (back-pressure).
// WS4: Logs a warning on drop so silent message loss is observable.
func (c *Conn) SendOutbound(data []byte) bool {
	select {
	case c.out <- data:
		return true
	default:
		log.Printf("ws: outbound channel full — message dropped (%d bytes)", len(data))
		return false
	}
}

// ---------------------------------------------------------------------------
// Upgrader — configurable HTTP → WebSocket upgrader
// ---------------------------------------------------------------------------

// Upgrader wraps coder/websocket.AcceptOptions.
type Upgrader struct {
	opts *websocket.AcceptOptions
}

// UpgraderOption configures the Upgrader.
type UpgraderOption func(*Upgrader)

// WithInsecureSkipVerify skips origin verification (dev only).
func WithInsecureSkipVerify() UpgraderOption {
	return func(u *Upgrader) { u.opts.InsecureSkipVerify = true }
}

// WithOriginPatterns sets allowed origin patterns (e.g. "*.dina.local").
func WithOriginPatterns(patterns ...string) UpgraderOption {
	return func(u *Upgrader) { u.opts.OriginPatterns = patterns }
}

// NewUpgrader creates an Upgrader with sensible defaults.
// By default, origin checking is enabled (secure by default).
// Use WithInsecureSkipVerify() to skip origin verification in development.
func NewUpgrader(opts ...UpgraderOption) *Upgrader {
	u := &Upgrader{
		opts: &websocket.AcceptOptions{
			InsecureSkipVerify: false, // secure by default; use WithInsecureSkipVerify() for dev
		},
	}
	for _, o := range opts {
		o(u)
	}
	return u
}

// Accept upgrades the HTTP connection to WebSocket.
func (u *Upgrader) Accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return websocket.Accept(w, r, u.opts)
}

// ---------------------------------------------------------------------------
// ServeWS — the main entry point for a new WebSocket connection
// ---------------------------------------------------------------------------

// ServeWS upgrades the HTTP connection to WebSocket, runs the auth handshake
// within AuthTimeoutSeconds, registers the connection with the hub, and starts
// the read/write pump loops. It blocks until the connection is closed.
//
// Parameters:
//   - upgrader: performs the HTTP 101 upgrade
//   - hub: connection registry (register / unregister / send)
//   - handler: message auth + routing
//   - heartbeat: ping/pong monitoring (may be nil to skip heartbeat)
//   - buffer: missed-message buffer for replay on reconnect (may be nil)
//   - w, r: the incoming HTTP request to upgrade
func ServeWS(
	upgrader *Upgrader,
	hub *WSHub,
	handler *WSHandler,
	heartbeat *HeartbeatManager,
	buffer *MessageBuffer,
	w http.ResponseWriter,
	r *http.Request,
) {
	raw, err := upgrader.Accept(w, r)
	if err != nil {
		log.Printf("ws: upgrade failed: %v", err)
		return
	}

	conn := NewConn(raw, 256)
	// WS1: Limit incoming message size to 1 MiB. Without this, a malicious
	// authenticated client can exhaust server memory via multi-frame messages.
	// HTTP body limits don't apply after WebSocket upgrade (HTTP 101).
	raw.SetReadLimit(1 << 20)
	ctx := r.Context()

	// WebSocket auth is Ed25519-only. The HTTP upgrade request must be signed
	// with a device key (kind="client", scope="device"). Unsigned upgrades
	// are rejected — no token handshake fallback.
	var preAuth *PreAuthIdentity
	if agentDID, ok := ctx.Value(AgentDIDContextKey).(string); ok && agentDID != "" {
		tokenKind, _ := ctx.Value(TokenKindContextKey).(string)
		tokenScope, _ := ctx.Value(TokenScopeContextKey).(string)
		if tokenKind == "client" && tokenScope == "device" {
			preAuth = &PreAuthIdentity{ClientID: agentDID}
		}
	}

	// ---- Phase 1: auth handshake (must complete within AuthTimeoutSeconds) ----
	clientID, err := authHandshake(ctx, conn, handler, preAuth)
	if err != nil {
		log.Printf("ws: auth handshake failed: %v", err)
		_ = conn.WriteJSON(ctx, map[string]interface{}{
			"type": "auth_fail",
			"payload": map[string]interface{}{
				"message": err.Error(),
			},
		})
		_ = conn.Close(websocket.StatusPolicyViolation, "auth failed")
		return
	}

	// ---- Phase 2: register with the hub ----
	if regErr := hub.Register(clientID, conn); regErr != nil {
		log.Printf("ws: register failed: %v", regErr)
		_ = conn.Close(websocket.StatusInternalError, "register failed")
		return
	}

	// ---- Phase 3: flush any buffered messages ----
	if buffer != nil {
		flushBuffered(ctx, conn, buffer, clientID)
	}

	// ---- Phase 4: run read and write pumps ----
	pumpCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	go writePump(pumpCtx, conn, heartbeat, clientID)
	readPump(pumpCtx, cancel, conn, hub, handler, heartbeat, clientID)

	// ---- Cleanup after disconnect ----
	_ = hub.Unregister(clientID)
	if heartbeat != nil {
		heartbeat.RemoveClient(clientID)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")
}

// ---------------------------------------------------------------------------
// Auth handshake
// ---------------------------------------------------------------------------

// PreAuthIdentity holds identity information from the HTTP auth middleware.
// WebSocket auth is Ed25519-only: the upgrade request must be signed with a
// device key. The auth middleware verifies the signature and sets the device
// identity in context. No protocol-level token handshake.
type PreAuthIdentity struct {
	ClientID string // device ID from auth middleware
}

// authHandshake admits the WebSocket connection using the pre-authenticated
// identity from the HTTP upgrade request. Returns the clientID on success.
// If the upgrade was not Ed25519-authenticated, returns ErrAuthFailed.
func authHandshake(parent context.Context, conn *Conn, handler *WSHandler, preAuth *PreAuthIdentity) (string, error) {
	if preAuth == nil || preAuth.ClientID == "" {
		return "", ErrAuthFailed
	}

	handler.MarkAuthenticated(preAuth.ClientID, preAuth.ClientID)

	ctx, cancel := context.WithTimeout(parent, time.Duration(AuthTimeoutSeconds)*time.Second)
	defer cancel()
	if err := conn.WriteJSON(ctx, map[string]interface{}{
		"type": "auth_ok",
		"payload": map[string]interface{}{
			"device_name": preAuth.ClientID,
		},
	}); err != nil {
		return "", err
	}

	return preAuth.ClientID, nil
}

// ---------------------------------------------------------------------------
// Flush buffered messages
// ---------------------------------------------------------------------------

// flushBuffered replays any messages that were buffered while the client was
// disconnected. Messages are sent in FIFO order.
func flushBuffered(ctx context.Context, conn *Conn, buffer *MessageBuffer, deviceID string) {
	msgs, err := buffer.Flush(deviceID)
	if err != nil || len(msgs) == 0 {
		return
	}
	for _, msg := range msgs {
		if err := conn.Write(ctx, msg); err != nil {
			log.Printf("ws: flush buffered message failed for %s: %v", deviceID, err)
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Read pump
// ---------------------------------------------------------------------------

// readPump runs in the caller's goroutine. It reads messages from the
// WebSocket connection and routes them through the WSHandler.
// coder/websocket handles ping/pong automatically — no manual pong handler needed.
func readPump(
	ctx context.Context,
	cancel context.CancelFunc,
	conn *Conn,
	hub *WSHub,
	handler *WSHandler,
	heartbeat *HeartbeatManager,
	clientID string,
) {
	defer cancel() // signal write pump to exit

	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			// context cancelled or connection closed
			if ctx.Err() == nil {
				log.Printf("ws: read error for %s: %v", clientID, err)
			}
			return
		}

		resp, err := handler.HandleMessage(ctx, clientID, msg)
		if err != nil {
			log.Printf("ws: handle message error for %s: %v", clientID, err)
			continue
		}
		if resp != nil {
			if !conn.SendOutbound(resp) {
				log.Printf("ws: response dropped for %s — outbound buffer full", clientID)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Write pump
// ---------------------------------------------------------------------------

// writePump runs in its own goroutine. It listens for outbound messages on
// the Conn's channel and application-level heartbeat pings. coder/websocket
// handles WebSocket-level ping/pong automatically.
func writePump(
	ctx context.Context,
	conn *Conn,
	heartbeat *HeartbeatManager,
	clientID string,
) {
	pingInterval := time.Duration(PingIntervalSec) * time.Second
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case msg, ok := <-conn.out:
			if !ok {
				return
			}
			if err := conn.Write(ctx, msg); err != nil {
				log.Printf("ws: write failed for %s: %v", clientID, err)
				return
			}

		case <-ticker.C:
			// Send application-level ping via HeartbeatManager so the
			// client can respond with an application-level pong.
			if heartbeat != nil {
				ts := time.Now().Unix()
				if err := heartbeat.SendPing(clientID, ts); err != nil {
					log.Printf("ws: heartbeat ping failed for %s: %v", clientID, err)
				}

				// Check missed pongs: if we exceeded the threshold, disconnect.
				missed := heartbeat.IncrementMissed(clientID)
				if missed >= MaxMissedPongCount {
					log.Printf("ws: %s exceeded max missed pongs (%d), disconnecting", clientID, missed)
					return
				}
			}
		}
	}
}
