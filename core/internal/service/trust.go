package service

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// TrustService orchestrates the local trust cache, AppView resolver,
// and contact directory for ingress gatekeeper decisions.
type TrustService struct {
	cache    port.TrustCache
	resolver port.TrustResolver
	contacts port.ContactLookup
}

// NewTrustService creates a trust service.
func NewTrustService(cache port.TrustCache, resolver port.TrustResolver, contacts port.ContactLookup) *TrustService {
	return &TrustService{
		cache:    cache,
		resolver: resolver,
		contacts: contacts,
	}
}

// EvaluateIngress makes a trust-based accept/quarantine/drop decision
// for an incoming D2D message. This is the hot-path call used by the
// ingress pipeline — must be fast (microseconds, no network calls).
//
// D2D v1 decision logic (strict contacts-only):
//  1. Empty sender DID → quarantine
//  2. Blocked contact → drop
//  3. Explicit contact (trusted/verified/unknown trust level) → accept
//  4. Not in contacts at all → quarantine (trust cache ignored in v1)
//
// The trust cache (AppView sync) is no longer used for the accept/quarantine
// decision in v1. Only explicit contacts (user-managed) pass. This prevents
// unknown senders from being accepted solely because they have a high
// AppView trust score.
func (s *TrustService) EvaluateIngress(senderDID string) domain.IngressDecision {
	if senderDID == "" {
		return domain.IngressQuarantine
	}

	// Check contacts (highest authority — user manually manages these).
	// D2D v1: only explicit contacts pass. Unknown senders → quarantine.
	trustLevel := s.contacts.GetTrustLevel(senderDID)
	switch trustLevel {
	case "blocked":
		return domain.IngressDrop
	case "trusted", "verified", "unknown":
		// Any explicit contact (even "unknown" trust level) is accepted.
		// The scenario policy layer (applied after trust check) handles
		// per-family allow/deny for known contacts.
		return domain.IngressAccept
	}

	// Not in the contact directory at all — quarantine (don't drop, might
	// be a new contact attempting first contact).
	if s.contacts.IsContact(senderDID) {
		// IsContact is the authoritative check; GetTrustLevel returned ""
		// only when trust_level field is empty — still a contact.
		return domain.IngressAccept
	}

	return domain.IngressQuarantine
}

// SyncNeighborhood fetches the trust neighborhood from AppView and
// updates the local cache. Called periodically (1 hour) and on-demand.
func (s *TrustService) SyncNeighborhood(ownDID string) error {
	if ownDID == "" {
		slog.Info("trust.sync: skipping — no own DID configured")
		return nil
	}

	entries, err := s.resolver.ResolveNeighborhood(ownDID, 2, 500)
	if err != nil {
		return err
	}

	if entries == nil {
		slog.Info("trust.sync: resolver returned nil (AppView not configured)")
		return nil
	}

	synced := 0
	now := time.Now().Unix()
	syncedDIDs := make(map[string]bool, len(entries))

	for _, entry := range entries {
		syncedDIDs[entry.DID] = true
		if err := s.cache.Upsert(entry); err != nil {
			slog.Warn("trust.sync: upsert failed", "did", entry.DID, "error", err)
			continue
		}
		synced++
	}

	// Remove stale entries: in cache from appview_sync but not in latest sync
	// and older than 7 days.
	cutoff := now - 7*24*3600
	existing, err := s.cache.List()
	if err == nil {
		for _, e := range existing {
			if e.Source == "appview_sync" && !syncedDIDs[e.DID] && e.UpdatedAt < cutoff {
				if err := s.cache.Remove(e.DID); err != nil {
					slog.Warn("trust.sync: remove stale failed", "did", e.DID, "error", err)
				}
			}
		}
	}

	// Update last sync timestamp.
	if err := s.cache.SetLastSync(now); err != nil {
		slog.Warn("trust.sync: set last sync failed", "error", err)
	}

	slog.Info("trust.sync: complete", "synced", synced, "total_from_appview", len(entries))
	return nil
}

// ResolveProfile fetches the full trust profile for a DID from AppView.
// Returns the raw JSON so Brain can use all trust signals.
func (s *TrustService) ResolveProfile(did string) (json.RawMessage, error) {
	return s.resolver.ResolveFullProfile(did)
}

// SearchTrust queries AppView for product/entity trust attestations.
func (s *TrustService) SearchTrust(query, category, subjectType string, limit int) (json.RawMessage, error) {
	return s.resolver.SearchTrust(query, category, subjectType, limit)
}

// GetCacheEntries returns all entries in the trust cache (for admin UI).
func (s *TrustService) GetCacheEntries() ([]domain.TrustEntry, error) {
	return s.cache.List()
}

// GetCacheStats returns cache summary statistics (for admin UI).
func (s *TrustService) GetCacheStats() (domain.TrustCacheStats, error) {
	return s.cache.Stats()
}

// ManualSync triggers an immediate sync (admin "Sync Now" button).
func (s *TrustService) ManualSync(ownDID string) (int, error) {
	entries, err := s.resolver.ResolveNeighborhood(ownDID, 2, 500)
	if err != nil {
		return 0, err
	}
	if entries == nil {
		return 0, nil
	}

	synced := 0
	for _, entry := range entries {
		if err := s.cache.Upsert(entry); err != nil {
			continue
		}
		synced++
	}

	now := time.Now().Unix()
	_ = s.cache.SetLastSync(now)

	return synced, nil
}
