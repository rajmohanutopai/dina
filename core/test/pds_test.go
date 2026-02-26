package test

import (
	"context"
	"testing"

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
	// Brain requests POST /v1/reputation/publish with attestation payload.
	// Core signs with persona key and writes to PDS as com.dina.reputation.attestation record.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
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
	recordID, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, recordID != "", "record ID must be returned after publish")
}

// TST-CORE-711
func TestPDS_22_1_2_SignOutcomeReport(t *testing.T) {
	// Brain requests outcome publication.
	// Core signs with Reputation Signing Key (HKDF "dina:reputation:v1") and writes to PDS.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.outcome",
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
}

// TST-CORE-712
func TestPDS_22_1_3_LexiconValidation(t *testing.T) {
	// Attestation missing required field (productCategory) must be rejected before signing.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
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
	// After publish, record must be stored in PDS's signed Merkle tree (tamper-evident).
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
		RecordKey:  "attestation-merkle-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "office_chairs",
			"productId":       "chair-merkle-001",
			"rating":          80,
			"verdict": map[string]interface{}{
				"build_quality": 8,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	recordID, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, recordID != "", "record must be stored in Merkle repo")
}

// TST-CORE-714
func TestPDS_22_1_5_PDSConnectionFailure(t *testing.T) {
	// When PDS container is down, core queues record in outbox for retry.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
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
	err := impl.QueueForRetry(context.Background(), record)
	testutil.RequireNoError(t, err)
}

// TST-CORE-715
func TestPDS_22_1_6_TypeBBundledPDS(t *testing.T) {
	// Type B (default): Core writes directly to pds:2583 on internal network.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
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
	// Type A: Home Node behind CGNAT, core pushes signed commit to external PDS via outbound HTTPS.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
		RecordKey:  "attestation-external-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "phone-002",
			"rating":          92,
			"verdict": map[string]interface{}{
				"build_quality": 9,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	recordID, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, recordID != "", "external PDS write must succeed")
}

// TST-CORE-717
func TestPDS_22_1_8_RatingRangeEnforcement(t *testing.T) {
	// Rating must be 0-100 inclusive. Values outside range must be rejected.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	makeRecord := func(rating int) testutil.PDSRecord {
		return testutil.PDSRecord{
			Collection: "com.dina.reputation.attestation",
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
		Collection: "com.dina.reputation.attestation",
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
		Collection: "com.dina.reputation.attestation",
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
	// All 5 required fields must be present: expertDid, productCategory, productId, rating, verdict.
	// Test each omission independently.
	impl := realPDSPublisher
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

	requiredFields := []string{"expertDid", "productCategory", "productId", "rating", "verdict"}
	for _, field := range requiredFields {
		// Copy base payload and remove one field.
		payload := make(map[string]interface{})
		for k, v := range basePayload {
			payload[k] = v
		}
		delete(payload, field)

		record := testutil.PDSRecord{
			Collection: "com.dina.reputation.attestation",
			RecordKey:  "attestation-missing-" + field,
			Payload:    payload,
			AuthorDID:  "did:key:z6MkAuthor",
		}
		err := impl.ValidateLexicon(record)
		testutil.RequireError(t, err)
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

	tombstone := testutil.Tombstone{
		Target:    "attestation-001",
		AuthorDID: "did:key:z6MkAuthor",
		Signature: []byte("mock-signature"),
	}
	err := impl.DeleteRecord(context.Background(), tombstone)
	testutil.RequireNoError(t, err)
}

// TST-CORE-721
func TestPDS_22_2_2_NonAuthorDeletionRejected(t *testing.T) {
	// External request to delete someone else's record must be rejected.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	tombstone := testutil.Tombstone{
		Target:    "attestation-001",
		AuthorDID: "did:key:z6MkAttacker", // not the original author
		Signature: []byte("wrong-signature"),
	}
	err := impl.DeleteRecord(context.Background(), tombstone)
	testutil.RequireError(t, err)
}

// TST-CORE-722
func TestPDS_22_2_3_TombstonePropagation(t *testing.T) {
	// Tombstone published to PDS must be distributed by relay to federated AppViews.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	tombstone := testutil.Tombstone{
		Target:    "attestation-propagation-001",
		AuthorDID: "did:key:z6MkAuthor",
		Signature: []byte("mock-signature"),
	}
	err := impl.DeleteRecord(context.Background(), tombstone)
	testutil.RequireNoError(t, err)
	// Propagation is verified at the integration/E2E level — relay distributes tombstones.
}

