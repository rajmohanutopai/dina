package domain

import (
	"encoding/json"
	"fmt"
)

// MessageType classifies a Dina-to-Dina message.
type MessageType string

// v1 message families — the fixed set accepted by the D2D v1 protocol.
// Estate and commerce are v2+ and excluded from the v1 handler surface.
const (
	// presence.signal — ephemeral location/status ping, never stored.
	MsgTypePresenceSignal MessageType = "presence.signal"

	// coordination.request — scheduling coordination (propose time, ask availability).
	MsgTypeCoordinationRequest MessageType = "coordination.request"

	// coordination.response — answer to a coordination request (accept, decline, counter).
	MsgTypeCoordinationResponse MessageType = "coordination.response"

	// social.update — relationship memory (profile, life event, context).
	MsgTypeSocialUpdate MessageType = "social.update"

	// safety.alert — urgent safety notification; always passes inbound.
	MsgTypeSafetyAlert MessageType = "safety.alert"

	// trust.vouch.request — ask a peer to vouch for a third party.
	MsgTypeTrustVouchRequest MessageType = "trust.vouch.request"

	// trust.vouch.response — answer to a vouch request; stored as attestation.
	MsgTypeTrustVouchResponse MessageType = "trust.vouch.response"

	// service.query — public service query (e.g., "when does bus 42 arrive?").
	// Ephemeral — never stored. Bypasses contact gate for public services.
	MsgTypeServiceQuery MessageType = "service.query"

	// service.response — answer to a service query (e.g., "45 minutes").
	// Ephemeral — never stored. Bypasses contact gate via reply window.
	MsgTypeServiceResponse MessageType = "service.response"

	// Legacy estate constants — kept for domain model; excluded from v1 D2D surface.
	MessageTypeEstate     MessageType = "dina/estate/notify"
	MessageTypeKeyDeliver MessageType = "dina/estate/key_deliver"

	// Legacy v0 constants — retained for backward compatibility with existing
	// tests and handler code. NOT part of v1 — rejected by ValidateV1Body.
	MessageTypeSocial    MessageType = "dina/social/arrival"
	MessageTypeQuery     MessageType = "dina/query"
	MessageTypeResponse  MessageType = "dina/response"
	MessageTypeAck       MessageType = "dina/ack"
	MessageTypeHeartbeat MessageType = "dina/heartbeat"
)

// V1MessageFamilies is the authoritative set of message types accepted by the
// D2D v1 protocol.  Any type not in this set is rejected on inbound and
// returns ErrUnknownMessageType; outbound sends with an unknown type receive
// a 400.
var V1MessageFamilies = map[MessageType]bool{
	MsgTypePresenceSignal:       true,
	MsgTypeCoordinationRequest:  true,
	MsgTypeCoordinationResponse: true,
	MsgTypeSocialUpdate:         true,
	MsgTypeSafetyAlert:          true,
	MsgTypeTrustVouchRequest:    true,
	MsgTypeTrustVouchResponse:   true,
	MsgTypeServiceQuery:         true,
	MsgTypeServiceResponse:      true,
}

// MsgTypeToScenario maps a v1 message type to its D2D scenario name.
// The scenario name is used for per-contact policy lookups.
func MsgTypeToScenario(t MessageType) string {
	switch t {
	case MsgTypePresenceSignal:
		return "presence"
	case MsgTypeCoordinationRequest, MsgTypeCoordinationResponse:
		return "coordination"
	case MsgTypeSocialUpdate:
		return "social"
	case MsgTypeSafetyAlert:
		return "safety"
	case MsgTypeTrustVouchRequest, MsgTypeTrustVouchResponse:
		return "trust"
	default:
		return ""
	}
}

// D2DMemoryTypes maps D2D v1 message types that produce memory content
// to valid vault item types. Real-time signals (presence.signal, safety.alert)
// are NOT staged — only relationship and trust memory.
//
// v1 mapping (greenfield — no backward-compat required):
//
//	social.update           → relationship_note
//	trust.vouch.response    → trust_attestation
var D2DMemoryTypes = map[MessageType]string{
	MsgTypeSocialUpdate:       "relationship_note",
	MsgTypeTrustVouchResponse: "trust_attestation",
}

// ---------------------------------------------------------------------------
// Per-family body schema structs
// ---------------------------------------------------------------------------

