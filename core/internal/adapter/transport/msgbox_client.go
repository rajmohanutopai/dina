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
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/mr-tron/base58"
)

// MsgBoxClient manages the outbound WebSocket to the D2D msgbox.
type MsgBoxClient struct {
	mu sync.Mutex

	// This node's msgbox URL (where *I* register to receive messages).
	myMsgBoxURL string
	did        string
	privKey    ed25519.PrivateKey
	pubKey     ed25519.PublicKey
	onMessage  func([]byte) // callback for inbound D2D messages from msgbox

	// RPC dispatch (MBX-017): handles RPC envelopes relayed from CLI devices.
	rpcBridge  *RPCBridge         // routes inner requests through Core's handler chain
	rpcPool    *RPCWorkerPool     // bounded worker pool for async RPC dispatch
	rpcCache   *IdempotencyCache  // sender-scoped request dedup
	nonceCache *NonceCache        // replay protection
	decryptor  *RPCDecryptor      // NaCl sealed-box decryption (nil = plaintext mode for tests)

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
	conn.SetReadLimit(1 << 20) // 1 MiB — matches MsgBox MaxPayloadSize

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

	// Wait for explicit {"type":"auth_success"} from the server. Greenfield
	// relay — every server sends one, so a timeout or mismatched frame is a
	// real failure, not a legacy-server tolerance case.
	ackCtx, ackCancel := context.WithTimeout(authCtx, 5*time.Second)
	msgType, ackBytes, ackErr := conn.Read(ackCtx)
	ackCancel()
	if ackErr != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("auth ack read failed: %w", ackErr)
	}
	if msgType != websocket.MessageText {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("auth ack wrong frame type: %v", msgType)
	}
	var ack struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(ackBytes, &ack); err != nil {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("auth ack parse: %w", err)
	}
	if ack.Type != "auth_success" {
		conn.Close(websocket.StatusAbnormalClosure, "")
		return fmt.Errorf("auth rejected (got frame %q)", ack.Type)
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
		if msgType != websocket.MessageBinary || len(data) == 0 {
			continue
		}

		// Unified envelope dispatch: all binary frames are JSON envelopes
		// (type: "d2d", "rpc", or "cancel"). Unknown types are dropped.
		c.tryHandleEnvelope(data)
	}
}

// rpcEnvelopeIn is the outer RPC envelope received from MsgBox.
type rpcEnvelopeIn struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	FromDID   string `json:"from_did"`
	ToDID     string `json:"to_did"`
	Direction string `json:"direction"`
	ExpiresAt *int64 `json:"expires_at,omitempty"`
	Ciphertext string `json:"ciphertext,omitempty"`
	CancelOf  string `json:"cancel_of,omitempty"`
}

// tryHandleEnvelope attempts to parse and dispatch a unified JSON envelope.
// Handles all types: "d2d", "rpc", "cancel". Returns true if handled.
// Returns false if not valid JSON or unknown type (legacy D2D fallback).
func (c *MsgBoxClient) tryHandleEnvelope(data []byte) bool {
	var env rpcEnvelopeIn
	if err := json.Unmarshal(data, &env); err != nil {
		return false // not valid JSON → legacy D2D
	}

	switch env.Type {
	case "d2d":
		// Unified D2D envelope: extract the d2dPayload from the ciphertext
		// field and pass to the existing onMessage → ProcessInbound pipeline.
		payload := env.Ciphertext
		if payload == "" {
			slog.Debug("msgbox_client.d2d_empty_ciphertext", "from", env.FromDID, "id", env.ID)
			return true // handled (drop empty)
		}
		c.mu.Lock()
		cb := c.onMessage
		c.mu.Unlock()
		if cb != nil {
			cb([]byte(payload))
		}
		return true
	case "rpc":
		if env.Direction == "request" {
			c.dispatchRPCRequest(&env)
		}
		return true
	case "cancel":
		c.handleRPCCancel(&env)
		return true
	default:
		return false // unknown type → legacy D2D fallback
	}
}

