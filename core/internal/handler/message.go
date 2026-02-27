package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// MessageHandler exposes message sending, inbox listing, and NaCl ingress endpoints.
type MessageHandler struct {
	Transport     *service.TransportService
	IngressRouter *ingress.Router // nil = direct path (backward compat)
}

// sendRequest is the JSON body for POST /v1/msg/send.
type sendRequest struct {
	To   string `json:"to"`   // recipient DID
	Body []byte `json:"body"` // message payload
	Type string `json:"type"` // message type
}

// HandleSend handles POST /v1/msg/send. It parses the recipient DID and
// message body, calls TransportService.SendMessage, and returns 202 Accepted.
func (h *MessageHandler) HandleSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req sendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	to, err := domain.NewDID(req.To)
	if err != nil {
		http.Error(w, `{"error":"invalid recipient DID"}`, http.StatusBadRequest)
		return
	}

	msgType := domain.MessageType(req.Type)
	if msgType == "" {
		msgType = domain.MessageTypeQuery
	}

	// SEC-HIGH-08: Generate stable message ID and timestamp for replay protection.
	msgID := generateMsgID()
	msg := domain.DinaMessage{
		ID:          msgID,
		Type:        msgType,
		To:          []string{string(to)},
		Body:        req.Body,
		CreatedTime: time.Now().UTC().Unix(),
	}

	if err := h.Transport.SendMessage(r.Context(), to, msg); err != nil {
		clientError(w, "send failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

// HandleInbox handles GET /v1/msg/inbox. It returns all received inbound
// messages that have been decrypted and stored by HandleIngestNaCl.
func (h *MessageHandler) HandleInbox(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	msgs := h.Transport.GetInbound()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages": msgs,
		"count":    len(msgs),
	})
}

// HandleIngestNaCl handles POST /msg. It accepts a raw NaCl-encrypted envelope,
// routes through the ingress pipeline (rate limit → dead-drop/fast-path), and
// returns 202 Accepted.
func (h *MessageHandler) HandleIngestNaCl(w http.ResponseWriter, r *http.Request) {
	const maxEnvelopeSize = 256 * 1024 // 256 KB
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeSize)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			http.Error(w, `{"error":"payload too large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}

	if len(body) == 0 {
		http.Error(w, `{"error":"empty envelope"}`, http.StatusBadRequest)
		return
	}

	// Use ingress Router if wired (rate limit + dead-drop when locked).
	if h.IngressRouter != nil {
		ip := r.RemoteAddr
		if colonIdx := strings.LastIndex(ip, ":"); colonIdx != -1 {
			ip = ip[:colonIdx]
		}
		if err := h.IngressRouter.Ingest(r.Context(), ip, body); err != nil {
			slog.Warn("D2D ingress rejected", "error", err)
			if strings.Contains(err.Error(), "rate") {
				http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
				return
			}
			if strings.Contains(err.Error(), "spool") {
				http.Error(w, `{"error":"spool full"}`, http.StatusServiceUnavailable)
				return
			}
			http.Error(w, `{"error":"ingress failed"}`, http.StatusInternalServerError)
			return
		}

		// Router.Ingest handles both paths:
		// - Locked → dead-drop (stored as opaque blob for later sweep)
		// - Unlocked → inbox spool (immediate processing)
		// No direct ProcessInbound here — the Router owns the full pipeline.
		// ProcessPending (background ticker) handles decryption after vault unlock.

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
		return
	}

	// Fallback: direct path (no ingress Router wired).
	msg, err := h.Transport.ProcessInbound(r.Context(), body)
	if err != nil {
		slog.Warn("D2D ingest: could not decrypt", "error", err)
	} else {
		slog.Info("D2D message received and decrypted", "type", msg.Type, "to", msg.To)
		h.Transport.StoreInbound(msg)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

// generateMsgID creates a random 16-byte hex-encoded message ID.
func generateMsgID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