// PresenceSignalBody is the body of a presence.signal message.
// Ephemeral — never stored in the vault.
type PresenceSignalBody struct {
	// Status is a short free-form presence description (e.g. "online", "busy").
	Status string `json:"status"`
	// ETAMinutes is an optional ETA in minutes (e.g. "I'm 10 min away").
	ETAMinutes *int `json:"eta_minutes,omitempty"`
	// LocationLabel is a coarse location label (e.g. "home", "office").
	// Never contains GPS coordinates in v1.
	LocationLabel string `json:"location_label,omitempty"`
}

// SocialUpdateBody is the body of a social.update message.
// Produces relationship_note vault items.
type SocialUpdateBody struct {
	// Text is the free-form update text.
	Text string `json:"text"`
	// Category classifies the update (e.g. "life_event", "context", "profile").
	Category string `json:"category,omitempty"`
}

// SafetyAlertBody is the body of a safety.alert message.
// Always passes inbound regardless of scenario policy.
type SafetyAlertBody struct {
	// Message is the alert description.
	Message string `json:"message"`
	// Severity is one of "low", "medium", "high", "critical".
	Severity string `json:"severity"`
}

// TrustVouchRequestBody is the body of a trust.vouch.request message.
type TrustVouchRequestBody struct {
	// SubjectDID is the DID of the entity being vouched for.
	SubjectDID string `json:"subject_did"`
	// Context explains why the vouch is being requested.
	Context string `json:"context,omitempty"`
}

// TrustVouchResponseBody is the body of a trust.vouch.response message.
// Produces trust_attestation vault items.
type TrustVouchResponseBody struct {
	// SubjectDID is the DID of the vouched entity.
	SubjectDID string `json:"subject_did"`
	// Vouch is "yes", "no", or "partial".
	Vouch string `json:"vouch"`
	// Note is an optional free-form justification.
	Note string `json:"note,omitempty"`
	// RequestID links back to the originating trust.vouch.request.
	RequestID string `json:"request_id,omitempty"`
}

// CoordinationRequestBody is the body of a coordination.request message.
// Ephemeral — never stored.
type CoordinationRequestBody struct {
	// Action: propose_time, ask_availability, ask_confirmation.
	Action string `json:"action"`
	// ProposedTime is a Unix timestamp (optional, for propose_time).
	ProposedTime int64 `json:"proposed_time,omitempty"`
	// Context is a brief description of the coordination request.
	Context string `json:"context"`
}

// CoordinationResponseBody is the body of a coordination.response message.
// Ephemeral — never stored.
type CoordinationResponseBody struct {
	// Action: accept, decline, counter_propose.
	Action string `json:"action"`
	// CounterTime is a Unix timestamp (optional, for counter_propose).
	CounterTime int64 `json:"counter_time,omitempty"`
	// Note is an optional explanation.
	Note string `json:"note,omitempty"`
	// RequestID links back to the originating coordination.request.
	RequestID string `json:"request_id,omitempty"`
}

// ServiceQueryBody is the body of a service.query message.
// Ephemeral — never stored. Sent to public services via query window bypass.
type ServiceQueryBody struct {
	// QueryID is a sender-generated UUID for request/response correlation.
	QueryID string `json:"query_id"`
	// Capability identifies the service capability being queried (e.g., "eta_query").
	Capability string `json:"capability"`
	// Params is a capability-specific JSON object (validated by Brain, opaque to Core).
	Params json.RawMessage `json:"params"`
	// TTLSeconds is the freshness window. Queries older than this are dropped.
	TTLSeconds int `json:"ttl_seconds"`
}

// ServiceResponseBody is the body of a service.response message.
// Ephemeral — never stored. Sent back via reply window.
type ServiceResponseBody struct {
	// QueryID matches the originating service.query.
	QueryID string `json:"query_id"`
	// Capability echoes the queried capability.
	Capability string `json:"capability"`
	// Status is "success", "unavailable", or "error".
	Status string `json:"status"`
	// Result is a capability-specific JSON object (validated by Brain, opaque to Core).
	Result json.RawMessage `json:"result,omitempty"`
	// TTLSeconds is the freshness window for the response.
	TTLSeconds int `json:"ttl_seconds"`
}

// MaxServiceTTL is the maximum allowed TTL for service queries/responses (5 minutes).
const MaxServiceTTL = 300

