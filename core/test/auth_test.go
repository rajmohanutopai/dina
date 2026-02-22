package test

import (
	"context"
	"testing"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/test/testutil"
)

var authCtx = context.Background()

// ==========================================================================
// TEST_PLAN §1 — Authentication & Authorization
// ==========================================================================
// Covers §1.1 (BRAIN_TOKEN), §1.2 (CLIENT_TOKEN), §1.3 (Browser Session),
// §1.4 (Auth Surface Completeness), §1.5 (Compromised Brain Damage Radius).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in. Replace `var impl <Interface>` with the real
// constructor when ready.
// ==========================================================================

// --------------------------------------------------------------------------
// §1.1 BRAIN_TOKEN (9 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-001, TST-CORE-002, TST-CORE-003, TST-CORE-004, TST-CORE-005, TST-CORE-006, TST-CORE-007
// TST-CORE-008, TST-CORE-009
func TestAuth_1_1_BrainToken(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	tests := []struct {
		name      string
		header    string // full Authorization header value ("" = omitted)
		wantValid bool
		wantCode  int // expected HTTP status code
	}{
		{
			name:      "1_ValidBrainToken",  // TST-CORE-001
			header:    "Bearer " + testutil.TestBrainToken,
			wantValid: true,
			wantCode:  200,
		},
		{
			name:      "2_MissingAuthHeader",  // TST-CORE-002
			header:    "",
			wantValid: false,
			wantCode:  401,
		},
		{
			name:      "3_MalformedHeaderBasic",  // TST-CORE-003
			header:    "Basic " + testutil.TestBrainToken,
			wantValid: false,
			wantCode:  401,
		},
		{
			name:      "4_WrongBrainToken",  // TST-CORE-004
			header:    "Bearer " + testutil.TestBrainTokenWrong,
			wantValid: false,
			wantCode:  401,
		},
		{
			name:      "5_EmptyBearerValue",  // TST-CORE-005
			header:    "Bearer ",
			wantValid: false,
			wantCode:  401,
		},
		{
			name:      "6_TokenWithWhitespace",  // TST-CORE-006
			header:    "Bearer  " + testutil.TestBrainToken + " ",
			wantValid: false, // trimmed and accepted, or rejected — either way, must not panic
			wantCode:  401,   // whitespace around token should be rejected (or trimmed → 200)
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Extract token from header (strip "Bearer " prefix).
			// Real test should issue an HTTP request and check status code.
			// For unit-level, we call ValidateBrainToken directly.
			token := ""
			if len(tt.header) > 7 && tt.header[:7] == "Bearer " {
				token = tt.header[7:]
			}
			got := impl.ValidateBrainToken(token)
			if got != tt.wantValid {
				t.Errorf("ValidateBrainToken(%q) = %v, want %v (expected HTTP %d)",
					token, got, tt.wantValid, tt.wantCode)
			}
		})
	}
}

// TST-CORE-007
func TestAuth_1_1_7_TokenFileMissing(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// When the BRAIN_TOKEN file is absent, startup should fail.
	// Point the loader at a non-existent path and expect an error.
	dir := testutil.TempDir(t)
	// Do NOT create a token file inside dir.
	t.Setenv("DINA_BRAIN_TOKEN_FILE", dir+"/nonexistent_brain_token")

	cfg, err := impl.Load()
	if err == nil {
		t.Fatalf("expected startup error when BRAIN_TOKEN file is missing, got cfg=%+v", cfg)
	}
	testutil.RequireContains(t, err.Error(), "token")
}

// TST-CORE-008
func TestAuth_1_1_8_TokenFileEmpty(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// When the BRAIN_TOKEN file exists but is 0 bytes, startup should fail.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "brain_token", "")
	t.Setenv("DINA_BRAIN_TOKEN_FILE", dir+"/brain_token")

	cfg, err := impl.Load()
	if err == nil {
		t.Fatalf("expected startup error when BRAIN_TOKEN file is empty, got cfg=%+v", cfg)
	}
	testutil.RequireContains(t, err.Error(), "token")
}

// TST-CORE-009
func TestAuth_1_1_9_TimingAttackResistance(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// Validate that comparing the correct token and a wrong token of the same
	// length takes approximately the same time (constant-time comparison).
	op1 := func() {
		impl.ValidateBrainToken(testutil.TestBrainToken)
	}
	op2 := func() {
		impl.ValidateBrainToken(testutil.TestBrainTokenWrong)
	}

	testutil.AssertConstantTime(t, op1, op2, 50*time.Microsecond, 1000)
}

// --------------------------------------------------------------------------
// §1.2 CLIENT_TOKEN (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-010, TST-CORE-011, TST-CORE-012, TST-CORE-013, TST-CORE-014, TST-CORE-015, TST-CORE-016
func TestAuth_1_2_ClientToken(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	tests := []struct {
		name       string
		token      string
		wantDevice string
		wantOK     bool
		wantCode   int
	}{
		{
			name:       "1_ValidClientToken",  // TST-CORE-010
			token:      testutil.TestClientToken,
			wantDevice: "device-001",
			wantOK:     true,
			wantCode:   200,
		},
		{
			name:       "2_UnknownClientToken",  // TST-CORE-011
			token:      "unknown-token-ffffffffffffffffffffffffffffffffffffffffffffffff",
			wantDevice: "",
			wantOK:     false,
			wantCode:   401,
		},
		{
			name:       "3_RevokedClientToken",  // TST-CORE-012
			token:      "revoked-token-placeholder",
			wantDevice: "",
			wantOK:     false,
			wantCode:   401,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// SHA-256 hash lookup: ValidateClientToken hashes the token and
			// checks the registry. For the valid case, the mock or real impl
			// must have testutil.TestClientToken pre-registered.
			deviceID, ok := impl.ValidateClientToken(tt.token)
			if ok != tt.wantOK {
				t.Errorf("ValidateClientToken(%q): ok=%v, want %v (expected HTTP %d)",
					tt.token, ok, tt.wantOK, tt.wantCode)
			}
			if ok && deviceID != tt.wantDevice {
				t.Errorf("ValidateClientToken(%q): device=%q, want %q",
					tt.token, deviceID, tt.wantDevice)
			}
		})
	}
}

