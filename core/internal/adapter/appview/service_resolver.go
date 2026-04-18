// service_resolver.go — AppView client for provider service lookup.
//
// Calls com.dina.service.isDiscoverable to check if a remote DID is a published
// provider service with a given capability. Results are cached with a 5-minute
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

// ServiceResolver checks whether a remote DID is a published provider service.
// Implements port.ProviderServiceResolver.
type ServiceResolver struct {
	appViewURL string
	client     *http.Client
	cacheTTL   time.Duration

	mu    sync.Mutex
	cache map[string]*cacheEntry
}

type cacheEntry struct {
	isDiscoverable     bool
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

// IsDiscoverableService returns true if the DID has a published provider service
// profile with the given capability. Fails closed on error.
func (r *ServiceResolver) IsDiscoverableService(did string, capability string) (bool, error) {
	entry, ok := r.getCached(did)
	if ok {
		return entry.isDiscoverable && containsCapability(entry.capabilities, capability), nil
	}

	// Fetch from AppView.
	isDiscoverable, caps, err := r.fetch(did)
	if err != nil {
		return false, err // fail closed
	}

	r.putCache(did, isDiscoverable, caps)
	return isDiscoverable && containsCapability(caps, capability), nil
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

func (r *ServiceResolver) putCache(did string, isDiscoverable bool, caps []string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.cache[did] = &cacheEntry{
		isDiscoverable:     isDiscoverable,
		capabilities: caps,
		fetchedAt:    time.Now(),
	}
}

func (r *ServiceResolver) fetch(did string) (bool, []string, error) {
	u := fmt.Sprintf("%s/xrpc/com.dina.service.isDiscoverable?did=%s",
		r.appViewURL, url.QueryEscape(did))

	resp, err := r.client.Get(u)
	if err != nil {
		return false, nil, fmt.Errorf("appview: isDiscoverable request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, nil, fmt.Errorf("appview: isDiscoverable returned %d", resp.StatusCode)
	}

	var result struct {
		IsDiscoverable     bool     `json:"isDiscoverable"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false, nil, fmt.Errorf("appview: isDiscoverable parse failed: %w", err)
	}

	return result.IsDiscoverable, result.Capabilities, nil
}

func containsCapability(caps []string, target string) bool {
	for _, c := range caps {
		if c == target {
			return true
		}
	}
	return false
}
