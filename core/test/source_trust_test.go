package test

import (
	"context"
	"os"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Source Trust & Provenance Tests
// 12 scenarios verifying provenance field round-trip, retrieval policy
// filtering, validation, and backward compatibility with legacy items.
// ==========================================================================

// helper: create an isolated vault manager with "general" persona open.
func newSourceTrustVault(t *testing.T) (*vault.Manager, context.Context) {
	t.Helper()
	dir, err := os.MkdirTemp("", "dina-st-")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	mgr := vault.NewManager(dir)
	ctx := context.Background()
	if err := mgr.Open(ctx, "general", testutil.TestDEK[:]); err != nil {
		t.Fatalf("failed to open vault: %v", err)
	}
	return mgr, ctx
}

// --------------------------------------------------------------------------
// 1. StoreWithProvenance — round-trip all 6 provenance fields.
// --------------------------------------------------------------------------

func TestSourceTrust_StoreWithProvenance(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	item := domain.VaultItem{
		Type:            "email",
		Summary:         "Quarterly report from CFO",
		BodyText:        "Revenue up 12% YoY",
		Timestamp:       1700000001,
		Sender:          "cfo@example.com",
		SenderTrust:     "contact_ring1",
		SourceType:      "contact",
		Confidence:      "high",
		RetrievalPolicy: "normal",
		Contradicts:     "item-old-report",
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id != "", "Store should return a non-empty ID")

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	testutil.RequireEqual(t, got.Sender, "cfo@example.com")
	testutil.RequireEqual(t, got.SenderTrust, "contact_ring1")
	testutil.RequireEqual(t, got.SourceType, "contact")
	testutil.RequireEqual(t, got.Confidence, "high")
	testutil.RequireEqual(t, got.RetrievalPolicy, "normal")
	testutil.RequireEqual(t, got.Contradicts, "item-old-report")
}

// --------------------------------------------------------------------------
// 2. StoreWithoutProvenance — defaults: empty strings, RetrievalPolicy="normal"
//    treated as searchable.
// --------------------------------------------------------------------------

func TestSourceTrust_StoreWithoutProvenance(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	item := domain.VaultItem{
		Type:      "note",
		Summary:   "Plain note without provenance",
		BodyText:  "Just a note",
		Timestamp: 1700000002,
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	// All provenance fields should be zero-value except RetrievalPolicy
	// which defaults to "normal" in both adapters.
	testutil.RequireEqual(t, got.Sender, "")
	testutil.RequireEqual(t, got.SenderTrust, "")
	testutil.RequireEqual(t, got.SourceType, "")
	testutil.RequireEqual(t, got.Confidence, "")
	testutil.RequireEqual(t, got.RetrievalPolicy, "normal")
	testutil.RequireEqual(t, got.Contradicts, "")
}

// --------------------------------------------------------------------------
// 3. DefaultQueryExcludesQuarantineAndBriefing — default search returns
//    only normal + caveated items.
// --------------------------------------------------------------------------

func TestSourceTrust_DefaultQueryExcludesQuarantineAndBriefing(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	policies := []string{"normal", "caveated", "quarantine", "briefing_only"}
	for _, rp := range policies {
		_, err := mgr.Store(ctx, "general", domain.VaultItem{
			Type:            "note",
			Summary:         "Item with policy " + rp,
			BodyText:        "body",
			Timestamp:       1700000010,
			RetrievalPolicy: rp,
		})
		testutil.RequireNoError(t, err)
	}

	// Default query: IncludeAll=false, no RetrievalPolicy filter.
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 2)

	// Verify returned items are normal or caveated.
	for _, item := range items {
		rp := item.RetrievalPolicy
		testutil.RequireTrue(t, rp == "normal" || rp == "caveated",
			"default query should only return normal or caveated, got: "+rp)
	}
}

// --------------------------------------------------------------------------
// 4. IncludeAllReturnsEverything — IncludeAll=true returns all 4 policies.
// --------------------------------------------------------------------------

func TestSourceTrust_IncludeAllReturnsEverything(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	policies := []string{"normal", "caveated", "quarantine", "briefing_only"}
	for _, rp := range policies {
		_, err := mgr.Store(ctx, "general", domain.VaultItem{
			Type:            "note",
			Summary:         "Item " + rp,
			BodyText:        "body",
			Timestamp:       1700000020,
			RetrievalPolicy: rp,
		})
		testutil.RequireNoError(t, err)
	}

	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		IncludeAll:     true,
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 4)
}

