package test

import (
	"context"
	"testing"

	"github.com/anthropics/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §26 — Client Sync Protocol
// ==========================================================================
// Covers checkpoint-based sync, conflict resolution, thin client queries,
// backup scheduling, full sync, and offline queue.
// ==========================================================================

// TST-CORE-862
func TestSync_26_1_ClientSendsCheckpoint_CoreReturnsChangedItems(t *testing.T) {
	// Client sends checkpoint, core returns changed items since checkpoint.
	var impl testutil.ClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	items, newCheckpoint, err := impl.Sync("device-001", 100)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, newCheckpoint >= 100, "new checkpoint must be >= old checkpoint")
	_ = items // items returned depend on server state
}

// TST-CORE-863
func TestSync_26_2_NewVaultItem_PushedToConnectedClients(t *testing.T) {
	// Real-time vault item push to connected clients via WebSocket.
	var impl testutil.ClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	item := testutil.VaultItem{
		ID:        "vault_sync_001",
		Type:      "note",
		Source:    "test",
		Summary:   "sync push test",
		Timestamp: 1700000000,
	}
	err := impl.PushUpdate(item)
	testutil.RequireNoError(t, err)
}

// TST-CORE-864
func TestSync_26_3_ConflictResolution_LastWriteWins(t *testing.T) {
	// Conflict resolution: last-write-wins, earlier version logged as recoverable.
	var impl testutil.ClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	local := testutil.VaultItem{
		ID:        "vault_conflict_001",
		Type:      "note",
		Summary:   "local version",
		Timestamp: 1700000000,
	}
	remote := testutil.VaultItem{
		ID:        "vault_conflict_001",
		Type:      "note",
		Summary:   "remote version",
		Timestamp: 1700000001, // later timestamp
	}
	winner := impl.ResolveConflict(local, remote)
	testutil.RequireEqual(t, winner.Summary, "remote version")
}

// TST-CORE-865
func TestSync_26_4_ThinClient_QueryViaWebSocket(t *testing.T) {
	// Thin client: query via WebSocket, no local cache model.
	var impl testutil.ClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	// Thin client sends checkpoint=0 but expects query relay, not full sync.
	items, _, err := impl.Sync("thin-device-001", 0)
	testutil.RequireNoError(t, err)
	_ = items
}

// TST-CORE-866
func TestSync_26_5_BackupBlobStoreDestination(t *testing.T) {
	// Backup scheduling to blob store, configurable frequency.
	// This validates the sync manager's backup integration.
	impl := realBackupManager
	testutil.RequireImplementation(t, impl, "BackupManager")

	err := impl.Backup(context.Background(), "personal", "/tmp/dina-backup-test")
	testutil.RequireNoError(t, err)
}

// TST-CORE-867
func TestSync_26_6_NewDeviceFullSync(t *testing.T) {
	// New device full sync from zero checkpoint.
	var impl testutil.ClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	items, checkpoint, err := impl.FullSync("new-device-001")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, checkpoint >= 0, "checkpoint must be non-negative")
	_ = items
}

// TST-CORE-868
func TestSync_26_7_OfflineQueueSyncsOnReconnect(t *testing.T) {
	// Connection drop: client queues changes, syncs on reconnect.
	var impl testutil.ClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	// Queue an offline change.
	err := impl.QueueOfflineChange("device-offline-001", []byte(`{"type":"note","summary":"offline note"}`))
	testutil.RequireNoError(t, err)

	// Flush the queue on reconnect.
	flushed, err := impl.FlushOfflineQueue("device-offline-001")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, flushed >= 1, "at least one offline change should be flushed")
}
