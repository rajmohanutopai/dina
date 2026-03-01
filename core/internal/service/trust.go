package service

import (
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
// Decision logic:
//  1. Blocked contact → drop
//  2. Trusted/verified contact → accept
//  3. Trust cache score ≥ 0.3 → accept
//  4. Trust cache score < 0.3 → quarantine
//  5. Unknown (not in contacts or cache) → quarantine
func (s *TrustService) EvaluateIngress(senderDID string) domain.IngressDecision {
	if senderDID == "" {
		return domain.IngressQuarantine
	}

	// Check contacts first (highest authority — user manually manages these).
	trustLevel := s.contacts.GetTrustLevel(senderDID)
	switch trustLevel {
	case "blocked":
		return domain.IngressDrop
	case "trusted":
		return domain.IngressAccept
	case "verified":
		return domain.IngressAccept
	}

	// Check trust cache (synced from AppView).
	entry, err := s.cache.Lookup(senderDID)
	if err != nil {
		slog.Warn("trust.evaluate: cache lookup error", "did", senderDID, "error", err)
		return domain.IngressQuarantine
	}

	if entry != nil {
		if entry.TrustScore >= 0.3 {
			return domain.IngressAccept
		}
		return domain.IngressQuarantine
	}

	// Unknown sender — quarantine (don't drop, might be legitimate).
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