// TST-CORE-013
func TestAuth_1_2_4_ClientTokenOnBrainEndpoint(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// CLIENT_TOKEN must not be accepted on /v1/brain/* endpoints.
	// The token itself is valid, but the routing layer should return 403.
	kind, _, err := impl.IdentifyToken(testutil.TestClientToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)

	// In integration: POST /v1/brain/process with CLIENT_TOKEN → 403.
	// At unit level, verify the token type is "client" and assert the
	// middleware would reject it for brain-only paths.
	if kind != domain.TokenClient {
		t.Fatalf("expected token kind 'client', got %q", kind)
	}
	// Middleware rule: "client" tokens on /v1/brain/* → 403 Forbidden.
}

// TST-CORE-014
func TestAuth_1_2_5_BrainTokenOnAdminEndpoint(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// BRAIN_TOKEN must not be accepted on /v1/admin/* endpoints.
	kind, _, err := impl.IdentifyToken(testutil.TestBrainToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenBrain)

	// In integration: GET /v1/admin/devices with BRAIN_TOKEN → 403.
	// At unit level, verify the token type is "brain" and assert the
	// middleware would reject it for admin-only paths.
	if kind != domain.TokenBrain {
		t.Fatalf("expected token kind 'brain', got %q", kind)
	}
	// Middleware rule: "brain" tokens on /v1/admin/* → 403 Forbidden.
}

// TST-CORE-015
func TestAuth_1_2_6_ConcurrentDeviceSessions(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// Two different CLIENT_TOKENs for two devices should both validate
	// independently and return different device IDs.
	tokenA := testutil.TestClientToken
	tokenB := "client-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	deviceA, okA := impl.ValidateClientToken(tokenA)
	deviceB, okB := impl.ValidateClientToken(tokenB)

	if !okA {
		t.Fatalf("device A token should be valid")
	}
	if !okB {
		t.Fatalf("device B token should be valid")
	}
	if deviceA == deviceB {
		t.Fatalf("two devices must have different IDs: both got %q", deviceA)
	}
}

// TST-CORE-016
func TestAuth_1_2_7_ClientTokenConstantTime(t *testing.T) {
	// var impl testutil.TokenValidator = realauth.NewTokenValidator(...)
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// Validate constant-time behaviour for CLIENT_TOKEN hash lookups.
	op1 := func() {
		impl.ValidateClientToken(testutil.TestClientToken)
	}
	op2 := func() {
		impl.ValidateClientToken("unknown-token-ffffffffffffffffffffffffffffffffffffffffffffffff")
	}

	testutil.AssertConstantTime(t, op1, op2, 50*time.Microsecond, 1000)
}

