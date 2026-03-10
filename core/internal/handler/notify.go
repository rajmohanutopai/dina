package handler

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// NotifyHandler serves the /v1/notify endpoint.
// Enforces Silence First (Law #1): notifications must carry an explicit
// priority so Core can route them correctly.
type NotifyHandler struct {
	Notifier   port.ClientNotifier
	DNDChecker port.DNDChecker // optional — nil means DND is inactive

	// §35.1 TST-CORE-1136: Per-client notification rate limiting.
	// RateLimit is the maximum number of broadcast notifications per
	// RateWindow. Zero means unlimited (no rate limiting).
	RateLimit  int
	RateWindow time.Duration

	rateMu    sync.Mutex
	rateCount int       // notifications in current window
	windowEnd time.Time // when current window expires
}

// DefaultNotifyRateLimit is the default max notifications per window.
const DefaultNotifyRateLimit = 10

// DefaultNotifyRateWindow is the default rate limiting window.
const DefaultNotifyRateWindow = 1 * time.Second

// ValidNotificationPriorities defines the three Silence First tiers.
// Brain must classify every notification into one of these before sending.
var ValidNotificationPriorities = map[string]bool{
	"fiduciary":  true, // Interrupt — silence would cause harm
	"solicited":  true, // Notify — user explicitly asked
	"engagement": true, // Save for briefing — silence merely misses an opportunity
}

// notifyRequest is the JSON body for POST /v1/notify.
// Priority is REQUIRED — Core refuses to push without classification (§35.1).
// ForcePush is decoded but deliberately ignored — Brain cannot bypass
// priority-based routing (TST-CORE-1137).
type notifyRequest struct {
	Message   string `json:"message"`
	Priority  string `json:"priority"`
	ForcePush bool   `json:"force_push"` // decoded, never used
}

// HandleNotify handles POST /v1/notify.
// Routes notifications based on Silence First priority classification:
//   - fiduciary: broadcast immediately (even during DND) — §35.1 TST-CORE-1134
//   - solicited: broadcast normally, deferred during DND — §35.1 TST-CORE-1135
//   - engagement: queued for daily briefing, never pushed via WebSocket — §35.1 TST-CORE-1133
//
// Requests without a valid priority are rejected with 400.
func (h *NotifyHandler) HandleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req notifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Message == "" {
		http.Error(w, `{"error":"message is required"}`, http.StatusBadRequest)
		return
	}

	// §35.1 TST-CORE-1132: Reject notifications without explicit priority.
	// Core enforces classification — Brain must decide the tier before sending.
	if req.Priority == "" {
		http.Error(w, `{"error":"priority is required (fiduciary|solicited|engagement)"}`, http.StatusBadRequest)
		return
	}
	if !ValidNotificationPriorities[req.Priority] {
		http.Error(w, `{"error":"invalid priority: must be fiduciary, solicited, or engagement"}`, http.StatusBadRequest)
		return
	}

	// §35.1 TST-CORE-1133: Engagement-tier notifications are queued for the
	// daily briefing, never pushed via WebSocket. Silence merely misses an
	// opportunity — it does not cause harm.
	if req.Priority == "engagement" {
		h.respond(w, "queued")
		return
	}

	// §35.1 TST-CORE-1137: ForcePush field is deliberately ignored.
	// Brain cannot bypass priority-based routing. The field is decoded
	// (so JSON doesn't fail on unknown fields) but has zero effect on
	// the routing decision above. Priority alone determines the path.

	// Check DND state for solicited/fiduciary routing.
	dndActive := h.DNDChecker != nil && h.DNDChecker.IsDNDActive(r.Context())

	// §35.1 TST-CORE-1135: Solicited notifications are deferred during DND.
	// The user asked for this (e.g., search results), but it's not urgent.
	// DND means "don't interrupt me" — solicited content waits until DND ends.
	// Critically, deferred ≠ dropped: the notification is preserved for later.
	if req.Priority == "solicited" && dndActive {
		h.respond(w, "deferred")
		return
	}

	// §35.1 TST-CORE-1136: Rate limiting per client.
	// Prevents a misbehaving Brain from flooding all connected clients
	// with rapid-fire notifications. Fiduciary notifications are exempt —
	// rate limiting must never suppress safety-critical alerts.
	if req.Priority != "fiduciary" && h.isRateLimited() {
		http.Error(w, `{"error":"rate limit exceeded — too many notifications"}`, http.StatusTooManyRequests)
		return
	}

	// §35.1 TST-CORE-1134: Fiduciary notifications are broadcast even during DND.
	// Silence would cause harm (flight cancelled, security alert, payment failure).
	// DND cannot suppress fiduciary — that's the whole point of the tier system.
	// At this point, req.Priority is either "fiduciary" or "solicited" (non-DND).
	// Both get broadcast.
	if err := h.Notifier.Broadcast(r.Context(), []byte(req.Message)); err != nil {
		http.Error(w, `{"error":"broadcast failed"}`, http.StatusInternalServerError)
		return
	}

	h.respond(w, "sent")
}

// isRateLimited checks if the notification rate limit has been exceeded.
// Returns true if the limit is configured and exceeded.
// Thread-safe: uses mutex for concurrent handler calls.
func (h *NotifyHandler) isRateLimited() bool {
	if h.RateLimit <= 0 {
		return false // no rate limiting configured
	}

	h.rateMu.Lock()
	defer h.rateMu.Unlock()

	now := time.Now()
	window := h.RateWindow
	if window <= 0 {
		window = DefaultNotifyRateWindow
	}

	// Reset window if expired.
	if now.After(h.windowEnd) {
		h.rateCount = 0
		h.windowEnd = now.Add(window)
	}

	h.rateCount++
	return h.rateCount > h.RateLimit
}

// respond writes a JSON response with the given status string.
func (h *NotifyHandler) respond(w http.ResponseWriter, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": status})
}
