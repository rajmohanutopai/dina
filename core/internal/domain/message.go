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
	ID          string
	Type        MessageType
	From        string   // sender DID
	To          []string // recipient DIDs
	CreatedTime int64    // Unix timestamp
	Body        []byte   // JSON payload
}

// DinaEnvelope represents the encrypted envelope for transport.
type DinaEnvelope struct {
	Typ        string // "application/dina-encrypted+json"
	FromKID    string // "did:plc:...#key-1"
	ToKID      string // "did:plc:...#key-1"
	Ciphertext string // base64url-encoded
	Sig        string // Ed25519 signature
}

// OutboxMessage represents a message queued for delivery.
type OutboxMessage struct {
	ID        string
	ToDID     string
	Payload   []byte
	CreatedAt int64
	NextRetry int64
	Retries   int
	Status    string // pending, sending, delivered, failed
	Priority  int    // higher = more important (fiduciary > normal)
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
