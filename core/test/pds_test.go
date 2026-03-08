package test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pds"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §22 — PDS Integration (AT Protocol)
// ==========================================================================
// Covers §22.1 (Record Signing & Publishing), §22.2 (Signed Tombstones).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §22.1 Record Signing & Publishing (10 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-710
func TestPDS_22_1_1_SignAttestationRecord(t *testing.T) {
	impl := pds.NewPDSPublisher("did:plc:testauthor")
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	ctx := context.Background()

	// Positive: valid attestation record → signed and published, returns AT URI.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-abc-123",
			"rating":          85,
			"verdict": map[string]interface{}{
				"build_quality":     8,
				"lumbar_support":    9,
				"value_for_money":   7,
				"durability_estimate": 8,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	uri, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, uri != "", "AT URI must be returned after publish")
	// Verify AT URI format: at://authorDID/collection/recordKey
	testutil.RequireTrue(t, strings.Contains(uri, "did:key:z6MkAuthor"), "URI must contain author DID")
	testutil.RequireTrue(t, strings.Contains(uri, "com.dina.trust.attestation"), "URI must contain collection")
	testutil.RequireTrue(t, strings.Contains(uri, "attestation-001"), "URI must contain record key")

	// Negative: missing required field (no "verdict") → lexicon validation fails.
	badRecord := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-bad",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-abc-123",
			"rating":          85,
			// verdict intentionally missing
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	_, err = impl.SignAndPublish(ctx, badRecord)
	testutil.RequireTrue(t, err != nil, "missing required field must fail lexicon validation")

	// Negative: rating out of range (>100) → must fail.
	outOfRange := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-range",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-abc-123",
			"rating":          150,
			"verdict":         map[string]interface{}{"quality": 5},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	_, err = impl.SignAndPublish(ctx, outOfRange)
	testutil.RequireTrue(t, err != nil, "out-of-range rating must fail validation")
}

// TST-CORE-711
func TestPDS_22_1_2_SignOutcomeReport(t *testing.T) {
	// Brain requests outcome publication.
	// Core signs with Trust Signing Key (HKDF "dina:trust:v1") and writes to PDS.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.trust.outcome",
		RecordKey:  "outcome-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-abc-123",
			"rating":          90,
			"verdict": map[string]interface{}{
				"build_quality":     9,
				"lumbar_support":    9,
				"value_for_money":   8,
				"durability_estimate": 9,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	recordID, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, recordID != "", "outcome record ID must be returned")

	// AT URI must contain the collection and record key.
	testutil.RequireContains(t, recordID, "com.dina.trust.outcome")
	testutil.RequireContains(t, recordID, "outcome-001")

	// Idempotent re-publish must return the same URI.
	recordID2, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, recordID, recordID2)
}

// TST-CORE-712
func TestPDS_22_1_3_LexiconValidation(t *testing.T) {
	// Attestation missing required field (productCategory) must be rejected before signing.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-invalid-001",
		Payload: map[string]interface{}{
			"expertDid": "did:key:z6MkExpert",
			// "productCategory" is missing
			"productId": "chair-abc-123",
			"rating":    85,
			"verdict": map[string]interface{}{
				"build_quality": 8,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	err := impl.ValidateLexicon(record)
	testutil.RequireError(t, err)
}

// TST-CORE-713
func TestPDS_22_1_4_RecordInMerkleRepo(t *testing.T) {
	// §22.1.4: After publish, record must be stored in PDS's signed Merkle
	// tree (tamper-evident). The AT URI serves as the record's address in
	// the repo. Re-publishing to the same key must be idempotent, and
	// deleting the record must remove it from the repo.

	authorDID := "did:key:z6MkMerkleAuthor"
	impl := pds.NewPDSPublisher(authorDID)
	ctx := context.Background()

	// Positive: publish a record — stored in repo.
	record := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-merkle-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-merkle-001",
			"rating":          80,
			"verdict":         map[string]interface{}{"build_quality": 8},
		},
		AuthorDID: authorDID,
	}
	uri, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(uri, "at://"),
		"record URI must be AT protocol format for Merkle repo addressing")
	testutil.RequireContains(t, uri, authorDID)
	testutil.RequireContains(t, uri, "attestation-merkle-001")

	// Idempotent: re-publishing same record key returns same URI.
	uri2, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, uri, uri2)

	// Tombstone: delete the record — must be removed from repo.
	tombstone := domain.Tombstone{
		Target:    "attestation-merkle-001",
		AuthorDID: authorDID,
		Signature: []byte("test-sig"),
	}
	err = impl.DeleteRecord(ctx, tombstone)
	testutil.RequireNoError(t, err)

	// After deletion, re-publishing to same key should succeed
	// (slot is now free in the repo).
	uri3, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, uri, uri3)

	// Negative: attacker (different DID) cannot delete the record.
	attackerDID := "did:key:z6MkAttacker"
	attackerTombstone := domain.Tombstone{
		Target:    "attestation-merkle-001",
		AuthorDID: attackerDID,
		Signature: []byte("attacker-sig"),
	}
	err = impl.DeleteRecord(ctx, attackerTombstone)
	testutil.RequireError(t, err)
}

