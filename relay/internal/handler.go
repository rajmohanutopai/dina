package internal

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// MaxPayloadSize is the maximum message body (1 MiB).
const MaxPayloadSize = 1 << 20

// Handler holds HTTP handlers for the relay.
type Handler struct {
	Hub     *Hub
	limiter *senderLimiter
}

// NewHandler creates a Handler with rate limiting.
func NewHandler(hub *Hub) *Handler {
	return &Handler{
		Hub:     hub,
		limiter: newSenderLimiter(),
	}
}

// HandleWebSocket handles the /ws endpoint. Home nodes connect here and
// authenticate via Ed25519 challenge-response.
func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // relay accepts from any origin
	})
	if err != nil {
		slog.Error("msgbox.ws_accept", "error", err)
		return
	}

	// Authenticate.
	did, authErr := Authenticate(r.Context(), ws)
	if authErr != nil {
		slog.Warn("msgbox.auth_failed", "error", authErr, "remote", r.RemoteAddr)
		ws.Close(websocket.StatusCode(4001), "auth failed")
		return
	}

	slog.Info("msgbox.connected", "did", did, "remote", r.RemoteAddr)

	// Use the connection's own context so it lives beyond the HTTP handler.
	connCtx := ws.CloseRead(r.Context())

	conn := &RelayConn{
		WS:     ws,
		DID:    did,
		Ctx:    connCtx,
		Cancel: func() { ws.Close(websocket.StatusNormalClosure, "closing") },
	}
	h.Hub.Register(conn)

	// Read pump: receive ACKs and forwarded messages from this node.
	for {
		msgType, data, err := ws.Read(connCtx)
		if err != nil {
			break
		}
		if msgType == websocket.MessageText {
			h.handleWSMessage(conn, data)
		} else if msgType == websocket.MessageBinary {
			h.handleWSBinaryForward(conn, data)
		}
	}

	h.Hub.Unregister(did, conn)
	slog.Info("msgbox.disconnected", "did", did)
}

// handleWSMessage handles text frames from connected nodes (ACKs).
func (h *Handler) handleWSMessage(conn *RelayConn, data []byte) {
	var msg struct {
		Type  string `json:"type"`
		MsgID string `json:"msg_id"`
	}
	if json.Unmarshal(data, &msg) != nil {
		return
	}
	if msg.Type == "ack" && msg.MsgID != "" {
		h.Hub.buf.Delete(msg.MsgID)
		slog.Debug("msgbox.ack", "from", conn.DID, "msg_id", msg.MsgID)
	}
}

// handleWSBinaryForward handles binary frames: sender pushes a message
// to forward to a recipient. Format: 2-byte DID length + DID + payload.
// Sender is already authenticated via the WebSocket handshake.
func (h *Handler) handleWSBinaryForward(conn *RelayConn, data []byte) {
	if len(data) < 3 {
		return
	}
	didLen := int(data[0])<<8 | int(data[1])
	if didLen > 256 || didLen+2 > len(data) {
		return
	}
	recipientDID := string(data[2 : 2+didLen])
	payload := data[2+didLen:]

	if !h.limiter.allow(conn.DID) {
		slog.Warn("msgbox.ws_rate_limited", "sender", conn.DID)
		return
	}

	msgID := generateMsgID()
	status, err := h.Hub.Deliver(recipientDID, msgID, payload)
	if err != nil {
		slog.Warn("msgbox.ws_forward_failed", "from", conn.DID, "to", recipientDID, "error", err)
		return
	}
	slog.Info("msgbox.ws_forwarded", "from", conn.DID, "to", recipientDID, "status", status)
}

