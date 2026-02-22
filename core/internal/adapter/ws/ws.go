// Package ws implements the WebSocket protocol for client-core communication (section 9).
//
// Provides four subsystems:
//   - WSHub: manage WebSocket connections (register, unregister, broadcast, send)
//   - WSHandler: handle WebSocket messages (auth, routing, envelope format)
//   - HeartbeatManager: ping/pong heartbeat monitoring
//   - MessageBuffer: per-device missed message buffer with TTL
package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/port"
)

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

var (
	ErrClientNotFound    = errors.New("ws: client not found")
	ErrAuthFailed        = errors.New("ws: authentication failed")
	ErrAuthTimeout       = errors.New("ws: auth timeout exceeded")
	ErrInvalidMessage    = errors.New("ws: invalid message format")
	ErrUnknownType       = errors.New("ws: unknown message type")
	ErrMissingID         = errors.New("ws: missing message id")
	ErrBufferFull        = errors.New("ws: message buffer full")
	ErrBufferExpired     = errors.New("ws: message buffer expired")
	ErrClientAlreadyAuth = errors.New("ws: client already authenticated")
)

// Compile-time interface checks.
var _ port.WSHub = (*WSHub)(nil)
var _ port.WSHandler = (*WSHandler)(nil)
var _ port.HeartbeatManager = (*HeartbeatManager)(nil)
var _ port.MessageBuffer = (*MessageBuffer)(nil)

// Protocol constants per specification.
const (
	AuthTimeoutSeconds = 5   // 5-second auth timer on connect
	PingIntervalSec    = 30  // ping every 30 seconds
	PongTimeoutSec     = 10  // expect pong within 10 seconds
	MaxMissedPongCount = 3   // disconnect after 3 missed pongs
	MaxBufferMessages  = 50  // max 50 messages per device buffer
	BufferTTLSeconds   = 300 // 5-minute buffer TTL
)

// ---------------------------------------------------------------------------
// WSHub
// ---------------------------------------------------------------------------

// WSHub manages WebSocket connections: register, unregister, broadcast, send.
// It satisfies testutil.WSHub.
type WSHub struct {
	mu       sync.RWMutex
	clients  map[string]interface{} // clientID -> connection
	messages map[string][][]byte    // clientID -> sent messages
}

// NewWSHub returns a new WSHub.
func NewWSHub() *WSHub {
	return &WSHub{
		clients:  make(map[string]interface{}),
		messages: make(map[string][][]byte),
	}
}

// Register adds a client connection.
func (h *WSHub) Register(clientID string, conn interface{}) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[clientID] = conn
	return nil
}

// Unregister removes a client connection and cleans up resources.
func (h *WSHub) Unregister(clientID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, clientID)
	delete(h.messages, clientID)
	return nil
}

// Broadcast sends a message to all connected clients.
func (h *WSHub) Broadcast(message []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	for clientID := range h.clients {
		h.messages[clientID] = append(h.messages[clientID], message)
	}
	return nil
}

// Send sends a message to a specific client.
// If the client is not currently connected, the message is silently buffered
// for delivery when the client reconnects.
func (h *WSHub) Send(clientID string, message []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.messages[clientID] = append(h.messages[clientID], message)
	return nil
}

// ConnectedClients returns a count of active connections.
func (h *WSHub) ConnectedClients() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// ---------------------------------------------------------------------------
// WSHandler
// ---------------------------------------------------------------------------

// TokenValidator is the function signature for validating CLIENT_TOKENs.
// Returns (deviceName, nil) on success, or ("", error) on failure.
type TokenValidator func(token string) (deviceName string, err error)

// BrainRouter is the function signature for routing queries/commands to the brain.
// Returns the response payload as JSON bytes.
type BrainRouter func(clientID string, msgType string, payload map[string]interface{}) ([]byte, error)

// WSHandler handles WebSocket message authentication and routing.
// It satisfies testutil.WSHandler.
type WSHandler struct {
	mu              sync.RWMutex
	authenticated   map[string]string // clientID -> deviceName
	tokenValidator  TokenValidator
	brainRouter     BrainRouter
	hub             *WSHub
	heartbeat       *HeartbeatManager
	buffer          *MessageBuffer
}

