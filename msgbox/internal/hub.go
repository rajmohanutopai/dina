// Package internal implements the Dina D2D msgbox.
//
// The msgbox is a lightweight encrypted mailbox. Home nodes connect via
// outbound WebSocket, authenticate with Ed25519, and receive messages
// pushed by other nodes. The msgbox never decrypts — it forwards NaCl
// sealed blobs between DID-identified connections.
package internal

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// MsgBoxConn wraps a WebSocket connection with its owning DID.
type MsgBoxConn struct {
	WS         *websocket.Conn
	DID        string
	RemoteAddr string // source IP:port, used for pairing IP throttle
	Ctx        context.Context
	Cancel     context.CancelFunc
}

// Hub manages active WebSocket connections keyed by DID and an offline
// message buffer. When a message arrives for a connected DID it is
// forwarded immediately; otherwise it is buffered for later drain.
type Hub struct {
	mu    sync.RWMutex
	conns map[string]*MsgBoxConn
	buf   *Buffer
}

// NewHub creates a Hub with the given buffer.
func NewHub(buf *Buffer) *Hub {
	return &Hub{
		conns: make(map[string]*MsgBoxConn),
		buf:   buf,
	}
}

// Register adds a connection and drains any buffered messages.
func (h *Hub) Register(conn *MsgBoxConn) {
	h.mu.Lock()
	old, exists := h.conns[conn.DID]
	h.conns[conn.DID] = conn
	h.mu.Unlock()

	if exists {
		// Close the old connection asynchronously to avoid blocking
		// Hub.Register on the WebSocket close handshake (which requires
		// the remote end to respond and can take up to 5 seconds).
		go func() {
			old.Cancel()
			old.WS.Close(websocket.StatusGoingAway, "replaced")
		}()
	}

	// Drain offline buffer using delete-on-write (MBX-066).
	// Peek reads without deleting. Each message is deleted after successful
	// WS.Write (data entered kernel send buffer). On write failure,
	// remaining messages stay buffered — no tail loss.
	//
	// This is NOT true delete-on-ack (client confirmation). A TCP-level
	// drop after Write() would lose the message. This is acceptable because:
	// - RPC: Core's idempotency cache means CLI can safely retry
	// - D2D: recipient-side signature verification provides dedupe
	msgs := h.buf.Peek(conn.DID)
	now := time.Now().Unix()
	for _, m := range msgs {
		// MBX-010: Check expires_at before delivering.
		if m.ExpiresAt != nil && *m.ExpiresAt < now {
			h.buf.Delete(m.ID)
			slog.Info("msgbox.drain_expired", "did", conn.DID, "msg_id", m.ID)
			continue
		}
		ctx, cancel := context.WithTimeout(conn.Ctx, 5*time.Second)
		if err := conn.WS.Write(ctx, websocket.MessageBinary, m.Payload); err != nil {
			slog.Warn("msgbox.drain_failed", "did", conn.DID, "msg_id", m.ID, "error", err)
			cancel()
			break // remaining messages stay buffered
		}
		// Write succeeded — delete this message from buffer.
		h.buf.Delete(m.ID)
		cancel()
		slog.Info("msgbox.drained", "did", conn.DID, "msg_id", m.ID)
	}
}

// Unregister removes a connection if it matches the current one.
func (h *Hub) Unregister(did string, conn *MsgBoxConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.conns[did]; ok && cur == conn {
		delete(h.conns, did)
	}
}

// Deliver sends a message to the recipient. If connected, it writes to
// the WebSocket. If offline, it buffers the message. Returns the
// delivery status: "delivered" or "buffered".
func (h *Hub) Deliver(recipientDID, msgID string, payload []byte, opts ...AddOption) (string, error) {
	h.mu.RLock()
	conn, online := h.conns[recipientDID]
	h.mu.RUnlock()

	if online {
		ctx, cancel := context.WithTimeout(conn.Ctx, 5*time.Second)
		defer cancel()
		if err := conn.WS.Write(ctx, websocket.MessageBinary, payload); err != nil {
			slog.Warn("msgbox.deliver_failed_buffering", "did", recipientDID, "error", err)
			return h.bufferMsg(recipientDID, msgID, payload, opts...)
		}
		slog.Info("msgbox.delivered", "to", recipientDID, "msg_id", msgID, "size", len(payload))
		return "delivered", nil
	}

	return h.bufferMsg(recipientDID, msgID, payload, opts...)
}

func (h *Hub) bufferMsg(did, msgID string, payload []byte, opts ...AddOption) (string, error) {
	if err := h.buf.Add(did, msgID, payload, opts...); err != nil {
		return "", err
	}
	slog.Info("msgbox.buffered", "did", did, "msg_id", msgID, "size", len(payload))
	return "buffered", nil
}

// ConnectedCount returns the number of active connections.
func (h *Hub) ConnectedCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// BufferedCount returns the total number of buffered messages.
func (h *Hub) BufferedCount() int {
	return h.buf.TotalCount()
}
