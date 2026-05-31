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
// Tiered Content (L0/L1/L2) Tests
// 10 scenarios verifying ContentL0, ContentL1, EnrichmentStatus, and
// EnrichmentVersion field round-trip, defaults, validation, search
// compatibility, batch storage, and re-enrichment (upsert).
// ==========================================================================

// helper: create an isolated vault manager with "general" persona open.
func newTieredContentVault(t *testing.T) (*vault.Manager, context.Context) {
	t.Helper()
	dir, err := os.MkdirTemp("", "dina-tc-")
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
// 1. StoreWithL0L1 — round-trip ContentL0, ContentL1, EnrichmentStatus,
//    EnrichmentVersion.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1410", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "01", "scenario": "01", "title": "TieredContent_StoreWithL0L1"}
func TestTieredContent_StoreWithL0L1(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	item := domain.VaultItem{
		Type:              "email",
		Summary:           "Quarterly report from CFO",
		BodyText:          "Revenue up 12% YoY with strong performance across all segments",
		Timestamp:         1700000001,
		ContentL0:         "Revenue up 12%",
		ContentL1:         "Quarterly report shows 12% YoY revenue growth across all business segments, driven by consumer and enterprise divisions.",
		EnrichmentStatus:  "ready",
		EnrichmentVersion: `{"prompt_v":2,"embed_model":"gemma-3n"}`,
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id != "", "Store should return a non-empty ID")

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	testutil.RequireEqual(t, got.ContentL0, "Revenue up 12%")
	testutil.RequireEqual(t, got.ContentL1, "Quarterly report shows 12% YoY revenue growth across all business segments, driven by consumer and enterprise divisions.")
	testutil.RequireEqual(t, got.EnrichmentStatus, "ready")
	testutil.RequireEqual(t, got.EnrichmentVersion, `{"prompt_v":2,"embed_model":"gemma-3n"}`)
}

// --------------------------------------------------------------------------
// 2. StoreWithoutL0L1 — defaults: EnrichmentStatus="pending",
//    ContentL0/L1 empty.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1411", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "02", "scenario": "01", "title": "TieredContent_StoreWithoutL0L1"}
func TestTieredContent_StoreWithoutL0L1(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	item := domain.VaultItem{
		Type:      "note",
		Summary:   "Plain note without enrichment",
		BodyText:  "Just a plain note",
		Timestamp: 1700000002,
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	testutil.RequireEqual(t, got.ContentL0, "")
	testutil.RequireEqual(t, got.ContentL1, "")
	testutil.RequireEqual(t, got.EnrichmentStatus, "pending")
	testutil.RequireEqual(t, got.EnrichmentVersion, "")
}

// --------------------------------------------------------------------------
// 3. EnrichmentStatusValidation — invalid enrichment_status is rejected.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1412", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "03", "scenario": "01", "title": "TieredContent_EnrichmentStatusValidation"}
func TestTieredContent_EnrichmentStatusValidation(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	item := domain.VaultItem{
		Type:             "note",
		Summary:          "Bad enrichment status",
		BodyText:         "body",
		Timestamp:        1700000003,
		EnrichmentStatus: "invalid",
	}

	_, err := mgr.Store(ctx, "general", item)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "invalid enrichment_status")
}

// --------------------------------------------------------------------------
// 4. ProcessingStatus — store with EnrichmentStatus="processing", verify
//    round-trip.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1413", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "04", "scenario": "01", "title": "TieredContent_ProcessingStatus"}
func TestTieredContent_ProcessingStatus(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	item := domain.VaultItem{
		Type:             "email",
		Summary:          "Being enriched right now",
		BodyText:         "Email body awaiting enrichment",
		Timestamp:        1700000004,
		EnrichmentStatus: "processing",
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	testutil.RequireEqual(t, got.EnrichmentStatus, "processing")
}

// --------------------------------------------------------------------------
// 5. FailedStatus — store with EnrichmentStatus="failed", verify round-trip.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1414", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "05", "scenario": "01", "title": "TieredContent_FailedStatus"}
func TestTieredContent_FailedStatus(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	item := domain.VaultItem{
		Type:             "note",
		Summary:          "Enrichment failed item",
		BodyText:         "Body text that failed enrichment",
		Timestamp:        1700000005,
		EnrichmentStatus: "failed",
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	testutil.RequireEqual(t, got.EnrichmentStatus, "failed")
}

// --------------------------------------------------------------------------
// 6. EnrichmentVersionJSON — EnrichmentVersion JSON string round-trips.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1415", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "06", "scenario": "01", "title": "TieredContent_EnrichmentVersionJSON"}
func TestTieredContent_EnrichmentVersionJSON(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	versionJSON := `{"prompt_v":1,"embed_model":"gemma-3n"}`

	item := domain.VaultItem{
		Type:              "email",
		Summary:           "Enriched with version metadata",
		BodyText:          "Full email body content",
		Timestamp:         1700000006,
		ContentL0:         "Summary line",
		ContentL1:         "Paragraph overview of the email content.",
		EnrichmentStatus:  "ready",
		EnrichmentVersion: versionJSON,
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)

	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)

	testutil.RequireEqual(t, got.EnrichmentVersion, versionJSON)
}

// --------------------------------------------------------------------------
// 7. UnenrichedItemSearchable — item with body but no L0/L1 (pending) is
//    still found by FTS5 query matching body text.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1416", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "07", "scenario": "01", "title": "TieredContent_UnenrichedItemSearchable"}
func TestTieredContent_UnenrichedItemSearchable(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	_, err := mgr.Store(ctx, "general", domain.VaultItem{
		Type:      "note",
		Summary:   "Unenriched office furniture note",
		BodyText:  "The Steelcase Leap ergonomic chair is excellent",
		Timestamp: 1700000007,
		// No ContentL0/L1 — EnrichmentStatus defaults to "pending".
	})
	testutil.RequireNoError(t, err)

	// FTS5 search for body text should find the unenriched item.
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		Mode:           domain.SearchFTS5,
		Query:          "Steelcase Leap",
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 1)
	testutil.RequireEqual(t, items[0].EnrichmentStatus, "pending")
	testutil.RequireContains(t, items[0].BodyText, "Steelcase Leap")
}

// --------------------------------------------------------------------------
// 8. EnrichedItemSearchable — item with L0/L1/body is still found by FTS5
//    query matching body text (body is L2, still indexed).
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1417", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "08", "scenario": "01", "title": "TieredContent_EnrichedItemSearchable"}
func TestTieredContent_EnrichedItemSearchable(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	_, err := mgr.Store(ctx, "general", domain.VaultItem{
		Type:              "note",
		Summary:           "Enriched furniture review",
		BodyText:          "The Herman Miller Aeron is the gold standard for office seating",
		Timestamp:         1700000008,
		ContentL0:         "Aeron is gold standard",
		ContentL1:         "Detailed review of the Herman Miller Aeron office chair, praising its ergonomic design.",
		EnrichmentStatus:  "ready",
		EnrichmentVersion: `{"prompt_v":1,"embed_model":"gemma-3n"}`,
	})
	testutil.RequireNoError(t, err)

	// FTS5 search for body text (L2) should still find the enriched item.
	items, err := mgr.Query(ctx, "general", domain.SearchQuery{
		Mode:           domain.SearchFTS5,
		Query:          "Herman Miller Aeron",
		IncludeContent: true,
	})
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(items), 1)
	testutil.RequireEqual(t, items[0].EnrichmentStatus, "ready")
	testutil.RequireEqual(t, items[0].ContentL0, "Aeron is gold standard")
}

