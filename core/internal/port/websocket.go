package port

import "context"

// WSHub manages WebSocket connections for client devices.
type WSHub interface {
	Register(clientID string, conn interface{}) error
	Unregister(clientID string) error
	Broadcast(message []byte) error
	Send(clientID string, message []byte) error
	ConnectedClients() int
}

// WSHandler processes WebSocket protocol messages.
type WSHandler interface {
	Authenticate(ctx context.Context, token string) (deviceName string, err error)
	HandleMessage(ctx context.Context, clientID string, message []byte) (response []byte, err error)
	AuthTimeout() int
}

// HeartbeatManager monitors WebSocket connection health via ping/pong.
type HeartbeatManager interface {
	SendPing(clientID string, ts int64) error
	RecordPong(clientID string, ts int64) error
	MissedPongs(clientID string) int
	PingInterval() int
	PongTimeout() int
	MaxMissedPongs() int
}

// MessageBuffer stores missed messages for offline devices.
type MessageBuffer interface {
	Buffer(deviceID string, message []byte) error
	Flush(deviceID string) ([][]byte, error)
	Count(deviceID string) int
	MaxMessages() int
	TTL() int
}
