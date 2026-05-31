package port

import (
	"context"
)

// ClientNotifier pushes messages to connected client devices.
type ClientNotifier interface {
	Notify(ctx context.Context, deviceID string, payload []byte) error
	Broadcast(ctx context.Context, payload []byte) error
}

// DNDChecker reports whether the user has Do Not Disturb active.
// Core checks this when routing solicited and fiduciary notifications.
// Fiduciary overrides DND (silence would cause harm). Solicited is deferred
// during DND (user asked, but not urgently). Engagement is always queued
// regardless of DND state (handled before this check).
type DNDChecker interface {
	IsDNDActive(ctx context.Context) bool
}
