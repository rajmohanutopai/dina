// Package sync implements an in-memory client sync manager for checkpoint-based sync.
package sync

import (
	"sync"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/test/testutil"
)

// Compile-time interface check.
var _ testutil.ClientSyncManager = (*ClientSyncManager)(nil)

// ClientSyncManager is an in-memory checkpoint-based sync implementation.
type ClientSyncManager struct {
	mu         sync.Mutex
	items      []domain.VaultItem
	checkpoint int64
	offlineQ   map[string][][]byte // deviceID -> queued changes
}

// NewClientSyncManager returns a new in-memory ClientSyncManager.
func NewClientSyncManager() *ClientSyncManager {
	return &ClientSyncManager{
		offlineQ: make(map[string][][]byte),
	}
}

// Sync returns items changed since the given checkpoint and the new checkpoint.
func (m *ClientSyncManager) Sync(_ string, checkpoint int64) ([]domain.VaultItem, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var changed []domain.VaultItem
	for _, item := range m.items {
		if item.Timestamp > checkpoint {
			changed = append(changed, item)
		}
	}
	newCP := checkpoint
	if m.checkpoint > newCP {
		newCP = m.checkpoint
	}
	return changed, newCP, nil
}

// PushUpdate pushes a new vault item to all connected sync clients.
func (m *ClientSyncManager) PushUpdate(item domain.VaultItem) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Upsert by ID.
	for i, existing := range m.items {
		if existing.ID == item.ID {
			m.items[i] = item
			m.checkpoint = item.Timestamp
			return nil
		}
	}
	m.items = append(m.items, item)
	if item.Timestamp > m.checkpoint {
		m.checkpoint = item.Timestamp
	}
	return nil
}

// ResolveConflict resolves a conflict between local and remote using last-write-wins.
func (m *ClientSyncManager) ResolveConflict(local, remote domain.VaultItem) domain.VaultItem {
	if remote.Timestamp >= local.Timestamp {
		return remote
	}
	return local
}

// FullSync returns all vault items for a new device (checkpoint=0).
func (m *ClientSyncManager) FullSync(_ string) ([]domain.VaultItem, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	all := make([]domain.VaultItem, len(m.items))
	copy(all, m.items)
	return all, m.checkpoint, nil
}

// QueueOfflineChange queues a change made while the device was offline.
func (m *ClientSyncManager) QueueOfflineChange(deviceID string, change []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.offlineQ[deviceID] = append(m.offlineQ[deviceID], change)
	return nil
}

// FlushOfflineQueue sends all queued offline changes and returns the count flushed.
func (m *ClientSyncManager) FlushOfflineQueue(deviceID string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	queue := m.offlineQ[deviceID]
	count := len(queue)
	delete(m.offlineQ, deviceID)
	return count, nil
}

// ResetForTest clears all state for test isolation.
func (m *ClientSyncManager) ResetForTest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items = nil
	m.checkpoint = 0
	m.offlineQ = make(map[string][][]byte)
}