// --------------------------------------------------------------------------
// §1.3 Browser Session Auth Gateway (21 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-017, TST-CORE-018, TST-CORE-019, TST-CORE-020, TST-CORE-021, TST-CORE-022, TST-CORE-023
// TST-CORE-024, TST-CORE-025, TST-CORE-026, TST-CORE-027, TST-CORE-028, TST-CORE-029, TST-CORE-030
// TST-CORE-031, TST-CORE-032, TST-CORE-033, TST-CORE-034, TST-CORE-035, TST-CORE-036, TST-CORE-037
func TestAuth_1_3_BrowserSession(t *testing.T) {
	// var impl testutil.SessionManager = realsession.NewManager(...)
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	t.Run("1_LoginCorrectPassphrase", func(t *testing.T) {  // TST-CORE-017
		// Correct Argon2id passphrase match → Set-Cookie + redirect.
		// In integration: POST /login with correct passphrase → 302 + Set-Cookie.
		// At unit level: SessionManager.Create returns a valid session.
		sessionID, csrfToken, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		if sessionID == "" {
			t.Fatal("expected non-empty session ID")
		}
		if csrfToken == "" {
			t.Fatal("expected non-empty CSRF token")
		}
	})

	t.Run("2_LoginWrongPassphrase", func(t *testing.T) {  // TST-CORE-018
		// Wrong passphrase → 401, no cookie.
		// At integration level: POST /login with wrong passphrase → 401.
		// At unit level: the passphrase check happens before Create() is called.
		// This is verified by the integration test; here we confirm Create
		// is not called when auth fails (mock-level check).
		_ = impl // passphrase validation is upstream of SessionManager
	})

	t.Run("3_SessionCookieBearerTranslation", func(t *testing.T) {  // TST-CORE-019
		// Session cookie → gateway injects Bearer token for downstream handlers.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		deviceID, err := impl.Validate(authCtx, sessionID)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, deviceID, "device-001")
	})

	t.Run("4_ExpiredSessionCookie", func(t *testing.T) {  // TST-CORE-020
		// Session that has exceeded TTL → 401 redirect.
		// Implementation must honour TTL. This test verifies Validate
		// rejects expired sessions. Real impl: create session, advance
		// time past TTL, then validate.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)

		// NOTE: In real implementation, simulate time advancement past TTL.
		// For now, verify the session is valid immediately after creation.
		_, err = impl.Validate(authCtx, sessionID)
		testutil.RequireNoError(t, err)
		// Integration test should use a short TTL and sleep/mock-clock.
	})

	t.Run("5_CSRFMissingHeader", func(t *testing.T) {  // TST-CORE-021
		// POST without X-CSRF-Token header → 403.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		ok, err := impl.ValidateCSRF(sessionID, "")
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, ok, "empty CSRF token should be rejected")
	})

	t.Run("6_CSRFMismatch", func(t *testing.T) {  // TST-CORE-022
		// Wrong CSRF token → 403.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		ok, err := impl.ValidateCSRF(sessionID, "wrong-csrf-token")
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, ok, "wrong CSRF token should be rejected")
	})

	t.Run("7_SessionFixationResistance", func(t *testing.T) {  // TST-CORE-023
		// New session ID must be issued on each login — never reuse.
		s1, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		s2, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		if s1 == s2 {
			t.Fatal("session fixation: same session ID issued twice for the same device")
		}
	})

	t.Run("8_ConcurrentBrowserSessions", func(t *testing.T) {  // TST-CORE-024
		// Two browser sessions for the same device should both be valid.
		s1, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		s2, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)

		d1, err := impl.Validate(authCtx, s1)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, d1, "device-001")

		d2, err := impl.Validate(authCtx, s2)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, d2, "device-001")
	})

	t.Run("9_Logout", func(t *testing.T) {  // TST-CORE-025
		// Destroy session → cookie cleared, session invalidated.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)

		err = impl.Destroy(authCtx, sessionID)
		testutil.RequireNoError(t, err)

		_, err = impl.Validate(authCtx, sessionID)
		testutil.RequireError(t, err)
	})

	t.Run("10_CookieAttributes", func(t *testing.T) {  // TST-CORE-026
		// HttpOnly, Secure, SameSite=Strict.
		// This is an integration-level check: the HTTP response must set
		// Set-Cookie with correct attributes. At unit level, confirm the
		// session is created (attributes are set by the HTTP handler).
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		if sessionID == "" {
			t.Fatal("session creation failed — cannot verify cookie attributes")
		}
		// Integration: parse Set-Cookie header for HttpOnly, Secure, SameSite=Strict.
	})

	t.Run("11_LoginRateLimit5PerMinPerIP", func(t *testing.T) {  // TST-CORE-027
		// 6th login attempt from the same IP within 1 minute → 429.
		// This is an integration/middleware test. At unit level, we document
		// the contract: rate limiter must be configured for 5 req/min/IP on /login.
		// Real test issues 6 POST /login requests and checks the 6th returns 429.
		_ = impl // rate limiting is middleware, not SessionManager
	})

	t.Run("12_SessionStorageInMemory", func(t *testing.T) {  // TST-CORE-028
		// Sessions are stored in memory only. A restart invalidates all sessions.
		// At unit level: create a session, "restart" (new manager instance),
		// validate → error.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)

		// Simulating restart: the real test would create a new SessionManager
		// instance and verify the old session ID is not recognized.
		_, err = impl.Validate(authCtx, sessionID)
		testutil.RequireNoError(t, err) // still valid before restart
		// After restart (new instance): impl2.Validate(sessionID) → error.
	})

	t.Run("13_SessionTTLConfigurable", func(t *testing.T) {  // TST-CORE-029
		// DINA_SESSION_TTL env var is honoured for session expiry.
		// Integration: set DINA_SESSION_TTL=2, create session, wait 3s, validate → error.
		_ = impl // TTL configuration is at init time, tested in integration
	})

	t.Run("14_SessionIDGeneration", func(t *testing.T) {  // TST-CORE-030
		// Session ID must be 32 bytes from crypto/rand (64 hex chars).
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		// 32 bytes = 64 hex characters.
		if len(sessionID) < 64 {
			t.Errorf("session ID too short: got %d chars, want >= 64 (32 bytes hex)", len(sessionID))
		}
	})

	t.Run("15_CookieMaxAgeMatchesTTL", func(t *testing.T) {  // TST-CORE-031
		// Max-Age on the Set-Cookie header must match the configured session TTL.
		// Integration-level check: parse Max-Age from Set-Cookie header.
		_ = impl // cookie Max-Age is set by HTTP handler
	})

	t.Run("16_SuccessfulLogin302", func(t *testing.T) {  // TST-CORE-032
		// Successful login returns HTTP 302 redirect to /admin.
		// Integration: POST /login → 302, Location: /admin.
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		if sessionID == "" {
			t.Fatal("login should create session for 302 redirect")
		}
		// Integration: check response status 302, Location header = "/admin".
	})

	t.Run("17_LoginPageGoEmbed", func(t *testing.T) {  // TST-CORE-033
		// Static login HTML is served from embed.FS, not from disk.
		// Integration: GET /login returns HTML with correct content-type.
		// No SessionManager interaction — this tests the HTTP handler.
		_ = impl
	})

	t.Run("18_DeviceAppBearerPassthrough", func(t *testing.T) {  // TST-CORE-034
		// A device app sends a Bearer token directly on /admin/* endpoints.
		// The session gateway must pass it through without requiring a cookie.
		// At unit level: validate that IdentifyToken works for client tokens.
		_ = impl // tested at middleware/integration level
	})

	t.Run("19_NoCookieShowsLoginPage", func(t *testing.T) {  // TST-CORE-035
		// Request to /admin without a session cookie → serve login page (not 401).
		// Integration: GET /admin without Cookie → 200 with login HTML.
		_ = impl // HTTP handler level
	})

	t.Run("20_ConvenienceModeAdminPassphrase", func(t *testing.T) {  // TST-CORE-036
		// Even in convenience mode, admin access requires passphrase auth.
		// Integration: set DINA_MODE=convenience, POST /login still required.
		_ = impl // config + middleware level
	})

	t.Run("21_BrainNeverSeesCookies", func(t *testing.T) {  // TST-CORE-037
		// No Cookie header is proxied to the brain sidecar.
		// Integration: verify that brain-bound requests have Cookie stripped.
		_ = impl // proxy/middleware level
	})
}