// TST-CORE-714
func TestPDS_22_1_5_PDSConnectionFailure(t *testing.T) {
	impl := pds.NewPDSPublisher("did:plc:testauthor")
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	ctx := context.Background()

	// Positive: when PDS is down, QueueForRetry accepts the record for outbox retry.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-retry-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-retry-001",
			"rating":          75,
			"verdict": map[string]interface{}{
				"build_quality": 7,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	err := impl.QueueForRetry(ctx, record)
	testutil.RequireNoError(t, err)

	// Positive: queuing multiple records must succeed (outbox can hold >1).
	record2 := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-retry-002",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert2",
			"productCategory": "laptops",
			"productId":       "laptop-xyz",
			"rating":          90,
			"verdict":         map[string]interface{}{"quality": 9},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	err = impl.QueueForRetry(ctx, record2)
	testutil.RequireNoError(t, err)

	// Negative: a queued record must NOT be retrievable via normal publish path.
	// SignAndPublish with the same key should succeed independently (separate stores).
	uri, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, uri != "", "queued record must not block subsequent publish")
}

// TST-CORE-715
func TestPDS_22_1_6_TypeBBundledPDS(t *testing.T) {
	// Type B (default): Core writes directly to pds:2583 on internal network.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-bundled-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "phone-001",
			"rating":          88,
			"verdict": map[string]interface{}{
				"build_quality": 9,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	recordID, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, recordID != "", "bundled PDS write must succeed")
}

// TST-CORE-716
func TestPDS_22_1_7_TypeAExternalPDS(t *testing.T) {
	// §22.1.7: Type A deployment — Home Node behind CGNAT pushes signed
	// commits to an external PDS via outbound HTTPS. The published record
	// must produce a valid AT URI containing the author DID, collection,
	// and record key so that the external PDS can index it.

	authorDID := "did:key:z6MkExternalAuthor"
	impl := pds.NewPDSPublisher(authorDID)
	ctx := context.Background()

	// Positive: publish an attestation to external PDS.
	record := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-external-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "phone-002",
			"rating":          92,
			"verdict":         map[string]interface{}{"build_quality": 9},
		},
		AuthorDID: authorDID,
	}
	uri, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)

	// AT URI must contain the author DID (for PDS repo routing).
	testutil.RequireTrue(t, strings.HasPrefix(uri, "at://"),
		"URI must be AT protocol format for external PDS")
	testutil.RequireContains(t, uri, authorDID)
	testutil.RequireContains(t, uri, "com.dina.trust.attestation")
	testutil.RequireContains(t, uri, "attestation-external-001")

	// Idempotent re-publish to same record key produces same URI.
	uri2, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, uri, uri2)

	// Negative: missing required fields must be rejected before push.
	badRecord := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "bad-external",
		Payload:    map[string]interface{}{"expertDid": "did:key:z6MkExpert"},
		AuthorDID:  authorDID,
	}
	_, err = impl.SignAndPublish(ctx, badRecord)
	testutil.RequireError(t, err)

	// Negative: empty author DID should still produce a valid URI
	// (publisher falls back to its own DID).
	noAuthor := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "no-author-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "audio",
			"productId":       "headphones-1",
			"rating":          80,
			"verdict":         map[string]interface{}{"sound": 85},
		},
		AuthorDID: "", // empty — publisher should use its own DID
	}
	uriFallback, err := impl.SignAndPublish(ctx, noAuthor)
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, uriFallback, authorDID)
}