// HandleForward handles POST /forward — authenticated message submission.
//
// Required headers:
//
//	X-Recipient-DID: did:plc:... (who to deliver to)
//	X-Sender-DID:    did:key:... (who is sending — for auth + rate limit)
//	X-Timestamp:     2006-01-02T15:04:05Z
//	X-Nonce:         random hex
//	X-Signature:     Ed25519 hex over canonical: POST\n/forward\n\n{ts}\n{nonce}\n{sha256(body)}
//	X-Sender-Pub:    hex-encoded 32-byte Ed25519 public key
func (h *Handler) HandleForward(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	recipientDID := r.Header.Get("X-Recipient-DID")
	if recipientDID == "" || !strings.HasPrefix(recipientDID, "did:") {
		http.Error(w, `{"error":"missing or invalid X-Recipient-DID"}`, http.StatusBadRequest)
		return
	}

	// Read body first (needed for signature verification).
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxPayloadSize+1))
	if err != nil {
		http.Error(w, `{"error":"read body failed"}`, http.StatusBadRequest)
		return
	}
	if len(body) > MaxPayloadSize {
		http.Error(w, `{"error":"payload too large"}`, http.StatusRequestEntityTooLarge)
		return
	}

	// --- Authenticate sender ---
	senderDID := r.Header.Get("X-Sender-DID")
	sig := r.Header.Get("X-Signature")
	ts := r.Header.Get("X-Timestamp")
	nonce := r.Header.Get("X-Nonce")
	pubHex := r.Header.Get("X-Sender-Pub")

	if senderDID == "" || sig == "" || ts == "" || nonce == "" || pubHex == "" {
		http.Error(w, `{"error":"missing auth headers (X-Sender-DID, X-Signature, X-Timestamp, X-Nonce, X-Sender-Pub)"}`, http.StatusUnauthorized)
		return
	}

	// Verify timestamp window (5 minutes).
	parsedTS, tsErr := time.Parse("2006-01-02T15:04:05Z", ts)
	if tsErr != nil {
		http.Error(w, `{"error":"invalid timestamp format"}`, http.StatusUnauthorized)
		return
	}
	if abs(time.Since(parsedTS)) > 5*time.Minute {
		http.Error(w, `{"error":"timestamp outside acceptable window"}`, http.StatusUnauthorized)
		return
	}

	// Decode public key. The relay accepts any DID format (did:plc, did:key)
	// as long as the Ed25519 signature verifies with the provided key.
	pubBytes, pubErr := hex.DecodeString(pubHex)
	if pubErr != nil || len(pubBytes) != ed25519.PublicKeySize {
		http.Error(w, `{"error":"invalid public key"}`, http.StatusUnauthorized)
		return
	}

	// Verify Ed25519 signature over canonical payload.
	bodyHash := sha256Hex(body)
	canonical := fmt.Sprintf("POST\n/forward\n\n%s\n%s\n%s", ts, nonce, bodyHash)
	sigBytes, sigErr := hex.DecodeString(sig)
	if sigErr != nil || len(sigBytes) != ed25519.SignatureSize {
		http.Error(w, `{"error":"invalid signature encoding"}`, http.StatusUnauthorized)
		return
	}
	if !ed25519.Verify(pubBytes, []byte(canonical), sigBytes) {
		http.Error(w, `{"error":"signature verification failed"}`, http.StatusUnauthorized)
		return
	}

	// --- Rate limiting by sender DID ---
	if !h.limiter.allow(senderDID) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded"})
		return
	}

	// --- Deliver ---
	msgID := r.Header.Get("X-Msg-ID")
	if msgID == "" {
		msgID = generateMsgID()
	}

	status, deliverErr := h.Hub.Deliver(recipientDID, msgID, body)
	if deliverErr != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": deliverErr.Error()})
		return
	}

	slog.Info("msgbox.forward", "from", senderDID, "to", recipientDID, "msg_id", msgID, "status", status)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"status": status,
		"msg_id": msgID,
	})
}

// HandleHealth handles GET /healthz.
func (h *Handler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "ok",
		"connected": h.Hub.ConnectedCount(),
		"buffered":  h.Hub.BufferedCount(),
	})
}

func generateMsgID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func abs(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// ---------------------------------------------------------------------------
// Per-sender-DID rate limiter (sliding window, 60 requests/minute)
// ---------------------------------------------------------------------------

const (
	rateLimitWindow  = time.Minute
	rateLimitMax     = 60
	rateLimitCleanup = 5 * time.Minute
)

type senderLimiter struct {
	mu      sync.Mutex
	windows map[string][]time.Time
}

func newSenderLimiter() *senderLimiter {
	l := &senderLimiter{windows: make(map[string][]time.Time)}
	go l.cleanupLoop()
	return l
}

func (l *senderLimiter) allow(did string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rateLimitWindow)

	// Trim old entries.
	times := l.windows[did]
	start := 0
	for start < len(times) && times[start].Before(cutoff) {
		start++
	}
	times = times[start:]

	if len(times) >= rateLimitMax {
		l.windows[did] = times
		return false
	}

	l.windows[did] = append(times, now)
	return true
}

func (l *senderLimiter) cleanupLoop() {
	ticker := time.NewTicker(rateLimitCleanup)
	defer ticker.Stop()
	for range ticker.C {
		l.mu.Lock()
		now := time.Now()
		cutoff := now.Add(-rateLimitWindow)
		for did, times := range l.windows {
			start := 0
			for start < len(times) && times[start].Before(cutoff) {
				start++
			}
			if start == len(times) {
				delete(l.windows, did)
			} else {
				l.windows[did] = times[start:]
			}
		}
		l.mu.Unlock()
	}
}