// NewWSHandler returns a new WSHandler.
// tokenValidator validates CLIENT_TOKENs during auth.
// brainRouter routes queries/commands to the brain sidecar.
func NewWSHandler(validator TokenValidator, router BrainRouter) *WSHandler {
	return &WSHandler{
		authenticated:  make(map[string]string),
		tokenValidator: validator,
		brainRouter:    router,
	}
}

// SetHub sets the WSHub reference for push messages.
func (wh *WSHandler) SetHub(hub *WSHub) {
	wh.mu.Lock()
	defer wh.mu.Unlock()
	wh.hub = hub
}

// SetHeartbeat sets the HeartbeatManager reference.
func (wh *WSHandler) SetHeartbeat(hb *HeartbeatManager) {
	wh.mu.Lock()
	defer wh.mu.Unlock()
	wh.heartbeat = hb
}

// SetBuffer sets the MessageBuffer reference.
func (wh *WSHandler) SetBuffer(buf *MessageBuffer) {
	wh.mu.Lock()
	defer wh.mu.Unlock()
	wh.buffer = buf
}

// Authenticate validates a client's auth frame and returns the device name.
func (wh *WSHandler) Authenticate(_ context.Context, token string) (string, error) {
	if wh.tokenValidator == nil {
		return "", ErrAuthFailed
	}
	deviceName, err := wh.tokenValidator(token)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrAuthFailed, err)
	}
	if deviceName == "" {
		return "", ErrAuthFailed
	}
	return deviceName, nil
}

// MarkAuthenticated records that a client has completed auth.
func (wh *WSHandler) MarkAuthenticated(clientID, deviceName string) {
	wh.mu.Lock()
	defer wh.mu.Unlock()
	wh.authenticated[clientID] = deviceName
}

// HandleMessage parses and routes an incoming JSON message envelope.
// Returns the response envelope (JSON) or an error.
func (wh *WSHandler) HandleMessage(_ context.Context, clientID string, message []byte) ([]byte, error) {
	var envelope map[string]interface{}
	if err := json.Unmarshal(message, &envelope); err != nil {
		return nil, ErrInvalidMessage
	}

	msgType, _ := envelope["type"].(string)
	msgID, hasID := envelope["id"].(string)

	// Handle pong: no ID required.
	if msgType == "pong" {
		ts, _ := envelope["ts"].(float64)
		wh.mu.RLock()
		hb := wh.heartbeat
		wh.mu.RUnlock()
		if hb != nil {
			_ = hb.RecordPong(clientID, int64(ts))
		}
		return nil, nil
	}

	// Handle ack: requires id field.
	if msgType == "ack" {
		if !hasID {
			return wh.errorEnvelope("", 400, "missing id field")
		}
		wh.mu.RLock()
		buf := wh.buffer
		wh.mu.RUnlock()
		if buf != nil {
			// Look up device for this client.
			wh.mu.RLock()
			deviceName := wh.authenticated[clientID]
			wh.mu.RUnlock()
			if deviceName != "" {
				_ = buf.AckMessage(deviceName, msgID)
			}
		}
		return nil, nil
	}

	// All other message types require an id field.
	if !hasID || msgID == "" {
		return wh.errorEnvelope("", 400, "missing id field")
	}

	// Route by message type.
	switch msgType {
	case "query", "command":
		payload, _ := envelope["payload"].(map[string]interface{})
		if wh.brainRouter != nil {
			resp, err := wh.brainRouter(clientID, msgType, payload)
			if err != nil {
				return wh.replyEnvelope(msgID, "error", map[string]interface{}{
					"code":    500,
					"message": err.Error(),
				})
			}
			// Wrap brain response.
			var brainPayload map[string]interface{}
			if json.Unmarshal(resp, &brainPayload) != nil {
				brainPayload = map[string]interface{}{"text": string(resp)}
			}
			return wh.replyEnvelope(msgID, "whisper", brainPayload)
		}
		// No brain router configured: return a stub whisper.
		return wh.replyEnvelope(msgID, "whisper", map[string]interface{}{
			"text": "brain not connected",
		})

	default:
		// Unknown type: return error but do NOT disconnect (extensible protocol).
		return wh.errorEnvelopeWithReply(msgID, 400, fmt.Sprintf("unknown message type: %s", msgType))
	}
}

