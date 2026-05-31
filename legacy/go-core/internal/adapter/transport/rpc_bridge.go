// rpc_bridge.go — WebSocket-to-HTTP bridge for CLI RPC over MsgBox.
//
// When Core receives an RPC envelope via the MsgBox WebSocket, the bridge
// decrypts the ciphertext, extracts the inner HTTP request (method, path,
// headers, body), builds an http.Request, and routes it through Core's
// handler chain. The response is captured and sent back as an RPC response
// envelope.
//
// The bridge preserves the exact same auth/handler path as direct HTTP.
// From the handler's perspective, a relayed request is indistinguishable
// from a direct HTTPS request.
package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

// MaxInnerBodySize is the maximum size of a decrypted inner RPC request JSON.
// This is defense-in-depth — the WebSocket frame size provides an implicit
// limit, but an explicit check prevents oversized requests from reaching the
// handler chain. 1 MiB matches the MsgBox's MaxPayloadSize.
const MaxInnerBodySize = 1 << 20 // 1 MiB

// RPCInnerRequest is the decrypted inner request from an RPC envelope.
// This is what the CLI encrypted inside the NaCl sealed-box.
type RPCInnerRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"` // raw JSON string
}

// RPCInnerResponse is the response captured from the handler chain,
// to be encrypted and sent back to the CLI.
type RPCInnerResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// RPCBridge routes decrypted RPC inner requests through Core's HTTP handler
// chain and captures the response.
type RPCBridge struct {
	handler http.Handler // Core's root mux (with all middleware)
}

// NewRPCBridge creates a bridge that routes through the given handler.
func NewRPCBridge(handler http.Handler) *RPCBridge {
	return &RPCBridge{handler: handler}
}

// HandleInnerRequest takes a decrypted inner request JSON, builds an
// http.Request, routes it through the handler chain, and returns the
// captured response.
//
// Identity binding: the caller (handleRPCRequest in msgbox_client.go)
// must verify envelope.from_did == inner X-DID BEFORE calling this.
func (b *RPCBridge) HandleInnerRequest(innerJSON []byte, ctx ...context.Context) (*RPCInnerResponse, error) {
	var inner RPCInnerRequest
	if err := json.Unmarshal(innerJSON, &inner); err != nil {
		return nil, fmt.Errorf("rpc_bridge: parse inner request: %w", err)
	}

	if inner.Method == "" || inner.Path == "" {
		return nil, fmt.Errorf("rpc_bridge: missing method or path")
	}

	// Build http.Request. Always provide a body reader (empty for GET/no-body).
	var bodyReader io.Reader = strings.NewReader(inner.Body)

	var reqCtx context.Context
	if len(ctx) > 0 && ctx[0] != nil {
		reqCtx = ctx[0]
	} else {
		reqCtx = context.Background()
	}
	req, err := http.NewRequestWithContext(reqCtx, inner.Method, inner.Path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("rpc_bridge: build request: %w", err)
	}

	// Copy inner headers to the request.
	for k, v := range inner.Headers {
		req.Header.Set(k, v)
	}

	// Route through handler chain.
	recorder := httptest.NewRecorder()
	b.handler.ServeHTTP(recorder, req)

	// Capture response.
	result := recorder.Result()
	defer result.Body.Close()
	respBody, _ := io.ReadAll(result.Body)

	respHeaders := make(map[string]string)
	for k := range result.Header {
		respHeaders[k] = result.Header.Get(k)
	}

	return &RPCInnerResponse{
		Status:  result.StatusCode,
		Headers: respHeaders,
		Body:    string(respBody),
	}, nil
}

// BuildInnerRequestJSON builds the inner request JSON that would be inside
// the NaCl sealed-box ciphertext.
func BuildInnerRequestJSON(method, path string, headers map[string]string, body string) ([]byte, error) {
	inner := RPCInnerRequest{
		Method:  method,
		Path:    path,
		Headers: headers,
		Body:    body,
	}
	return json.Marshal(inner)
}

// VerifyIdentityBinding checks that envelope.from_did matches inner X-DID.
// Returns error if they don't match.
func VerifyIdentityBinding(envelopeFromDID string, innerJSON []byte) error {
	var inner RPCInnerRequest
	if err := json.Unmarshal(innerJSON, &inner); err != nil {
		return fmt.Errorf("rpc_bridge: parse inner for identity binding: %w", err)
	}
	innerDID := inner.Headers["X-DID"]
	if innerDID == "" {
		return fmt.Errorf("rpc_bridge: inner request has no X-DID header")
	}
	if envelopeFromDID != innerDID {
		return fmt.Errorf("rpc_bridge: identity binding failed: envelope from_did=%q != inner X-DID=%q", envelopeFromDID, innerDID)
	}
	return nil
}

// VerifyPairingIdentityBinding checks that envelope.from_did matches
// "did:key:" + body.public_key_multibase for pairing requests.
// Pairing requests have no X-DID — the pairing code IS the auth.
func VerifyPairingIdentityBinding(envelopeFromDID string, innerJSON []byte) error {
	var inner RPCInnerRequest
	if err := json.Unmarshal(innerJSON, &inner); err != nil {
		return fmt.Errorf("rpc_bridge: parse inner for pairing binding: %w", err)
	}

	// Parse the body to extract public_key_multibase.
	var body struct {
		PublicKeyMultibase string `json:"public_key_multibase"`
	}
	if err := json.Unmarshal([]byte(inner.Body), &body); err != nil {
		return fmt.Errorf("rpc_bridge: parse pairing body: %w", err)
	}
	if body.PublicKeyMultibase == "" {
		return fmt.Errorf("rpc_bridge: pairing body has no public_key_multibase")
	}

	expectedDID := "did:key:" + body.PublicKeyMultibase
	if envelopeFromDID != expectedDID {
		return fmt.Errorf("rpc_bridge: pairing identity binding failed: envelope from_did=%q != did:key:%s", envelopeFromDID, body.PublicKeyMultibase)
	}
	return nil
}

