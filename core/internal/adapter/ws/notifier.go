package ws

import (
	"context"

	"github.com/anthropics/dina/core/internal/port"
)

var _ port.ClientNotifier = (*Notifier)(nil)

// Notifier wraps WSHub to satisfy the port.ClientNotifier interface.
type Notifier struct {
	hub *WSHub
}

// NewNotifier returns a new Notifier backed by the given WSHub.
func NewNotifier(hub *WSHub) *Notifier {
	return &Notifier{hub: hub}
}

// Notify sends a payload to a specific device.
func (n *Notifier) Notify(_ context.Context, deviceID string, payload []byte) error {
	return n.hub.Send(deviceID, payload)
}

// Broadcast sends a payload to all connected devices.
func (n *Notifier) Broadcast(_ context.Context, payload []byte) error {
	return n.hub.Broadcast(payload)
}