// IsAuthenticated reports whether the given client has completed auth.
func (wh *WSHandler) IsAuthenticated(clientID string) bool {
	wh.mu.RLock()
	defer wh.mu.RUnlock()
	_, ok := wh.authenticated[clientID]
	return ok
}

// AuthTimeout returns the auth timeout duration in seconds.
func (wh *WSHandler) AuthTimeout() int {
	return AuthTimeoutSeconds
}

// errorEnvelope builds a JSON error response envelope.
func (wh *WSHandler) errorEnvelope(replyTo string, code int, message string) ([]byte, error) {
	env := map[string]interface{}{
		"type": "error",
		"payload": map[string]interface{}{
			"code":    code,
			"message": message,
		},
	}
	if replyTo != "" {
		env["reply_to"] = replyTo
	}
	return json.Marshal(env)
}

// errorEnvelopeWithReply builds a JSON error response with reply_to.
func (wh *WSHandler) errorEnvelopeWithReply(replyTo string, code int, message string) ([]byte, error) {
	return wh.errorEnvelope(replyTo, code, message)
}

// replyEnvelope builds a JSON response envelope with reply_to.
func (wh *WSHandler) replyEnvelope(replyTo, msgType string, payload map[string]interface{}) ([]byte, error) {
	env := map[string]interface{}{
		"type":     msgType,
		"reply_to": replyTo,
		"payload":  payload,
	}
	return json.Marshal(env)
}

// ---------------------------------------------------------------------------
// HeartbeatManager
// ---------------------------------------------------------------------------

// HeartbeatManager implements ping/pong heartbeat monitoring.
// It satisfies testutil.HeartbeatManager.
type HeartbeatManager struct {
	mu          sync.Mutex
	missedPongs map[string]int   // clientID -> consecutive missed pongs
	lastPong    map[string]int64 // clientID -> last pong timestamp
	sendFunc    func(clientID string, data []byte) error
}

// NewHeartbeatManager returns a new HeartbeatManager.
// sendFunc is called to send ping frames to clients.
func NewHeartbeatManager(sendFunc func(clientID string, data []byte) error) *HeartbeatManager {
	return &HeartbeatManager{
		missedPongs: make(map[string]int),
		lastPong:    make(map[string]int64),
		sendFunc:    sendFunc,
	}
}

// SendPing sends a ping message to the specified client with the given timestamp.
func (hm *HeartbeatManager) SendPing(clientID string, ts int64) error {
	ping := map[string]interface{}{
		"type": "ping",
		"ts":   ts,
	}
	data, err := json.Marshal(ping)
	if err != nil {
		return err
	}
	if hm.sendFunc != nil {
		return hm.sendFunc(clientID, data)
	}
	return nil
}

// RecordPong records that a pong was received from the client.
func (hm *HeartbeatManager) RecordPong(clientID string, ts int64) error {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	hm.missedPongs[clientID] = 0
	hm.lastPong[clientID] = ts
	return nil
}

// MissedPongs returns the number of consecutive missed pongs for the client.
func (hm *HeartbeatManager) MissedPongs(clientID string) int {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	return hm.missedPongs[clientID]
}

// ResetPongCounter resets the missed pong counter for the client to zero.
func (hm *HeartbeatManager) ResetPongCounter(clientID string) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	hm.missedPongs[clientID] = 0
}

// IncrementMissed increments the missed pong counter for the client.
// Returns the new count.
func (hm *HeartbeatManager) IncrementMissed(clientID string) int {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	hm.missedPongs[clientID]++
	return hm.missedPongs[clientID]
}

// PingInterval returns the ping interval in seconds.
func (hm *HeartbeatManager) PingInterval() int {
	return PingIntervalSec
}

// PongTimeout returns the pong timeout in seconds.
func (hm *HeartbeatManager) PongTimeout() int {
	return PongTimeoutSec
}

// MaxMissedPongs returns the max missed pongs before disconnect.
func (hm *HeartbeatManager) MaxMissedPongs() int {
	return MaxMissedPongCount
}

// RemoveClient removes heartbeat state for a disconnected client.
func (hm *HeartbeatManager) RemoveClient(clientID string) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	delete(hm.missedPongs, clientID)
	delete(hm.lastPong, clientID)
}