// dispatchRPCRequest decrypts, validates, and dispatches an RPC request.
func (c *MsgBoxClient) dispatchRPCRequest(env *rpcEnvelopeIn) {
	if c.rpcPool == nil || c.rpcBridge == nil {
		slog.Warn("msgbox_client.rpc_not_configured")
		return
	}

	// Decrypt ciphertext.
	var innerJSON []byte
	if c.decryptor != nil {
		// Production mode: encryption is mandatory.
		if env.Ciphertext == "" {
			slog.Warn("msgbox_client.empty_ciphertext", "from", env.FromDID, "id", env.ID)
			c.sendRPCError(env, 400, "empty ciphertext — encryption required")
			return
		}
		var err error
		innerJSON, err = c.decryptor.DecryptCiphertext(env.Ciphertext)
		if err != nil {
			slog.Warn("msgbox_client.decrypt_failed", "from", env.FromDID, "id", env.ID, "error", err)
			c.sendRPCError(env, 400, "decryption failed")
			return
		}
	} else {
		// No decryptor — test mode. Treat ciphertext as plaintext JSON.
		innerJSON = []byte(env.Ciphertext)
	}

	// Inner body size guard (defense-in-depth). The WebSocket frame size
	// provides an implicit limit, but an explicit check prevents oversized
	// requests from reaching the handler chain if transport limits change.
	if len(innerJSON) > MaxInnerBodySize {
		slog.Warn("msgbox_client.inner_body_too_large", "from", env.FromDID, "id", env.ID, "size", len(innerJSON))
		c.sendRPCError(env, 413, "inner request body too large")
		return
	}

	// Identity binding: verify envelope.from_did matches inner X-DID.
	if err := VerifyIdentityBinding(env.FromDID, innerJSON); err != nil {
		// Try pairing identity binding (inner body has public_key_multibase).
		if err2 := VerifyPairingIdentityBinding(env.FromDID, innerJSON); err2 != nil {
			slog.Warn("msgbox_client.identity_binding_failed", "from", env.FromDID, "id", env.ID, "error", err)
			c.sendRPCError(env, 403, "identity binding failed")
			return
		}
	}

	// Idempotency check: return cached response if available.
	if c.rpcCache != nil {
		if cached := c.rpcCache.Get(env.FromDID, env.ID); cached != nil {
			slog.Debug("msgbox_client.idempotency_hit", "from", env.FromDID, "id", env.ID)
			c.sendRPCResponse(env, cached)
			return
		}
	}

	// Nonce replay check.
	if c.nonceCache != nil {
		var inner RPCInnerRequest
		if json.Unmarshal(innerJSON, &inner) == nil {
			nonce := inner.Headers["X-Nonce"]
			did := inner.Headers["X-DID"]
			if nonce != "" && did != "" {
				if !c.nonceCache.CheckAndStore(did, nonce) {
					slog.Warn("msgbox_client.nonce_replay", "from", env.FromDID, "id", env.ID)
					c.sendRPCError(env, 401, "nonce replay detected")
					return
				}
			}
		}
	}

	parentCtx := c.ctx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithCancel(parentCtx)
	task := &RPCTask{
		RequestID: env.ID,
		FromDID:   env.FromDID,
		ExpiresAt: env.ExpiresAt,
		InnerJSON: innerJSON,
		Ctx:       ctx,
		Cancel:    cancel,
	}

	switch c.rpcPool.Submit(task) {
	case SubmitOK:
		// Submitted successfully.
	case SubmitFull:
		cancel()
		slog.Warn("msgbox_client.rpc_pool_full", "from", env.FromDID, "id", env.ID)
		c.sendRPCError(env, 503, "Core overloaded — RPC worker pool full")
	case SubmitDuplicate:
		cancel()
		slog.Debug("msgbox_client.rpc_duplicate_inflight", "from", env.FromDID, "id", env.ID)
		c.sendRPCError(env, 409, "request already in-flight")
	case SubmitExpired:
		cancel()
		slog.Debug("msgbox_client.rpc_expired_on_receipt", "from", env.FromDID, "id", env.ID)
		c.sendRPCError(env, 408, "request expired before processing")
	}
}

