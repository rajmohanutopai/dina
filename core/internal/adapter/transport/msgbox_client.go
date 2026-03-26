// msgbox_client.go — Outbound WebSocket connection to the Dina D2D msgbox.
//
// The msgbox client maintains a persistent outbound WebSocket to the msgbox
// that this node's DID document advertises as its #dina_messaging service.
// It handles:
//   - Auth handshake (Ed25519 challenge-response)
//   - Reconnect with exponential backoff
//   - Inbound message delivery (msgbox pushes messages down the same WS)
//   - Forwarding messages to recipients via msgbox's POST /forward
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

// MsgBoxClient manages the outbound WebSocket to the D2D msgbox.
type MsgBoxClient struct {
	mu sync.Mutex

	// This node's msgbox URL (where *I* register to receive messages).
	myMsgBoxURL string
	did        string
	privKey    ed25519.PrivateKey
	pubKey     ed25519.PublicKey
	onMessage  func([]byte) // callback for inbound messages from msgbox

	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	backoff time.Duration
}

// NewMsgBoxClient creates a msgbox client for this node's mailbox.
// myMsgBoxURL is the WebSocket URL of the msgbox where this node registers
// (e.g., "ws://msgbox:7700/ws"). This is NOT used for outbound routing —
// outbound routing comes from the recipient's DID document.
func NewMsgBoxClient(myMsgBoxURL, did string, privKey ed25519.PrivateKey) *MsgBoxClient {
	return &MsgBoxClient{
		myMsgBoxURL: myMsgBoxURL,
		did:        did,
		privKey:    privKey,
		pubKey:     privKey.Public().(ed25519.PublicKey),
		backoff:    time.Second,
	}
}

// SetOnMessage sets the callback for inbound messages received via msgbox.
func (c *MsgBoxClient) SetOnMessage(fn func([]byte)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onMessage = fn
}

// Start connects to the msgbox and runs the read pump. Reconnects on failure.
// Blocks until ctx is cancelled.
func (c *MsgBoxClient) Start(ctx context.Context) {
	c.ctx = ctx
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if err := c.connectAndAuth(ctx); err != nil {
			slog.Warn("msgbox_client.connect_failed", "url", c.myMsgBoxURL, "error", err, "backoff", c.backoff)
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
		slog.Info("msgbox_client.connected", "url", c.myMsgBoxURL, "did", c.did)

		// Read pump — blocks until connection drops.
		c.readPump()

		slog.Info("msgbox_client.disconnected", "url", c.myMsgBoxURL)
	}
}

func (c *MsgBoxClient) connectAndAuth(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(dialCtx, c.myMsgBoxURL, nil)
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

func (c *MsgBoxClient) readPump() {
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

// ForwardToMsgBox sends an encrypted envelope to a recipient via a msgbox's
// POST /forward endpoint. This is used when the recipient's DID document
// advertises a DinaMsgBox service type.
//
// msgboxForwardURL is the msgbox's HTTP forward URL (e.g., "http://msgbox:7700/forward"),
// derived from the recipient's DID document service endpoint.
func (c *MsgBoxClient) ForwardToMsgBox(ctx context.Context, msgboxForwardURL, recipientDID string, envelope []byte) error {
	slog.Info("msgbox_client.forward_attempt", "url", msgboxForwardURL, "to", recipientDID, "size", len(envelope))
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(randomBytes(16))
	bodyHash := sha256Hex(envelope)

	canonical := fmt.Sprintf("POST\n/forward\n\n%s\n%s\n%s", ts, nonce, bodyHash)
	sig := ed25519.Sign(c.privKey, []byte(canonical))

	req, err := http.NewRequestWithContext(ctx, "POST", msgboxForwardURL, bytes.NewReader(envelope))
	if err != nil {
		return fmt.Errorf("msgbox forward: build request: %w", err)
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
		return fmt.Errorf("msgbox forward: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("msgbox forward: unexpected status %d", resp.StatusCode)
	}

	slog.Info("msgbox_client.forwarded", "to", recipientDID, "msgbox", msgboxForwardURL)
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