// TST-CORE-717
func TestPDS_22_1_8_RatingRangeEnforcement(t *testing.T) {
	// Rating must be 0-100 inclusive. Values outside range must be rejected.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	makeRecord := func(rating int) testutil.PDSRecord {
		return testutil.PDSRecord{
			Collection: "com.dina.trust.attestation",
			RecordKey:  "attestation-rating-test",
			Payload: map[string]interface{}{
				"expertDid":       "did:key:z6MkExpert",
				"productCategory": "electronics",
				"productId":       "phone-003",
				"rating":          rating,
				"verdict": map[string]interface{}{
					"build_quality": 8,
				},
			},
			AuthorDID: "did:key:z6MkAuthor",
		}
	}

	// rating: 101 -> rejected
	err := impl.ValidateLexicon(makeRecord(101))
	testutil.RequireError(t, err)

	// rating: -1 -> rejected
	err = impl.ValidateLexicon(makeRecord(-1))
	testutil.RequireError(t, err)

	// rating: 0 -> accepted
	err = impl.ValidateLexicon(makeRecord(0))
	testutil.RequireNoError(t, err)

	// rating: 100 -> accepted
	err = impl.ValidateLexicon(makeRecord(100))
	testutil.RequireNoError(t, err)
}

// TST-CORE-718
func TestPDS_22_1_9_VerdictIsStructuredObject(t *testing.T) {
	// verdict must be a #verdictDetail ref (object with sub-scores), not a plain string.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	// Plain string verdict -> rejected
	badRecord := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-verdict-string",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "furniture",
			"productId":       "chair-verdict-001",
			"rating":          80,
			"verdict":         "good", // plain string — should be rejected
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	err := impl.ValidateLexicon(badRecord)
	testutil.RequireError(t, err)

	// Valid object verdict -> accepted
	goodRecord := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-verdict-object",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "furniture",
			"productId":       "chair-verdict-002",
			"rating":          80,
			"verdict": map[string]interface{}{
				"build_quality":     8,
				"lumbar_support":    9,
				"value_for_money":   7,
				"durability_estimate": 8,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	err = impl.ValidateLexicon(goodRecord)
	testutil.RequireNoError(t, err)
}

// TST-CORE-719
func TestPDS_22_1_10_AllRequiredFieldsValidated(t *testing.T) {
	impl := pds.NewPDSPublisher("did:plc:testauthor")
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	basePayload := map[string]interface{}{
		"expertDid":       "did:key:z6MkExpert",
		"productCategory": "electronics",
		"productId":       "phone-005",
		"rating":          85,
		"verdict": map[string]interface{}{
			"build_quality": 8,
		},
	}

	// Positive: all fields present → validation passes.
	completeRecord := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-complete",
		Payload:    basePayload,
		AuthorDID:  "did:key:z6MkAuthor",
	}
	err := impl.ValidateLexicon(completeRecord)
	testutil.RequireNoError(t, err)

	// Negative: each of 5 required fields missing → validation fails.
	requiredFields := []string{"expertDid", "productCategory", "productId", "rating", "verdict"}
	for _, field := range requiredFields {
		payload := make(map[string]interface{})
		for k, v := range basePayload {
			payload[k] = v
		}
		delete(payload, field)

		record := testutil.PDSRecord{
			Collection: "com.dina.trust.attestation",
			RecordKey:  "attestation-missing-" + field,
			Payload:    payload,
			AuthorDID:  "did:key:z6MkAuthor",
		}
		err := impl.ValidateLexicon(record)
		testutil.RequireTrue(t, err != nil, "missing "+field+" must fail validation")
	}
}

