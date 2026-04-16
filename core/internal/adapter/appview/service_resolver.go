// service_resolver.go — AppView client for public service lookup.
//
// Calls com.dina.service.isPublic to check if a remote DID is a published
// public service with a given capability. Results are cached with a 5-minute
// TTL. Fails closed: if AppView is unreachable, returns (false, error).
package appview

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// ServiceResolver checks whether a remote DID is a published public service.
// Implements port.PublicServiceResolver.
type ServiceResolver struct {
	appViewURL string
	client     *http.Client
	cacheTTL   time.Duration

	mu    sync.Mutex
	cache map[string]*cacheEntry
}

type cacheEntry struct {
	isPublic     bool
	capabilities []string
	fetchedAt    time.Time
}

// NewServiceResolver creates a resolver that queries the AppView.
func NewServiceResolver(appViewURL string) *ServiceResolver {
	return &ServiceResolver{
		appViewURL: appViewURL,
		client:     &http.Client{Timeout: 5 * time.Second},
		cacheTTL:   5 * time.Minute,
		cache:      make(map[string]*cacheEntry),
	}
}

// IsPublicService returns true if the DID has a published public service
// profile with the given capability. Fails closed on error.
func (r *ServiceResolver) IsPublicService(did string, capability string) (bool, error) {
	entry, ok := r.getCached(did)
	if ok {
		return entry.isPublic && containsCapability(entry.capabilities, capability), nil
	}

	// Fetch from AppView.
	isPublic, caps, err := r.fetch(did)
	if err != nil {
		return false, err // fail closed
	}

	r.putCache(did, isPublic, caps)
	return isPublic && containsCapability(caps, capability), nil
}

func (r *ServiceResolver) getCached(did string) (*cacheEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.cache[did]
	if !ok || time.Since(entry.fetchedAt) > r.cacheTTL {
		return nil, false
	}
	return entry, true
}

func (r *ServiceResolver) putCache(did string, isPublic bool, caps []string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.cache[did] = &cacheEntry{
		isPublic:     isPublic,
		capabilities: caps,
		fetchedAt:    time.Now(),
	}
}

func (r *ServiceResolver) fetch(did string) (bool, []string, error) {
	u := fmt.Sprintf("%s/xrpc/com.dina.service.isPublic?did=%s",
		r.appViewURL, url.QueryEscape(did))

	resp, err := r.client.Get(u)
	if err != nil {
		return false, nil, fmt.Errorf("appview: isPublic request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, nil, fmt.Errorf("appview: isPublic returned %d", resp.StatusCode)
	}

	var result struct {
		IsPublic     bool     `json:"isPublic"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false, nil, fmt.Errorf("appview: isPublic parse failed: %w", err)
	}

	return result.IsPublic, result.Capabilities, nil
}

func containsCapability(caps []string, target string) bool {
	for _, c := range caps {
		if c == target {
			return true
		}
	}
	return false
}