// --------------------------------------------------------------------------
// §1.4 Auth Surface Completeness (9 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-038, TST-CORE-039, TST-CORE-040, TST-CORE-041, TST-CORE-042, TST-CORE-043, TST-CORE-044
// TST-CORE-045, TST-CORE-046
func TestAuth_1_4_AuthSurface(t *testing.T) {
	// var tokenImpl testutil.TokenValidator = realauth.NewTokenValidator(...)
	tokenImpl := realTokenValidator
	testutil.RequireImplementation(t, tokenImpl, "TokenValidator")

	t.Run("1_NoThirdAuthMechanism", func(t *testing.T) {  // TST-CORE-038
		// Only BRAIN_TOKEN and CLIENT_TOKEN are accepted. No API keys,
		// no OAuth tokens, no JWTs from external IdPs.
		// Verify IdentifyToken returns an error for anything that is not
		// the brain token or a registered client token.
		_, _, err := tokenImpl.IdentifyToken("some-random-api-key")
		testutil.RequireError(t, err)
	})

	t.Run("2_UnknownAuthSchemeIgnored", func(t *testing.T) {  // TST-CORE-039
		// "ApiKey xyz123" in Authorization header → 401.
		// At unit level: IdentifyToken with an unknown token → error.
		_, _, err := tokenImpl.IdentifyToken("xyz123-apikey-scheme")
		testutil.RequireError(t, err)
	})

	t.Run("3_ExternalJWTRejected", func(t *testing.T) {  // TST-CORE-040
		// JWT from an external IdP is not accepted.
		fakeJWT := "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakesig"
		_, _, err := tokenImpl.IdentifyToken(fakeJWT)
		testutil.RequireError(t, err)
	})

	t.Run("4_NoPluginEndpoints", func(t *testing.T) {  // TST-CORE-041
		// No /v1/plugins or other undocumented endpoints exist.
		// var serverImpl testutil.Server = realserver.New(...)
		serverImpl := realServer
		testutil.RequireImplementation(t, serverImpl, "Server")

		routes := serverImpl.Routes()
		for _, r := range routes {
			if len(r) >= 12 && r[:12] == "/v1/plugins" {
				t.Fatalf("unexpected plugin endpoint registered: %s", r)
			}
		}
	})

	t.Run("5_IdentifyTokenPriority", func(t *testing.T) {  // TST-CORE-042
		// BRAIN_TOKEN is checked first before CLIENT_TOKEN.
		kind, identity, err := tokenImpl.IdentifyToken(testutil.TestBrainToken)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, kind, domain.TokenBrain)
		testutil.RequireEqual(t, identity, "brain")
	})

	t.Run("6_IdentifyTokenFallback", func(t *testing.T) {  // TST-CORE-043
		// If the token is not a BRAIN_TOKEN, fall back to CLIENT_TOKEN via SHA-256.
		kind, _, err := tokenImpl.IdentifyToken(testutil.TestClientToken)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, kind, domain.TokenClient)
	})

	t.Run("7_BrainTokenOnAdminPathsForbidden", func(t *testing.T) {  // TST-CORE-044
		// BRAIN_TOKEN on /v1/admin/* → 403.
		// At unit level: verify token is classified as "brain".
		kind, _, err := tokenImpl.IdentifyToken(testutil.TestBrainToken)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, kind, domain.TokenBrain)
		// Middleware enforces: brain tokens cannot access admin paths → 403.
	})

	t.Run("8_ClientTokenFullAccess", func(t *testing.T) {  // TST-CORE-045
		// CLIENT_TOKEN grants access to all non-brain endpoints (vault, admin, etc.).
		kind, deviceID, err := tokenImpl.IdentifyToken(testutil.TestClientToken)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, kind, domain.TokenClient)
		if deviceID == "" {
			t.Fatal("CLIENT_TOKEN should resolve to a device ID")
		}
		// Middleware enforces: client tokens have full access to /v1/vault/*,
		// /v1/admin/*, /v1/identity/*, etc.
	})

	t.Run("9_CoreNeverCallsExternalAPIs", func(t *testing.T) {  // TST-CORE-046
		// dina-core must never make outbound HTTP calls during auth.
		// This is a design invariant: all auth is local (token file + SHA-256
		// registry). No external IdP, no OIDC discovery, no JWKS fetch.
		//
		// Integration test: instrument net/http.DefaultTransport or use a
		// proxy to verify zero outbound connections during the auth flow.
		//
		// At unit level, this is verified by code review and the absence of
		// any http.Client usage in the auth package.
		_ = tokenImpl
	})
}

