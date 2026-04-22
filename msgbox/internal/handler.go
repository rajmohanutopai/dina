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

// Handler holds HTTP handlers for the msgbox.
type Handler struct {
	Hub            *Hub
	PLCResolver    PLCResolver    // optional: for did:plc verification on /ws auth
	d2dLimiter     *senderLimiter // D2D: WebSocket binary frames + POST /forward (60/min per DID)
	rpcLimiter     *senderLimiter // RPC: WebSocket JSON frames (300/min per DID)
	pairIPLimiter  *senderLimiter // Pairing: subtype "pair" RPCs (10/5min per source IP)
	nonceCache     *NonceCache    // /forward nonce replay protection
}

// NewHandler creates a Handler with separate rate limit buckets.
// Pass a PLCResolver for did:plc verification on WebSocket auth.
// If nil, did:plc auth falls back to signature-only (no PLC doc cross-check).
func NewHandler(hub *Hub, resolver ...PLCResolver) *Handler {
	// Nonce replay window: 6 min = 5-min timestamp validity + 1-min buffer.
	nc := NewNonceCache(6 * time.Minute)
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			nc.Cleanup()
		}
	}()

	h := &Handler{
		Hub:           hub,
		d2dLimiter:    newSenderLimiterWithMax(rateLimitMaxD2D),
		rpcLimiter:    newSenderLimiterWithMax(rateLimitMaxRPC),
		pairIPLimiter: newSenderLimiterWithMax(rateLimitMaxPairing),
		nonceCache:    nc,
	}
	if len(resolver) > 0 {
		h.PLCResolver = resolver[0]
	}
	return h
}

// HandleWebSocket handles the /ws endpoint. Home nodes connect here and
// authenticate via Ed25519 challenge-response.
func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,  // msgbox accepts from any origin
	})
	if err != nil {
		slog.Error("msgbox.ws_accept", "error", err)
		return
	}
	ws.SetReadLimit(MaxPayloadSize) // 1 MiB — matches /forward body limit

	// Authenticate with PLC resolver if configured.
	did, authErr := AuthenticateWithResolver(r.Context(), ws, h.PLCResolver)
	if authErr != nil {
		slog.Warn("msgbox.auth_failed", "error", authErr, "remote", r.RemoteAddr)
		ws.Close(websocket.StatusCode(4001), "auth failed")
		return
	}

	slog.Info("msgbox.connected", "did", did, "remote", r.RemoteAddr)

	// The connection's lifetime is governed by the HTTP request context.
	// NOTE: earlier this called ws.CloseRead(), which was a bug —
	// CloseRead spawns a goroutine that closes the connection with
	// "unexpected data message" (1008) whenever the peer sends ANY frame.
	// We need to read peer frames (D2D/RPC/cancel envelopes), so use the
	// request context directly and let the outer read loop handle frames.
	connCtx := r.Context()

	conn := &MsgBoxConn{
		WS:         ws,
		DID:        did,
		RemoteAddr: r.RemoteAddr,
		Ctx:        connCtx,
		Cancel:     func() { ws.Close(websocket.StatusNormalClosure, "closing") },
	}
	h.Hub.Register(conn)

	// Read pump: receive forwarded messages from this node.
	for {
		msgType, data, err := ws.Read(connCtx)
		if err != nil {
			break
		}
		// Only binary frames are processed (D2D, RPC, cancel envelopes).
		// Text frames are ignored after the auth handshake.
		if msgType == websocket.MessageBinary {
			h.handleWSBinaryForward(conn, data)
		}
	}

	h.Hub.Unregister(did, conn)
	slog.Info("msgbox.disconnected", "did", did)
}


// handleWSBinaryForward handles binary frames using the unified JSON envelope
// format. All message types (D2D, RPC, cancel) use the same JSON envelope.
//
// Malformed frames are logged and dropped — never kill the connection.
func (h *Handler) handleWSBinaryForward(conn *MsgBoxConn, data []byte) {
	if len(data) == 0 {
		return
	}
	h.handleJSONEnvelope(conn, data)
}

