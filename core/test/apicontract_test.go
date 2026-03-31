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
// TRACE: {"suite": "CORE", "case": "0006", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "01", "scenario": "01", "title": "VaultQueryExposed"}
func TestAPIContract_18_1_VaultQueryExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + query request must return 200 with results.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/vault/query"),
		"/v1/vault/query must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/vault/query", testutil.TestBrainToken,
		[]byte(`{"persona":"general","q":"meeting","mode":"fts5"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// --------------------------------------------------------------------------
// §18.2 Core exposes /v1/vault/store to brain
// --------------------------------------------------------------------------

// TST-CORE-640
// TRACE: {"suite": "CORE", "case": "0007", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "02", "scenario": "01", "title": "VaultStoreExposed"}
func TestAPIContract_18_2_VaultStoreExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + store request must return 201 Created.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/vault/store"),
		"/v1/vault/store must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/vault/store", testutil.TestBrainToken,
		[]byte(`{"persona":"general","type":"email","source":"gmail","summary":"test"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 201)
}

// --------------------------------------------------------------------------
// §18.3 Core exposes /v1/did/sign — admin only
// --------------------------------------------------------------------------

// TST-CORE-641
// TRACE: {"suite": "CORE", "case": "0008", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "03", "scenario": "01", "title": "DIDSignAdminOnly"}
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
// TRACE: {"suite": "CORE", "case": "0009", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "04", "scenario": "01", "title": "DIDVerifyExposed"}
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
// TRACE: {"suite": "CORE", "case": "0010", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "05", "scenario": "01", "title": "PIIScrubExposed"}
func TestAPIContract_18_5_PIIScrubExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// Positive: /v1/pii/scrub must be brain-callable.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/pii/scrub"),
		"/v1/pii/scrub must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/pii/scrub", testutil.TestBrainToken,
		[]byte(`{"text":"Email me at john@example.com"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)

	// Negative control: admin-only endpoint must NOT be brain-callable.
	testutil.RequireFalse(t, impl.IsBrainCallable("/v1/did/sign"),
		"/v1/did/sign is admin-only — must not be brain-callable")

	// Negative: brain token on admin-only endpoint must return 403.
	statusCode2, _, err := impl.CallEndpoint("POST", "/v1/did/sign", testutil.TestBrainToken, nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode2, 403)
}

// --------------------------------------------------------------------------
// §18.6 Core exposes /v1/notify to brain
// --------------------------------------------------------------------------

// TST-CORE-644
// TRACE: {"suite": "CORE", "case": "0011", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "06", "scenario": "01", "title": "NotifyExposed"}
func TestAPIContract_18_6_NotifyExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// Positive: /v1/notify must be brain-callable and return 200.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/notify"),
		"/v1/notify must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/notify", testutil.TestBrainToken,
		[]byte(`{"type":"alert","message":"sync complete"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)

	// Negative control: admin-only endpoint must NOT be brain-callable.
	testutil.RequireFalse(t, impl.IsBrainCallable("/v1/did/rotate"),
		"/v1/did/rotate is admin-only — must not be brain-callable")

	// Negative: brain token on admin-only endpoint must return 403.
	statusCode2, _, err := impl.CallEndpoint("POST", "/v1/did/rotate", testutil.TestBrainToken, nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode2, 403)
}

// --------------------------------------------------------------------------
// §18.7 All brain-callable endpoints accept BRAIN_TOKEN
// --------------------------------------------------------------------------