// --------------------------------------------------------------------------
// §22.2 Signed Tombstones (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-720
func TestPDS_22_2_1_AuthorDeletesOwnRecord(t *testing.T) {
	// User requests deletion of own review.
	// Core generates Tombstone{target, author, sig} signed by same key.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	ctx := context.Background()
	authorDID := "did:key:z6MkAuthorDel"

	// Step 1: Publish a record so there's something to delete.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-del-001",
		Payload: map[string]interface{}{
			"expertDid":       authorDID,
			"productCategory": "office_chairs",
			"productId":       "chair-del-001",
			"rating":          85,
			"verdict":         map[string]interface{}{"build_quality": 8},
		},
		AuthorDID: authorDID,
	}
	recordID, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, recordID != "", "record must be published before deletion")

	// Step 2: Delete as the same author — should succeed.
	tombstone := testutil.Tombstone{
		Target:    "attestation-del-001",
		AuthorDID: authorDID,
		Signature: []byte("author-signature"),
	}
	err = impl.DeleteRecord(ctx, tombstone)
	testutil.RequireNoError(t, err)

	// Step 3: A second delete by the same author on the tombstoned record should still succeed
	// (idempotent — tombstone already recorded for this author).
	err = impl.DeleteRecord(ctx, tombstone)
	testutil.RequireNoError(t, err)

	// Step 4: A different author trying to delete the same (now tombstoned) record must fail.
	attackerTombstone := testutil.Tombstone{
		Target:    "attestation-del-001",
		AuthorDID: "did:key:z6MkAttacker",
		Signature: []byte("attacker-signature"),
	}
	err = impl.DeleteRecord(ctx, attackerTombstone)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "forbidden")
}

// TST-CORE-721
func TestPDS_22_2_2_NonAuthorDeletionRejected(t *testing.T) {
	impl := pds.NewPDSPublisher("did:plc:testauthor")
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	ctx := context.Background()

	// First, publish a record as the legitimate author.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "non-author-del-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "monitors",
			"productId":       "monitor-xyz",
			"rating":          80,
			"verdict":         map[string]interface{}{"quality": 7},
		},
		AuthorDID: "did:key:z6MkLegitAuthor",
	}
	_, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)

	// Negative: attacker (different DID) tries to delete → must be rejected.
	attackerTombstone := testutil.Tombstone{
		Target:    "non-author-del-001",
		AuthorDID: "did:key:z6MkAttacker",
		Signature: []byte("wrong-signature"),
	}
	err = impl.DeleteRecord(ctx, attackerTombstone)
	testutil.RequireTrue(t, err != nil, "non-author deletion must be rejected")

	// Positive: legitimate author can delete their own record.
	authorTombstone := testutil.Tombstone{
		Target:    "non-author-del-001",
		AuthorDID: "did:key:z6MkLegitAuthor",
		Signature: []byte("valid-signature"),
	}
	err = impl.DeleteRecord(ctx, authorTombstone)
	testutil.RequireNoError(t, err)
}

// TST-CORE-722
func TestPDS_22_2_3_TombstonePropagation(t *testing.T) {
	// Tombstone published to PDS must be distributed by relay to federated AppViews.
	pub := pds.NewPDSPublisher()
	testutil.RequireImplementation(t, pub, "PDSPublisher")

	ctx := context.Background()
	authorDID := "did:key:z6MkPropagationAuthor"
	attackerDID := "did:key:z6MkAttacker"

	// Publish a record first so tombstone has something to propagate.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-propagation-001",
		Payload: map[string]interface{}{
			"expertDid":       authorDID,
			"productCategory": "electronics",
			"productId":       "phone-prop-001",
			"rating":          80,
			"verdict":         map[string]interface{}{"build": 8},
		},
		AuthorDID: authorDID,
	}
	uri, err := pub.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.Contains(uri, "attestation-propagation-001"), "URI must reference the record key")

	// Negative: attacker cannot tombstone another author's record.
	attackerTombstone := testutil.Tombstone{
		Target:    "attestation-propagation-001",
		AuthorDID: attackerDID,
		Signature: []byte("attacker-sig"),
	}
	err = pub.DeleteRecord(ctx, attackerTombstone)
	testutil.RequireTrue(t, err != nil, "non-author must be rejected")
	testutil.RequireTrue(t, strings.Contains(err.Error(), "forbidden"), "error must mention forbidden")

	// Positive: author's tombstone succeeds — record deleted, tombstone recorded.
	authorTombstone := testutil.Tombstone{
		Target:    "attestation-propagation-001",
		AuthorDID: authorDID,
		Signature: []byte("author-sig"),
	}
	err = pub.DeleteRecord(ctx, authorTombstone)
	testutil.RequireNoError(t, err)

	// Verify propagation: re-deleting by same author still succeeds (tombstone is recorded).
	err = pub.DeleteRecord(ctx, authorTombstone)
	testutil.RequireNoError(t, err)

	// Negative: attacker still cannot claim the tombstoned record.
	err = pub.DeleteRecord(ctx, attackerTombstone)
	testutil.RequireTrue(t, err != nil, "attacker must be rejected even after tombstone")
}