// --------------------------------------------------------------------------
// 5. QueryFiltersByPolicy — explicit RetrievalPolicy filter returns only
//    matching items.
// --------------------------------------------------------------------------

func TestSourceTrust_QueryFiltersByPolicy(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	policies := []string{"normal", "caveated", "quarantine", "briefing_only"}
	for _, rp := range policies {
		_, err := mgr.Store(ctx, "general", domain.VaultItem{
			Type:            "note",
			Summary:         "Filtered " + rp,
			BodyText:        "body",
			Timestamp:       1700000030,
			RetrievalPolicy: rp,
		})
		testutil.RequireNoError(t, err)
	}

	// Filter to quarantine only.
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		RetrievalPolicy: "quarantine",
		IncludeContent:  true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 1)
	testutil.RequireEqual(t, items[0].RetrievalPolicy, "quarantine")
}

// --------------------------------------------------------------------------
// 6. FTS5RespectsPolicy — text search honours retrieval policy filtering.
// --------------------------------------------------------------------------

func TestSourceTrust_FTS5RespectsPolicy(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	// Normal item matching "office chair".
	_, err := mgr.Store(ctx, "general", domain.VaultItem{
		Type:            "note",
		Summary:         "office chair recommendation",
		BodyText:        "The Steelcase Leap is great",
		Timestamp:       1700000040,
		RetrievalPolicy: "normal",
	})
	testutil.RequireNoError(t, err)

	// Quarantined item also matching "office chair".
	_, err = mgr.Store(ctx, "general", domain.VaultItem{
		Type:            "note",
		Summary:         "office chair spam ad",
		BodyText:        "Buy cheap office chairs now",
		Timestamp:       1700000041,
		RetrievalPolicy: "quarantine",
	})
	testutil.RequireNoError(t, err)

	// FTS5 search for "office chair" with default policy filtering.
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		Mode:           domain.SearchFTS5,
		Query:          "office chair",
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 1)
	testutil.RequireEqual(t, items[0].RetrievalPolicy, "normal")
}

// --------------------------------------------------------------------------
// 7. ContradictionStored — Contradicts field round-trips correctly.
// --------------------------------------------------------------------------

func TestSourceTrust_ContradictionStored(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	item := domain.VaultItem{
		Type:            "note",
		Summary:         "Updated earnings report",
		BodyText:        "Corrected revenue figures",
		Timestamp:       1700000050,
		Contradicts:     "item-abc",
		RetrievalPolicy: "caveated",
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)
	testutil.RequireEqual(t, got.Contradicts, "item-abc")
}

// --------------------------------------------------------------------------
// 8. ValidationRejectsInvalid — invalid sender_trust is rejected.
// --------------------------------------------------------------------------

func TestSourceTrust_ValidationRejectsInvalid(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	item := domain.VaultItem{
		Type:        "note",
		Summary:     "Bad provenance",
		BodyText:    "body",
		Timestamp:   1700000060,
		SenderTrust: "invalid_value",
	}

	_, err := mgr.Store(ctx, "general", item)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "invalid sender_trust")
}

// --------------------------------------------------------------------------
// 9. BatchStoreWithProvenance — StoreBatch preserves provenance on all items.
// --------------------------------------------------------------------------

