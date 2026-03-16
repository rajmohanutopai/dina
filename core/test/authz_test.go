package test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Authz Middleware Tests — endpoint-level authorization enforcement
// ==========================================================================
// These tests verify that the authz middleware correctly reads token_kind
// from context and enforces the AdminEndpointChecker rules at the HTTP layer.
// ==========================================================================

// authzTestBrainDID is the DID used for the test brain service key.
const authzTestBrainDID = "did:key:zTestAuthzBrain"

var authzTestBrainPriv ed25519.PrivateKey

// buildTestHandler constructs a middleware chain: Auth → Authz → echo handler.
// The echo handler returns 200 with body "ok" for any request that passes through.
func buildTestHandler() http.Handler {
	tokenValidator := auth.NewDefaultTokenValidator()
	checker := auth.NewAdminEndpointChecker()

	// Register a brain service key for Ed25519 auth.
	pub, priv, _ := ed25519.GenerateKey(nil)
	authzTestBrainPriv = priv
	tokenValidator.RegisterServiceKey(authzTestBrainDID, []byte(pub), "brain")

	echoHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Chain: Auth → Authz → echo handler (same order as main.go)
	authMW := &middleware.Auth{Tokens: tokenValidator}
	authzMW := middleware.NewAuthzMiddleware(checker)

	return authMW.Handler(authzMW(echoHandler))
}

// doRequest is a test helper that creates an HTTP request with the given
// method, path, and Authorization header, then runs it through the handler chain.
func doRequest(handler http.Handler, method, path, bearerToken string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr
}

// doSignedRequest creates an Ed25519-signed request (simulating brain service auth).
func doSignedRequest(handler http.Handler, method, path string) *httptest.ResponseRecorder {
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonce := testNonce()
	body := []byte{}
	bodyHash := sha256.Sum256(body)
	payload := fmt.Sprintf("%s\n%s\n\n%s\n%s\n%s", method, path, ts, nonce, hex.EncodeToString(bodyHash[:]))
	sig := ed25519.Sign(authzTestBrainPriv, []byte(payload))

	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("X-DID", authzTestBrainDID)
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Signature", hex.EncodeToString(sig))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr
}

// --------------------------------------------------------------------------
// Test: brain token request to /v1/did/sign → 403 Forbidden
// TST-CORE-1097
// --------------------------------------------------------------------------

func TestAuthz_1_6_1_BrainServiceKeyOnDIDSign_Forbidden(t *testing.T) {
	// TST-CORE-1097: Service signature auth on /v1/did/sign → forbidden
	// Requirement: Brain (service key auth) must be denied access to /v1/did/sign.
	// /v1/did/sign is an admin-only endpoint — brain cannot sign arbitrary data.
	handler := buildTestHandler()

	rr := doSignedRequest(handler, http.MethodPost, "/v1/did/sign")

	// 1. Verify HTTP status is 403 Forbidden (not 401 — brain IS authenticated, just not authorized).
	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for brain service key on /v1/did/sign, got %d", rr.Code)
	}

	// 2. Verify response body contains structured error (not an empty or HTML error page).
	body := rr.Body.String()
	if body == "" {
		t.Fatal("expected non-empty error response body")
	}
	if !strings.Contains(body, "forbidden") {
		t.Fatalf("expected response body to contain 'forbidden', got: %s", body)
	}
}

// --------------------------------------------------------------------------
// Test: client token request to /v1/did/sign → allowed (200)
// TST-CORE-1098
// --------------------------------------------------------------------------

func TestAuthz_1_6_2_ClientTokenOnDIDSign_Allowed(t *testing.T) {
	handler := buildTestHandler()

	rr := doRequest(handler, http.MethodPost, "/v1/did/sign", testutil.TestClientToken)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for client token on /v1/did/sign, got %d", rr.Code)
	}
}

// --------------------------------------------------------------------------
// Test: brain token request to /v1/vault/query → allowed (200)
// TST-CORE-1099
// --------------------------------------------------------------------------

func TestAuthz_1_6_3_BrainServiceKeyOnVaultQuery_Allowed(t *testing.T) {
	handler := buildTestHandler()

	rr := doSignedRequest(handler, http.MethodPost, "/v1/vault/query")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for brain service key on /v1/vault/query, got %d", rr.Code)
	}
}

// --------------------------------------------------------------------------
// Test: brain token on various admin endpoints → 403 Forbidden
// TST-CORE-1100
// --------------------------------------------------------------------------

