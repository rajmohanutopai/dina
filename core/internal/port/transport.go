package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// MessageSender sends encrypted messages to other Dina nodes.
type MessageSender interface {
	Send(ctx context.Context, to domain.DID, msg domain.DinaMessage) error
}

// MessageReceiver handles incoming decrypted messages.
type MessageReceiver interface {
	OnMessage(handler func(ctx context.Context, msg domain.DinaMessage) error)
}

// Deliverer delivers encrypted payloads to remote Dina node endpoints.
// Used by TransportService for immediate delivery after outbox enqueue.
type Deliverer interface {
	Deliver(ctx context.Context, endpoint string, payload []byte) error
}

// OutboxManager provides reliable message delivery with retry.
type OutboxManager interface {
	Enqueue(ctx context.Context, msg domain.OutboxMessage) (string, error)
	MarkDelivered(ctx context.Context, msgID string) error
	MarkFailed(ctx context.Context, msgID string) error
	Requeue(ctx context.Context, msgID string) error
	PendingCount(ctx context.Context) (int, error)
	ListPending(ctx context.Context) ([]domain.OutboxMessage, error)
}

// InboxManager provides inbound message processing with rate limiting.
type InboxManager interface {
	CheckIPRate(ip string) bool
	CheckGlobalRate() bool
	CheckPayloadSize(payload []byte) bool
	Spool(ctx context.Context, payload []byte) (string, error)
	SpoolSize() (int64, error)
	ProcessSpool(ctx context.Context) (int, error)
	DrainSpool(ctx context.Context) ([][]byte, error)
}