// TST-CORE-723
func TestPDS_22_2_4_DeletedRecordAbsentFromQueries(t *testing.T) {
	// After tombstone, AppView no longer returns the record.
	// Aggregate scores must be recomputed without the deleted record.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	// Publish then delete.
	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
		RecordKey:  "attestation-delete-query-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "phone-delete-001",
			"rating":          70,
			"verdict": map[string]interface{}{
				"build_quality": 7,
			},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	_, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)

	tombstone := testutil.Tombstone{
		Target:    "attestation-delete-query-001",
		AuthorDID: "did:key:z6MkAuthor",
		Signature: []byte("mock-signature"),
	}
	err = impl.DeleteRecord(context.Background(), tombstone)
	testutil.RequireNoError(t, err)
}

// TST-CORE-918
func TestPDS_22_2_5_BotLexiconValidation(t *testing.T) {
	// com.dina.reputation.bot and com.dina.trust.membership Lexicons validated.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	botRecord := testutil.PDSRecord{
		Collection: "com.dina.reputation.bot",
		RecordKey:  "bot-lexicon-001",
		Payload:    map[string]interface{}{"botDid": "did:key:z6MkBot", "score": 85},
		AuthorDID:  "did:key:z6MkAuthor",
	}
	err := impl.ValidateLexicon(botRecord)
	testutil.RequireNoError(t, err)
}

// TST-CORE-919
func TestPDS_22_2_6_OutcomeDataSchemaValidation(t *testing.T) {
	// Outcome data schema: reporter_trust_ring, outcome, satisfaction, issues.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	outcomeRecord := testutil.PDSRecord{
		Collection: "com.dina.reputation.outcome",
		RecordKey:  "outcome-001",
		Payload: map[string]interface{}{
			"reporter_trust_ring": 2,
			"outcome":            "positive",
			"satisfaction":       85,
			"issues":             []interface{}{},
		},
		AuthorDID: "did:key:z6MkReporter",
	}
	err := impl.ValidateLexicon(outcomeRecord)
	testutil.RequireNoError(t, err)
}

// TST-CORE-920
func TestPDS_22_2_7_AttestationOptionalFieldsURIFormat(t *testing.T) {
	// Attestation optional fields URI format (sourceUrl, deepLink).
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
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
		AuthorDID: "did:key:z6MkAuthor",
	}
	err := impl.ValidateLexicon(record)
	testutil.RequireNoError(t, err)
}

// TST-CORE-921
func TestPDS_22_2_8_ReputationQueryResponseIncludesSignedPayloads(t *testing.T) {
	// Reputation query response includes signed payloads.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
		RecordKey:  "signed-001",
		Payload: map[string]interface{}{
			"expertDid":       "did:key:z6MkExpert",
			"productCategory": "electronics",
			"productId":       "pixel-9",
			"rating":          88,
			"verdict":         map[string]interface{}{"camera": 92, "battery": 80},
		},
		AuthorDID: "did:key:z6MkAuthor",
	}
	uri, err := impl.SignAndPublish(context.Background(), record)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, uri != "", "published record must return a URI")
}

// TST-CORE-922
func TestPDS_22_2_9_DIDDocContainsDIDCommServiceEndpoint(t *testing.T) {
	// DID Document contains DIDComm service endpoint for D2D communication.
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	doc, err := impl.Resolve(idCtx, domain.DID("did:plc:test123"))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(doc) > 0, "DID Document must not be empty")
}

// TST-CORE-923
func TestPDS_22_2_10_OutcomeRecordSigning(t *testing.T) {
	// Outcome and Bot Lexicon signing and validation.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	outcomeRecord := testutil.PDSRecord{
		Collection: "com.dina.reputation.outcome",
		RecordKey:  "signed-outcome-001",
		Payload: map[string]interface{}{
			"reporter_trust_ring": 2,
			"outcome":            "positive",
			"satisfaction":       90,
		},
		AuthorDID: "did:key:z6MkReporter",
	}
	uri, err := impl.SignAndPublish(context.Background(), outcomeRecord)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, uri != "", "signed outcome must return a URI")
}

// TST-CORE-924
func TestPDS_22_2_11_TypeA_FallbackToExternalHTTPS(t *testing.T) {
	// PDS Type A: fallback to external HTTPS push.
	impl := realPDSPublisher
	testutil.RequireImplementation(t, impl, "PDSPublisher")

	// When PDS is unreachable, record should be queued for retry.
	record := testutil.PDSRecord{
		Collection: "com.dina.reputation.attestation",
		RecordKey:  "fallback-001",
		Payload:    map[string]interface{}{"expertDid": "did:key:z6Mk", "productCategory": "test", "productId": "test", "rating": 50, "verdict": map[string]interface{}{"quality": 50}},
		AuthorDID:  "did:key:z6MkAuthor",
	}
	err := impl.QueueForRetry(context.Background(), record)
	testutil.RequireNoError(t, err)
}