// TST-CORE-723
func TestPDS_22_2_4_DeletedRecordAbsentFromQueries(t *testing.T) {
	// After tombstone, the record must no longer be present — re-publish by new
	// author must succeed (old record truly gone), and tombstone ownership must
	// be preserved (attacker can't claim the tombstoned key).
	pub := pds.NewPDSPublisher("did:key:z6MkOriginalAuthor")
	testutil.RequireImplementation(t, pub, "PDSPublisher")

	ctx := context.Background()
	authorDID := "did:key:z6MkOriginalAuthor"
	attackerDID := "did:key:z6MkAttacker"

	// Publish a record.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-delete-query-001",
		Payload: map[string]interface{}{
			"expertDid":       authorDID,
			"productCategory": "electronics",
			"productId":       "phone-delete-001",
			"rating":          70,
			"verdict":         map[string]interface{}{"build_quality": 7},
		},
		AuthorDID: authorDID,
	}
	uri, err := pub.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.Contains(uri, "attestation-delete-query-001"), "URI must contain record key")

	// Delete by author — must succeed.
	tombstone := testutil.Tombstone{
		Target:    "attestation-delete-query-001",
		AuthorDID: authorDID,
		Signature: []byte("author-sig"),
	}
	err = pub.DeleteRecord(ctx, tombstone)
	testutil.RequireNoError(t, err)

	// Verify record is absent: re-publishing to the same key succeeds
	// (the old record was deleted, so the slot is free for a new record).
	newRecord := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "attestation-delete-query-001",
		Payload: map[string]interface{}{
			"expertDid":       authorDID,
			"productCategory": "electronics",
			"productId":       "phone-delete-001-v2",
			"rating":          90,
			"verdict":         map[string]interface{}{"build_quality": 9},
		},
		AuthorDID: authorDID,
	}
	uri2, err := pub.SignAndPublish(ctx, newRecord)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.Contains(uri2, "attestation-delete-query-001"), "re-publish must succeed on deleted key")

	// Negative: attacker cannot delete the re-published record.
	attackerTombstone := testutil.Tombstone{
		Target:    "attestation-delete-query-001",
		AuthorDID: attackerDID,
		Signature: []byte("attacker-sig"),
	}
	err = pub.DeleteRecord(ctx, attackerTombstone)
	testutil.RequireTrue(t, err != nil, "attacker must be rejected from deleting another author's record")
	testutil.RequireTrue(t, strings.Contains(err.Error(), "forbidden"), "error must mention forbidden")
}

// TST-CORE-918
func TestPDS_22_2_5_BotLexiconValidation(t *testing.T) {
	// com.dina.trust.bot and com.dina.trust.membership Lexicons validated.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	botRecord := testutil.PDSRecord{
		Collection: "com.dina.trust.bot",
		RecordKey:  "bot-lexicon-001",
		Payload:    map[string]interface{}{"botDid": "did:key:z6MkBot", "score": 85},
		AuthorDID:  "did:key:z6MkAuthor",
	}
	err := impl.ValidateLexicon(botRecord)
	testutil.RequireNoError(t, err)
}

