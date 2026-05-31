package test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §12 — Admin Proxy
// ==========================================================================
// Covers reverse-proxying admin UI traffic from core (:8100) to brain (:8200).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §12.1 Proxy to Brain Admin UI
// --------------------------------------------------------------------------

// TST-CORE-541
// TRACE: {"suite": "CORE", "case": "0001", "section": "12", "sectionName": "Admin Proxy", "subsection": "01", "scenario": "01", "title": "ProxyToBrainAdminUI"}
func TestAdminProxy_12_1_ProxyToBrainAdminUI(t *testing.T) {
	// var impl testutil.AdminProxy = realproxy.New(...)
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	// Verify the proxy target URL points to the brain service.
	target := impl.TargetURL()
	testutil.RequireContains(t, target, "8200")
	testutil.RequireContains(t, target, "brain")

	// Authenticated GET /admin/ must return 200 with response body.
	statusCode, respBody, _, err := impl.ProxyHTTP("GET", "/admin/", map[string]string{
		"Authorization": "Bearer " + testutil.TestClientToken,
	}, nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 200)
	testutil.RequireTrue(t, len(respBody) > 0, "proxied response must have a body")

	// Negative control: unauthenticated request must NOT return 200.
	statusCodeNoAuth, _, respHeaders, err := impl.ProxyHTTP("GET", "/admin/", map[string]string{}, nil)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, statusCodeNoAuth == 302 || statusCodeNoAuth == 401,
		"unauthenticated request must redirect or return 401")

	// If redirected, Location header must point to login.
	if statusCodeNoAuth == 302 {
		loc := respHeaders["Location"]
		testutil.RequireContains(t, loc, "login")
	}

	// Wrong token must be rejected.
	statusCodeBadToken, _, _, err := impl.ProxyHTTP("GET", "/admin/", map[string]string{
		"Authorization": "Bearer wrong-token-ffffffffffffffffffffffffffffffffffffffffffffffff",
	}, nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCodeBadToken, 401)
}

// --------------------------------------------------------------------------
// §12.2 Auth Required
// --------------------------------------------------------------------------

// TST-CORE-542
// TRACE: {"suite": "CORE", "case": "0002", "section": "12", "sectionName": "Admin Proxy", "subsection": "02", "scenario": "01", "title": "AuthRequired"}
func TestAdminProxy_12_2_AuthRequired(t *testing.T) {
	// var impl testutil.AdminProxy = realproxy.New(...)
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	// Unauthenticated request to :8100 must be redirected to the login page.
	// No Authorization header, no session cookie.
	statusCode, _, respHeaders, err := impl.ProxyHTTP("GET", "/admin/", map[string]string{}, nil)
	testutil.RequireNoError(t, err)

	// Expect 302 redirect to login page or 401 Unauthorized.
	isRedirectOrUnauth := statusCode == 302 || statusCode == 301 || statusCode == 401
	testutil.RequireTrue(t, isRedirectOrUnauth,
		"unauthenticated admin request must redirect to login or return 401")

	// If 302, the Location header should point to /login.
	if statusCode == 302 {
		location := respHeaders["Location"]
		testutil.RequireContains(t, location, "login")
	}
}

// --------------------------------------------------------------------------
// §12.3 Static Asset Proxying
// --------------------------------------------------------------------------

// TST-CORE-543
// TRACE: {"suite": "CORE", "case": "0003", "section": "12", "sectionName": "Admin Proxy", "subsection": "03", "scenario": "01", "title": "StaticAssetProxying"}
func TestAdminProxy_12_3_StaticAssetProxying(t *testing.T) {
	// Use the real handler.AdminHandler + httputil.ReverseProxy, backed by
	// an httptest brain server that serves static assets with correct Content-Type.

	tests := []struct {
		path        string
		contentType string
		body        string
	}{
		{"/admin/static/style.css", "text/css", "body { margin: 0; }"},
		{"/admin/static/app.js", "application/javascript", "console.log('dina');"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			// Mock brain: serves the asset with the expected Content-Type.
			brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				testutil.RequireEqual(t, r.URL.Path, tt.path)
				w.Header().Set("Content-Type", tt.contentType)
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(tt.body))
			}))
			defer brain.Close()

			// Real AdminHandler with httputil.ReverseProxy targeting mock brain.
			ah := &handler.AdminHandler{ProxyURL: brain.URL}
			proxy := httptest.NewServer(http.HandlerFunc(ah.HandleAdmin))
			defer proxy.Close()

			resp, err := http.Get(proxy.URL + tt.path)
			testutil.RequireNoError(t, err)
			defer resp.Body.Close()

			testutil.RequireEqual(t, resp.StatusCode, 200)
			testutil.RequireContains(t, resp.Header.Get("Content-Type"), tt.contentType)

			var buf [4096]byte
			n, _ := resp.Body.Read(buf[:])
			testutil.RequireContains(t, string(buf[:n]), tt.body)
		})
	}
}

// --------------------------------------------------------------------------
// §12.4 WebSocket Upgrade Proxy
// --------------------------------------------------------------------------

// TST-CORE-544
// TRACE: {"suite": "CORE", "case": "0004", "section": "12", "sectionName": "Admin Proxy", "subsection": "04", "scenario": "01", "title": "WebSocketUpgradeProxy"}
func TestAdminProxy_12_4_WebSocketUpgradeProxy(t *testing.T) {
	// var impl testutil.AdminProxy = realproxy.New(...)
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	// WS connection to :8100/ws must be proxied to brain:8200/ws.
	// The proxy must handle the HTTP Upgrade handshake.
	upgraded, err := impl.ProxyWebSocket("/ws", map[string]string{
		"Authorization":          "Bearer " + testutil.TestClientToken,
		"Connection":             "Upgrade",
		"Upgrade":                "websocket",
		"Sec-WebSocket-Version":  "13",
		"Sec-WebSocket-Key":      "dGhlIHNhbXBsZSBub25jZQ==",
	})
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, upgraded, "WebSocket upgrade must be proxied to brain")
}

// TST-CORE-897
// TRACE: {"suite": "CORE", "case": "0005", "section": "12", "sectionName": "Admin Proxy", "subsection": "05", "scenario": "01", "title": "CSRFTokenInjectedInResponse"}
func TestAdminProxy_12_5_CSRFTokenInjectedInResponse(t *testing.T) {
	// CSRF token injected as X-CSRF-Token in proxied response to browser.
	// The real CSRF token is generated by SessionManager.Create(), not the
	// proxy stub. Verify the real SessionManager produces a CSRF token
	// alongside the session ID, and that ValidateCSRF accepts a valid token
	// and rejects a wrong one.

	sm := realSessionManager
	testutil.RequireImplementation(t, sm, "SessionManager")

	sessionID, csrfToken, err := sm.Create(authCtx, "device-csrf-test")
	testutil.RequireNoError(t, err)

	// CSRF token must be non-empty and 64 hex chars (32 bytes).
	if len(csrfToken) < 64 {
		t.Fatalf("CSRF token too short: got %d chars, want >= 64", len(csrfToken))
	}

	// Valid CSRF token must pass validation.
	ok, err := sm.ValidateCSRF(sessionID, csrfToken)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, ok, "valid CSRF token must pass validation")

	// Wrong CSRF token must be rejected.
	ok, err = sm.ValidateCSRF(sessionID, "0000000000000000000000000000000000000000000000000000000000000000")
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, ok, "wrong CSRF token must be rejected")

	// Empty CSRF token must be rejected.
	ok, _ = sm.ValidateCSRF(sessionID, "")
	testutil.RequireFalse(t, ok, "empty CSRF token must be rejected")
}
