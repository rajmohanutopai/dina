package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// PDSPublisher signs and publishes AT Protocol records to the Personal Data Server.
type PDSPublisher interface {
	SignAndPublish(ctx context.Context, record domain.PDSRecord) (string, error)
	ValidateLexicon(record domain.PDSRecord) error
	DeleteRecord(ctx context.Context, tombstone domain.Tombstone) error
	QueueForRetry(ctx context.Context, record domain.PDSRecord) error
}
