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
	// Ack is true when the client declared the "ack" feature at auth: it
	// acknowledges each message it has handled ({"type":"ack"}). For such a
	// connection a message is buffered BEFORE it is written and deleted only
	// on the ack, so a socket that dies after the write (an iOS app
	// suspended, a network drop) loses nothing — it is sent again on the
	// next connect. Clients that never declared it (older CLIs, the Go
	// reference node) keep delete-on-write.
	Ack bool
}

// Hub manages active WebSocket connections keyed by DID and an offline
// message buffer. When a message arrives for a connected DID it is
// forwarded immediately; otherwise it is buffered for later drain.
type Hub struct {
	mu    sync.RWMutex
	conns map[string]*MsgBoxConn
	buf   *Buffer
	// recipientLocks put everything done for ONE recipient in order: a
	// connect and its drain, a delivery, a cancel, an ack. Without it a
	// cancel could delete a row a drain had already read and was about to
	// write (the request then runs, uncancelled), and a delivery that looked
	// up a connection just replaced could buffer behind a drain that had
	// already finished (the message then waits while its recipient is
	// online). One lock per recipient DID, never shared: the lock is held
	// across socket writes, so a slow or half-open socket delays only its
	// own recipient. An entry lives while someone holds or waits for it.
	locksMu        sync.Mutex
	recipientLocks map[string]*recipientLock
}

type recipientLock struct {
	mu   sync.Mutex
	refs int
}

// lockRecipient takes the lock for one recipient and returns its unlock.
// Never take a second recipient lock while holding one.
func (h *Hub) lockRecipient(did string) func() {
	h.locksMu.Lock()
	l := h.recipientLocks[did]
	if l == nil {
		l = &recipientLock{}
		h.recipientLocks[did] = l
	}
	l.refs++
	h.locksMu.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		h.locksMu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(h.recipientLocks, did)
		}
		h.locksMu.Unlock()
	}
}

// NewHub creates a Hub with the given buffer.
func NewHub(buf *Buffer) *Hub {
	return &Hub{
		conns:          make(map[string]*MsgBoxConn),
		buf:            buf,
		recipientLocks: make(map[string]*recipientLock),
	}
}

// Register adds a connection and drains any buffered messages.
func (h *Hub) Register(conn *MsgBoxConn) {
	unlock := h.lockRecipient(conn.DID)
	defer unlock()

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
	//
	// An ack-capable connection gets true delete-on-ack: every buffered
	// message — including ones written to an earlier connection and never
	// acked — is written again, and stays until the client acks it.
	msgs := h.buf.Peek(conn.DID)
	now := time.Now().Unix()
	for _, m := range msgs {
		// MBX-010: Check expires_at before delivering — and the generic TTL,
		// here and not only in the background sweep: a relay restarted with
		// old rows drains before its first sweep, and a client forgets what
		// it handled once the TTL has passed, so an over-age row must never
		// be written again.
		if (m.ExpiresAt != nil && *m.ExpiresAt < now) || now-m.StoredAt.Unix() > int64(MessageTTL.Seconds()) {
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
		cancel()
		if conn.Ack {
			h.buf.MarkDelivered(m.ID)
			slog.Info("msgbox.drained_awaiting_ack", "did", conn.DID, "msg_id", m.ID)
			continue
		}
		// Write succeeded — delete this message from buffer.
		h.buf.Delete(m.ID)
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
	unlock := h.lockRecipient(recipientDID)
	defer unlock()
	return h.deliverLocked(recipientDID, msgID, payload, opts...)
}

// deliverLocked is Deliver for a caller already holding the recipient lock.
func (h *Hub) deliverLocked(recipientDID, msgID string, payload []byte, opts ...AddOption) (string, error) {
	h.mu.RLock()
	conn, online := h.conns[recipientDID]
	h.mu.RUnlock()

	if online && conn.Ack {
		// Buffer FIRST, then write: the copy is deleted only when the
		// recipient acks it, so a write that "succeeds" into a socket that is
		// already dead (an iOS app suspended, a network drop) is sent again on
		// the next connect instead of being lost.
		//
		// A copy that cannot be kept (the recipient's buffer is full, the
		// store failed) is NOT written: a write without a kept copy is the
		// delete-on-write loss this mode exists to remove. The sender gets an
		// error and retries, as for an offline recipient with a full buffer.
		if err := h.buf.Add(recipientDID, msgID, payload, opts...); err != nil {
			slog.Warn("msgbox.ack_buffer_failed", "did", recipientDID, "msg_id", msgID, "error", err)
			return "", err
		}
		ctx, cancel := context.WithTimeout(conn.Ctx, 5*time.Second)
		defer cancel()
		if err := conn.WS.Write(ctx, websocket.MessageBinary, payload); err != nil {
			slog.Warn("msgbox.deliver_failed_buffered", "did", recipientDID, "error", err)
			return "buffered", nil
		}
		h.buf.MarkDelivered(msgID)
		slog.Info("msgbox.delivered_awaiting_ack", "to", recipientDID, "msg_id", msgID, "size", len(payload))
		return "delivered", nil
	}

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

// Ack deletes a message the recipient confirms it has handled. Scoped to the
// recipient: a client can only acknowledge its own messages. Reports whether
// a buffered copy was removed (false for an unknown or already-acked id).
func (h *Hub) Ack(recipientDID, msgID string) bool {
	unlock := h.lockRecipient(recipientDID)
	defer unlock()
	deleted := h.buf.DeleteForRecipient(msgID, recipientDID)
	if deleted {
		slog.Info("msgbox.acked", "did", recipientDID, "msg_id", msgID)
	}
	return deleted
}

// Cancel withdraws a sender's buffered message (`msgID` is the sender-scoped
// buffer key) for `recipientDID`, under that recipient's lock so no drain or
// delivery can be half-way through it. A copy never written is deleted and
// nothing more happens: the recipient never sees the request. A copy already
// written (an acking recipient that has not acked) is deleted too, but the
// recipient may be running it, so `relay` — the cancel itself, ready to send
// — goes on to the recipient. Nothing buffered: the message was delivered
// and deleted (delete-on-write), so the cancel is relayed as well.
// Reports whether the cancel was relayed.
//
// The recipient is the one the buffered row names when there is a row —
// never the cancel's own `to_did`, which the sender may leave out or get
// wrong — so the cancel always waits on the lock the drain holds. With no
// row the message was delivered and deleted; `toDID` is then the only place
// to send the cancel, and with no `toDID` there is nowhere to send it.
func (h *Hub) Cancel(toDID, msgID string, relay func(recipientDID string, deliver func(msgID string, payload []byte, opts ...AddOption))) bool {
	recipientDID := toDID
	if buffered, ok := h.buf.RecipientOf(msgID); ok {
		recipientDID = buffered
	}
	if recipientDID == "" {
		return false
	}
	unlock := h.lockRecipient(recipientDID)
	defer unlock()
	if found, delivered := h.buf.CancelBuffered(msgID); found && !delivered {
		return false
	}
	relay(recipientDID, func(key string, payload []byte, opts ...AddOption) {
		if _, err := h.deliverLocked(recipientDID, key, payload, opts...); err != nil {
			slog.Warn("msgbox.cancel_relay_failed", "to", recipientDID, "error", err)
		}
	})
	return true
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
