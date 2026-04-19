// Package service — MemoryService is the cross-persona reader for the
// working-memory ToC. It walks a set of unlocked personas, pulls their
// top-ranked topics, merges, and returns a bounded list sorted by
// decayed salience.
//
// The per-persona touch path is NOT in this service — it lives in the
// HTTP handler, which resolves the persona + its TopicStore and calls
// Touch directly. That keeps this service purely a read aggregator.
package service

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// TopicStoreProvider hands back a TopicStore for a given persona, or
// nil if the persona is locked / unknown. The Pool adapter satisfies
// this by looking up the persona's DB handle.
type TopicStoreProvider interface {
	TopicStoreFor(persona string) port.TopicStore
}

// MemoryService assembles a ranked ToC from one or more personas.
type MemoryService struct {
	provider TopicStoreProvider
	clock    port.Clock
}

// NewMemoryService returns a ToC aggregator. Clock is injected so tests
// can pin "now" without mocking time.
func NewMemoryService(provider TopicStoreProvider, clock port.Clock) *MemoryService {
	return &MemoryService{provider: provider, clock: clock}
}

// Toc returns up to `limit` topics across the named personas, ranked by
// decayed salience. Locked / unknown personas are silently skipped.
//
// The per-persona query pulls up to `limit` entries from each store —
// the merge step re-ranks and truncates. Pulling `limit` per persona
// gives enough headroom for the merge without fetching everything.
func (s *MemoryService) Toc(ctx context.Context, personas []string, limit int) ([]domain.TocEntry, error) {
	if limit <= 0 {
		return nil, nil
	}
	nowUnix := s.clock.Now().Unix()

	var merged []domain.TocEntry
	for _, persona := range personas {
		store := s.provider.TopicStoreFor(persona)
		if store == nil {
			continue // locked or unknown
		}
		topics, err := store.Top(ctx, limit, nowUnix)
		if err != nil {
			// Per-persona tolerance: a single persona failing to
			// yield topics shouldn't crash the whole ToC read. Most
			// common cause: the migration ran but the persona was
			// opened from a snapshot that predates v5 and never
			// closed. Log the reason, skip the persona, keep going.
			if strings.Contains(err.Error(), "no such table: topic_salience") {
				slog.Warn("memory.Toc.missing_table",
					"persona", persona,
					"hint", "migration v5 has not run for this persona yet")
				continue
			}
			slog.Warn("memory.Toc.persona_failed",
				"persona", persona, "error", err)
			continue
		}
		for _, t := range topics {
			merged = append(merged, domain.TocEntry{
				Persona:      persona,
				Topic:        t.Topic,
				Kind:         t.Kind,
				Salience:     salienceAt(t, nowUnix),
				LastUpdate:   t.LastUpdate,
				SampleItemID: t.SampleItemID,
			})
		}
	}

	sort.SliceStable(merged, func(i, j int) bool {
		return merged[i].Salience > merged[j].Salience
	})

	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged, nil
}

// salienceAt recomputes the salience for a topic at `nowUnix`. Kept
// here (not exported) so the domain package stays free of time math —
// only constants live there.
func salienceAt(t domain.Topic, nowUnix int64) float64 {
	dtDays := float64(nowUnix-t.LastUpdate) / 86400.0
	if dtDays < 0 {
		dtDays = 0
	}
	return t.SLong*math.Exp(-dtDays/domain.TopicTauLongDays) +
		domain.TopicShortMix*t.SShort*math.Exp(-dtDays/domain.TopicTauShortDays)
}