// envelope is the unified outer envelope for all message types (D2D, RPC, cancel).
// D2D: ciphertext contains the d2dPayload JSON (opaque to MsgBox).
// RPC: ciphertext contains base64-encoded NaCl sealed-box.
// Cancel: uses cancel_of field, no ciphertext.
type envelope struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	FromDID   string `json:"from_did"`
	ToDID     string `json:"to_did"`
	Direction string `json:"direction,omitempty"`
	ExpiresAt *int64 `json:"expires_at,omitempty"`
	Subtype   string `json:"subtype,omitempty"`
	// CancelOf is used by cancel messages only.
	CancelOf   string `json:"cancel_of,omitempty"`
	Ciphertext string `json:"ciphertext,omitempty"`
}

// handleJSONEnvelope dispatches unified envelopes by type.
// Malformed JSON is dropped without killing the connection.
func (h *Handler) handleJSONEnvelope(conn *MsgBoxConn, data []byte) {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		slog.Debug("msgbox.bad_json_envelope", "from", conn.DID, "error", err)
		return
	}

	switch env.Type {
	case "d2d":
		h.routeD2D(conn, data, &env)
	case "rpc":
		h.routeRPC(conn, data, &env)
	case "cancel":
		h.routeCancel(conn, &env)
	default:
		slog.Debug("msgbox.unknown_envelope_type", "type", env.Type, "from", conn.DID)
	}
}

// routeD2D validates and routes a D2D envelope to the recipient.
// D2D envelopes carry the same metadata as RPC (sender binding, expires_at,
// composite key) but use the D2D rate limit bucket.
func (h *Handler) routeD2D(conn *MsgBoxConn, raw []byte, env *envelope) {
	// Drops elevated from Debug → Warn. Under info-level log configs (our
	// production default), debug drops are invisible; a client sending a
	// malformed envelope just gets silent blackhole with no operator signal.
	// Warn surfaces shape bugs during integration work without flooding logs
	// in steady-state (well-formed traffic never hits these branches).
	if env.ID == "" {
		slog.Warn("msgbox.d2d_missing_id", "from", conn.DID)
		return
	}
	if env.FromDID == "" || env.ToDID == "" {
		slog.Warn("msgbox.d2d_missing_did", "from", conn.DID)
		return
	}

	// Sender binding: envelope.from_did must match authenticated connection DID.
	if env.FromDID != conn.DID {
		slog.Warn("msgbox.d2d_sender_mismatch", "envelope_from", env.FromDID, "conn_did", conn.DID)
		return
	}

	// Rate limiting (D2D bucket — same as legacy binary path).
	if !h.d2dLimiter.allow(conn.DID) {
		slog.Warn("msgbox.d2d_rate_limited", "from", conn.DID)
		return
	}

	// Composite buffer key: sender-scoped.
	msgID := env.FromDID + ":" + env.ID

	var bufOpts []AddOption
	bufOpts = append(bufOpts, WithSender(env.FromDID))
	if env.ExpiresAt != nil {
		bufOpts = append(bufOpts, WithExpiresAt(*env.ExpiresAt))
	}

	status, err := h.Hub.Deliver(env.ToDID, msgID, raw, bufOpts...)
	if err != nil {
		slog.Warn("msgbox.d2d_deliver_failed", "from", conn.DID, "to", env.ToDID, "error", err)
		return
	}
	slog.Info("msgbox.d2d_routed", "from", conn.DID, "to", env.ToDID, "id", env.ID, "status", status)
}