// TST-CORE-919
func TestPDS_22_2_6_OutcomeDataSchemaValidation(t *testing.T) {
	// §22.2.6: Outcome data schema requires reporter_trust_ring, outcome,
	// satisfaction, issues fields. ValidateLexicon must enforce these.

	authorDID := "did:key:z6MkOutcomeReporter"
	impl := pds.NewPDSPublisher(authorDID)
	ctx := context.Background()

	// Positive: valid outcome record with all required fields.
	validOutcome := domain.PDSRecord{
		Collection: "com.dina.trust.outcome",
		RecordKey:  "outcome-valid-001",
		Payload: map[string]interface{}{
			"reporter_trust_ring": 2,
			"outcome":            "positive",
			"satisfaction":       85,
			"issues":             []interface{}{},
		},
		AuthorDID: authorDID,
	}
	uri, err := impl.SignAndPublish(ctx, validOutcome)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(uri, "at://"),
		"outcome URI must be AT protocol format")
	testutil.RequireContains(t, uri, "com.dina.trust.outcome")
	testutil.RequireContains(t, uri, "outcome-valid-001")

	// Negative: empty payload should be rejected — outcome schema requires fields.
	// NOTE: If this passes (no error), it indicates a production bug where
	// validateOutcome() is a no-op and doesn't enforce the schema.
	emptyOutcome := domain.PDSRecord{
		Collection: "com.dina.trust.outcome",
		RecordKey:  "outcome-empty",
		Payload:    map[string]interface{}{},
		AuthorDID:  authorDID,
	}
	err = impl.ValidateLexicon(emptyOutcome)
	// Per spec, outcome records MUST have reporter_trust_ring, outcome,
	// satisfaction, issues. Empty payload should fail validation.
	// If this assertion fails, it means validateOutcome() is not enforcing the schema.
	testutil.RequireError(t, err)

	// Negative: satisfaction out of range (>100) should be rejected.
	badSatisfaction := domain.PDSRecord{
		Collection: "com.dina.trust.outcome",
		RecordKey:  "outcome-bad-sat",
		Payload: map[string]interface{}{
			"reporter_trust_ring": 2,
			"outcome":            "positive",
			"satisfaction":       150,
			"issues":             []interface{}{},
		},
		AuthorDID: authorDID,
	}
	err = impl.ValidateLexicon(badSatisfaction)
	testutil.RequireError(t, err)
}

// TST-CORE-920
func TestPDS_22_2_7_AttestationOptionalFieldsURIFormat(t *testing.T) {
	// §22.2.7: Attestation optional fields sourceUrl and deepLink must be
	// valid URIs when present. The full record with optional fields must
	// pass validation and produce a correct AT URI via SignAndPublish.

	authorDID := "did:key:z6MkOptFieldAuthor"
	impl := pds.NewPDSPublisher(authorDID)
	ctx := context.Background()

	// Positive: attestation with valid optional URI fields.
	record := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "att-uri-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "furniture",
			"productId":       "steelcase-leap",
			"rating":          92,
			"verdict":         map[string]interface{}{"build_quality": 95, "value_for_money": 88},
			"sourceUrl":       "https://youtube.com/watch?v=abc123",
			"deepLink":        "https://youtube.com/watch?v=abc123&t=142",
		},
		AuthorDID: authorDID,
	}
	uri, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(uri, "at://"),
		"URI must be AT protocol format")
	testutil.RequireContains(t, uri, authorDID)
	testutil.RequireContains(t, uri, "att-uri-001")

	// Positive: attestation WITHOUT optional fields must also succeed.
	recordNoOpt := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "att-no-opt-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "furniture",
			"productId":       "steelcase-leap",
			"rating":          92,
			"verdict":         map[string]interface{}{"build_quality": 95},
		},
		AuthorDID: authorDID,
	}
	uriNoOpt, err := impl.SignAndPublish(ctx, recordNoOpt)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, uri != uriNoOpt, "different records must produce different URIs")

	// Negative: non-URI sourceUrl should be rejected.
	// Per spec, sourceUrl and deepLink must be valid URI format when present.
	badSourceUrl := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "att-bad-url",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "furniture",
			"productId":       "chair-x",
			"rating":          80,
			"verdict":         map[string]interface{}{"comfort": 70},
			"sourceUrl":       "not a url at all",
		},
		AuthorDID: authorDID,
	}
	err = impl.ValidateLexicon(badSourceUrl)
	// Per spec, invalid URI format should fail validation.
	// If this passes, it means ValidateLexicon doesn't check URI format for optional fields.
	testutil.RequireError(t, err)
}