// ---------------------------------------------------------------------------
// MessageBuffer
// ---------------------------------------------------------------------------

// MessageBuffer buffers messages for disconnected clients.
// It satisfies testutil.MessageBuffer.
type MessageBuffer struct {
	mu      sync.Mutex
	buffers map[string]*deviceBuffer // deviceID -> buffer
}

type deviceBuffer struct {
	messages  []bufferedMessage
	createdAt time.Time
}

type bufferedMessage struct {
	eventID string
	data    []byte
}

// NewMessageBuffer returns a new MessageBuffer.
func NewMessageBuffer() *MessageBuffer {
	return &MessageBuffer{
		buffers: make(map[string]*deviceBuffer),
	}
}

// Buffer stores a message for a disconnected device.
// Oldest messages are dropped when the buffer exceeds MaxBufferMessages.
func (mb *MessageBuffer) Buffer(deviceID string, message []byte) error {
	mb.mu.Lock()
	defer mb.mu.Unlock()

	buf, ok := mb.buffers[deviceID]
	if !ok {
		buf = &deviceBuffer{createdAt: time.Now()}
		mb.buffers[deviceID] = buf
	}

	// Extract event ID from message for ACK support.
	var env map[string]interface{}
	eventID := ""
	if json.Unmarshal(message, &env) == nil {
		if id, ok := env["id"].(string); ok {
			eventID = id
		}
	}

	buf.messages = append(buf.messages, bufferedMessage{
		eventID: eventID,
		data:    message,
	})

	// Enforce cap: drop oldest to keep newest MaxBufferMessages.
	if len(buf.messages) > MaxBufferMessages {
		excess := len(buf.messages) - MaxBufferMessages
		buf.messages = buf.messages[excess:]
	}

	return nil
}

// Flush returns all buffered messages for the device in FIFO order and clears the buffer.
func (mb *MessageBuffer) Flush(deviceID string) ([][]byte, error) {
	mb.mu.Lock()
	defer mb.mu.Unlock()

	buf, ok := mb.buffers[deviceID]
	if !ok || len(buf.messages) == 0 {
		return nil, nil
	}

	result := make([][]byte, len(buf.messages))
	for i, msg := range buf.messages {
		result[i] = msg.data
	}

	delete(mb.buffers, deviceID)
	return result, nil
}

// Count returns the number of buffered messages for the device.
func (mb *MessageBuffer) Count(deviceID string) int {
	mb.mu.Lock()
	defer mb.mu.Unlock()
	buf, ok := mb.buffers[deviceID]
	if !ok {
		return 0
	}
	return len(buf.messages)
}

// AckMessage removes a specific message from the buffer by event ID.
func (mb *MessageBuffer) AckMessage(deviceID string, eventID string) error {
	mb.mu.Lock()
	defer mb.mu.Unlock()

	buf, ok := mb.buffers[deviceID]
	if !ok {
		return nil
	}

	for i, msg := range buf.messages {
		if msg.eventID == eventID {
			buf.messages = append(buf.messages[:i], buf.messages[i+1:]...)
			return nil
		}
	}
	return nil
}

// MaxMessages returns the max number of messages per device buffer.
func (mb *MessageBuffer) MaxMessages() int {
	return MaxBufferMessages
}

// TTL returns the buffer TTL in seconds.
func (mb *MessageBuffer) TTL() int {
	return BufferTTLSeconds
}

// IsExpired reports whether the device's buffer has exceeded its TTL.
func (mb *MessageBuffer) IsExpired(deviceID string) bool {
	mb.mu.Lock()
	defer mb.mu.Unlock()

	buf, ok := mb.buffers[deviceID]
	if !ok {
		return false
	}
	return time.Since(buf.createdAt) > time.Duration(BufferTTLSeconds)*time.Second
}

// PurgeExpired removes all expired device buffers.
func (mb *MessageBuffer) PurgeExpired() int {
	mb.mu.Lock()
	defer mb.mu.Unlock()

	purged := 0
	ttl := time.Duration(BufferTTLSeconds) * time.Second
	for deviceID, buf := range mb.buffers {
		if time.Since(buf.createdAt) > ttl {
			delete(mb.buffers, deviceID)
			purged++
		}
	}
	return purged
}
