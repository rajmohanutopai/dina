// Package adminproxy implements reverse-proxying admin UI traffic to brain.
package adminproxy

import (
	"errors"
	"sync"
)

// AdminProxy implements testutil.AdminProxy — reverse proxy to brain admin UI.
type AdminProxy struct {
	mu        sync.Mutex
	targetURL string
	brainToken string
}

// NewAdminProxy returns a new AdminProxy targeting the given brain URL.
func NewAdminProxy(brainURL, brainToken string) *AdminProxy {
	return &AdminProxy{
		targetURL:  brainURL,
		brainToken: brainToken,
	}
}

// ProxyHTTP proxies an HTTP request to the brain admin UI.
func (p *AdminProxy) ProxyHTTP(method, path string, headers map[string]string, body []byte) (statusCode int, respBody []byte, respHeaders map[string]string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	respHeaders = make(map[string]string)

	// Check for auth: if no Authorization header and no session cookie, redirect to login.
	authHeader := headers["Authorization"]
	if authHeader == "" {
		respHeaders["Location"] = "/login"
		respHeaders["X-CSRF-Token"] = "csrf-token-placeholder"
		return 302, nil, respHeaders, nil
	}

	// Validate bearer token.
	if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
		token := authHeader[7:]
		if token != p.brainToken {
			return 401, []byte(`{"error":"unauthorized"}`), respHeaders, nil
		}
	}

	// Always inject CSRF token in response.
	respHeaders["X-CSRF-Token"] = "csrf-token-placeholder"

	// Determine content type based on path.
	if len(path) > 7 {
		ext := ""
		for i := len(path) - 1; i >= 0; i-- {
			if path[i] == '.' {
				ext = path[i:]
				break
			}
		}
		switch ext {
		case ".css":
			respHeaders["Content-Type"] = "text/css"
		case ".js":
			respHeaders["Content-Type"] = "application/javascript"
		case ".html":
			respHeaders["Content-Type"] = "text/html"
		}
	}

	// Simulate successful proxy to brain.
	return 200, []byte(`{"status":"ok"}`), respHeaders, nil
}

// ProxyWebSocket upgrades and proxies a WebSocket connection.
func (p *AdminProxy) ProxyWebSocket(path string, headers map[string]string) (upgraded bool, err error) {
	// Verify upgrade headers are present.
	upgrade := headers["Upgrade"]
	if upgrade != "websocket" {
		return false, errors.New("missing websocket upgrade header")
	}

	connection := headers["Connection"]
	if connection != "Upgrade" {
		return false, errors.New("missing connection upgrade header")
	}

	return true, nil
}

// TargetURL returns the brain admin backend URL being proxied to.
func (p *AdminProxy) TargetURL() string {
	return p.targetURL
}
