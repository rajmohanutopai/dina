package vault

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time check: StagingInbox satisfies port.StagingInbox.
var _ port.StagingInbox = (*StagingInbox)(nil)

// StoreToVaultFunc is a callback that persists a classified VaultItem
// into the named persona vault. Used by Resolve and DrainPending to
// actually write data, not just update staging status.
type StoreToVaultFunc func(ctx context.Context, persona string, item domain.VaultItem) (string, error)

// StagingInbox is an in-memory implementation of port.StagingInbox for
// testing and the no-CGO (in-memory vault) build path. Items live in a
// map keyed by staging ID and are protected by a sync.Mutex.
type StagingInbox struct {
	mu             sync.Mutex
	items          map[string]*domain.StagingItem
	dedupIndex     map[string]string // "connector_id|source|source_id" -> staging ID
	isPersonaOpen  func(string) bool
	storeToVault   StoreToVaultFunc
}

// NewStagingInbox creates an in-memory StagingInbox.
// isPersonaOpen: checks if a persona vault is open (for stored vs pending_unlock).
// storeToVault: actually persists classified items to persona vaults.
func NewStagingInbox(isPersonaOpen func(string) bool, storeToVault StoreToVaultFunc) *StagingInbox {
	return &StagingInbox{
		items:         make(map[string]*domain.StagingItem),
		dedupIndex:    make(map[string]string),
		isPersonaOpen: isPersonaOpen,
		storeToVault:  storeToVault,
	}
}

// dedupKey builds the deduplication key from connector_id, source, and source_id.
func dedupKey(connectorID, source, sourceID string) string {
	return connectorID + "|" + source + "|" + sourceID
}

// Ingest stores a raw item in the staging inbox.
// Deduplicates on (connector_id, source, source_id) — if a duplicate
// exists, the existing staging ID is returned without modification.
func (s *StagingInbox) Ingest(_ context.Context, item domain.StagingItem) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Dedup check.
	dk := dedupKey(item.ConnectorID, item.Source, item.SourceID)
	if dk != "||" { // only dedup when all three fields are non-empty
		if existingID, ok := s.dedupIndex[dk]; ok {
			return existingID, nil
		}
	}

	// Generate random hex ID.
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return "", fmt.Errorf("staging: failed to generate ID: %w", err)
	}
	id := hex.EncodeToString(idBytes)

	now := time.Now().Unix()
	item.ID = id
	item.Status = domain.StagingReceived
	// Compute source_hash if not already set.
	if item.SourceHash == "" && item.Body != "" {
		h := sha256.Sum256([]byte(item.Body))
		item.SourceHash = hex.EncodeToString(h[:])
	}
	item.CreatedAt = now
	item.UpdatedAt = now
	item.ExpiresAt = now + int64(domain.DefaultStagingTTL)

	s.items[id] = &item
	if dk != "||" {
		s.dedupIndex[dk] = id
	}

	return id, nil
}

// Claim marks up to limit received items as classifying with a lease.
// Returns the claimed items.
func (s *StagingInbox) Claim(_ context.Context, limit int, leaseDuration time.Duration) ([]domain.StagingItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	leaseSeconds := int64(leaseDuration.Seconds())
	var claimed []domain.StagingItem

	for _, item := range s.items {
		if len(claimed) >= limit {
			break
		}
		if item.Status != domain.StagingReceived {
			continue
		}
		item.Status = domain.StagingClassifying
		item.ClaimedAt = now
		item.LeaseUntil = now + leaseSeconds
		item.UpdatedAt = now
		claimed = append(claimed, *item)
	}

	return claimed, nil
}

