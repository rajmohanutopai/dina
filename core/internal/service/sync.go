package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// SyncService coordinates client cache synchronization using a
// checkpoint-based delta protocol. Connected devices send their
// last-seen checkpoint, and the service returns all items changed
// since that point. Conflict resolution uses last-write-wins.
type SyncService struct {
	vault    port.VaultManager
	reader   port.VaultReader
	writer   port.VaultWriter
	hub      port.WSHub
	notifier port.ClientNotifier
	clock    port.Clock
}

// NewSyncService constructs a SyncService with the given port dependencies.
func NewSyncService(
	vault port.VaultManager,
	reader port.VaultReader,
	writer port.VaultWriter,
	hub port.WSHub,
	notifier port.ClientNotifier,
	clock port.Clock,
) *SyncService {
	return &SyncService{
		vault:    vault,
		reader:   reader,
		writer:   writer,
		hub:      hub,
		notifier: notifier,
		clock:    clock,
	}
}

// SyncRequest carries the client's last checkpoint and persona context.
type SyncRequest struct {
	DeviceID   string
	Persona    domain.PersonaName
	Checkpoint int64 // Unix timestamp of last sync
}

// SyncResponse carries changed items and the new checkpoint.
type SyncResponse struct {
	Items      []domain.VaultItem
	Checkpoint int64 // new checkpoint for the client to store
	HasMore    bool  // true if more items are available (paginated)
}

// GetDelta returns all vault items changed since the client's checkpoint.
// The client sends its last checkpoint; the service queries for items
// with IngestedAt > checkpoint and returns them with a new checkpoint.
func (s *SyncService) GetDelta(ctx context.Context, req SyncRequest) (*SyncResponse, error) {
	if !s.vault.IsOpen(req.Persona) {
		return nil, fmt.Errorf("sync: %w", domain.ErrPersonaLocked)
	}

	// Query for items modified after the checkpoint.
	q := domain.SearchQuery{
		After: req.Checkpoint,
		Limit: 100, // page size
	}

	items, err := s.reader.Query(ctx, req.Persona, q)
	if err != nil {
		return nil, fmt.Errorf("sync: query delta: %w", err)
	}

	// New checkpoint is the max IngestedAt from the results,
	// or the current time if no results.
	newCheckpoint := s.clock.Now().Unix()
	for _, item := range items {
		if item.IngestedAt > newCheckpoint {
			newCheckpoint = item.IngestedAt
		}
	}

	return &SyncResponse{
		Items:      items,
		Checkpoint: newCheckpoint,
		HasMore:    len(items) >= 100,
	}, nil
}

// PushUpdate notifies all connected clients that a vault item has changed.
// This is called after a Store or Delete operation to trigger real-time sync.
func (s *SyncService) PushUpdate(ctx context.Context, persona domain.PersonaName, itemID string) error {
	if s.hub.ConnectedClients() == 0 {
		return nil // no clients to notify
	}

	payload := []byte(fmt.Sprintf(`{"type":"sync_update","persona":"%s","item_id":"%s","timestamp":%d}`,
		persona, itemID, s.clock.Now().Unix()))

	return s.notifier.Broadcast(ctx, payload)
}

// ResolveConflict applies last-write-wins conflict resolution.
// When a client pushes an item that conflicts with the server version,
// the item with the higher IngestedAt timestamp wins.
func (s *SyncService) ResolveConflict(ctx context.Context, persona domain.PersonaName, clientItem domain.VaultItem) (*domain.VaultItem, error) {
	if !s.vault.IsOpen(persona) {
		return nil, fmt.Errorf("sync: %w", domain.ErrPersonaLocked)
	}

	// Fetch the server version.
	serverItem, err := s.reader.GetItem(ctx, persona, clientItem.ID)
	if err != nil {
		// No server version — client item wins by default.
		id, storeErr := s.writer.Store(ctx, persona, clientItem)
		if storeErr != nil {
			return nil, fmt.Errorf("sync: store client item: %w", storeErr)
		}
		clientItem.ID = id
		return &clientItem, nil
	}

	// Last-write-wins: compare IngestedAt timestamps.
	if clientItem.IngestedAt > serverItem.IngestedAt {
		// Client wins — overwrite server version.
		if err := s.writer.Delete(ctx, persona, serverItem.ID); err != nil {
			return nil, fmt.Errorf("sync: delete server item: %w", err)
		}
		id, err := s.writer.Store(ctx, persona, clientItem)
		if err != nil {
			return nil, fmt.Errorf("sync: store client item: %w", err)
		}
		clientItem.ID = id
		return &clientItem, nil
	}

	// Server wins — return server version.
	return serverItem, nil
}

// FullSync returns all items for a persona, intended for new device onboarding.
func (s *SyncService) FullSync(ctx context.Context, persona domain.PersonaName) ([]domain.VaultItem, error) {
	if !s.vault.IsOpen(persona) {
		return nil, fmt.Errorf("sync: %w", domain.ErrPersonaLocked)
	}

	q := domain.SearchQuery{
		Limit: 10000, // reasonable upper bound for full sync
	}

	items, err := s.reader.Query(ctx, persona, q)
	if err != nil {
		return nil, fmt.Errorf("sync: full sync: %w", err)
	}

	return items, nil
}
