// relay_client.go — Outbound WebSocket connection to the Dina D2D relay/mailbox.
//
// The relay client maintains a persistent outbound WebSocket to the relay
// that this node's DID document advertises as its #dina_messaging service.
// It handles:
//   - Auth handshake (Ed25519 challenge-response)
//   - Reconnect with exponential backoff
//   - Inbound message delivery (relay pushes messages down the same WS)
//   - Forwarding messages to recipients via relay's POST /forward
package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	crypto_rand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// RelayClient manages the outbound WebSocket to the D2D relay.
type RelayClient struct {
	mu sync.Mutex

	// This node's relay URL (where *I* register to receive messages).
	myRelayURL string
	did        string
	privKey    ed25519.PrivateKey
	pubKey     ed25519.PublicKey
	onMessage  func([]byte) // callback for inbound messages from relay

	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	backoff time.Duration
}

// NewRelayClient creates a relay client for this node's mailbox.
// myRelayURL is the WebSocket URL of the relay where this node registers
// (e.g., "ws://relay:7700/ws"). This is NOT used for outbound routing —
// outbound routing comes from the recipient's DID document.
func NewRelayClient(myRelayURL, did string, privKey ed25519.PrivateKey) *RelayClient {
	return &RelayClient{
		myRelayURL: myRelayURL,
		did:        did,
		privKey:    privKey,
		pubKey:     privKey.Public().(ed25519.PublicKey),
		backoff:    time.Second,
	}
}

// SetOnMessage sets the callback for inbound messages received via relay.
func (c *RelayClient) SetOnMessage(fn func([]byte)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onMessage = fn
}

// Start connects to the relay and runs the read pump. Reconnects on failure.
// Blocks until ctx is cancelled.
func (c *RelayClient) Start(ctx context.Context) {
	c.ctx = ctx
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if err := c.connectAndAuth(ctx); err != nil {
			slog.Warn("msgbox_client.connect_failed", "url", c.myRelayURL, "error", err, "backoff", c.backoff)
			select {
			case <-time.After(c.backoff):
			case <-ctx.Done():
				return
			}
			// Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 60s.
			c.backoff = min(c.backoff*2, 60*time.Second)
			continue
		}

		// Reset backoff on successful connect.
		c.backoff = time.Second
		slog.Info("msgbox_client.connected", "url", c.myRelayURL, "did", c.did)

		// Read pump — blocks until connection drops.
		c.readPump()

		slog.Info("msgbox_client.disconnected", "url", c.myRelayURL)
	}
}

func (c *RelayClient) connectAndAuth(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(dialCtx, c.myRelayURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}

	// Read auth challenge.
	authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
	defer authCancel()

	_, chalBytes, err := conn.Read(authCtx)
	if err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("read challenge: %w", err)
	}

	var challenge struct {
		Type  string `json:"type"`
		Nonce string `json:"nonce"`
		TS    int64  `json:"ts"`
	}
	if err := json.Unmarshal(chalBytes, &challenge); err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("parse challenge: %w", err)
	}

	// Sign challenge.
	payload := fmt.Sprintf("AUTH_RELAY\n%s\n%d", challenge.Nonce, challenge.TS)
	sig := ed25519.Sign(c.privKey, []byte(payload))

	resp, _ := json.Marshal(map[string]string{
		"type": "auth_response",
		"did":  c.did,
		"sig":  hex.EncodeToString(sig),
		"pub":  hex.EncodeToString(c.pubKey),
	})

	if err := conn.Write(authCtx, websocket.MessageText, resp); err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("write auth: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	return nil
}

func (c *RelayClient) readPump() {
	for {
		msgType, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		if msgType == websocket.MessageBinary && len(data) > 0 {
			c.mu.Lock()
			cb := c.onMessage
			c.mu.Unlock()
			if cb != nil {
				cb(data)
			}
		}
	}
}

// ForwardToRelay sends an encrypted envelope to a recipient via a relay's
// POST /forward endpoint. This is used when the recipient's DID document
// advertises a DinaMsgBox service type.
//
// relayForwardURL is the relay's HTTP forward URL (e.g., "http://relay:7700/forward"),
// derived from the recipient's DID document service endpoint.
func (c *RelayClient) ForwardToRelay(ctx context.Context, relayForwardURL, recipientDID string, envelope []byte) error {
	slog.Info("msgbox_client.forward_attempt", "url", relayForwardURL, "to", recipientDID, "size", len(envelope))
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(randomBytes(16))
	bodyHash := sha256Hex(envelope)

	canonical := fmt.Sprintf("POST\n/forward\n\n%s\n%s\n%s", ts, nonce, bodyHash)
	sig := ed25519.Sign(c.privKey, []byte(canonical))

	req, err := http.NewRequestWithContext(ctx, "POST", relayForwardURL, bytes.NewReader(envelope))
	if err != nil {
		return fmt.Errorf("relay forward: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Recipient-DID", recipientDID)
	req.Header.Set("X-Sender-DID", c.did)
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Signature", hex.EncodeToString(sig))
	req.Header.Set("X-Sender-Pub", hex.EncodeToString(c.pubKey))

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("relay forward: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("relay forward: unexpected status %d", resp.StatusCode)
	}

	slog.Info("msgbox_client.forwarded", "to", recipientDID, "relay", relayForwardURL)
	return nil
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	crypto_rand.Read(b)
	return b
}
