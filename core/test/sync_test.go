package test

import (
	"context"
	"fmt"
	"os"
	"testing"

	dinasync "github.com/rajmohanutopai/dina/core/internal/adapter/sync"
	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §26 — Client Sync Protocol
// ==========================================================================
// Covers checkpoint-based sync, conflict resolution, thin client queries,
// backup scheduling, full sync, and offline queue.
// ==========================================================================

// TST-CORE-862
// TRACE: {"suite": "CORE", "case": "1341", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "01", "scenario": "01", "title": "ClientSendsCheckpoint_CoreReturnsChangedItems"}
func TestSync_26_1_ClientSendsCheckpoint_CoreReturnsChangedItems(t *testing.T) {
	mgr := dinasync.NewClientSyncManager()

	// Negative: empty manager, sync from checkpoint 0 returns no items.
	items, cp, err := mgr.Sync("device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 0)
	testutil.RequireTrue(t, cp >= 0, "checkpoint must be non-negative")

	// Push two items at different timestamps.
	err = mgr.PushUpdate(domain.VaultItem{ID: "item-A", Summary: "Alpha", Timestamp: 100})
	testutil.RequireNoError(t, err)
	err = mgr.PushUpdate(domain.VaultItem{ID: "item-B", Summary: "Beta", Timestamp: 200})
	testutil.RequireNoError(t, err)

	// Sync from checkpoint 0 returns both items.
	items, cp, err = mgr.Sync("device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 2)
	testutil.RequireTrue(t, cp >= 200, "new checkpoint must be >= latest timestamp")

	// Sync from checkpoint 150 returns only item-B (timestamp 200 > 150).
	items, cp2, err := mgr.Sync("device-001", 150)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 1)
	testutil.RequireEqual(t, items[0].ID, "item-B")
	testutil.RequireTrue(t, cp2 >= 200, "new checkpoint must be >= latest timestamp")

	// Sync from checkpoint 200 returns nothing (no items after 200).
	items, _, err = mgr.Sync("device-001", 200)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 0)
}

// TST-CORE-863
// TRACE: {"suite": "CORE", "case": "1342", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "02", "scenario": "01", "title": "NewVaultItem_PushedToConnectedClients"}
func TestSync_26_2_NewVaultItem_PushedToConnectedClients(t *testing.T) {
	mgr := dinasync.NewClientSyncManager()

	// Negative: Sync before any push returns empty.
	items, _, err := mgr.Sync("device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 0)

	// Push a vault item.
	item := domain.VaultItem{
		ID:        "vault_sync_001",
		Type:      "note",
		Source:    "test",
		Summary:   "sync push test",
		Timestamp: 1700000000,
	}
	err = mgr.PushUpdate(item)
	testutil.RequireNoError(t, err)

	// Positive: Sync after push returns the pushed item.
	items, cp, err := mgr.Sync("device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 1)
	testutil.RequireEqual(t, items[0].ID, "vault_sync_001")
	testutil.RequireEqual(t, items[0].Summary, "sync push test")
	testutil.RequireTrue(t, cp >= 1700000000, "checkpoint must be >= pushed item timestamp")

	// Upsert: pushing an item with the same ID overwrites (no duplicates).
	updated := domain.VaultItem{
		ID:        "vault_sync_001",
		Type:      "note",
		Source:    "test",
		Summary:   "updated push",
		Timestamp: 1700000002,
	}
	err = mgr.PushUpdate(updated)
	testutil.RequireNoError(t, err)

	items, _, err = mgr.Sync("device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 1)
	testutil.RequireEqual(t, items[0].Summary, "updated push")
}

// TST-CORE-864
// TRACE: {"suite": "CORE", "case": "1343", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "03", "scenario": "01", "title": "ConflictResolution_LastWriteWins"}
func TestSync_26_3_ConflictResolution_LastWriteWins(t *testing.T) {
	mgr := dinasync.NewClientSyncManager()

	local := domain.VaultItem{
		ID:        "vault_conflict_001",
		Type:      "note",
		Summary:   "local version",
		Timestamp: 1700000000,
	}
	remote := domain.VaultItem{
		ID:        "vault_conflict_001",
		Type:      "note",
		Summary:   "remote version",
		Timestamp: 1700000001, // later timestamp
	}

	// Case 1: remote timestamp later → remote wins.
	winner := mgr.ResolveConflict(local, remote)
	testutil.RequireEqual(t, winner.Summary, "remote version")
	testutil.RequireEqual(t, winner.ID, "vault_conflict_001")
	testutil.RequireEqual(t, winner.Type, "note")

	// Case 2: local timestamp later → local wins.
	localNewer := domain.VaultItem{
		ID:        "vault_conflict_002",
		Type:      "note",
		Summary:   "local newer",
		Timestamp: 1700000010,
	}
	remoteOlder := domain.VaultItem{
		ID:        "vault_conflict_002",
		Type:      "note",
		Summary:   "remote older",
		Timestamp: 1700000005,
	}
	winner2 := mgr.ResolveConflict(localNewer, remoteOlder)
	testutil.RequireEqual(t, winner2.Summary, "local newer")

	// Case 3: equal timestamps → remote wins (>= favours remote).
	localTie := domain.VaultItem{ID: "tie", Summary: "local-tie", Timestamp: 100}
	remoteTie := domain.VaultItem{ID: "tie", Summary: "remote-tie", Timestamp: 100}
	winnerTie := mgr.ResolveConflict(localTie, remoteTie)
	testutil.RequireEqual(t, winnerTie.Summary, "remote-tie")
}

// TST-CORE-865
// TRACE: {"suite": "CORE", "case": "1344", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "04", "scenario": "01", "title": "ThinClient_QueryViaWebSocket"}
func TestSync_26_4_ThinClient_QueryViaWebSocket(t *testing.T) {
	// Fresh ClientSyncManager — no shared state.
	impl := dinasync.NewClientSyncManager()
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	// Thin client pattern: always sends checkpoint=0, no local cache.
	// Negative: empty sync returns no items.
	items, cp, err := impl.Sync("thin-device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 0)
	testutil.RequireEqual(t, cp, int64(0))

	// Push 3 items to simulate server-side data.
	for i := 1; i <= 3; i++ {
		err = impl.PushUpdate(domain.VaultItem{
			ID:        fmt.Sprintf("thin-item-%d", i),
			Type:      "note",
			Summary:   fmt.Sprintf("thin client item %d", i),
			Timestamp: int64(100 * i),
		})
		testutil.RequireNoError(t, err)
	}

	// Thin client always sends checkpoint=0 → must get ALL items.
	items, cp, err = impl.Sync("thin-device-001", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 3)
	testutil.RequireTrue(t, cp >= 300, "checkpoint must reflect latest timestamp")

	// Verify all 3 items are returned with correct IDs.
	ids := make(map[string]bool)
	for _, item := range items {
		ids[item.ID] = true
		testutil.RequireEqual(t, item.Type, "note")
	}
	testutil.RequireTrue(t, ids["thin-item-1"], "item 1 must be returned")
	testutil.RequireTrue(t, ids["thin-item-2"], "item 2 must be returned")
	testutil.RequireTrue(t, ids["thin-item-3"], "item 3 must be returned")

	// Second thin client sync with checkpoint=0 again — same result (no local cache).
	items2, cp2, err := impl.Sync("thin-device-002", 0)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items2), 3)
	testutil.RequireEqual(t, cp2, cp)

	// Contrast: checkpoint=200 only returns items after 200 — NOT thin client pattern.
	itemsPartial, _, err := impl.Sync("thick-device", 200)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(itemsPartial), 1)
	testutil.RequireEqual(t, itemsPartial[0].ID, "thin-item-3")
}

// TST-CORE-866
// TRACE: {"suite": "CORE", "case": "1345", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "05", "scenario": "01", "title": "BackupBlobStoreDestination"}
func TestSync_26_5_BackupBlobStoreDestination(t *testing.T) {
	// §26.5: Backup scheduling to blob store, configurable frequency.

	// Create a fresh vault manager with a temp directory.
	vaultDir, err := os.MkdirTemp("", "dina-backup-test-vault-")
	testutil.RequireNoError(t, err)
	defer os.RemoveAll(vaultDir)

	mgr := vault.NewManager(vaultDir)
	err = mgr.Open(context.Background(), "general", testutil.TestDEK[:])
	testutil.RequireNoError(t, err)

	// Store an item in the vault so backup has data.
	_, err = mgr.Store(context.Background(), "general", domain.VaultItem{
		Type:    "note",
		Source:  "test",
		Summary: "backup test item",
	})
	testutil.RequireNoError(t, err)

	// Create backup manager and back up to a temp file.
	backupMgr := vault.NewBackupManager(mgr)
	backupPath := vaultDir + "/backup.json"
	err = backupMgr.Backup(context.Background(), "general", backupPath)
	testutil.RequireNoError(t, err)

	// Positive: backup file must exist and be non-empty.
	info, err := os.Stat(backupPath)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, info.Size() > 0, "backup file must be non-empty")

	// Positive: backup can be restored to a new vault and data is preserved.
	mgr2 := vault.NewManager(vaultDir + "/restored")
	err = mgr2.Open(context.Background(), "general", testutil.TestDEK[:])
	testutil.RequireNoError(t, err)

	err = vault.NewBackupManager(mgr2).Restore(context.Background(), "general", backupPath)
	testutil.RequireNoError(t, err)

	// Query the restored vault to verify data.
	items, err := mgr2.Query(context.Background(), "general", domain.SearchQuery{})
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(items) >= 1, "restored vault must have at least 1 item")
	testutil.RequireEqual(t, items[0].Summary, "backup test item")
}

