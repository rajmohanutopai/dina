// Package service implements the application service layer.
// Services compose port interfaces to implement business workflows.
// They import ONLY port/ and domain/ packages, NEVER adapter/.
package service

import (
	"context"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// AutoUnlockFunc is a callback that auto-opens a sensitive persona vault
// for user-originated requests (Telegram/admin). Called by ensureOpen()
// when the vault is closed but the caller has user-level access.
type AutoUnlockFunc func(ctx context.Context, persona domain.PersonaName) error

// VaultService orchestrates vault operations, combining search strategies
// and enforcing gatekeeper checks before data access.
type VaultService struct {
	manager    port.VaultManager
	reader     port.VaultReader
	writer     port.VaultWriter
	gatekeeper port.Gatekeeper
	clock      port.Clock
	personaMgr port.PersonaManager       // optional — tier enforcement
	autoUnlock AutoUnlockFunc            // optional — auto-opens sensitive vaults for user requests
	Tracer     middleware.TraceEmitter   // optional — emit authz traces
}

// SetPersonaManager enables persona tier enforcement on vault operations.
func (s *VaultService) SetPersonaManager(pm port.PersonaManager) {
	s.personaMgr = pm
}

// SetAutoUnlock sets the callback for auto-opening sensitive vaults.
func (s *VaultService) SetAutoUnlock(fn AutoUnlockFunc) {
	s.autoUnlock = fn
}

// ensureOpen checks if a persona vault is open. If not, and the request
// is user-originated, auto-unlocks it. Otherwise returns ErrPersonaLocked.
func (s *VaultService) ensureOpen(ctx context.Context, persona domain.PersonaName) error {
	if s.manager.IsOpen(persona) {
		return nil
	}
	// Only auto-unlock for user-originated requests.
	userOriginated, _ := ctx.Value(middleware.UserOriginatedKey).(bool)
	if !userOriginated || s.autoUnlock == nil {
		return domain.ErrPersonaLocked
	}
	return s.autoUnlock(ctx, persona)
}

// ensureAuthorized runs the full 3-step authorization gauntlet:
//  1. AccessPersona — tier-based access (approval/session gating for sensitive personas)
//  2. ensureOpen — vault file unlocked (auto-unlock for user-originated requests)
//  3. EvaluateIntent — gatekeeper action-level authorization
//
// F05: Extracted from 6 duplicated call sites (Query, GetItem, Store, StoreBatch, Delete, HybridSearch).
func (s *VaultService) ensureAuthorized(ctx context.Context, agentDID string, persona domain.PersonaName, action, target, opName string) error {
	if s.personaMgr != nil {
		if err := s.personaMgr.AccessPersona(ctx, string(persona)); err != nil {
			if s.Tracer != nil {
				s.Tracer.Emit(ctx, "authz_error", "core", map[string]string{
					"persona": string(persona), "action": action, "error_type": "access_denied",
				})
			}
			return fmt.Errorf("%s: persona %s: %w", opName, persona, err)
		}
	}
	if err := s.ensureOpen(ctx, persona); err != nil {
		if s.Tracer != nil {
			s.Tracer.Emit(ctx, "authz_error", "core", map[string]string{
				"persona": string(persona), "action": action, "error_type": "persona_locked",
			})
		}
		return fmt.Errorf("%s: persona %s: %w", opName, persona, err)
	}
	if s.gatekeeper != nil {
		intent := domain.Intent{
			AgentDID:  agentDID,
			Action:    action,
			Target:    target,
			PersonaID: string(persona),
		}
		decision, err := s.gatekeeper.EvaluateIntent(ctx, intent)
		if err != nil {
			return fmt.Errorf("%s: gatekeeper evaluation failed: %w", opName, err)
		}
		if !decision.Allowed {
			return fmt.Errorf("%s: %w: %s", opName, domain.ErrForbidden, decision.Reason)
		}
	}
	return nil
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
	if err := s.ensureAuthorized(ctx, agentDID, persona, domain.ActionVaultRead, string(persona), "vault query"); err != nil {
		return nil, err
	}

	// Route hybrid/semantic queries with embeddings through HybridSearch
	// which merges FTS5 keyword results with HNSW vector similarity.
	if (q.Mode == domain.SearchHybrid || q.Mode == domain.SearchSemantic) && len(q.Embedding) > 0 {
		return s.HybridSearch(ctx, agentDID, persona, q)
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
	if err := s.ensureAuthorized(ctx, agentDID, persona, domain.ActionVaultRead, id, "vault get item"); err != nil {
		return nil, err
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
// MEDIUM-07: Added agentDID param and gatekeeper check to match Query/GetItem pattern.
func (s *VaultService) Store(ctx context.Context, agentDID string, persona domain.PersonaName, item domain.VaultItem) (string, error) {
	if err := s.ensureAuthorized(ctx, agentDID, persona, domain.ActionVaultWrite, string(persona), "vault store"); err != nil {
		return "", err
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
func (s *VaultService) StoreBatch(ctx context.Context, agentDID string, persona domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	if err := s.ensureAuthorized(ctx, agentDID, persona, domain.ActionVaultWrite, string(persona), "vault store batch"); err != nil {
		return nil, err
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
// MEDIUM-07: Added agentDID param and gatekeeper check.
func (s *VaultService) Delete(ctx context.Context, agentDID string, persona domain.PersonaName, id string) error {
	if err := s.ensureAuthorized(ctx, agentDID, persona, domain.ActionVaultDelete, id, "vault delete"); err != nil {
		return err
	}

	if err := s.writer.Delete(ctx, persona, id); err != nil {
		return fmt.Errorf("vault delete: %w", err)
	}
	return nil
}

// HybridSearch combines FTS5 full-text search and vector similarity search
// with a weighted merge (0.4 FTS5 + 0.6 vector) to produce the most relevant results.
// The query must include both a text query and an embedding vector.
// F01: agentDID added for gatekeeper authorization (was missing — auth bypass risk).
func (s *VaultService) HybridSearch(ctx context.Context, agentDID string, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error) {
	if err := s.ensureAuthorized(ctx, agentDID, persona, domain.ActionVaultRead, string(persona), "hybrid search"); err != nil {
		return nil, err
	}

	const (
		ftsWeight    = 0.4
		vectorWeight = 0.6
	)

	// Execute FTS5 full-text search.
	ftsQuery := domain.SearchQuery{
		Mode:            domain.SearchFTS5,
		Query:           q.Query,
		Types:           q.Types,
		After:           q.After,
		Before:          q.Before,
		IncludeContent:  q.IncludeContent,
		Limit:           q.Limit * 2, // fetch more candidates for merging
		IncludeAll:      q.IncludeAll,
		RetrievalPolicy: q.RetrievalPolicy,
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

	// Post-filter vector results for retrieval_policy (HNSW doesn't filter).
	if !q.IncludeAll {
		filtered := vectorResults[:0]
		for _, item := range vectorResults {
			rp := item.RetrievalPolicy
			if q.RetrievalPolicy != "" {
				if rp == q.RetrievalPolicy {
					filtered = append(filtered, item)
				}
			} else if rp == "" || rp == "normal" || rp == "caveated" {
				filtered = append(filtered, item)
			}
		}
		vectorResults = filtered
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

	// Trust-weighted modifiers: demote low-trust, boost high-trust sources.
	// Multipliers compound: caveated + low confidence = 0.42x; self-sourced = 1.2x.
	const (
		caveatedMultiplier      = 0.7 // retrieval_policy=caveated → demoted
		highTrustBoost          = 1.2 // sender_trust ∈ {self, contact_ring1} → boosted
		lowConfidenceMultiplier = 0.6 // confidence=low → demoted
	)
	for _, si := range scores {
		if si.item.RetrievalPolicy == "caveated" {
			si.score *= caveatedMultiplier
		}
		if si.item.SenderTrust == "self" || si.item.SenderTrust == "contact_ring1" {
			si.score *= highTrustBoost
		}
		if si.item.Confidence == "low" {
			si.score *= lowConfidenceMultiplier
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