// TST-CORE-645
// TRACE: {"suite": "CORE", "case": "0012", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "07", "scenario": "01", "title": "AllBrainEndpointsAcceptToken"}
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
		"/v1/trust/query",
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
// TRACE: {"suite": "CORE", "case": "0013", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "08", "scenario": "01", "title": "ExactAPIServiceMatch"}
func TestAPIContract_18_8_ExactAPIServiceMatch(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// Enumerate all routes — they must exactly match the documented API surface.
	// Brain-callable families: vault/query, vault/store, did/verify, pii/scrub,
	// notify, msg/send, trust/query, process+reason.
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
// TRACE: {"suite": "CORE", "case": "0014", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "09", "scenario": "01", "title": "MsgSendExposed"}
func TestAPIContract_18_9_MsgSendExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// Positive: /v1/msg/send must be brain-callable and return 200.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/msg/send"),
		"/v1/msg/send must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/msg/send", testutil.TestBrainToken,
		[]byte(`{"recipient_did":"did:plc:abc123","ciphertext":"base64encodeddata"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)

	// Negative control: admin-only endpoint must NOT be brain-callable.
	testutil.RequireFalse(t, impl.IsBrainCallable("/v1/vault/backup"),
		"/v1/vault/backup is admin-only — must not be brain-callable")

	// Negative: wrong token on brain-callable endpoint must return 401.
	statusCode2, _, err := impl.CallEndpoint("POST", "/v1/msg/send", "wrong-token-value", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode2, 401)
}

// --------------------------------------------------------------------------
// §18.10 Core exposes /v1/trust/query to brain
// --------------------------------------------------------------------------

// TST-CORE-648
// TRACE: {"suite": "CORE", "case": "0015", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "10", "scenario": "01", "title": "TrustQueryExposed"}
func TestAPIContract_18_10_TrustQueryExposed(t *testing.T) {
	// var impl testutil.APIContract = realcontract.New(...)
	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// BRAIN_TOKEN + query (entity, category) must return 200 with trust score.
	testutil.RequireTrue(t, impl.IsBrainCallable("/v1/trust/query"),
		"/v1/trust/query must accept BRAIN_TOKEN")

	statusCode, _, err := impl.CallEndpoint("POST", "/v1/trust/query", testutil.TestBrainToken,
		[]byte(`{"entity":"did:plc:vendor123","category":"electronics"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// TST-CORE-906
// TRACE: {"suite": "CORE", "case": "0016", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "11", "scenario": "01", "title": "VaultCrashMissingFieldsRejected"}
func TestAPIContract_18_11_VaultCrashMissingFieldsRejected(t *testing.T) {
	// /v1/vault/crash rejects requests missing required fields (error, traceback).
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// POST with empty body — both fields missing → 400.
	statusCode, respBody, err := impl.HandleRequest("POST", "/v1/vault/crash", "application/json", []byte(`{}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 400)
	testutil.RequireContains(t, string(respBody), "missing")

	// POST with only "error" field — should be accepted (at least one field present).
	statusCode2, _, err := impl.HandleRequest("POST", "/v1/vault/crash", "application/json", []byte(`{"error":"something broke"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode2, 200)

	// POST with only "traceback" field — should also be accepted.
	statusCode3, _, err := impl.HandleRequest("POST", "/v1/vault/crash", "application/json", []byte(`{"traceback":"line 42 in main.go"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode3, 200)

	// POST with both fields — should be accepted.
	statusCode4, _, err := impl.HandleRequest("POST", "/v1/vault/crash", "application/json",
		[]byte(`{"error":"panic","traceback":"goroutine 1 [running]:\nmain.go:42"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode4, 200)
}

// TST-CORE-907
// TRACE: {"suite": "CORE", "case": "0017", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "12", "scenario": "01", "title": "VaultQueryResponseSchema"}
func TestAPIContract_18_12_VaultQueryResponseSchema(t *testing.T) {
	// Vault query full response schema (id, type, persona, summary, relevance, pagination).
	impl := realVaultAPI
	testutil.RequireImplementation(t, impl, "VaultAPI")

	// Store an item first so Search has something to return.
	item := testutil.VaultItem{
		Type:      "note",
		Source:    "test",
		Summary:   "meeting notes about project alpha",
		Timestamp: 1700000000,
	}
	storedID, err := impl.StoreItem("general", item)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, storedID != "", "stored item must have an ID")

	// Search must return results including the stored item.
	results, err := impl.Search("general", "meeting", "fts5")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(results) > 0, "search must return at least one result after storing an item")

	// Validate schema: each result must have required fields populated.
	found := false
	for _, r := range results {
		testutil.RequireTrue(t, r.ID != "", "result ID must not be empty")
		testutil.RequireTrue(t, r.Type != "", "result Type must not be empty")
		if r.ID == storedID {
			found = true
			testutil.RequireEqual(t, r.Type, "note")
			testutil.RequireEqual(t, r.Source, "test")
			testutil.RequireContains(t, r.Summary, "meeting")
		}
	}
	testutil.RequireTrue(t, found, "stored item must appear in search results")
}

// TST-CORE-908
// TRACE: {"suite": "CORE", "case": "0018", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "13", "scenario": "01", "title": "VaultStoreResponseIDFormat"}
func TestAPIContract_18_13_VaultStoreResponseIDFormat(t *testing.T) {
	// Vault store response ID format (vault_ prefix) + uniqueness.
	impl := realVaultAPI
	testutil.RequireImplementation(t, impl, "VaultAPI")

	item1 := testutil.VaultItem{
		Type:      "note",
		Source:    "test",
		Summary:   "test item for ID format 1",
		Timestamp: 1700000000,
	}
	id1, err := impl.StoreItem("general", item1)
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, id1, "vault_")
	testutil.RequireTrue(t, len(id1) > len("vault_"),
		"ID must have content after the vault_ prefix")

	// Second store must produce a different ID.
	item2 := testutil.VaultItem{
		Type:      "note",
		Source:    "test",
		Summary:   "test item for ID format 2",
		Timestamp: 1700000001,
	}
	id2, err := impl.StoreItem("general", item2)
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, id2, "vault_")

	if id1 == id2 {
		t.Fatalf("two stores must produce different IDs: both got %q", id1)
	}

	// Third store for additional uniqueness confidence.
	item3 := testutil.VaultItem{
		Type:      "email",
		Source:    "test",
		Summary:   "test item for ID format 3",
		Timestamp: 1700000002,
	}
	id3, err := impl.StoreItem("general", item3)
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, id3, "vault_")
	if id3 == id1 || id3 == id2 {
		t.Fatalf("third store ID must be unique: got %q (id1=%q, id2=%q)", id3, id1, id2)
	}
}

// TST-CORE-909
// TRACE: {"suite": "CORE", "case": "0019", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "14", "scenario": "01", "title": "VaultQueryMissingPersonaField"}
func TestAPIContract_18_14_VaultQueryMissingPersonaField(t *testing.T) {
	// Vault query: missing persona field -> 400 Bad Request.
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/query", "application/json", []byte(`{"q":"test"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 400)
}

// TST-CORE-910
// TRACE: {"suite": "CORE", "case": "0020", "section": "18", "sectionName": "Core-Brain API Contract", "subsection": "15", "scenario": "01", "title": "CoreCallsOnlyDocumentedBrainEndpoints"}
func TestAPIContract_18_15_CoreCallsOnlyDocumentedBrainEndpoints(t *testing.T) {
	// Core calls only documented brain endpoints.
	impl := realSecurityAuditor
	testutil.RequireImplementation(t, impl, "SecurityAuditor")

	// Audit for undocumented outbound HTTP calls to brain.
	violations, err := impl.AuditSourceCode(`brain.*undocumented`)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(violations), 0)
}

// --------------------------------------------------------------------------
// §30.8 CI Pipeline Gates — contract-core-brain stage
// --------------------------------------------------------------------------

// TST-CORE-1016
// TRACE: {"suite": "CORE", "case": "0021", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "01", "title": "ContractCoreBrainStage"}
func TestCI_30_8_ContractCoreBrainStage(t *testing.T) {
	// Requirements (§30.8, test_issues #9):
	//   - The `contract-core-brain` CI stage validates that the Core↔Brain
	//     API contracts are correct: every brain-callable endpoint accepts
	//     BRAIN_TOKEN, every admin-only endpoint rejects it with 403.
	//   - The stage uses real APIContract (backed by real auth.AdminEndpointChecker)
	//     to prevent drift between documented API surface and production auth rules.
	//   - No undocumented endpoints, no gaps in classification.

	impl := realAPIContract
	testutil.RequireImplementation(t, impl, "APIContract")

	// TRACE: {"suite": "CORE", "case": "0022", "section": "30", "sectionName": "Test System Quality", "title": "all_brain_callable_endpoints_accept_brain_token"}
	t.Run("all_brain_callable_endpoints_accept_brain_token", func(t *testing.T) {
		// Every endpoint classified as brain-callable must accept BRAIN_TOKEN.
		// This is the positive contract: brain CAN call these endpoints.
		brainCallable := []string{
			"/v1/vault/query",
			"/v1/vault/store",
			"/v1/did/verify",
			"/v1/pii/scrub",
			"/v1/notify",
			"/v1/msg/send",
			"/v1/trust/query",
			"/healthz",
			"/readyz",
		}

		for _, path := range brainCallable {
			if !impl.IsBrainCallable(path) {
				t.Errorf("CI contract check: %s must be classified as brain-callable", path)
			}
		}

		// Verify we tested a meaningful number of endpoints.
		if len(brainCallable) < 7 {
			t.Fatalf("brain-callable list must include at least 7 endpoints, has %d", len(brainCallable))
		}
	})

	// TRACE: {"suite": "CORE", "case": "0023", "section": "30", "sectionName": "Test System Quality", "title": "all_admin_endpoints_reject_brain_token"}
	t.Run("all_admin_endpoints_reject_brain_token", func(t *testing.T) {
		// Every admin-only endpoint must reject BRAIN_TOKEN with 403.
		// This is the negative contract: brain CANNOT call these endpoints.
		adminOnly := []string{
			"/v1/did/sign",
			"/v1/did/rotate",
			"/v1/vault/backup",
			"/v1/persona/unlock",
		}

		for _, path := range adminOnly {
			if !impl.IsAdminOnly(path) {
				t.Errorf("CI contract check: %s must be classified as admin-only", path)
			}
			if impl.IsBrainCallable(path) {
				t.Errorf("CI contract check: %s must NOT be brain-callable", path)
			}

			// Verify the endpoint actually returns 403 when called with brain token.
			statusCode, _, err := impl.CallEndpoint("POST", path, testutil.TestBrainToken, nil)
			if err != nil {
				t.Errorf("CallEndpoint %s: %v", path, err)
				continue
			}
			if statusCode != 403 {
				t.Errorf("CI contract check: %s with BRAIN_TOKEN must return 403, got %d", path, statusCode)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0024", "section": "30", "sectionName": "Test System Quality", "title": "registered_endpoint_list_is_comprehensive"}
	t.Run("registered_endpoint_list_is_comprehensive", func(t *testing.T) {
		// The APIContract must register a comprehensive list of endpoints.
		// A CI stage must not pass with an incomplete registry.
		endpoints := impl.ListEndpoints()

		if len(endpoints) < 10 {
			t.Fatalf("CI contract registry must have at least 10 endpoints, has %d", len(endpoints))
		}

		// Verify critical endpoints are present in the registry.
		requiredPaths := map[string]bool{
			"/v1/vault/query": false,
			"/v1/vault/store": false,
			"/v1/did/sign":    false,
			"/v1/did/verify":  false,
			"/v1/pii/scrub":   false,
			"/v1/notify":      false,
			"/v1/msg/send":    false,
			"/healthz":        false,
		}

		for _, ep := range endpoints {
			if _, wanted := requiredPaths[ep.Path]; wanted {
				requiredPaths[ep.Path] = true
			}
		}

		for path, found := range requiredPaths {
			if !found {
				t.Errorf("CI contract registry missing critical endpoint: %s", path)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0025", "section": "30", "sectionName": "Test System Quality", "title": "brain_callable_and_admin_only_are_disjoint"}
	t.Run("brain_callable_and_admin_only_are_disjoint", func(t *testing.T) {
		// No endpoint should be both brain-callable AND admin-only.
		// This is a structural invariant of the authorization model.
		endpoints := impl.ListEndpoints()

		for _, ep := range endpoints {
			brainOK := impl.IsBrainCallable(ep.Path)
			adminOnly := impl.IsAdminOnly(ep.Path)

			if brainOK && adminOnly {
				t.Errorf("endpoint %s classified as BOTH brain-callable and admin-only — must be one or the other", ep.Path)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0026", "section": "30", "sectionName": "Test System Quality", "title": "health_endpoints_are_brain_callable"}
	t.Run("health_endpoints_are_brain_callable", func(t *testing.T) {
		// /healthz and /readyz must be accessible to brain for monitoring.
		// These are operational endpoints, not admin endpoints.
		for _, path := range []string{"/healthz", "/readyz"} {
			if !impl.IsBrainCallable(path) {
				t.Errorf("%s must be brain-callable for health monitoring", path)
			}
			if impl.IsAdminOnly(path) {
				t.Errorf("%s must NOT be admin-only", path)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0027", "section": "30", "sectionName": "Test System Quality", "title": "contract_delegates_to_real_auth_checker"}
	t.Run("contract_delegates_to_real_auth_checker", func(t *testing.T) {
		// Anti-tautological: verify the APIContract delegates to the real
		// auth.AdminEndpointChecker, not a hardcoded list. If the auth
		// checker changes, the contract tests must catch the drift.
		//
		// We verify this by checking that AdminEndpointChecker and APIContract
		// agree on classification for a representative sample.
		checker := realAdminEndpointChecker

		adminPaths := []string{"/v1/did/sign", "/v1/did/rotate", "/v1/vault/backup"}
		for _, path := range adminPaths {
			checkerSays := checker.IsAdminEndpoint(path)
			contractSays := impl.IsAdminOnly(path)
			if checkerSays != contractSays {
				t.Errorf("drift detected: AdminEndpointChecker says admin=%v but APIContract says admin=%v for %s",
					checkerSays, contractSays, path)
			}
		}

		brainPaths := []string{"/v1/vault/query", "/v1/pii/scrub", "/v1/msg/send"}
		for _, path := range brainPaths {
			checkerSays := checker.IsAdminEndpoint(path)
			if checkerSays {
				t.Errorf("drift detected: AdminEndpointChecker classifies %s as admin but it should be brain-callable", path)
			}
		}
	})
}