// --------------------------------------------------------------------------
// 9. BatchStoreWithEnrichment — StoreBatch with mixed enrichment states.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1418", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "09", "scenario": "01", "title": "TieredContent_BatchStoreWithEnrichment"}
func TestTieredContent_BatchStoreWithEnrichment(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	batch := []domain.VaultItem{
		{
			Type:              "email",
			Summary:           "Batch ready item",
			BodyText:          "Fully enriched email body",
			Timestamp:         1700000010,
			ContentL0:         "Enriched email",
			ContentL1:         "Paragraph summary of the enriched email.",
			EnrichmentStatus:  "ready",
			EnrichmentVersion: `{"prompt_v":1,"embed_model":"gemma-3n"}`,
		},
		{
			Type:             "note",
			Summary:          "Batch pending item",
			BodyText:         "Note awaiting enrichment",
			Timestamp:        1700000011,
			EnrichmentStatus: "pending",
		},
		{
			Type:             "email",
			Summary:          "Batch failed item",
			BodyText:         "Email that failed enrichment",
			Timestamp:        1700000012,
			EnrichmentStatus: "failed",
		},
	}

	ids, err := mgr.StoreBatch(ctx, "general", batch)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(ids), 3)

	// Verify each item stored with correct enrichment state.
	got0, err := mgr.GetItem(ctx, "general", ids[0])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got0.EnrichmentStatus, "ready")
	testutil.RequireEqual(t, got0.ContentL0, "Enriched email")
	testutil.RequireEqual(t, got0.EnrichmentVersion, `{"prompt_v":1,"embed_model":"gemma-3n"}`)

	got1, err := mgr.GetItem(ctx, "general", ids[1])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got1.EnrichmentStatus, "pending")
	testutil.RequireEqual(t, got1.ContentL0, "")

	got2, err := mgr.GetItem(ctx, "general", ids[2])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got2.EnrichmentStatus, "failed")
}

