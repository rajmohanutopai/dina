// plc_resolver.go — HTTP-based PLC document resolver for did:plc verification.
package internal

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// HTTPPLCResolver fetches PLC documents from plc.directory over HTTPS.
type HTTPPLCResolver struct {
	plcURL string // e.g., "https://plc.directory"
	client *http.Client
}

// NewHTTPPLCResolver creates a resolver that fetches from the given PLC URL.
func NewHTTPPLCResolver(plcURL string) *HTTPPLCResolver {
	return &HTTPPLCResolver{
		plcURL: strings.TrimRight(plcURL, "/"),
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// plcDocument is a minimal PLC document structure for extracting #dina_signing.
type plcDocument struct {
	VerificationMethod []plcVerificationMethod `json:"verificationMethod"`
}

type plcVerificationMethod struct {
	ID                 string `json:"id"`
	PublicKeyMultibase string `json:"publicKeyMultibase"`
}

// ResolveDinaSigningKey fetches the PLC document and extracts the Ed25519
// public key from the #dina_signing verification method.
func (r *HTTPPLCResolver) ResolveDinaSigningKey(ctx context.Context, did string) (ed25519.PublicKey, error) {
	url := fmt.Sprintf("%s/%s", r.plcURL, did)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("plc: build request: %w", err)
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("plc: fetch %s: %w", did, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("plc: fetch %s: status %d", did, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("plc: read body: %w", err)
	}

	var doc plcDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("plc: parse document: %w", err)
	}

	// Find #dina_signing or #key-1 verification method.
	// PLC ID format: "did:plc:abc123#dina_signing" — extract the fragment
	// after '#' and match exactly to avoid false positives from substring
	// matching (e.g., "#not_dina_signing" or "#dina_signing_v2").
	for _, vm := range doc.VerificationMethod {
		fragment := vm.ID
		if idx := strings.LastIndex(vm.ID, "#"); idx != -1 {
			fragment = vm.ID[idx+1:]
		}
		if fragment == "dina_signing" || fragment == "key-1" {
			return decodeMultibaseKey(vm.PublicKeyMultibase)
		}
	}

	return nil, fmt.Errorf("plc: %s has no #dina_signing verification method", did)
}

// decodeMultibaseKey decodes a z-prefixed base58btc multibase Ed25519 public key.
func decodeMultibaseKey(multibase string) (ed25519.PublicKey, error) {
	if len(multibase) < 2 || multibase[0] != 'z' {
		return nil, fmt.Errorf("plc: invalid multibase prefix")
	}
	raw := base58Decode(multibase[1:])
	if len(raw) != 34 || raw[0] != 0xed || raw[1] != 0x01 {
		return nil, fmt.Errorf("plc: invalid Ed25519 multicodec (expected 0xed01 + 32 bytes, got %d bytes)", len(raw))
	}
	return ed25519.PublicKey(raw[2:]), nil
}

// base58Decode decodes a Bitcoin base58 string (no check).
func base58Decode(s string) []byte {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	result := make([]byte, 0, len(s))
	for _, c := range []byte(s) {
		carry := strings.IndexByte(alphabet, c)
		if carry < 0 {
			return nil
		}
		for i := range result {
			carry += int(result[i]) * 58
			result[i] = byte(carry % 256)
			carry /= 256
		}
		for carry > 0 {
			result = append(result, byte(carry%256))
			carry /= 256
		}
	}
	// Leading zeros.
	for _, c := range []byte(s) {
		if c != '1' {
			break
		}
		result = append(result, 0)
	}
	// Reverse.
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result
}
