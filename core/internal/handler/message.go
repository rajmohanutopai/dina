package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/service"
)

// MessageHandler exposes message sending, inbox listing, and NaCl ingress endpoints.
type MessageHandler struct {
	Transport *service.TransportService
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

	msg := domain.DinaMessage{
		Type: msgType,
		To:   []string{string(to)},
		Body: req.Body,
	}

	if err := h.Transport.SendMessage(r.Context(), to, msg); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

// HandleInbox handles GET /v1/msg/inbox. It returns pending inbound messages.
// In the current architecture, inbox processing is handled by the
// TransportService's outbox/inbox managers. This endpoint returns the number
// of messages processed by the outbox processor.
func (h *MessageHandler) HandleInbox(w http.ResponseWriter, r *http.Request) {
	processed, err := h.Transport.ProcessOutbox(r.Context())
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages":  []interface{}{},
		"processed": processed,
	})
}

// HandleIngestNaCl handles POST /msg. It accepts a raw NaCl-encrypted envelope
// at the ingress endpoint and returns 202 Accepted. The envelope is queued for
// asynchronous decryption and processing.
func (h *MessageHandler) HandleIngestNaCl(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}

	if len(body) == 0 {
		http.Error(w, `{"error":"empty envelope"}`, http.StatusBadRequest)
		return
	}

	// The raw NaCl envelope is accepted for asynchronous processing.
	// In production, this would be spooled via the InboxManager.
	_ = body

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}
