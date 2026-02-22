// Package identity provides DID management adapters.
package identity

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// WebResolver resolves did:web DIDs by fetching the DID Document from a well-known URL.
// did:web:example.com → GET https://example.com/.well-known/did.json
// did:web:example.com:path:to:doc → GET https://example.com/path/to/doc/did.json
type WebResolver struct {
	client *http.Client
}

// NewWebResolver creates a WebResolver with a 10-second timeout.
func NewWebResolver() *WebResolver {
	return &WebResolver{
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Resolve fetches and returns the DID Document for a did:web DID.
func (r *WebResolver) Resolve(did string) (json.RawMessage, error) {
	if !strings.HasPrefix(did, "did:web:") {
		return nil, fmt.Errorf("not a did:web DID: %s", did)
	}

	// Parse the domain and optional path from the DID.
	// did:web:example.com → https://example.com/.well-known/did.json
	// did:web:example.com:user:alice → https://example.com/user/alice/did.json
	specific := strings.TrimPrefix(did, "did:web:")
	parts := strings.Split(specific, ":")

	// URL-decode percent-encoded characters (e.g., %3A → :)
	for i, p := range parts {
		parts[i] = strings.ReplaceAll(p, "%3A", ":")
	}

	var url string
	if len(parts) == 1 {
		// Root domain: /.well-known/did.json
		url = "https://" + parts[0] + "/.well-known/did.json"
	} else {
		// Domain + path: /path/to/did.json
		url = "https://" + parts[0] + "/" + strings.Join(parts[1:], "/") + "/did.json"
	}

	resp, err := r.client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch DID document from %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DID document not found at %s: HTTP %d", url, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB limit
	if err != nil {
		return nil, fmt.Errorf("failed to read DID document: %w", err)
	}

	// Validate it's valid JSON.
	var doc json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("invalid DID document JSON: %w", err)
	}

	return doc, nil
}