// Resolve processes a classified item. Core decides:
//   - persona open -> store classified_item to vault, mark stored, clear raw body
//   - persona locked -> mark pending_unlock, keep classified_item, clear raw body
func (s *StagingInbox) Resolve(_ context.Context, id, targetPersona string, classifiedItem domain.VaultItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	item, ok := s.items[id]
	if !ok {
		return fmt.Errorf("staging: item %s not found", id)
	}

	// Serialize classified item to JSON for storage in the staging record.
	classifiedJSON, err := json.Marshal(classifiedItem)
	if err != nil {
		return fmt.Errorf("staging: failed to marshal classified item: %w", err)
	}

	now := time.Now().Unix()
	item.TargetPersona = targetPersona
	item.Body = ""          // Clear raw body after classification
	item.UpdatedAt = now

	if s.isPersonaOpen != nil && s.isPersonaOpen(targetPersona) {
		// Set deterministic ID for idempotent vault writes.
		if classifiedItem.ID == "" {
			classifiedItem.ID = "stg-" + id
		}
		// Persona is open — store the classified item to the vault.
		if s.storeToVault != nil {
			s.mu.Unlock() // Release lock during vault write (may be slow).
			_, storeErr := s.storeToVault(context.Background(), targetPersona, classifiedItem)
			s.mu.Lock() // Re-acquire after write.
			if storeErr != nil {
				item.Status = domain.StagingFailed
				item.Error = fmt.Sprintf("vault store failed: %v", storeErr)
				return storeErr
			}
		}
		item.Status = domain.StagingStored
		item.ClassifiedItem = "" // Stored successfully, no need to keep
	} else {
		item.Status = domain.StagingPendingUnlock
		item.ClassifiedItem = string(classifiedJSON)
	}

	return nil
}

// MarkFailed records a classification failure with an error message.
func (s *StagingInbox) MarkFailed(_ context.Context, id, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	item, ok := s.items[id]
	if !ok {
		return fmt.Errorf("staging: item %s not found", id)
	}

	item.Status = domain.StagingFailed
	item.Error = errMsg
	item.RetryCount++
	item.UpdatedAt = time.Now().Unix()

	return nil
}

// DrainPending promotes pending_unlock items for a persona to stored.
// Called by Core when a persona is unlocked. No Brain dependency.
// For each pending item: deserializes classified_item, stores to vault,
// marks as stored. Returns the count of items drained.
func (s *StagingInbox) DrainPending(ctx context.Context, persona string) (int, error) {
	s.mu.Lock()
	// Collect items to drain while holding the lock.
	var toDrain []*domain.StagingItem
	for _, item := range s.items {
		if item.Status == domain.StagingPendingUnlock && item.TargetPersona == persona {
			toDrain = append(toDrain, item)
		}
	}
	s.mu.Unlock()

	now := time.Now().Unix()
	count := 0

	for _, item := range toDrain {
		if item.ClassifiedItem == "" || item.ClassifiedItem == "{}" {
			continue
		}

		// Deserialize the classified VaultItem.
		var vaultItem domain.VaultItem
		if err := json.Unmarshal([]byte(item.ClassifiedItem), &vaultItem); err != nil {
			continue
		}

		// Set deterministic ID for idempotent vault writes.
		if vaultItem.ID == "" {
			vaultItem.ID = "stg-" + item.ID
		}

		// Store to vault.
		if s.storeToVault != nil {
			if _, err := s.storeToVault(ctx, persona, vaultItem); err != nil {
				continue
			}
		}

		// Mark as stored.
		s.mu.Lock()
		item.Status = domain.StagingStored
		item.ClassifiedItem = ""
		item.UpdatedAt = now
		count++
		s.mu.Unlock()
	}

	return count, nil
}

// Sweep expires items past TTL and reverts expired classifying leases.
// Returns the count of items cleaned up.
func (s *StagingInbox) Sweep(_ context.Context) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	count := 0

	for id, item := range s.items {
		// Delete expired items.
		if item.ExpiresAt > 0 && item.ExpiresAt < now {
			dk := dedupKey(item.ConnectorID, item.Source, item.SourceID)
			delete(s.dedupIndex, dk)
			delete(s.items, id)
			count++
			continue
		}
		// Revert expired classifying leases back to received.
		if item.Status == domain.StagingClassifying && item.LeaseUntil > 0 && item.LeaseUntil < now {
			item.Status = domain.StagingReceived
			item.ClaimedAt = 0
			item.LeaseUntil = 0
			item.UpdatedAt = now
			count++
		}
	}

	return count, nil
}

// ListByStatus returns staging items matching the given status, up to limit.
func (s *StagingInbox) ListByStatus(_ context.Context, status string, limit int) ([]domain.StagingItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var result []domain.StagingItem
	for _, item := range s.items {
		if len(result) >= limit {
			break
		}
		if item.Status == status {
			result = append(result, *item)
		}
	}

	return result, nil
}