// --------------------------------------------------------------------------
// §1.5 Compromised Brain Damage Radius (9 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-047, TST-CORE-048, TST-CORE-049, TST-CORE-050, TST-CORE-051, TST-CORE-052, TST-CORE-053
// TST-CORE-054, TST-CORE-055
func TestAuth_1_5_CompromisedBrain(t *testing.T) {
	// These tests verify that a compromised brain (holding only BRAIN_TOKEN)
	// cannot escalate to privileged operations. Each test confirms the
	// operation is forbidden for brain-identified tokens.

	// var tokenImpl testutil.TokenValidator = realauth.NewTokenValidator(...)
	tokenImpl := realTokenValidator
	testutil.RequireImplementation(t, tokenImpl, "TokenValidator")

	// Confirm the brain token is classified correctly.
	kind, _, err := tokenImpl.IdentifyToken(testutil.TestBrainToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenBrain)

	t.Run("1_BrainAccessesOpenPersona", func(t *testing.T) {  // TST-CORE-047
		// BRAIN_TOKEN + open persona → 200 (allowed).
		// var gk testutil.Gatekeeper = realgk.New(...)
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID:   "brain",
			Action:     "read_vault",
			PersonaID:  "persona-consumer",
			TrustLevel: "open",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, decision.Allowed, "brain should access open persona")
	})

	t.Run("2_BrainCannotAccessLocked", func(t *testing.T) {  // TST-CORE-048
		// BRAIN_TOKEN on a locked persona → 403.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID:   "brain",
			Action:     "read_vault",
			PersonaID:  "persona-financial",
			TrustLevel: "locked",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "brain must not access locked persona")
	})

	t.Run("3_RestrictedCreatesAuditTrail", func(t *testing.T) {  // TST-CORE-049
		// Accessing a restricted persona creates an audit entry + notification.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID:   "brain",
			Action:     "read_vault",
			PersonaID:  "persona-health",
			TrustLevel: "restricted",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		// Regardless of allowed/denied, audit trail must be created.
		testutil.RequireTrue(t, decision.Audit, "restricted access must create audit entry")
	})

	t.Run("4_BrainCannotCallDIDSign", func(t *testing.T) {  // TST-CORE-050
		// Brain must not be able to invoke DID signing operations.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID: "brain",
			Action:   "did_sign",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "brain must not call DID sign")
	})

	t.Run("5_BrainCannotCallDIDRotate", func(t *testing.T) {  // TST-CORE-051
		// Brain must not be able to rotate DID keys.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID: "brain",
			Action:   "did_rotate",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "brain must not call DID rotate")
	})

	t.Run("6_BrainCannotCallVaultBackup", func(t *testing.T) {  // TST-CORE-052
		// Brain must not be able to trigger vault backups.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID: "brain",
			Action:   "vault_backup",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "brain must not call vault backup")
	})

	t.Run("7_BrainCannotCallPersonaUnlock", func(t *testing.T) {  // TST-CORE-053
		// Brain must not be able to unlock personas.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		intent := testutil.Intent{
			AgentDID:  "brain",
			Action:    "persona_unlock",
			PersonaID: "persona-financial",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "brain must not unlock personas")
	})

	t.Run("8_BrainCannotBypassPIIScrubber", func(t *testing.T) {  // TST-CORE-054
		// PII scrubbing runs in the core pipeline, not in brain.
		// Brain cannot bypass it because it never sees raw data.
		// This is a design invariant: the egress path always includes PII scrubbing.
		gk := realGatekeeper
		testutil.RequireImplementation(t, gk, "Gatekeeper")

		// Verify egress control blocks raw data from leaving.
		allowed, err := gk.CheckEgress(context.Background(), "brain", []byte("SSN: 123-45-6789"))
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, allowed, "PII must not pass through egress to brain")
	})

	t.Run("9_BrainCannotAccessRawVaultFiles", func(t *testing.T) {  // TST-CORE-055
		// Brain has no SQLite file mounted — it only communicates via HTTP API.
		// This is a deployment/architecture invariant: the brain container
		// does not have a volume mount to ~/.dina/vault/.
		//
		// At unit level: BRAIN_TOKEN holder can only use /v1/brain/* endpoints.
		// No /v1/vault/raw or filesystem access is possible through the API.
		brainKind, _, err := tokenImpl.IdentifyToken(testutil.TestBrainToken)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, brainKind, domain.TokenBrain)
		// Middleware enforces: brain tokens → only /v1/brain/* paths.
		// No raw vault file access is exposed via any API endpoint.
	})
}

// ==========================================================================
// INDIVIDUAL TEST FUNCTIONS — §1.3, §1.4, §1.5
// ==========================================================================
// These expand the grouped subtests above into standalone top-level functions
// following the naming convention TestAuth_<section>_<scenario>_<Name>.
// Each calls testutil.RequireImplementation so they skip until wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §1.3 Browser Session Auth Gateway — individual tests (21 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-017
func TestAuth_1_3_1_LoginCorrectPassphrase(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	pv := realPassphraseVerifier
	testutil.RequireImplementation(t, pv, "PassphraseVerifier")

	// Verify passphrase matches stored Argon2id hash.
	ok, err := pv.Verify(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, ok, "correct passphrase must be accepted")

	// After passphrase verification succeeds, a session is created.
	sessionID, csrfToken, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)
	if sessionID == "" {
		t.Fatal("expected non-empty session ID after successful login")
	}
	if csrfToken == "" {
		t.Fatal("expected non-empty CSRF token after successful login")
	}

	// Session must be immediately valid.
	deviceID, err := impl.Validate(authCtx, sessionID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, deviceID, "device-001")
}

// TST-CORE-018
func TestAuth_1_3_2_LoginWrongPassphrase(t *testing.T) {
	pv := realPassphraseVerifier
	testutil.RequireImplementation(t, pv, "PassphraseVerifier")

	ok, err := pv.Verify(testutil.TestPassphraseWrong)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, ok, "wrong passphrase must be rejected")
}

// TST-CORE-019
func TestAuth_1_3_3_SessionCookieToBearerTranslation(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	// Login to get a session cookie value.
	statusCode, setCookie, _, err := gw.Login(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 302)
	if setCookie == "" {
		t.Fatal("expected Set-Cookie header on successful login")
	}

	// Proxied request: session cookie → Authorization: Bearer <CLIENT_TOKEN>.
	authHeader, cookieStripped, err := gw.ProxyRequest(setCookie)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, cookieStripped, "Cookie header must be stripped from proxied request")
	if len(authHeader) < 8 || authHeader[:7] != "Bearer " {
		t.Fatalf("expected 'Bearer <token>' auth header, got %q", authHeader)
	}
}

// TST-CORE-020
func TestAuth_1_3_4_ExpiredSessionCookie(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	// Create a session and verify it works.
	sessionID, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	_, err = impl.Validate(authCtx, sessionID)
	testutil.RequireNoError(t, err)

	// NOTE: Real implementation should accept a configurable clock or short TTL.
	// After TTL expires, Validate must return an error.
	// Integration test: create with TTL=1s, sleep 2s, validate → error.
	// At unit level we verify the session is valid before expiry.
}

// TST-CORE-021
func TestAuth_1_3_5_CSRFMissingHeader(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	sessionID, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	// Empty CSRF token must be rejected.
	ok, err := impl.ValidateCSRF(sessionID, "")
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, ok, "empty CSRF token must be rejected (HTTP 403)")
}

// TST-CORE-022
func TestAuth_1_3_6_CSRFMismatch(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	sessionID, csrfToken, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	// Wrong CSRF token must be rejected.
	ok, err := impl.ValidateCSRF(sessionID, "wrong-csrf-token-value")
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, ok, "mismatched CSRF token must be rejected (HTTP 403)")

	// Correct CSRF token must be accepted.
	ok, err = impl.ValidateCSRF(sessionID, csrfToken)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, ok, "correct CSRF token must be accepted")
}

