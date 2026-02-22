package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// MessageSender sends encrypted messages to other Dina nodes.
type MessageSender interface {
	Send(ctx context.Context, to domain.DID, msg domain.DinaMessage) error
}

// MessageReceiver handles incoming decrypted messages.
type MessageReceiver interface {
	OnMessage(handler func(ctx context.Context, msg domain.DinaMessage) error)
}

// OutboxManager provides reliable message delivery with retry.
type OutboxManager interface {
	Enqueue(ctx context.Context, msg domain.OutboxMessage) (string, error)
	MarkDelivered(ctx context.Context, msgID string) error
	MarkFailed(ctx context.Context, msgID string) error
	Requeue(ctx context.Context, msgID string) error
	PendingCount(ctx context.Context) (int, error)
}

// InboxManager provides inbound message processing with rate limiting.
type InboxManager interface {
	CheckIPRate(ip string) bool
	CheckGlobalRate() bool
	CheckPayloadSize(payload []byte) bool
	Spool(ctx context.Context, payload []byte) (string, error)
	SpoolSize() (int64, error)
	ProcessSpool(ctx context.Context) (int, error)
}