// routeRPC validates and routes an RPC envelope to the recipient.
func (h *Handler) routeRPC(conn *MsgBoxConn, raw []byte, env *envelope) {
	// Validate required fields.
	if env.ID == "" {
		slog.Debug("msgbox.rpc_missing_id", "from", conn.DID)
		return
	}
	if env.FromDID == "" || env.ToDID == "" {
		slog.Debug("msgbox.rpc_missing_did", "from", conn.DID)
		return
	}
	if env.Direction != "request" && env.Direction != "response" {
		slog.Debug("msgbox.rpc_bad_direction", "direction", env.Direction, "from", conn.DID)
		return
	}

	// Sender binding: envelope.from_did must match authenticated connection DID.
	if env.FromDID != conn.DID {
		slog.Warn("msgbox.rpc_sender_mismatch", "envelope_from", env.FromDID, "conn_did", conn.DID)
		return
	}

	// Role enforcement: did:key senders (CLI devices) can only send requests.
	// Responses come from Home Nodes (did:plc). A did:key sending a response
	// is either a bug or a cache-poisoning attempt.
	if env.Direction == "response" && strings.HasPrefix(env.FromDID, "did:key:") {
		slog.Warn("msgbox.rpc_didkey_response_rejected", "from", env.FromDID, "id", env.ID)
		return
	}

	// Pairing IP throttle: rate-limit by source IP for envelopes with
	// subtype "pair". This is client-controlled metadata (not signed), so
	// a custom client can bypass it by omitting the field. The primary
	// brute-force protection is Core's per-code attempt counter (burn
	// after 3 failures). The IP throttle is defense-in-depth.
	// We cannot throttle all did:key senders because paired CLI devices
	// also use did:key for normal operations.
	if env.Subtype == "pair" && conn.RemoteAddr != "" {
		ip := conn.RemoteAddr
		if idx := strings.LastIndex(ip, ":"); idx != -1 {
			ip = ip[:idx]
		}
		if !h.pairIPLimiter.allow(ip) {
			slog.Warn("msgbox.pairing_ip_throttled", "ip", conn.RemoteAddr, "from", conn.DID)
			return
		}
	}

	// Rate limiting (RPC bucket — separate from D2D).
	// Only rate-limit requests, not responses. A busy Home Node sending
	// many responses should not be throttled by its own rate limit bucket.
	if env.Direction == "request" && !h.rpcLimiter.allow(conn.DID) {
		slog.Warn("msgbox.rpc_rate_limited", "from", conn.DID)
		return
	}

	// Composite buffer key: sender-scoped to prevent cross-device collision.
	msgID := env.FromDID + ":" + env.ID

	// Pass sender + expires_at so the buffer can enforce ownership and expiry.
	var bufOpts []AddOption
	bufOpts = append(bufOpts, WithSender(env.FromDID))
	if env.ExpiresAt != nil {
		bufOpts = append(bufOpts, WithExpiresAt(*env.ExpiresAt))
	}

	status, err := h.Hub.Deliver(env.ToDID, msgID, raw, bufOpts...)
	if err != nil {
		slog.Warn("msgbox.rpc_deliver_failed", "from", conn.DID, "to", env.ToDID, "error", err)
		return
	}
	slog.Info("msgbox.rpc_routed", "from", conn.DID, "to", env.ToDID, "id", env.ID, "status", status)
}