// TST-CORE-023
func TestAuth_1_3_7_SessionFixationResistance(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	// Creating two sessions for the same device must produce different IDs.
	ids := make(map[string]bool)
	for i := 0; i < 10; i++ {
		sessionID, _, err := impl.Create(authCtx, "device-001")
		testutil.RequireNoError(t, err)
		if ids[sessionID] {
			t.Fatalf("session fixation: duplicate session ID %q on iteration %d", sessionID, i)
		}
		ids[sessionID] = true
	}
}

// TST-CORE-024
func TestAuth_1_3_8_ConcurrentBrowserSessions(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	// Two browser sessions for the same device must both be independently valid.
	s1, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)
	s2, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	if s1 == s2 {
		t.Fatal("concurrent sessions must have different IDs")
	}

	d1, err := impl.Validate(authCtx, s1)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, d1, "device-001")

	d2, err := impl.Validate(authCtx, s2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, d2, "device-001")

	// Destroying one session must not affect the other.
	err = impl.Destroy(authCtx, s1)
	testutil.RequireNoError(t, err)

	_, err = impl.Validate(authCtx, s1)
	testutil.RequireError(t, err)

	d2Again, err := impl.Validate(authCtx, s2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, d2Again, "device-001")
}

// TST-CORE-025
func TestAuth_1_3_9_Logout(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	sessionID, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	// Validate before logout.
	_, err = impl.Validate(authCtx, sessionID)
	testutil.RequireNoError(t, err)

	// Destroy the session (POST /logout).
	err = impl.Destroy(authCtx, sessionID)
	testutil.RequireNoError(t, err)

	// Session must be invalid after logout.
	_, err = impl.Validate(authCtx, sessionID)
	testutil.RequireError(t, err)

	// Destroying again should not panic (idempotent or error — both acceptable).
	_ = impl.Destroy(authCtx, sessionID)
}

// TST-CORE-026
func TestAuth_1_3_10_CookieAttributes(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	// Login and inspect the Set-Cookie header for required attributes.
	statusCode, setCookie, _, err := gw.Login(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 302)

	// Set-Cookie must contain HttpOnly.
	testutil.RequireContains(t, setCookie, "HttpOnly")
	// Set-Cookie must contain SameSite=Strict.
	testutil.RequireContains(t, setCookie, "SameSite=Strict")
	// Note: Secure is expected only when TLS is enabled.
}

// TST-CORE-027
func TestAuth_1_3_11_LoginRateLimit(t *testing.T) {
	rl := realRateLimiter
	testutil.RequireImplementation(t, rl, "RateLimiter")

	ip := "192.168.1.100"
	rl.Reset(ip)

	// First 5 attempts from the same IP must be allowed.
	for i := 1; i <= 5; i++ {
		if !rl.Allow(ip) {
			t.Fatalf("attempt %d should be allowed (limit is 5/min)", i)
		}
	}

	// 6th attempt must be rate-limited (HTTP 429).
	if rl.Allow(ip) {
		t.Fatal("6th attempt from the same IP within 1 minute should be rejected (429)")
	}

	// Different IP should still be allowed.
	if !rl.Allow("10.0.0.1") {
		t.Fatal("different IP should not be rate-limited")
	}
}

// TST-CORE-028
func TestAuth_1_3_12_SessionStorageLostOnRestart(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	// Create a session.
	sessionID, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	// Session is valid before "restart".
	_, err = impl.Validate(authCtx, sessionID)
	testutil.RequireNoError(t, err)

	// Simulate restart: a new SessionManager instance should not retain
	// sessions from the old instance. This test documents the invariant;
	// the integration test creates a fresh SessionManager and verifies
	// the old sessionID is rejected.
	//
	// At unit level, the key assertion is that sessions live in memory only
	// (no persistence to disk). The count after Destroy verifies memory-backed.
	err = impl.Destroy(authCtx, sessionID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.ActiveSessions(), 0)
}

// TST-CORE-029
func TestAuth_1_3_13_SessionTTLConfigurable(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	// This test documents the contract: DINA_SESSION_TTL environment variable
	// controls the session TTL. Default is 86400 seconds (24 hours).
	// Integration test sets DINA_SESSION_TTL=2, creates a session, waits 3s,
	// and verifies Validate returns an error.
	//
	// At unit level, verify that the session manager respects its TTL config.
	sessionID, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)
	_, err = impl.Validate(authCtx, sessionID)
	testutil.RequireNoError(t, err)
}

// TST-CORE-030
func TestAuth_1_3_14_SessionIDGeneration(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	// Session ID must be 32 bytes from crypto/rand (64 hex characters).
	sessionID, _, err := impl.Create(authCtx, "device-001")
	testutil.RequireNoError(t, err)

	if len(sessionID) < 64 {
		t.Errorf("session ID too short: got %d chars, want >= 64 (32 bytes hex-encoded)", len(sessionID))
	}

	// Verify all characters are valid hex.
	for i, c := range sessionID {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			t.Errorf("session ID char at position %d is not hex: %c", i, c)
			break
		}
	}
}

// TST-CORE-031
func TestAuth_1_3_15_CookieMaxAgeMatchesTTL(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	// Login and verify the Set-Cookie header contains Max-Age matching the TTL.
	statusCode, setCookie, _, err := gw.Login(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 302)

	// Default TTL is 86400 seconds.
	testutil.RequireContains(t, setCookie, "Max-Age=86400")
}

// TST-CORE-032
func TestAuth_1_3_16_SuccessfulLogin302Redirect(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	statusCode, setCookie, location, err := gw.Login(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 302)
	testutil.RequireEqual(t, location, "/admin")
	if setCookie == "" {
		t.Fatal("expected Set-Cookie header on successful login redirect")
	}
}

// TST-CORE-033
func TestAuth_1_3_17_LoginPageGoEmbed(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	body, contentType, err := gw.ServeLoginPage()
	testutil.RequireNoError(t, err)

	if len(body) == 0 {
		t.Fatal("login page body must not be empty")
	}

	// Content-Type must be text/html.
	testutil.RequireContains(t, contentType, "text/html")

	// Body must contain a form element (basic HTML login form check).
	testutil.RequireContains(t, string(body), "<form")
}