// ---------------------------------------------------------------------------
// ValidateV1Body
// ---------------------------------------------------------------------------

// ValidateV1Body validates that a message's type is a known v1 family and
// that the body is well-formed JSON with the required fields for that type.
//
// Returns ErrUnknownMessageType if the type is not in V1MessageFamilies.
// Returns ErrInvalidD2DBody if the body fails per-type validation.
func ValidateV1Body(t MessageType, body []byte) error {
	if !V1MessageFamilies[t] {
		return fmt.Errorf("%w: %q", ErrUnknownMessageType, t)
	}

	switch t {
	case MsgTypePresenceSignal:
		var b PresenceSignalBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: presence.signal: %v", ErrInvalidD2DBody, err)
		}
		if b.Status == "" {
			return fmt.Errorf("%w: presence.signal: status is required", ErrInvalidD2DBody)
		}

	case MsgTypeCoordinationRequest:
		var b CoordinationRequestBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: coordination.request: %v", ErrInvalidD2DBody, err)
		}
		switch b.Action {
		case "propose_time", "ask_availability", "ask_confirmation":
			// valid
		case "":
			return fmt.Errorf("%w: coordination.request: action is required", ErrInvalidD2DBody)
		default:
			return fmt.Errorf("%w: coordination.request: action must be propose_time|ask_availability|ask_confirmation, got %q", ErrInvalidD2DBody, b.Action)
		}
		if b.Context == "" {
			return fmt.Errorf("%w: coordination.request: context is required", ErrInvalidD2DBody)
		}

	case MsgTypeCoordinationResponse:
		var b CoordinationResponseBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: coordination.response: %v", ErrInvalidD2DBody, err)
		}
		switch b.Action {
		case "accept", "decline", "counter_propose":
			// valid
		case "":
			return fmt.Errorf("%w: coordination.response: action is required", ErrInvalidD2DBody)
		default:
			return fmt.Errorf("%w: coordination.response: action must be accept|decline|counter_propose, got %q", ErrInvalidD2DBody, b.Action)
		}

	case MsgTypeSocialUpdate:
		var b SocialUpdateBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: social.update: %v", ErrInvalidD2DBody, err)
		}
		if b.Text == "" {
			return fmt.Errorf("%w: social.update: text is required", ErrInvalidD2DBody)
		}

	case MsgTypeSafetyAlert:
		var b SafetyAlertBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: safety.alert: %v", ErrInvalidD2DBody, err)
		}
		if b.Message == "" {
			return fmt.Errorf("%w: safety.alert: message is required", ErrInvalidD2DBody)
		}
		switch b.Severity {
		case "low", "medium", "high", "critical":
			// valid
		case "":
			return fmt.Errorf("%w: safety.alert: severity is required", ErrInvalidD2DBody)
		default:
			return fmt.Errorf("%w: safety.alert: severity must be low|medium|high|critical, got %q", ErrInvalidD2DBody, b.Severity)
		}

	case MsgTypeTrustVouchRequest:
		var b TrustVouchRequestBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: trust.vouch.request: %v", ErrInvalidD2DBody, err)
		}
		if b.SubjectDID == "" {
			return fmt.Errorf("%w: trust.vouch.request: subject_did is required", ErrInvalidD2DBody)
		}

	case MsgTypeTrustVouchResponse:
		var b TrustVouchResponseBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: trust.vouch.response: %v", ErrInvalidD2DBody, err)
		}
		if b.SubjectDID == "" {
			return fmt.Errorf("%w: trust.vouch.response: subject_did is required", ErrInvalidD2DBody)
		}
		switch b.Vouch {
		case "yes", "no", "partial":
			// valid
		case "":
			return fmt.Errorf("%w: trust.vouch.response: vouch is required", ErrInvalidD2DBody)
		default:
			return fmt.Errorf("%w: trust.vouch.response: vouch must be yes|no|partial, got %q", ErrInvalidD2DBody, b.Vouch)
		}

	case MsgTypeServiceQuery:
		var b ServiceQueryBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: service.query: %v", ErrInvalidD2DBody, err)
		}
		if b.QueryID == "" {
			return fmt.Errorf("%w: service.query: query_id is required", ErrInvalidD2DBody)
		}
		if b.Capability == "" {
			return fmt.Errorf("%w: service.query: capability is required", ErrInvalidD2DBody)
		}
		if b.TTLSeconds <= 0 || b.TTLSeconds > MaxServiceTTL {
			return fmt.Errorf("%w: service.query: ttl_seconds must be 1-%d, got %d", ErrInvalidD2DBody, MaxServiceTTL, b.TTLSeconds)
		}

	case MsgTypeServiceResponse:
		var b ServiceResponseBody
		if err := json.Unmarshal(body, &b); err != nil {
			return fmt.Errorf("%w: service.response: %v", ErrInvalidD2DBody, err)
		}
		if b.QueryID == "" {
			return fmt.Errorf("%w: service.response: query_id is required", ErrInvalidD2DBody)
		}
		if b.Capability == "" {
			return fmt.Errorf("%w: service.response: capability is required", ErrInvalidD2DBody)
		}
		switch b.Status {
		case "success", "unavailable", "error":
			// valid
		case "":
			return fmt.Errorf("%w: service.response: status is required", ErrInvalidD2DBody)
		default:
			return fmt.Errorf("%w: service.response: status must be success|unavailable|error, got %q", ErrInvalidD2DBody, b.Status)
		}
		if b.TTLSeconds <= 0 || b.TTLSeconds > MaxServiceTTL {
			return fmt.Errorf("%w: service.response: ttl_seconds must be 1-%d, got %d", ErrInvalidD2DBody, MaxServiceTTL, b.TTLSeconds)
		}

	}

	return nil
}

