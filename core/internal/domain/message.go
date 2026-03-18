package domain

// MessageType classifies a Dina-to-Dina message.
type MessageType string

const (
	MessageTypeSocial     MessageType = "dina/social/arrival"
	MessageTypeQuery      MessageType = "dina/query"
	MessageTypeResponse   MessageType = "dina/response"
	MessageTypeAck        MessageType = "dina/ack"
	MessageTypeHeartbeat  MessageType = "dina/heartbeat"
	MessageTypeEstate     MessageType = "dina/estate/notify"
	MessageTypeKeyDeliver MessageType = "dina/estate/key_deliver"
)

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
	ID        string `json:"id"`
	ToDID     string `json:"to_did"`
	Payload   []byte `json:"payload"`
	Sig       []byte `json:"sig"`        // Ed25519 signature over plaintext (before encryption)
	CreatedAt int64  `json:"created_at"`
	NextRetry int64  `json:"next_retry"`
	Retries   int    `json:"retries"`
	Status    string `json:"status"`   // pending, sending, delivered, failed
	Priority  int    `json:"priority"` // higher = more important (fiduciary > normal)
}

// OutboxStatus enumerates outbox message states.
type OutboxStatus string

const (
	OutboxPending   OutboxStatus = "pending"
	OutboxSending   OutboxStatus = "sending"
	OutboxDelivered OutboxStatus = "delivered"
	OutboxFailed    OutboxStatus = "failed"
)

// PriorityLevel defines message urgency following the Four Laws.
type PriorityLevel int

const (
	PriorityNormal    PriorityLevel = 5
	PriorityFiduciary PriorityLevel = 10 // Silence First: interrupt when silence causes harm
)