func TestSourceTrust_BatchStoreWithProvenance(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	batch := []domain.VaultItem{
		{
			Type:            "email",
			Summary:         "Batch item 1",
			BodyText:        "body1",
			Timestamp:       1700000070,
			Sender:          "alice@example.com",
			SenderTrust:     "contact_ring1",
			SourceType:      "contact",
			Confidence:      "high",
			RetrievalPolicy: "normal",
		},
		{
			Type:            "email",
			Summary:         "Batch item 2",
			BodyText:        "body2",
			Timestamp:       1700000071,
			Sender:          "unknown@spam.com",
			SenderTrust:     "marketing",
			SourceType:      "marketing",
			Confidence:      "low",
			RetrievalPolicy: "quarantine",
		},
		{
			Type:            "note",
			Summary:         "Batch item 3",
			BodyText:        "body3",
			Timestamp:       1700000072,
			Sender:          "user",
			SenderTrust:     "self",
			SourceType:      "self",
			Confidence:      "high",
			RetrievalPolicy: "normal",
		},
	}

	ids, err := mgr.StoreBatch(ctx, "general", batch)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(ids), 3)

	// Verify each item's provenance was stored correctly.
	got1, err := mgr.GetItem(ctx, "general", ids[0])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got1.SenderTrust, "contact_ring1")
	testutil.RequireEqual(t, got1.Confidence, "high")

	got2, err := mgr.GetItem(ctx, "general", ids[1])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got2.SenderTrust, "marketing")
	testutil.RequireEqual(t, got2.RetrievalPolicy, "quarantine")

	got3, err := mgr.GetItem(ctx, "general", ids[2])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got3.SenderTrust, "self")
	testutil.RequireEqual(t, got3.SourceType, "self")
}

// --------------------------------------------------------------------------
// 10. EmptyPolicyDefaultsToNormal — empty RetrievalPolicy is treated as
//     searchable (equivalent to "normal" in default queries).
// --------------------------------------------------------------------------

func TestSourceTrust_EmptyPolicyDefaultsToNormal(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	_, err := mgr.Store(ctx, "general", domain.VaultItem{
		Type:            "note",
		Summary:         "Explicitly normal",
		BodyText:        "body",
		Timestamp:       1700000080,
		RetrievalPolicy: "normal",
	})
	testutil.RequireNoError(t, err)

	_, err = mgr.Store(ctx, "general", domain.VaultItem{
		Type:            "note",
		Summary:         "Empty policy item",
		BodyText:        "body",
		Timestamp:       1700000081,
		RetrievalPolicy: "",
	})
	testutil.RequireNoError(t, err)

	// Default search should return both items.
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 2)
}

// --------------------------------------------------------------------------
// 11. LegacyItemsVisible — items with all-empty provenance fields (simulating
//     pre-provenance data) appear in default searches.
// --------------------------------------------------------------------------

func TestSourceTrust_LegacyItemsVisible(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	// Legacy item: no provenance fields set at all.
	_, err := mgr.Store(ctx, "general", domain.VaultItem{
		Type:      "note",
		Summary:   "Legacy item from before provenance",
		BodyText:  "old data",
		Timestamp: 1600000000,
	})
	testutil.RequireNoError(t, err)

	// Default search must include legacy items (empty policy = searchable).
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 1)
	testutil.RequireEqual(t, items[0].Summary, "Legacy item from before provenance")
}

// --------------------------------------------------------------------------
// 12. CaveatedIncludedInDefaultSearch — caveated items are NOT excluded
//     from default searches (only quarantine + briefing_only are excluded).
// --------------------------------------------------------------------------

func TestSourceTrust_CaveatedIncludedInDefaultSearch(t *testing.T) {
	mgr, ctx := newSourceTrustVault(t)

	_, err := mgr.Store(ctx, "general", domain.VaultItem{
		Type:            "note",
		Summary:         "Normal item",
		BodyText:        "body",
		Timestamp:       1700000090,
		RetrievalPolicy: "normal",
	})
	testutil.RequireNoError(t, err)

	_, err = mgr.Store(ctx, "general", domain.VaultItem{
		Type:            "note",
		Summary:         "Caveated item",
		BodyText:        "body",
		Timestamp:       1700000091,
		RetrievalPolicy: "caveated",
	})
	testutil.RequireNoError(t, err)

	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 2)

	// Verify both normal and caveated are present.
	foundNormal := false
	foundCaveated := false
	for _, item := range items {
		if item.RetrievalPolicy == "normal" {
			foundNormal = true
		}
		if item.RetrievalPolicy == "caveated" {
			foundCaveated = true
		}
	}
	testutil.RequireTrue(t, foundNormal, "normal item should be in default search results")
	testutil.RequireTrue(t, foundCaveated, "caveated item should be in default search results")
}