// sendRPCResponse sends a successful RPC response envelope through MsgBox.
// The response is encrypted with the CLI device's X25519 public key (derived
// from the did:key in env.FromDID). When a decryptor is configured (production),
// encryption is mandatory — failure to encrypt drops the response rather than
// leaking vault data in plaintext.
func (c *MsgBoxClient) sendRPCResponse(env *rpcEnvelopeIn, resp *RPCInnerResponse) {
	innerJSON, err := json.Marshal(resp)
	if err != nil {
		slog.Error("msgbox_client.marshal_response", "error", err)
		return
	}

	// Encrypt the response with the CLI's X25519 public key.
	var ciphertextField string
	if c.decryptor != nil {
		// Production mode: encryption is mandatory for success responses.
		if !strings.HasPrefix(env.FromDID, "did:key:") {
			slog.Error("msgbox_client.encrypt_response_failed",
				"from", env.FromDID, "reason", "not a did:key DID, cannot derive X25519 key")
			return
		}
		sealed, err := c.encryptForCLI(env.FromDID, innerJSON)
		if err != nil {
			slog.Error("msgbox_client.encrypt_response_failed",
				"from", env.FromDID, "error", err)
			return
		}
		ciphertextField = base64Encode(sealed)
	} else {
		// Test mode (no decryptor): plaintext acceptable.
		ciphertextField = string(innerJSON)
	}

	responseExpiresAt := time.Now().Unix() + 120 // 2 minute response expiry
	envelope := map[string]interface{}{
		"type":       "rpc",
		"id":         env.ID,
		"from_did":   c.did,
		"to_did":     env.FromDID,
		"direction":  "response",
		"expires_at": responseExpiresAt,
		"ciphertext": ciphertextField,
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		slog.Error("msgbox_client.marshal_response_envelope", "error", err)
		return
	}
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	parentCtx := c.ctx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(parentCtx, 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
		slog.Warn("msgbox_client.send_response_failed", "error", err)
	}
}

// StartRPCWorkers starts the worker pool with the bridge handler.
// Workers process RPC tasks: bridge → store-before-send → respond.
// Call this after SetRPCBridge and before Start.
func (c *MsgBoxClient) StartRPCWorkers(ctx context.Context) {
	if c.rpcPool == nil || c.rpcBridge == nil {
		return
	}

	// Wire the expiry callback: when a task expires in the backlog, send
	// 408 so the CLI doesn't wait forever for a response that will never come.
	c.rpcPool.OnExpired = func(task *RPCTask) {
		slog.Info("msgbox_client.rpc_expired_in_backlog", "id", task.RequestID, "from", task.FromDID)
		env := &rpcEnvelopeIn{ID: task.RequestID, FromDID: task.FromDID}
		c.sendRPCError(env, 408, "request expired while queued")
	}

	c.rpcPool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		env := &rpcEnvelopeIn{ID: task.RequestID, FromDID: task.FromDID}

		// Execute through the bridge (same as direct HTTP).
		resp, err := c.rpcBridge.HandleInnerRequest(task.InnerJSON, task.Ctx)
		if err != nil {
			slog.Warn("msgbox_client.rpc_bridge_error", "id", task.RequestID, "error", err)
			// Must send the error response — the pool discards our return value,
			// so returning without sending leaves the CLI hanging forever.
			c.sendRPCError(env, 400, err.Error())
			errBody, _ := json.Marshal(map[string]string{"error": err.Error()})
			return &RPCInnerResponse{Status: 400, Body: string(errBody)}
		}

		// Store-before-send: cache before sending response.
		if c.rpcCache != nil {
			c.rpcCache.Put(task.FromDID, task.RequestID, resp)
		}

		// Send response back to CLI.
		c.sendRPCResponse(env, resp)

		return resp
	})
}