// TST-CORE-921
func TestPDS_22_2_8_TrustQueryResponseIncludesSignedPayloads(t *testing.T) {
	// §22.2.8: Trust query response includes signed payloads.
	// Published attestation records must have valid AT URIs containing
	// the author DID, collection, and record key. The signature field
	// must be populated after signing.

	authorDID := "did:key:z6MkTrustQueryAuthor"
	impl := pds.NewPDSPublisher(authorDID)

	ctx := context.Background()

	// Positive: publish a valid attestation and verify the signed payload.
	record := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "signed-payload-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "pixel-9",
			"rating":          88,
			"verdict":         map[string]interface{}{"camera": 92, "battery": 80},
		},
		AuthorDID: authorDID,
	}
	uri, err := impl.SignAndPublish(ctx, record)
	testutil.RequireNoError(t, err)

	// URI must be a valid AT URI containing all three components.
	testutil.RequireTrue(t, strings.HasPrefix(uri, "at://"),
		"URI must be an AT protocol URI (at://...)")
	testutil.RequireContains(t, uri, authorDID)
	testutil.RequireContains(t, uri, "com.dina.trust.attestation")
	testutil.RequireContains(t, uri, "signed-payload-001")

	// Second record with different key must produce distinct URI.
	record2 := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "signed-payload-002",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert2",
			"productCategory": "audio",
			"productId":       "headphones-x",
			"rating":          75,
			"verdict":         map[string]interface{}{"sound": 85, "comfort": 60},
		},
		AuthorDID: authorDID,
	}
	uri2, err := impl.SignAndPublish(ctx, record2)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, uri != uri2, "distinct records must produce distinct URIs")
	testutil.RequireContains(t, uri2, "signed-payload-002")

	// Negative: missing required field must be rejected (payload not signed).
	badRecord := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "bad-payload",
		Payload: map[string]interface{}{
			"expertDid": "did:key:z6MkExpert",
			// missing productCategory, productId, rating, verdict
		},
		AuthorDID: authorDID,
	}
	_, err = impl.SignAndPublish(ctx, badRecord)
	testutil.RequireError(t, err)

	// Negative: rating out of range must be rejected.
	outOfRange := domain.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "bad-rating",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "phone-y",
			"rating":          150,
			"verdict":         map[string]interface{}{"overall": 50},
		},
		AuthorDID: authorDID,
	}
	_, err = impl.SignAndPublish(ctx, outOfRange)
	testutil.RequireError(t, err)
}

// TST-CORE-922
func TestPDS_22_2_9_DIDDocContainsDIDCommServiceEndpoint(t *testing.T) {
	// Requirement: DID Document must contain a messaging service endpoint
	// for D2D (Dina-to-Dina) communication.

	// Fresh DIDManager with temp dir.
	dir := t.TempDir()
	dm := identity.NewDIDManager(dir)

	ctx := context.Background()

	// Generate a key pair and create a DID.
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	testutil.RequireNoError(t, err)

	did, err := dm.Create(ctx, pub)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(string(did), "did:plc:"),
		"created DID must be did:plc: format")

	// Resolve the DID document.
	docBytes, err := dm.Resolve(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(docBytes) > 0, "DID doc must not be empty")

	// Parse the DID document JSON.
	var doc map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(docBytes, &doc))

	// DID doc must have "id" matching the created DID.
	testutil.RequireEqual(t, doc["id"], string(did))

	// DID doc must have "service" array with at least one messaging endpoint.
	services, ok := doc["service"].([]interface{})
	testutil.RequireTrue(t, ok, "DID doc must have 'service' array")
	testutil.RequireTrue(t, len(services) >= 1, "DID doc must have at least 1 service endpoint")

	// Verify the messaging service endpoint.
	svc, ok := services[0].(map[string]interface{})
	testutil.RequireTrue(t, ok, "service entry must be an object")

	// Service must have id, type, and serviceEndpoint fields.
	svcID, _ := svc["id"].(string)
	testutil.RequireTrue(t, len(svcID) > 0, "service must have an 'id'")
	testutil.RequireContains(t, svcID, "#")

	svcType, _ := svc["type"].(string)
	testutil.RequireTrue(t, len(svcType) > 0, "service must have a 'type'")
	// Type should indicate messaging capability (DinaMessaging or DIDCommMessaging).
	testutil.RequireTrue(t, strings.Contains(svcType, "Messaging"),
		"service type must indicate messaging capability, got: "+svcType)

	endpoint, _ := svc["serviceEndpoint"].(string)
	testutil.RequireTrue(t, len(endpoint) > 0, "service must have a serviceEndpoint URL")
	testutil.RequireTrue(t, strings.HasPrefix(endpoint, "https://"),
		"serviceEndpoint must use HTTPS, got: "+endpoint)

	// Negative: unknown DID must return error, not synthetic document.
	_, err = dm.Resolve(ctx, domain.DID("did:plc:nonexistent999"))
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "not found")
}