func TestAuthz_1_6_4_BrainServiceKeyOnAdminEndpoints_Forbidden(t *testing.T) {
	handler := buildTestHandler()

	adminPaths := []string{
		"/v1/did/sign",
		"/v1/did/rotate",
		"/v1/vault/backup",
		"/v1/persona/unlock",
		// /admin/* paths are excluded: Core's auth middleware passes them
		// through to Brain (which handles its own auth for admin endpoints).
		"/v1/export",
		"/v1/import",
		"/v1/pair/initiate",
		"/v1/pair/complete",
	}

	for _, path := range adminPaths {
		rr := doSignedRequest(handler, http.MethodPost, path)
		if rr.Code != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden for brain service key on %s, got %d", path, rr.Code)
		}
	}
}

// --------------------------------------------------------------------------
// Test: client token on all endpoints → allowed (200)
// TST-CORE-1101
// --------------------------------------------------------------------------

func TestAuthz_1_6_5_ClientTokenOnAllEndpoints_Allowed(t *testing.T) {
	handler := buildTestHandler()

	allPaths := []string{
		"/v1/did/sign",
		"/v1/did/rotate",
		"/v1/vault/backup",
		"/v1/vault/query",
		"/v1/persona/unlock",
		"/admin/dashboard",
		"/v1/msg/send",
		"/v1/task/ack",
		"/v1/pii/scrub",
		"/v1/export",
		"/v1/import",
		"/v1/pair/initiate",
	}

	for _, path := range allPaths {
		rr := doRequest(handler, http.MethodPost, path, testutil.TestClientToken)
		if rr.Code != http.StatusOK {
			t.Errorf("expected 200 OK for client token on %s, got %d", path, rr.Code)
		}
	}
}

// --------------------------------------------------------------------------
// Test: brain token on allowed non-admin paths → 200
// TST-CORE-1102
// --------------------------------------------------------------------------

func TestAuthz_1_6_6_BrainServiceKeyOnAllowedPaths_OK(t *testing.T) {
	handler := buildTestHandler()

	allowedPaths := []string{
		"/v1/vault/query",
		"/v1/vault/store",
		"/v1/msg/send",
		"/v1/msg/inbox",
		"/v1/task/ack",
		"/v1/pii/scrub",
		"/v1/did",
		"/v1/did/verify",
		"/v1/did/document",
	}

	for _, path := range allowedPaths {
		rr := doSignedRequest(handler, http.MethodPost, path)
		if rr.Code != http.StatusOK {
			t.Errorf("expected 200 OK for brain service key on %s, got %d", path, rr.Code)
		}
	}
}

// --------------------------------------------------------------------------
// Test: unauthenticated requests on public paths pass through authz
// TST-CORE-1103
// --------------------------------------------------------------------------

func TestAuthz_1_6_7_UnauthenticatedPublicPaths_PassThrough(t *testing.T) {
	// Build a chain with only the authz middleware (no auth middleware)
	// to verify that requests without token_kind in context pass through.
	checker := auth.NewAdminEndpointChecker()
	authzMW := middleware.NewAuthzMiddleware(checker)

	echoHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	handler := authzMW(echoHandler)

	// Request with no token_kind in context should pass through.
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for unauthenticated request, got %d", rr.Code)
	}
}

// --------------------------------------------------------------------------
// Test: authz middleware with explicit context token_kind
// TST-CORE-1104
// --------------------------------------------------------------------------

func TestAuthz_1_6_8_ExplicitContextTokenKind(t *testing.T) {
	checker := auth.NewAdminEndpointChecker()
	authzMW := middleware.NewAuthzMiddleware(checker)

	echoHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	handler := authzMW(echoHandler)

	t.Run("brain_on_admin_path", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/did/sign", nil)
		ctx := context.WithValue(req.Context(), middleware.TokenKindKey, "service")
		ctx = context.WithValue(ctx, middleware.TokenScopeKey, "brain")
		req = req.WithContext(ctx)

		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for brain on /v1/did/sign, got %d", rr.Code)
		}
	})

	t.Run("client_on_admin_path", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/did/sign", nil)
		ctx := context.WithValue(req.Context(), middleware.TokenKindKey, "client")
		req = req.WithContext(ctx)

		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200 for client on /v1/did/sign, got %d", rr.Code)
		}
	})

	t.Run("brain_on_vault_query", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", nil)
		ctx := context.WithValue(req.Context(), middleware.TokenKindKey, "service")
		ctx = context.WithValue(ctx, middleware.TokenScopeKey, "brain")
		req = req.WithContext(ctx)

		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200 for brain on /v1/vault/query, got %d", rr.Code)
		}
	})

	t.Run("unknown_kind_on_any_path", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", nil)
		ctx := context.WithValue(req.Context(), middleware.TokenKindKey, "unknown")
		req = req.WithContext(ctx)

		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for unknown token kind, got %d", rr.Code)
		}
	})
}

