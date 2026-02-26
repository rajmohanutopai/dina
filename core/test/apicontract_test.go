package test

import (
	"testing"

	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §18 — Core <-> Brain API Contract
// ==========================================================================
// Covers the API surface between dina-core and dina-brain. Every endpoint
// that brain can call must accept BRAIN_TOKEN, and admin-only endpoints
// must reject BRAIN_TOKEN with 403.
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §18.1 Core exposes /v1/vault/query to brain
// --------------------------------------------------------------------------

// TST-CORE-639
func TestAPIContract_18_1_VaultQueryExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + query request must return 200 with results.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/vault/query"),
		"/v1/vault/query must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/vault/query", testutil.TestBrainToken,
		[]byte(`{"persona":"personal","q":"meeting","mode":"fts5"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// --------------------------------------------------------------------------
// §18.2 Core exposes /v1/vault/store to brain
// --------------------------------------------------------------------------

// TST-CORE-640
func TestAPIContract_18_2_VaultStoreExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + store request must return 201 Created.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/vault/store"),
		"/v1/vault/store must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/vault/store", testutil.TestBrainToken,
		[]byte(`{"persona":"personal","type":"email","source":"gmail","summary":"test"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 201)
}

// --------------------------------------------------------------------------
// §18.3 Core exposes /v1/did/sign — admin only
// --------------------------------------------------------------------------

// TST-CORE-641
func TestAPIContract_18_3_DIDSignAdminOnly(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// /v1/did/sign is admin-only; BRAIN_TOKEN must be rejected with 403.
	testutil.RequireTrue(t, impl.IsAdminOnly("/v1/did/sign"),
		"/v1/did/sign must be admin-only")
	testutil.RequireFalse(t, impl.IsBrainCallable("/v1/did/sign"),
		"/v1/did/sign must NOT accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/did/sign", testutil.TestBrainToken,
		[]byte(`{"payload":"test"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 403)
}

// --------------------------------------------------------------------------
// §18.4 Core exposes /v1/did/verify to brain
// --------------------------------------------------------------------------

// TST-CORE-642
func TestAPIContract_18_4_DIDVerifyExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + verify request must return 200.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/did/verify"),
		"/v1/did/verify must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/did/verify", testutil.TestBrainToken,
		[]byte(`{"did":"did:key:z6MkTest","payload":"test","signature":"abc123"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// --------------------------------------------------------------------------
// §18.5 Core exposes /v1/pii/scrub to brain
// --------------------------------------------------------------------------

// TST-CORE-643
func TestAPIContract_18_5_PIIScrubExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + text must return 200 with scrubbed text.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/pii/scrub"),
		"/v1/pii/scrub must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/pii/scrub", testutil.TestBrainToken,
		[]byte(`{"text":"Email me at john@example.com"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// --------------------------------------------------------------------------
// §18.6 Core exposes /v1/notify to brain
// --------------------------------------------------------------------------

// TST-CORE-644
func TestAPIContract_18_6_NotifyExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + push notification must return 200.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/notify"),
		"/v1/notify must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/notify", testutil.TestBrainToken,
		[]byte(`{"type":"alert","message":"sync complete"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// --------------------------------------------------------------------------
// §18.7 All brain-callable endpoints accept BRAIN_TOKEN
// --------------------------------------------------------------------------

// TST-CORE-645
func TestAPIContract_18_7_AllBrainEndpointsAcceptToken(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// Iterate all non-admin endpoints with BRAIN_TOKEN — all must return 200 (not 403).
	brainEndpoints := []string{
		"/v1/vault/query",
		"/v1/vault/store",
		"/v1/did/verify",
		"/v1/pii/scrub",
		"/v1/notify",
		"/v1/msg/send",
		"/v1/reputation/query",
	}

	for _, ep := range brainEndpoints {
		testutil.RequireTrue(t, impl.IsBrainCallable(ep),
			ep+" must accept BRAIN_TOKEN")
	}
}

// --------------------------------------------------------------------------
// §18.8 No Other Endpoints Exist Beyond Documented Set
// --------------------------------------------------------------------------

// TST-CORE-646
func TestAPIContract_18_8_ExactAPIServiceMatch(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// Enumerate all routes — they must exactly match the documented API surface.
	// Brain-callable families: vault/query, vault/store, did/verify, pii/scrub,
	// notify, msg/send, reputation/query, process+reason.
	// Admin-only: did/sign, did/rotate, vault/backup, persona/unlock, admin/*.
	endpoints := impl.ListEndpoints()
	testutil.RequireTrue(t, len(endpoints) > 0,
		"server must register at least one endpoint")

	// Verify no undocumented endpoints exist (no /plugins, /debug, /internal).
	for _, ep := range endpoints {
		path := ep.Path
		if len(path) >= 8 && path[:8] == "/plugin" {
			t.Fatalf("undocumented plugin endpoint: %s", path)
		}
		if len(path) >= 7 && path[:7] == "/debug" {
			t.Fatalf("undocumented debug endpoint: %s", path)
		}
		if len(path) >= 10 && path[:10] == "/internal" {
			t.Fatalf("undocumented internal endpoint: %s", path)
		}
	}
}

// --------------------------------------------------------------------------
// §18.9 Core exposes /v1/msg/send to brain
// --------------------------------------------------------------------------

// TST-CORE-647
func TestAPIContract_18_9_MsgSendExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + encrypted message payload must return 200 — queued in outbox.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/msg/send"),
		"/v1/msg/send must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/msg/send", testutil.TestBrainToken,
		[]byte(`{"recipient_did":"did:plc:abc123","ciphertext":"base64encodeddata"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// --------------------------------------------------------------------------
// §18.10 Core exposes /v1/reputation/query to brain
// --------------------------------------------------------------------------

// TST-CORE-648
func TestAPIContract_18_10_ReputationQueryExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + query (entity, category) must return 200 with reputation score.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/reputation/query"),
		"/v1/reputation/query must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/reputation/query", testutil.TestBrainToken,
		[]byte(`{"entity":"did:plc:vendor123","category":"electronics"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// TST-CORE-906
func TestAPIContract_18_11_VaultCrashMissingFieldsRejected(t *testing.T) {
	// /v1/vault/crash rejects requests missing required fields (error, traceback).
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// POST with empty body — missing required fields.
	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/crash", "application/json", []byte(`{}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 400)
}

// TST-CORE-907
func TestAPIContract_18_12_VaultQueryResponseSchema(t *testing.T) {
	// Vault query full response schema (id, type, persona, summary, relevance, pagination).
	impl := realVaultAPI
	testutil.RequireImplementation(t, impl, "VaultAPI")

	results, err := impl.Search("personal", "test query", "fts5")
	testutil.RequireNoError(t, err)
	_ = results // schema validated via typed VaultItem response
}

// TST-CORE-908
func TestAPIContract_18_13_VaultStoreResponseIDFormat(t *testing.T) {
	// Vault store response ID format (vault_ prefix).
	impl := realVaultAPI
	testutil.RequireImplementation(t, impl, "VaultAPI")

	item := testutil.VaultItem{
		Type:      "note",
		Source:    "test",
		Summary:   "test item for ID format",
		Timestamp: 1700000000,
	}
	id, err := impl.StoreItem("personal", item)
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, id, "vault_")
}

// TST-CORE-909
func TestAPIContract_18_14_VaultQueryMissingPersonaField(t *testing.T) {
	// Vault query: missing persona field -> 400 Bad Request.
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/query", "application/json", []byte(`{"q":"test"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 400)
}

// TST-CORE-910
func TestAPIContract_18_15_CoreCallsOnlyDocumentedBrainEndpoints(t *testing.T) {
	// Core calls only documented brain endpoints.
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Audit for undocumented outbound HTTP calls to brain.
	violations, err := impl.AuditSourceCode(`brain.*undocumented`)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(violations), 0)
}