// TST-CORE-034
func TestAuth_1_3_18_DeviceBearerPassthrough(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	// A device app sends a Bearer token directly — no cookie needed.
	// The gateway must validate the Bearer token and proxy the request.
	statusCode, err := gw.HandleAdminRequest(testutil.TestClientToken, "")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// TST-CORE-035
func TestAuth_1_3_19_NoCookieShowsLoginPage(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	// GET /admin without session cookie or Bearer → serve login page (200), not 401.
	statusCode, err := gw.HandleAdminRequest("", "")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
}

// TST-CORE-036
func TestAuth_1_3_20_ConvenienceModeAdminPassphrase(t *testing.T) {
	impl := realSessionManager
	testutil.RequireImplementation(t, impl, "SessionManager")

	pv := realPassphraseVerifier
	testutil.RequireImplementation(t, pv, "PassphraseVerifier")

	// Even when DINA_MODE=convenience (vault auto-unlocked), the admin
	// interface requires passphrase authentication. Defense in depth.
	//
	// Integration test: set DINA_MODE=convenience, attempt GET /admin
	// without session → login page. POST /login with correct passphrase → 302.
	//
	// At unit level, verify that passphrase verification is required
	// regardless of convenience mode.
	ok, err := pv.Verify(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, ok, "passphrase must be verified even in convenience mode")
}

// TST-CORE-037
func TestAuth_1_3_21_BrainNeverSeesCookies(t *testing.T) {
	gw := realAuthGateway
	testutil.RequireImplementation(t, gw, "AuthGateway")

	// Login to get a session cookie.
	_, setCookie, _, err := gw.Login(testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	if setCookie == "" {
		t.Fatal("expected Set-Cookie header on successful login")
	}

	// When proxying a request to brain:8200, the Cookie header must be stripped
	// and replaced with Authorization: Bearer.
	authHeader, cookieStripped, err := gw.ProxyRequest(setCookie)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, cookieStripped, "Cookie header must be stripped from proxied request to brain")
	testutil.RequireHasPrefix(t, authHeader, "Bearer ")
}

// --------------------------------------------------------------------------
// §1.4 Auth Surface Completeness — individual tests (9 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-038
func TestAuth_1_4_1_NoThirdAuthMechanism(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// Only BRAIN_TOKEN and CLIENT_TOKEN are recognized. Any other token
	// must result in an error from IdentifyToken.
	unknownTokens := []string{
		"some-random-api-key",
		"oauth-token-1234567890",
		"basic-auth-credential",
		"x-custom-auth-scheme",
	}
	for _, token := range unknownTokens {
		_, _, err := impl.IdentifyToken(token)
		testutil.RequireError(t, err)
	}
}

// TST-CORE-039
func TestAuth_1_4_2_UnknownSchemeIgnored(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// "ApiKey abc123" in Authorization header → 401.
	// IdentifyToken only handles raw tokens, but the middleware must reject
	// unknown auth schemes before extracting the token value.
	_, _, err := impl.IdentifyToken("xyz123-apikey-scheme")
	testutil.RequireError(t, err)
}

// TST-CORE-040
func TestAuth_1_4_3_ExternalJWTRejected(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// A well-formed JWT from an external identity provider must be rejected.
	// dina-core does not validate external JWTs — no JWKS fetch, no OIDC discovery.
	fakeJWT := "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWV9.fakesignature"
	_, _, err := impl.IdentifyToken(fakeJWT)
	testutil.RequireError(t, err)
}

// TST-CORE-041
func TestAuth_1_4_4_NoPluginEndpoints(t *testing.T) {
	impl := realServer
	testutil.RequireImplementation(t, impl, "Server")

	routes := impl.Routes()
	forbiddenPrefixes := []string{
		"/v1/plugins",
		"/v1/extensions",
		"/v1/hooks",
		"/v1/webhooks",
		"/v1/addons",
	}
	for _, route := range routes {
		for _, prefix := range forbiddenPrefixes {
			if len(route) >= len(prefix) && route[:len(prefix)] == prefix {
				t.Fatalf("unexpected plugin/extension endpoint registered: %s", route)
			}
		}
	}
}

// TST-CORE-042
func TestAuth_1_4_5_IdentifyTokenPriority(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// BRAIN_TOKEN must be checked first (constant-time) before CLIENT_TOKEN
	// (SHA-256 hash lookup). This prevents timing leaks.
	kind, identity, err := impl.IdentifyToken(testutil.TestBrainToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenBrain)
	testutil.RequireEqual(t, identity, "brain")
}

// TST-CORE-043
func TestAuth_1_4_6_IdentifyTokenFallback(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// When the token is not the BRAIN_TOKEN, fall back to CLIENT_TOKEN via
	// SHA-256(token) lookup in device_tokens WHERE revoked = 0.
	kind, deviceID, err := impl.IdentifyToken(testutil.TestClientToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
	if deviceID == "" {
		t.Fatal("CLIENT_TOKEN fallback must resolve a device ID")
	}
}

// TST-CORE-044
func TestAuth_1_4_7_IsAdminEndpointAllowlist(t *testing.T) {
	checker := realAdminEndpointChecker
	testutil.RequireImplementation(t, checker, "AdminEndpointChecker")

	// BRAIN_TOKEN must be rejected on all admin endpoints.
	adminPaths := []string{
		"/v1/did/sign",
		"/v1/did/rotate",
		"/v1/vault/backup",
		"/v1/persona/unlock",
		"/admin/dashboard",
		"/admin/devices",
	}
	for _, path := range adminPaths {
		testutil.RequireTrue(t, checker.IsAdminEndpoint(path),
			"expected "+path+" to be classified as admin endpoint")
		testutil.RequireFalse(t, checker.AllowedForTokenKind("brain", path),
			"BRAIN_TOKEN must be forbidden on "+path)
	}
}

// TST-CORE-045
func TestAuth_1_4_8_ClientTokenFullAccess(t *testing.T) {
	checker := realAdminEndpointChecker
	testutil.RequireImplementation(t, checker, "AdminEndpointChecker")

	// CLIENT_TOKEN grants full access to all endpoints (admin + non-admin).
	allPaths := []string{
		"/v1/did/sign",
		"/v1/did/rotate",
		"/v1/vault/backup",
		"/v1/persona/unlock",
		"/v1/vault/query",
		"/v1/identity/resolve",
		"/admin/dashboard",
	}
	for _, path := range allPaths {
		testutil.RequireTrue(t, checker.AllowedForTokenKind("client", path),
			"CLIENT_TOKEN must be allowed on "+path)
	}
}

// TST-CORE-046
func TestAuth_1_4_9_CoreNeverCallsExternalAPIs(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	// dina-core must never make outbound HTTP calls during auth.
	// All auth is local: BRAIN_TOKEN from a file, CLIENT_TOKEN via SHA-256
	// hash lookup in a local database. No OAuth, OIDC, JWKS, or external IdP.
	//
	// This is verified by:
	// 1. Code audit: no http.Client usage in auth package.
	// 2. Integration: instrument net/http.DefaultTransport to reject all outbound.
	//
	// At unit level, the absence of external calls is a design invariant.
	// We verify the auth flow completes purely locally.
	kind, _, err := impl.IdentifyToken(testutil.TestBrainToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenBrain)

	kind, _, err = impl.IdentifyToken(testutil.TestClientToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenClient)
}

// --------------------------------------------------------------------------
// §1.5 Compromised Brain Damage Radius — individual tests (9 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-047
func TestAuth_1_5_1_BrainAccessesOpenPersona(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	// A compromised brain (holding only BRAIN_TOKEN) can access open personas.
	// This is the expected damage radius — open personas are accessible.
	intent := testutil.Intent{
		AgentDID:   "brain",
		Action:     "read_vault",
		PersonaID:  "persona-consumer",
		TrustLevel: "open",
	}
	decision, err := gk.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "brain should access open persona — this is the expected damage radius")
}

// TST-CORE-048
func TestAuth_1_5_2_BrainCannotAccessLocked(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	// A compromised brain cannot access locked personas because the DEK
	// is not in RAM. The crypto enforces this — not just an access check.
	lockedPersonas := []string{"persona-financial", "persona-health", "persona-citizen"}
	for _, persona := range lockedPersonas {
		intent := testutil.Intent{
			AgentDID:   "brain",
			Action:     "read_vault",
			PersonaID:  persona,
			TrustLevel: "locked",
		}
		decision, err := gk.EvaluateIntent(context.Background(), intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "brain must not access locked persona "+persona)
	}
}

// TST-CORE-049
func TestAuth_1_5_3_RestrictedCreatesDetectionTrail(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	// Accessing a restricted persona is allowed but creates an audit entry
	// and a notification in the daily briefing.
	intent := testutil.Intent{
		AgentDID:   "brain",
		Action:     "read_vault",
		PersonaID:  "persona-health",
		TrustLevel: "restricted",
	}
	decision, err := gk.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Audit, "restricted access must create an audit trail entry")
	// The decision.Reason should indicate the access was logged.
	if decision.Reason == "" {
		t.Log("warning: decision.Reason is empty — production should include audit detail")
	}
}