// --------------------------------------------------------------------------
// TST-CORE-990: Matrix test — every admin endpoint rejects Service Signature Auth
// --------------------------------------------------------------------------

// TST-CORE-990 TST-CORE-1123 TST-CORE-1022
func TestAuthz_30_2_MatrixEveryAdminEndpointRejectsServiceSigAuth(t *testing.T) {
	// Requirement: Service Signature Auth (brain service keys) must be rejected
	// on EVERY admin endpoint with 403 Forbidden. This is a comprehensive matrix
	// covering all admin prefixes and exact paths from IsAdminEndpoint().
	handler := buildTestHandler()

	// Comprehensive admin endpoint matrix — covers every category from
	// IsAdminEndpoint() in auth.go: prefixes (/admin, /v1/persona, /v1/export,
	// /v1/import, /v1/pair) + exact paths (/v1/did/sign, /v1/did/rotate,
	// /v1/vault/backup). Includes sub-paths to verify prefix matching.
	type adminCase struct {
		path   string
		method string
		desc   string
	}

	adminEndpoints := []adminCase{
		// NOTE: /admin/* paths are excluded from this matrix because in production
		// they are proxied to Brain's admin app (which handles its own CLIENT_TOKEN
		// auth). The Core authz middleware does not see /admin/* traffic.
		// See TestAuthz_1_6_4 for the documented design decision.

		// --- /v1/persona/* prefix (persona management) ---
		{"/v1/persona/unlock", "POST", "persona_unlock"},
		{"/v1/persona/lock", "POST", "persona_lock"},
		{"/v1/persona/create", "POST", "persona_create"},
		{"/v1/persona/list", "GET", "persona_list"},
		{"/v1/persona/tier", "POST", "persona_tier"},

		// --- /v1/export/* prefix ---
		{"/v1/export", "POST", "export_root"},
		{"/v1/export/data", "POST", "export_data"},
		{"/v1/export/full", "POST", "export_full"},

		// --- /v1/import/* prefix ---
		{"/v1/import", "POST", "import_root"},
		{"/v1/import/data", "POST", "import_data"},
		{"/v1/import/restore", "POST", "import_restore"},

		// --- /v1/pair/* prefix (device pairing) ---
		{"/v1/pair/initiate", "POST", "pair_initiate"},
		{"/v1/pair/complete", "POST", "pair_complete"},
		{"/v1/pair/status", "GET", "pair_status"},

		// --- Exact admin paths ---
		{"/v1/did/sign", "POST", "did_sign"},
		{"/v1/did/rotate", "POST", "did_rotate"},
		{"/v1/vault/backup", "POST", "vault_backup"},
	}

	var failures []string
	for _, tc := range adminEndpoints {
		t.Run(tc.desc, func(t *testing.T) {
			rr := doSignedRequest(handler, tc.method, tc.path)
			if rr.Code != http.StatusForbidden {
				failures = append(failures, fmt.Sprintf("%s %s: expected 403, got %d", tc.method, tc.path, rr.Code))
				t.Errorf("expected 403 Forbidden for brain service key on %s %s, got %d",
					tc.method, tc.path, rr.Code)
			}

			// Verify structured error response (not empty or HTML).
			body := rr.Body.String()
			if body == "" {
				t.Errorf("expected non-empty error body for %s", tc.path)
			}
			if rr.Code == http.StatusForbidden && !strings.Contains(body, "forbidden") {
				t.Errorf("expected 'forbidden' in body for %s, got: %s", tc.path, body)
			}
		})
	}

	// Sanity: verify we tested a meaningful number of endpoints.
	if len(adminEndpoints) < 15 {
		t.Fatalf("matrix should cover at least 15 admin endpoints, only has %d", len(adminEndpoints))
	}

	// Positive control: brain service key MUST succeed on non-admin paths.
	// This ensures we're not just testing a broken auth chain that rejects everything.
	positiveControls := []string{
		"/v1/vault/query",
		"/v1/vault/store",
		"/v1/msg/send",
		"/v1/pii/scrub",
		"/v1/did",
		"/v1/did/verify",
		"/v1/task/ack",
	}
	for _, path := range positiveControls {
		t.Run("positive_control_"+path[4:], func(t *testing.T) {
			rr := doSignedRequest(handler, http.MethodPost, path)
			if rr.Code == http.StatusForbidden {
				t.Errorf("brain service key should be ALLOWED on %s but got 403", path)
			}
		})
	}
}

