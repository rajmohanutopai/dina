package port

import (
	"context"
)

// ClientNotifier pushes messages to connected client devices.
type ClientNotifier interface {
	Notify(ctx context.Context, deviceID string, payload []byte) error
	Broadcast(ctx context.Context, payload []byte) error
}
