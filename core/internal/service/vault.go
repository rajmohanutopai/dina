// Package service implements the application service layer.
// Services compose port interfaces to implement business workflows.
// They import ONLY port/ and domain/ packages, NEVER adapter/.
package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// VaultService orchestrates vault operations, combining search strategies
// and enforcing gatekeeper checks before data access.
type VaultService struct {
	manager    port.VaultManager
	reader     port.VaultReader
	writer     port.VaultWriter
	gatekeeper port.Gatekeeper
	clock      port.Clock
}

// NewVaultService constructs a VaultService with the given port dependencies.
func NewVaultService(
	manager port.VaultManager,
	reader port.VaultReader,
	writer port.VaultWriter,
	gatekeeper port.Gatekeeper,
	clock port.Clock,
) *VaultService {
	return &VaultService{
		manager:    manager,
		reader:     reader,
		writer:     writer,
		gatekeeper: gatekeeper,
		clock:      clock,
	}
}

// Query executes a search query against a persona's vault after verifying
// that the requesting agent has permission via the gatekeeper.
// The agentDID identifies who is making the request for audit purposes.
func (s *VaultService) Query(ctx context.Context, agentDID string, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error) {
	if !s.manager.IsOpen(persona) {
		return nil, fmt.Errorf("vault query: %w", domain.ErrPersonaLocked)
	}

	intent := domain.Intent{
		AgentDID:  agentDID,
		Action:    "vault_read",
		Target:    string(persona),
		PersonaID: string(persona),
	}
	decision, err := s.gatekeeper.EvaluateIntent(ctx, intent)
	if err != nil {
		return nil, fmt.Errorf("vault query: gatekeeper evaluation failed: %w", err)
	}
	if !decision.Allowed {
		return nil, fmt.Errorf("vault query: %w: %s", domain.ErrForbidden, decision.Reason)
	}

	items, err := s.reader.Query(ctx, persona, q)
	if err != nil {
		return nil, fmt.Errorf("vault query: %w", err)
	}
	return items, nil
}

// GetItem retrieves a single vault item by its primary key.
// It performs the same gatekeeper authorization checks as Query.
func (s *VaultService) GetItem(ctx context.Context, agentDID string, persona domain.PersonaName, id string) (*domain.VaultItem, error) {
	if !s.manager.IsOpen(persona) {
		return nil, fmt.Errorf("vault get item: %w", domain.ErrPersonaLocked)
	}

	intent := domain.Intent{
		AgentDID:  agentDID,
		Action:    "vault_read",
		Target:    id,
		PersonaID: string(persona),
	}
	decision, err := s.gatekeeper.EvaluateIntent(ctx, intent)
	if err != nil {
		return nil, fmt.Errorf("vault get item: gatekeeper evaluation failed: %w", err)
	}
	if !decision.Allowed {
		return nil, fmt.Errorf("vault get item: %w: %s", domain.ErrForbidden, decision.Reason)
	}

	return s.reader.GetItem(ctx, persona, id)
}

// GetKV retrieves a single key-value item by key. It is a convenience wrapper
// around GetItem that prefixes the key with "kv:" to match the storage convention.
func (s *VaultService) GetKV(ctx context.Context, agentDID string, persona domain.PersonaName, key string) (*domain.VaultItem, error) {
	return s.GetItem(ctx, agentDID, persona, "kv:"+key)
}

// Store persists a single item into a persona's vault.
// Returns the ID of the stored item.
func (s *VaultService) Store(ctx context.Context, persona domain.PersonaName, item domain.VaultItem) (string, error) {
	if !s.manager.IsOpen(persona) {
		return "", fmt.Errorf("vault store: %w", domain.ErrPersonaLocked)
	}

	now := s.clock.Now().Unix()
	if item.IngestedAt == 0 {
		item.IngestedAt = now
	}

	id, err := s.writer.Store(ctx, persona, item)
	if err != nil {
		return "", fmt.Errorf("vault store: %w", err)
	}
	return id, nil
}

// StoreBatch persists multiple items into a persona's vault in a single operation.
// Returns the IDs of all stored items.
func (s *VaultService) StoreBatch(ctx context.Context, persona domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	if !s.manager.IsOpen(persona) {
		return nil, fmt.Errorf("vault store batch: %w", domain.ErrPersonaLocked)
	}

	now := s.clock.Now().Unix()
	for i := range items {
		if items[i].IngestedAt == 0 {
			items[i].IngestedAt = now
		}
	}

	ids, err := s.writer.StoreBatch(ctx, persona, items)
	if err != nil {
		return nil, fmt.Errorf("vault store batch: %w", err)
	}
	return ids, nil
}

// Delete removes an item from a persona's vault by ID.
func (s *VaultService) Delete(ctx context.Context, persona domain.PersonaName, id string) error {
	if !s.manager.IsOpen(persona) {
		return fmt.Errorf("vault delete: %w", domain.ErrPersonaLocked)
	}

	if err := s.writer.Delete(ctx, persona, id); err != nil {
		return fmt.Errorf("vault delete: %w", err)
	}
	return nil
}

// HybridSearch combines FTS5 full-text search and vector similarity search
// with a weighted merge (0.4 FTS5 + 0.6 vector) to produce the most relevant results.
// The query must include both a text query and an embedding vector.
func (s *VaultService) HybridSearch(ctx context.Context, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error) {
	if !s.manager.IsOpen(persona) {
		return nil, fmt.Errorf("hybrid search: %w", domain.ErrPersonaLocked)
	}

	const (
		ftsWeight    = 0.4
		vectorWeight = 0.6
	)

	// Execute FTS5 full-text search.
	ftsQuery := domain.SearchQuery{
		Mode:           domain.SearchFTS5,
		Query:          q.Query,
		Types:          q.Types,
		After:          q.After,
		Before:         q.Before,
		IncludeContent: q.IncludeContent,
		Limit:          q.Limit * 2, // fetch more candidates for merging
	}
	ftsResults, err := s.reader.Query(ctx, persona, ftsQuery)
	if err != nil {
		return nil, fmt.Errorf("hybrid search: fts5 query failed: %w", err)
	}

	// Execute vector similarity search.
	vectorResults, err := s.reader.VectorSearch(ctx, persona, q.Embedding, q.Limit*2)
	if err != nil {
		return nil, fmt.Errorf("hybrid search: vector search failed: %w", err)
	}

	// Build scored index: each item gets a weighted rank score from both result sets.
	type scoredItem struct {
		item  domain.VaultItem
		score float64
	}
	scores := make(map[string]*scoredItem)

	for rank, item := range ftsResults {
		// Reciprocal rank scoring: 1/(rank+1) gives diminishing returns for lower ranks.
		s := ftsWeight * (1.0 / float64(rank+1))
		scores[item.ID] = &scoredItem{item: item, score: s}
	}

	for rank, item := range vectorResults {
		s := vectorWeight * (1.0 / float64(rank+1))
		if existing, ok := scores[item.ID]; ok {
			existing.score += s
		} else {
			scores[item.ID] = &scoredItem{item: item, score: s}
		}
	}

	// Sort by descending score and apply limit.
	sorted := make([]*scoredItem, 0, len(scores))
	for _, si := range scores {
		sorted = append(sorted, si)
	}
	// Insertion sort is fine for the small result sets we expect.
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].score > sorted[j-1].score; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}

	limit := q.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > len(sorted) {
		limit = len(sorted)
	}

	results := make([]domain.VaultItem, limit)
	for i := 0; i < limit; i++ {
		results[i] = sorted[i].item
	}
	return results, nil
}