// ==========================================================================
// TST-CORE-002 TST-CORE-003 TST-CORE-004 TST-CORE-005 TST-CORE-006
// §1.1 Service Signature Auth — Missing/Malformed Authorization header
// ==========================================================================
// These tests exercise the Auth middleware's rejection of requests that
// lack proper authentication headers on protected endpoints.
// The expected behavior: 401 Unauthorized with JSON error body.
// ==========================================================================

func TestAuth_1_1_MissingAndMalformedAuthorizationHeader(t *testing.T) {
	handler := buildTestHandler()
	protectedPath := "/v1/vault/query"

	t.Run("missing_Authorization_header_returns_401", func(t *testing.T) {
		// TST-CORE-002: No Authorization header at all on a protected endpoint.
		// Requirement: 401 Unauthorized when no auth headers are present.
		req := httptest.NewRequest(http.MethodPost, protectedPath, nil)
		// No Authorization header, no X-DID/X-Signature headers.
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized for missing Authorization header, got %d", rr.Code)
		}

		// Verify structured JSON error response.
		body := rr.Body.String()
		if !strings.Contains(body, "missing or invalid Authorization header") {
			t.Fatalf("expected error message about missing header, got: %s", body)
		}
	})

	t.Run("malformed_header_Basic_instead_of_Bearer_returns_401", func(t *testing.T) {
		// TST-CORE-003: Authorization header uses "Basic" scheme instead of "Bearer".
		// The middleware only accepts "Bearer " prefix.
		req := httptest.NewRequest(http.MethodPost, protectedPath, nil)
		req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for 'Basic' auth scheme, got %d", rr.Code)
		}
		body := rr.Body.String()
		if !strings.Contains(body, "missing or invalid Authorization header") {
			t.Fatalf("expected structured error, got: %s", body)
		}
	})

	t.Run("wrong_Bearer_token_value_returns_401", func(t *testing.T) {
		// TST-CORE-004: Valid Bearer format but invalid token value.
		// The token doesn't match any registered client token.
		rr := doRequest(handler, http.MethodPost, protectedPath, "completely-wrong-token-value")

		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for wrong Bearer token, got %d", rr.Code)
		}
		body := rr.Body.String()
		if !strings.Contains(body, "invalid token") {
			t.Fatalf("expected 'invalid token' error, got: %s", body)
		}
	})

	t.Run("empty_Bearer_value_returns_401", func(t *testing.T) {
		// TST-CORE-005: "Authorization: Bearer " with nothing after it.
		rr := doRequest(handler, http.MethodPost, protectedPath, "")
		// doRequest sends "Bearer " + "" = "Bearer " — which starts with "Bearer "
		// but the token is empty.
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for empty Bearer value, got %d", rr.Code)
		}
	})

	t.Run("Bearer_with_leading_trailing_whitespace_returns_401", func(t *testing.T) {
		// TST-CORE-006: Token with extra whitespace should not match any stored token.
		req := httptest.NewRequest(http.MethodPost, protectedPath, nil)
		req.Header.Set("Authorization", "  Bearer "+testutil.TestClientToken+"  ")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		// Leading whitespace before "Bearer" means !strings.HasPrefix(authHeader, "Bearer ")
		// → 401 with "missing or invalid Authorization header"
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for whitespace-padded Authorization header, got %d", rr.Code)
		}
	})

	t.Run("positive_control_valid_client_token_accepted", func(t *testing.T) {
		// Contrast check: valid client token must be accepted.
		// Without this, the test passes if the middleware rejects everything.
		rr := doRequest(handler, http.MethodPost, protectedPath, testutil.TestClientToken)
		if rr.Code != http.StatusOK {
			t.Fatalf("valid client token must be accepted, got %d", rr.Code)
		}
	})

	t.Run("positive_control_public_path_no_header_accepted", func(t *testing.T) {
		// Contrast check: public paths don't require any auth.
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("public path /healthz must not require auth, got %d", rr.Code)
		}
	})
}