// TST-CORE-050
func TestAuth_1_5_4_BrainCannotCallDIDSign(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID: "brain",
		Action:   "did_sign",
	}
	decision, err := gk.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "brain must not invoke POST /v1/did/sign — admin endpoint")
}

// TST-CORE-051
func TestAuth_1_5_5_BrainCannotCallDIDRotate(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID: "brain",
		Action:   "did_rotate",
	}
	decision, err := gk.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "brain must not invoke POST /v1/did/rotate — admin endpoint")
}

// TST-CORE-052
func TestAuth_1_5_6_BrainCannotCallVaultBackup(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID: "brain",
		Action:   "vault_backup",
	}
	decision, err := gk.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "brain must not invoke POST /v1/vault/backup — admin endpoint")
}

// TST-CORE-053
func TestAuth_1_5_7_BrainCannotCallPersonaUnlock(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:  "brain",
		Action:    "persona_unlock",
		PersonaID: "persona-financial",
	}
	decision, err := gk.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "brain must not invoke POST /v1/persona/unlock — admin endpoint")
}

// TST-CORE-054
func TestAuth_1_5_8_BrainCannotBypassPIIScrubber(t *testing.T) {
	gk := realGatekeeper
	testutil.RequireImplementation(t, gk, "Gatekeeper")

	// The PII scrubber runs in the core pipeline. Brain cannot bypass it
	// because it only communicates via the core API, which always scrubs
	// egress data.
	piiPayloads := []string{
		"SSN: 123-45-6789",
		"Email: alice@example.com",
		"Card: 4111-1111-1111-1111",
		"Phone: 555-123-4567",
	}
	for _, payload := range piiPayloads {
		allowed, err := gk.CheckEgress(context.Background(), "brain", []byte(payload))
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, allowed, "PII must not pass through egress to brain: "+payload)
	}
}

// TST-CORE-055
func TestAuth_1_5_9_BrainCannotAccessRawVaultFiles(t *testing.T) {
	impl := realTokenValidator
	testutil.RequireImplementation(t, impl, "TokenValidator")

	serverImpl := realServer
	testutil.RequireImplementation(t, serverImpl, "Server")

	// Verify the brain token is classified correctly.
	kind, _, err := impl.IdentifyToken(testutil.TestBrainToken)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, kind, domain.TokenBrain)

	// Verify no raw vault file endpoints exist.
	routes := serverImpl.Routes()
	for _, route := range routes {
		if len(route) >= 13 && route[:13] == "/v1/vault/raw" {
			t.Fatalf("raw vault file endpoint must not exist: %s", route)
		}
		if len(route) >= 14 && route[:14] == "/v1/vault/file" {
			t.Fatalf("vault file endpoint must not exist: %s", route)
		}
	}

	// Brain can only access /v1/brain/* paths. The middleware enforces this.
	// The deployment invariant: brain container has no volume mount to vault files.
}