// TST-CORE-867
// TRACE: {"suite": "CORE", "case": "1346", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "06", "scenario": "01", "title": "NewDeviceFullSync"}
func TestSync_26_6_NewDeviceFullSync(t *testing.T) {
	mgr := dinasync.NewClientSyncManager()

	// Negative: FullSync on empty manager returns empty items and checkpoint 0.
	items, checkpoint, err := mgr.FullSync("new-device-001")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 0)
	testutil.RequireEqual(t, checkpoint, int64(0))

	// Push 2 items.
	err = mgr.PushUpdate(domain.VaultItem{ID: "fs-1", Summary: "First", Timestamp: 500})
	testutil.RequireNoError(t, err)
	err = mgr.PushUpdate(domain.VaultItem{ID: "fs-2", Summary: "Second", Timestamp: 600})
	testutil.RequireNoError(t, err)

	// Positive: FullSync returns all items regardless of checkpoint.
	items, checkpoint, err = mgr.FullSync("new-device-001")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(items), 2)
	testutil.RequireTrue(t, checkpoint >= 600, "checkpoint must be >= latest timestamp")

	// Verify items contain the expected IDs.
	ids := map[string]bool{}
	for _, it := range items {
		ids[it.ID] = true
	}
	testutil.RequireTrue(t, ids["fs-1"], "must include fs-1")
	testutil.RequireTrue(t, ids["fs-2"], "must include fs-2")
}

// TST-CORE-868
// TRACE: {"suite": "CORE", "case": "1347", "section": "26", "sectionName": "Client Sync Protocol", "subsection": "07", "scenario": "01", "title": "OfflineQueueSyncsOnReconnect"}
func TestSync_26_7_OfflineQueueSyncsOnReconnect(t *testing.T) {
	// Connection drop: client queues changes, syncs on reconnect.
	impl := realClientSyncManager
	testutil.RequireImplementation(t, impl, "ClientSyncManager")

	deviceID := "device-offline-007"

	// Queue 3 offline changes while disconnected.
	for i := 0; i < 3; i++ {
		change := []byte(fmt.Sprintf(`{"type":"note","id":"note-%d"}`, i))
		err := impl.QueueOfflineChange(deviceID, change)
		testutil.RequireNoError(t, err)
	}

	// Flush on reconnect — all 3 must be flushed.
	flushed, err := impl.FlushOfflineQueue(deviceID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, flushed, 3)

	// After flush, the queue must be empty — second flush returns 0.
	flushed2, err := impl.FlushOfflineQueue(deviceID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, flushed2, 0)

	// Flushing a device that never queued must also return 0.
	flushed3, err := impl.FlushOfflineQueue("device-never-queued")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, flushed3, 0)
}