// MaxMessageBodySize is the maximum size for a D2D message body (256 KB).
// DM2: Enforced at domain level — handlers and transport check this limit.
const MaxMessageBodySize = 256 * 1024

// DinaMessage represents a DIDComm-compatible plaintext message.
type DinaMessage struct {
	ID          string      `json:"id"`
	Type        MessageType `json:"type"`
	From        string      `json:"from"`         // sender DID
	To          []string    `json:"to"`            // recipient DIDs
	CreatedTime int64       `json:"created_time"`  // Unix timestamp
	Body        []byte      `json:"body"`          // JSON payload
	Quarantined bool        `json:"quarantined"`   // true if sender not in trust cache — flagged for user review
}

// ValidateBody checks that the message body is within the size limit.
// DM2: Returns error if body exceeds MaxMessageBodySize.
func (m *DinaMessage) ValidateBody() error {
	if len(m.Body) > MaxMessageBodySize {
		return fmt.Errorf("message body exceeds %d bytes (got %d)", MaxMessageBodySize, len(m.Body))
	}
	return nil
}

// DinaEnvelope represents the encrypted envelope for transport.
type DinaEnvelope struct {
	Typ        string `json:"typ"`        // "application/dina-encrypted+json"
	FromKID    string `json:"from_kid"`   // "did:plc:...#key-1"
	ToKID      string `json:"to_kid"`     // "did:plc:...#key-1"
	Ciphertext string `json:"ciphertext"` // base64url-encoded
	Sig        string `json:"sig"`        // Ed25519 signature
}

// OutboxMessage represents a message queued for delivery.
type OutboxMessage struct {
	ID         string `json:"id"`
	ToDID      string `json:"to_did"`
	Payload    []byte `json:"payload"`
	Sig        []byte `json:"sig"`         // Ed25519 signature over plaintext (before encryption)
	CreatedAt  int64  `json:"created_at"`
	NextRetry  int64  `json:"next_retry"`
	Retries    int    `json:"retries"`
	Status     string `json:"status"`      // pending, pending_approval, sending, delivered, failed
	Priority   int    `json:"priority"`    // higher = more important (fiduciary > normal)
	ApprovalID string `json:"approval_id"` // links to unified ApprovalRequest (set when status=pending_approval)
}

// OutboxStatus enumerates outbox message states.
type OutboxStatus string

const (
	OutboxPending         OutboxStatus = "pending"
	OutboxPendingApproval OutboxStatus = "pending_approval" // blocked by explicit_once, awaiting owner
	OutboxSending         OutboxStatus = "sending"
	OutboxDelivered       OutboxStatus = "delivered"
	OutboxFailed          OutboxStatus = "failed"
)

// PriorityLevel defines message urgency following the Four Laws.
type PriorityLevel int

const (
	PriorityNormal    PriorityLevel = 5
	PriorityFiduciary PriorityLevel = 10 // Silence First: interrupt when silence causes harm
)