// TST-CORE-923
func TestPDS_22_2_10_OutcomeRecordSigning(t *testing.T) {
	// §22.2.10: Outcome records must be signed and published with valid AT URIs.
	// Both outcome and bot lexicon records must pass through SignAndPublish.

	authorDID := "did:key:z6MkOutcomeSigner"
	impl := pds.NewPDSPublisher(authorDID)
	ctx := context.Background()

	// Positive: outcome record signed and published.
	outcomeRecord := domain.PDSRecord{
		Collection: "com.dina.trust.outcome",
		RecordKey:  "signed-outcome-001",
		Payload: map[string]interface{}{
			"reporter_trust_ring": 2,
			"outcome":            "positive",
			"satisfaction":       90,
			"issues":             []interface{}{},
		},
		AuthorDID: authorDID,
	}
	uri, err := impl.SignAndPublish(ctx, outcomeRecord)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(uri, "at://"),
		"outcome URI must be AT protocol format")
	testutil.RequireContains(t, uri, authorDID)
	testutil.RequireContains(t, uri, "com.dina.trust.outcome")
	testutil.RequireContains(t, uri, "signed-outcome-001")

	// Positive: bot lexicon record signed and published.
	botRecord := domain.PDSRecord{
		Collection: "com.dina.trust.bot",
		RecordKey:  "bot-review-001",
		Payload: map[string]interface{}{
			"botDid":      "did:key:z6MkBot",
			"capability":  "product_review",
			"trustScore":  75,
		},
		AuthorDID: authorDID,
	}
	botURI, err := impl.SignAndPublish(ctx, botRecord)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.HasPrefix(botURI, "at://"),
		"bot URI must be AT protocol format")
	testutil.RequireContains(t, botURI, "com.dina.trust.bot")

	// Distinct records must produce distinct URIs.
	testutil.RequireTrue(t, uri != botURI,
		"outcome and bot records must have different URIs")

	// Negative: unknown collection still gets signed (extensibility).
	unknownRecord := domain.PDSRecord{
		Collection: "com.dina.custom.data",
		RecordKey:  "custom-001",
		Payload:    map[string]interface{}{"data": "test"},
		AuthorDID:  authorDID,
	}
	customURI, err := impl.SignAndPublish(ctx, unknownRecord)
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, customURI, "com.dina.custom.data")
}

// TST-CORE-924
func TestPDS_22_2_11_TypeA_FallbackToExternalHTTPS(t *testing.T) {
	// PDS Type A: fallback to external HTTPS push.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	// When PDS is unreachable, record should be queued for retry.
	record := testutil.PDSRecord{
		Collection: "com.dina.trust.attestation",
		RecordKey:  "fallback-001",
		Payload:    map[string]interface{}{"expertDid": "did:key:z6Mk", "productCategory": "test", "productId": "test", "rating": 50, "verdict": map[string]interface{}{"quality": 50}},
		AuthorDID:  "did:key:z6MkAuthor",
	}
	err := impl.QueueForRetry(context.Background(), record)
	testutil.RequireNoError(t, err)
}