// handleRPCCancel handles cancel envelopes from CLI devices.
func (c *MsgBoxClient) handleRPCCancel(env *rpcEnvelopeIn) {
	if c.rpcPool == nil {
		return
	}
	if env.CancelOf == "" || env.FromDID == "" {
		return
	}
	c.rpcPool.CancelTask(env.FromDID, env.CancelOf)
}

// sendRPCError sends an error response envelope back through the MsgBox WebSocket.
// Error responses are best-effort encrypted: encrypt if possible, plaintext fallback
// is acceptable since error messages contain no user data (just generic error strings
// like "decryption failed" or "identity binding failed").
func (c *MsgBoxClient) sendRPCError(env *rpcEnvelopeIn, status int, message string) {
	// Build inner response with proper JSON marshaling (no string interpolation).
	errorBody, _ := json.Marshal(map[string]string{"error": message})
	innerResp := RPCInnerResponse{
		Status:  status,
		Headers: map[string]string{},
		Body:    string(errorBody),
	}
	innerJSON, _ := json.Marshal(innerResp)

	// Best-effort encryption for error responses.
	ciphertextField := string(innerJSON) // plaintext default (no user data in errors)
	if c.decryptor != nil && strings.HasPrefix(env.FromDID, "did:key:") {
		if sealed, err := c.encryptForCLI(env.FromDID, innerJSON); err == nil {
			ciphertextField = base64Encode(sealed)
		}
	}

	responseExpiresAt := time.Now().Unix() + 120
	resp := map[string]interface{}{
		"type":       "rpc",
		"id":         env.ID,
		"from_did":   c.did,
		"to_did":     env.FromDID,
		"direction":  "response",
		"expires_at": responseExpiresAt,
		"ciphertext": ciphertextField,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		slog.Error("msgbox_client.marshal_error_response", "error", err)
		return
	}
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	parentCtx := c.ctx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithTimeout(parentCtx, 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
		slog.Warn("msgbox_client.send_error_response_failed", "error", err)
	}
}

// SetRPCBridge configures the RPC bridge for handling CLI requests.
// Must be called before Start(). decryptor may be nil for test mode.
func (c *MsgBoxClient) SetRPCBridge(bridge *RPCBridge, pool *RPCWorkerPool, cache *IdempotencyCache, nonceCache *NonceCache, decryptor ...*RPCDecryptor) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rpcBridge = bridge
	c.rpcPool = pool
	c.rpcCache = cache
	c.nonceCache = nonceCache
	if len(decryptor) > 0 {
		c.decryptor = decryptor[0]
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

	canonical := fmt.Sprintf("POST\n/forward\n%s\n%s\n%s\n%s", recipientDID, ts, nonce, bodyHash)
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

// encryptForCLI encrypts data for the CLI device using its X25519 public key
// derived from the did:key DID.
func (c *MsgBoxClient) encryptForCLI(cliDID string, plaintext []byte) ([]byte, error) {
	if c.decryptor == nil {
		return nil, fmt.Errorf("no decryptor configured")
	}
	cliEd25519Pub, err := didKeyToEd25519(cliDID)
	if err != nil {
		return nil, err
	}
	cliX25519Pub, err := c.decryptor.converter.Ed25519ToX25519Public(cliEd25519Pub)
	if err != nil {
		return nil, fmt.Errorf("ed25519→x25519: %w", err)
	}
	return c.decryptor.decryptor.SealAnonymous(plaintext, cliX25519Pub)
}

// didKeyToEd25519 extracts the raw Ed25519 public key from a did:key DID.
// did:key:z{base58btc(0xed01 + 32-byte-pubkey)}
func didKeyToEd25519(did string) ([]byte, error) {
	if !strings.HasPrefix(did, "did:key:z") {
		return nil, fmt.Errorf("not a did:key: %s", did)
	}
	raw, err := base58.Decode(did[len("did:key:z"):])
	if err != nil {
		return nil, fmt.Errorf("base58 decode: %w", err)
	}
	if len(raw) != 34 || raw[0] != 0xed || raw[1] != 0x01 {
		return nil, fmt.Errorf("invalid Ed25519 multicodec")
	}
	return raw[2:], nil
}

func base64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}