// --------------------------------------------------------------------------
// 10. ReEnrichment — store item with status="ready", then upsert with new
//     L0/L1 and new version. Verify the update took effect.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "1419", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "10", "scenario": "01", "title": "TieredContent_ReEnrichment"}
func TestTieredContent_ReEnrichment(t *testing.T) {
	mgr, ctx := newTieredContentVault(t)

	// Initial store with enrichment v1.
	item := domain.VaultItem{
		ID:                "re-enrich-001",
		Type:              "email",
		Summary:           "Report to be re-enriched",
		BodyText:          "Original email body about quarterly performance",
		Timestamp:         1700000020,
		ContentL0:         "Q3 performance summary",
		ContentL1:         "Overview of Q3 results showing moderate growth.",
		EnrichmentStatus:  "ready",
		EnrichmentVersion: `{"prompt_v":1,"embed_model":"gemma-3n"}`,
	}

	id, err := mgr.Store(ctx, "general", item)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, id, "re-enrich-001")

	// Verify initial state.
	got, err := mgr.GetItem(ctx, "general", id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got.ContentL0, "Q3 performance summary")
	testutil.RequireEqual(t, got.EnrichmentVersion, `{"prompt_v":1,"embed_model":"gemma-3n"}`)

	// Re-enrich: upsert with updated L0/L1 and new version.
	updated := domain.VaultItem{
		ID:                "re-enrich-001",
		Type:              "email",
		Summary:           "Report to be re-enriched",
		BodyText:          "Original email body about quarterly performance",
		Timestamp:         1700000020,
		ContentL0:         "Strong Q3 with 15% growth",
		ContentL1:         "Revised enrichment: Q3 showed 15% revenue growth exceeding analyst expectations.",
		EnrichmentStatus:  "ready",
		EnrichmentVersion: `{"prompt_v":2,"embed_model":"gemma-3n-v2"}`,
	}

	id2, err := mgr.Store(ctx, "general", updated)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, id2, "re-enrich-001")

	// Verify the update took effect.
	got2, err := mgr.GetItem(ctx, "general", id2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got2.ContentL0, "Strong Q3 with 15% growth")
	testutil.RequireEqual(t, got2.ContentL1, "Revised enrichment: Q3 showed 15% revenue growth exceeding analyst expectations.")
	testutil.RequireEqual(t, got2.EnrichmentVersion, `{"prompt_v":2,"embed_model":"gemma-3n-v2"}`)
	testutil.RequireEqual(t, got2.EnrichmentStatus, "ready")
}