// routeCancel handles cancel messages. Tries to delete from buffer first;
// if not found, relays to the recipient's connection.
func (h *Handler) routeCancel(conn *MsgBoxConn, env *envelope) {
	if env.CancelOf == "" || env.FromDID == "" {
		slog.Debug("msgbox.cancel_missing_fields", "from", conn.DID)
		return
	}

	// Sender binding.
	if env.FromDID != conn.DID {
		slog.Warn("msgbox.cancel_sender_mismatch", "envelope_from", env.FromDID, "conn_did", conn.DID)
		return
	}

	// Composite key matches what routeRPC stored.
	compositeKey := env.FromDID + ":" + env.CancelOf
	if h.Hub.buf.DeleteIfExists(compositeKey) {
		slog.Info("msgbox.cancel_deleted_buffered", "cancel_of", env.CancelOf, "from", conn.DID)
		return
	}

	// Already delivered — relay cancel to recipient (best-effort).
	// Include sender and short expiry so it doesn't linger in the 24h buffer.
	if env.ToDID != "" {
		cancelPayload, _ := json.Marshal(env)
		cancelExpiry := time.Now().Unix() + 120 // 2-minute expiry for relayed cancels
		h.Hub.Deliver(env.ToDID, generateMsgID(), cancelPayload,
			WithSender(env.FromDID), WithExpiresAt(cancelExpiry))
		slog.Info("msgbox.cancel_relayed", "cancel_of", env.CancelOf, "to", env.ToDID)
	}
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

	// Decode public key.
	pubBytes, pubErr := hex.DecodeString(pubHex)
	if pubErr != nil || len(pubBytes) != ed25519.PublicKeySize {
		http.Error(w, `{"error":"invalid public key"}`, http.StatusUnauthorized)
		return
	}

	// DID-key binding: for did:key senders, verify the provided public key
	// matches the key encoded in the DID. Without this, an attacker can
	// claim any DID but sign with their own key.
	if strings.HasPrefix(senderDID, "did:key:") {
		expectedDID := deriveDIDKey(pubBytes)
		if senderDID != expectedDID {
			http.Error(w, `{"error":"X-Sender-DID does not match X-Sender-Pub"}`, http.StatusUnauthorized)
			return
		}
	} else if strings.HasPrefix(senderDID, "did:plc:") {
		// did:plc binding: verify provided public key matches #dina_signing
		// in the PLC document. Without this, an attacker can claim any
		// did:plc and sign with their own key.
		if h.PLCResolver != nil {
			plcKey, plcErr := h.PLCResolver.ResolveDinaSigningKey(r.Context(), senderDID)
			if plcErr != nil {
				http.Error(w, `{"error":"PLC document lookup failed"}`, http.StatusUnauthorized)
				return
			}
			if !ed25519.PublicKey(pubBytes).Equal(plcKey) {
				http.Error(w, `{"error":"X-Sender-Pub does not match #dina_signing in PLC document"}`, http.StatusUnauthorized)
				return
			}
		} else {
			// No resolver configured — accept signature-only verification.
			// Recipient-side D2D verification still provides end-to-end authenticity.
			slog.Debug("msgbox.forward_did_plc_no_resolver", "sender", senderDID)
		}
	}

	// Verify Ed25519 signature over canonical payload.
	// Includes recipient DID to cryptographically bind routing to the sender's intent.
	bodyHash := sha256Hex(body)
	canonical := fmt.Sprintf("POST\n/forward\n%s\n%s\n%s\n%s", recipientDID, ts, nonce, bodyHash)
	sigBytes, sigErr := hex.DecodeString(sig)
	if sigErr != nil || len(sigBytes) != ed25519.SignatureSize {
		http.Error(w, `{"error":"invalid signature encoding"}`, http.StatusUnauthorized)
		return
	}
	if !ed25519.Verify(pubBytes, []byte(canonical), sigBytes) {
		http.Error(w, `{"error":"signature verification failed"}`, http.StatusUnauthorized)
		return
	}

	// --- Nonce replay protection ---
	// The nonce is already part of the signed canonical payload, so it cannot
	// be modified. But without server-side storage, a captured signed request
	// can be replayed verbatim within the 5-min timestamp window.
	if h.nonceCache != nil && !h.nonceCache.CheckAndStore(senderDID, nonce) {
		http.Error(w, `{"error":"nonce replay detected"}`, http.StatusUnauthorized)
		return
	}

	// --- Rate limiting by sender DID ---
	if !h.d2dLimiter.allow(senderDID) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded"})
		return
	}

	// --- Deliver ---
	// Message ID is always server-generated. Client-supplied X-Msg-ID is
	// ignored to prevent ID collision attacks (an attacker could pre-occupy
	// an ID to cause a later legitimate message to be silently dropped
	// by the buffer's idempotency check).
	msgID := generateMsgID()

	// Wrap the raw d2dPayload body into a unified D2D envelope so that
	// all buffered/delivered messages use the same JSON envelope format.
	// The ciphertext field carries the d2dPayload body as an opaque string.
	d2dEnv := envelope{
		Type:       "d2d",
		ID:         msgID,
		FromDID:    senderDID,
		ToDID:      recipientDID,
		Ciphertext: string(body),
	}
	envelopeBytes, _ := json.Marshal(d2dEnv)

	compositeKey := senderDID + ":" + msgID
	status, deliverErr := h.Hub.Deliver(recipientDID, compositeKey, envelopeBytes, WithSender(senderDID))
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
	rateLimitMaxD2D     = 60  // D2D per DID
	rateLimitMaxRPC     = 300 // RPC per DID
	rateLimitMaxPairing = 10  // Pairing per source IP (subtype "pair")
	rateLimitCleanup    = 5 * time.Minute
)

type senderLimiter struct {
	mu      sync.Mutex
	max     int
	windows map[string][]time.Time
}

func newSenderLimiterWithMax(max int) *senderLimiter {
	l := &senderLimiter{max: max, windows: make(map[string][]time.Time)}
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

	if len(times) >= l.max {
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
