package test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	body := []byte{}
	bodyHash := sha256.Sum256(body)
	payload := fmt.Sprintf("%s\n%s\n\n%s\n%s", method, path, ts, hex.EncodeToString(bodyHash[:]))
	sig := ed25519.Sign(authzTestBrainPriv, []byte(payload))

	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("X-DID", authzTestBrainDID)
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Signature", hex.EncodeToString(sig))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr
}

// --------------------------------------------------------------------------
// Test: brain token request to /v1/did/sign → 403 Forbidden
// --------------------------------------------------------------------------

func TestAuthz_1_6_1_BrainServiceKeyOnDIDSign_Forbidden(t *testing.T) {
	handler := buildTestHandler()

	rr := doSignedRequest(handler, http.MethodPost, "/v1/did/sign")

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for brain service key on /v1/did/sign, got %d", rr.Code)
	}
}

// --------------------------------------------------------------------------
// Test: client token request to /v1/did/sign → allowed (200)
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
		ctx := context.WithValue(req.Context(), middleware.TokenKindKey, "brain")
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
		ctx := context.WithValue(req.Context(), middleware.TokenKindKey, "brain")
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
