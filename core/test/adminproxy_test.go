package test

import (
	"testing"

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
func TestAdminProxy_12_1_ProxyToBrainAdminUI(t *testing.T) {
	// var impl testutil.AdminProxy = realproxy.New(...)
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	// GET localhost:8100/admin/ must be reverse-proxied to brain:8200/admin/.
	// Verify the proxy target URL points to the brain service.
	target := impl.TargetURL()
	testutil.RequireContains(t, target, "8200")

	// Issue a GET /admin/ through the proxy and verify it reaches brain.
	statusCode, _, _, err := impl.ProxyHTTP("GET", "/admin/", map[string]string{
		"Authorization": "Bearer " + testutil.TestBrainToken,
	}, nil)
	testutil.RequireNoError(t, err)
	// A proxied request should return 200 (or 502 if brain is down, but the
	// proxy layer itself must not reject it).
	testutil.RequireTrue(t, statusCode == 200 || statusCode == 502,
		"proxy should forward to brain, not reject locally")
}

// --------------------------------------------------------------------------
// §12.2 Auth Required
// --------------------------------------------------------------------------

// TST-CORE-542
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
func TestAdminProxy_12_3_StaticAssetProxying(t *testing.T) {
	// var impl testutil.AdminProxy = realproxy.New(...)
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	// CSS/JS files must be correctly proxied with the right Content-Type.
	tests := []struct {
		path        string
		contentType string
	}{
		{"/admin/static/style.css", "text/css"},
		{"/admin/static/app.js", "application/javascript"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			statusCode, _, respHeaders, err := impl.ProxyHTTP("GET", tt.path, map[string]string{
				"Authorization": "Bearer " + testutil.TestBrainToken,
			}, nil)
			testutil.RequireNoError(t, err)

			// The proxy must forward the request. If brain is up, expect 200
			// with correct Content-Type. If brain is down, 502 is acceptable.
			if statusCode == 200 {
				ct := respHeaders["Content-Type"]
				testutil.RequireContains(t, ct, tt.contentType)
			}
		})
	}
}

// --------------------------------------------------------------------------
// §12.4 WebSocket Upgrade Proxy
// --------------------------------------------------------------------------

// TST-CORE-544
func TestAdminProxy_12_4_WebSocketUpgradeProxy(t *testing.T) {
	// var impl testutil.AdminProxy = realproxy.New(...)
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	// WS connection to :8100/ws must be proxied to brain:8200/ws.
	// The proxy must handle the HTTP Upgrade handshake.
	upgraded, err := impl.ProxyWebSocket("/ws", map[string]string{
		"Authorization":          "Bearer " + testutil.TestBrainToken,
		"Connection":             "Upgrade",
		"Upgrade":                "websocket",
		"Sec-WebSocket-Version":  "13",
		"Sec-WebSocket-Key":      "dGhlIHNhbXBsZSBub25jZQ==",
	})
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, upgraded, "WebSocket upgrade must be proxied to brain")
}

// TST-CORE-897
func TestAdminProxy_12_5_CSRFTokenInjectedInResponse(t *testing.T) {
	// CSRF token injected as X-CSRF-Token in proxied response to browser.
	impl := realAdminProxy
	testutil.RequireImplementation(t, impl, "AdminProxy")

	statusCode, _, respHeaders, err := impl.ProxyHTTP("GET", "/admin/dashboard", map[string]string{}, nil)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, statusCode > 0, "proxy must return a status code")
	_, hasCSRF := respHeaders["X-CSRF-Token"]
	testutil.RequireTrue(t, hasCSRF, "proxied response must contain X-CSRF-Token header")
}
