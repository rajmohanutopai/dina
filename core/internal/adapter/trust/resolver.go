package trust

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

var _ port.TrustResolver = (*Resolver)(nil)

// Resolver fetches trust profiles from AppView's XRPC endpoints.
// Falls back gracefully when AppView is unreachable.
type Resolver struct {
	baseURL string
	client  *http.Client
}

// NewResolver creates a trust resolver. If appViewURL is empty,
// all calls return empty results (AppView not configured).
func NewResolver(appViewURL string) *Resolver {
	return &Resolver{
		baseURL: appViewURL,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// appViewProfileResponse mirrors the AppView XRPC getProfile response.
type appViewProfileResponse struct {
	DID               string  `json:"did"`
	Handle            string  `json:"handle"`
	OverallTrustScore float64 `json:"overallTrustScore"`
	VouchCount        int     `json:"vouchCount"`
	ActiveDomains     []string `json:"activeDomains"`
}

// appViewGraphResponse mirrors the AppView XRPC getGraph response.
type appViewGraphResponse struct {
	Nodes []appViewGraphNode `json:"nodes"`
}

type appViewGraphNode struct {
	DID         string  `json:"did"`
	Handle      string  `json:"handle"`
	TrustScore  float64 `json:"trustScore"`
	Relationship string `json:"relationship"`
}

// ResolveProfile fetches the trust profile for a single DID from AppView.
func (r *Resolver) ResolveProfile(did string) (*domain.TrustEntry, error) {
	if r.baseURL == "" {
		return nil, nil
	}

	u := fmt.Sprintf("%s/xrpc/com.dina.trust.getProfile?did=%s", r.baseURL, url.QueryEscape(did))
	resp, err := r.client.Get(u)
	if err != nil {
		slog.Warn("trust_resolver: getProfile request failed", "did", did, "error", err)
		return nil, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		slog.Warn("trust_resolver: getProfile non-200", "did", did, "status", resp.StatusCode)
		return nil, nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, nil
	}

	var profile appViewProfileResponse
	if err := json.Unmarshal(body, &profile); err != nil {
		slog.Warn("trust_resolver: getProfile decode failed", "did", did, "error", err)
		return nil, nil
	}

	ring := scoreToRing(profile.OverallTrustScore, profile.VouchCount)

	return &domain.TrustEntry{
		DID:            profile.DID,
		DisplayName:    profile.Handle,
		TrustScore:     profile.OverallTrustScore,
		TrustRing:      ring,
		Relationship:   "unknown",
		Source:         "appview_sync",
		LastVerifiedAt: time.Now().Unix(),
	}, nil
}

// ResolveFullProfile fetches the raw AppView profile JSON for a DID.
// Returns the full JSON (no field loss from struct mapping) so Brain
// can use all trust signals for reasoning.
//
// Return semantics:
//   - (nil, nil)  → AppView not configured, or DID genuinely not found (404)
//   - (nil, err)  → transient failure (network error, timeout, bad response)
//   - (data, nil) → success
func (r *Resolver) ResolveFullProfile(did string) (json.RawMessage, error) {
	if r.baseURL == "" {
		return nil, domain.ErrAppViewNotConfigured
	}

	u := fmt.Sprintf("%s/xrpc/com.dina.trust.getProfile?did=%s", r.baseURL, url.QueryEscape(did))
	resp, err := r.client.Get(u)
	if err != nil {
		slog.Warn("trust_resolver: getFullProfile request failed", "did", did, "error", err)
		return nil, fmt.Errorf("appview unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// DID genuinely not in AppView — not an error.
		return nil, nil
	}

	if resp.StatusCode != http.StatusOK {
		slog.Warn("trust_resolver: getFullProfile non-200", "did", did, "status", resp.StatusCode)
		return nil, fmt.Errorf("appview returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("appview response read failed: %w", err)
	}

	// Validate it's valid JSON before returning.
	if !json.Valid(body) {
		slog.Warn("trust_resolver: getFullProfile invalid JSON", "did", did)
		return nil, fmt.Errorf("appview returned invalid JSON")
	}

	return json.RawMessage(body), nil
}

// ResolveNeighborhood fetches the trust graph around a center DID.
func (r *Resolver) ResolveNeighborhood(centerDID string, hops int, limit int) ([]domain.TrustEntry, error) {
	if r.baseURL == "" {
		return nil, nil
	}

	u := fmt.Sprintf("%s/xrpc/com.dina.trust.getGraph?did=%s&depth=%d&limit=%d",
		r.baseURL, url.QueryEscape(centerDID), hops, limit)
	resp, err := r.client.Get(u)
	if err != nil {
		slog.Warn("trust_resolver: getGraph request failed", "did", centerDID, "error", err)
		return nil, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		slog.Warn("trust_resolver: getGraph non-200", "did", centerDID, "status", resp.StatusCode)
		return nil, nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return nil, nil
	}

	var graph appViewGraphResponse
	if err := json.Unmarshal(body, &graph); err != nil {
		slog.Warn("trust_resolver: getGraph decode failed", "did", centerDID, "error", err)
		return nil, nil
	}

	now := time.Now().Unix()
	entries := make([]domain.TrustEntry, 0, len(graph.Nodes))
	for _, node := range graph.Nodes {
		rel := node.Relationship
		if rel == "" {
			rel = "unknown"
		}
		if !domain.ValidRelationships[rel] {
			rel = "unknown"
		}
		entries = append(entries, domain.TrustEntry{
			DID:            node.DID,
			DisplayName:    node.Handle,
			TrustScore:     node.TrustScore,
			TrustRing:      scoreToRing(node.TrustScore, 0),
			Relationship:   rel,
			Source:         "appview_sync",
			LastVerifiedAt: now,
		})
	}

	return entries, nil
}

// scoreToRing maps a trust score and vouch count to a trust ring.
func scoreToRing(score float64, vouches int) int {
	if score >= 0.7 && vouches >= 3 {
		return 3 // Verified + Actioned
	}
	if score >= 0.3 {
		return 2 // Verified
	}
	return 1 // Unverified
}
