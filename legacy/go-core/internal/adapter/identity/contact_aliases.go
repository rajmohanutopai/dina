package identity

import (
	"context"
	"fmt"
	"sync"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time interface check.
var _ port.ContactAliasStore = (*InMemoryAliasStore)(nil)

// InMemoryAliasStore implements port.ContactAliasStore with in-memory maps.
type InMemoryAliasStore struct {
	mu      sync.RWMutex
	byDID   map[string][]aliasEntry       // DID → aliases
	byAlias map[string]string             // normalized alias → DID
	names   func() map[string]string      // callback to get name→DID map for collision checks
}

type aliasEntry struct {
	alias      string
	normalized string
}

// NewInMemoryAliasStore returns a new in-memory alias store.
// nameResolver returns normalized display_name → DID for bidirectional uniqueness.
func NewInMemoryAliasStore(nameResolver func() map[string]string) *InMemoryAliasStore {
	return &InMemoryAliasStore{
		byDID:   make(map[string][]aliasEntry),
		byAlias: make(map[string]string),
		names:   nameResolver,
	}
}

func (s *InMemoryAliasStore) AddAlias(_ context.Context, did, alias string) error {
	if msg := domain.ValidateAlias(alias); msg != "" {
		return fmt.Errorf("alias store: %s", msg)
	}

	normalized := domain.NormalizeAlias(alias)

	s.mu.Lock()
	defer s.mu.Unlock()

	// Check collision with contact names.
	if s.names != nil {
		for name := range s.names() {
			if domain.NormalizeAlias(name) == normalized {
				return fmt.Errorf("alias store: '%s' conflicts with an existing contact name", alias)
			}
		}
	}

	// Check collision with other aliases.
	if existingDID, ok := s.byAlias[normalized]; ok {
		if existingDID == did {
			return nil // idempotent
		}
		return fmt.Errorf("alias store: '%s' already belongs to another contact", alias)
	}

	s.byAlias[normalized] = did
	s.byDID[did] = append(s.byDID[did], aliasEntry{alias: alias, normalized: normalized})
	return nil
}

func (s *InMemoryAliasStore) RemoveAlias(_ context.Context, did, alias string) error {
	normalized := domain.NormalizeAlias(alias)

	s.mu.Lock()
	defer s.mu.Unlock()

	entries := s.byDID[did]
	found := false
	var kept []aliasEntry
	for _, e := range entries {
		if e.normalized == normalized {
			found = true
			continue
		}
		kept = append(kept, e)
	}
	if !found {
		return fmt.Errorf("alias store: alias '%s' not found for this contact", alias)
	}

	s.byDID[did] = kept
	delete(s.byAlias, normalized)
	return nil
}

func (s *InMemoryAliasStore) ListAliases(_ context.Context, did string) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []string
	for _, e := range s.byDID[did] {
		result = append(result, e.alias)
	}
	return result, nil
}

func (s *InMemoryAliasStore) ResolveAlias(_ context.Context, alias string) (string, error) {
	normalized := domain.NormalizeAlias(alias)

	s.mu.RLock()
	defer s.mu.RUnlock()

	did, ok := s.byAlias[normalized]
	if !ok {
		return "", fmt.Errorf("alias store: alias '%s' not found", alias)
	}
	return did, nil
}

func (s *InMemoryAliasStore) ListAllAliases(_ context.Context) (map[string][]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string][]string)
	for did, entries := range s.byDID {
		for _, e := range entries {
			result[did] = append(result[did], e.alias)
		}
	}
	return result, nil
}

func (s *InMemoryAliasStore) DeleteAllForContact(_ context.Context, did string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, e := range s.byDID[did] {
		delete(s.byAlias, e.normalized)
	}
	delete(s.byDID, did)
	return nil
}
