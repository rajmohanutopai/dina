package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/middleware"
)

// ---------------------------------------------------------------------------
// injectUserOrigin — Core-enforced allowlist for user_origin values
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "2132", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "01", "scenario": "01", "title": "InjectUserOrigin_AllowlistedValues"}
func TestInjectUserOrigin_AllowlistedValues(t *testing.T) {
	for _, origin := range []string{"telegram", "admin"} {
		r := httptest.NewRequest("POST", "/v1/vault/query", nil)
		ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "brain")
		r = r.WithContext(ctx)

		r = injectUserOrigin(r, origin)

		got, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
		if !got {
			t.Errorf("origin=%q: expected UserOriginatedKey=true", origin)
		}
		gotOrigin, _ := r.Context().Value(middleware.UserOriginKey).(string)
		if gotOrigin != origin {
			t.Errorf("origin=%q: UserOriginKey=%q", origin, gotOrigin)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "2133", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "02", "scenario": "01", "title": "InjectUserOrigin_UnknownValueRejected"}
func TestInjectUserOrigin_UnknownValueRejected(t *testing.T) {
	for _, origin := range []string{"hacker", "bot", "cli", "TELEGRAM", "Admin"} {
		r := httptest.NewRequest("POST", "/v1/vault/query", nil)
		ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "brain")
		r = r.WithContext(ctx)

		r = injectUserOrigin(r, origin)

		got, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
		if got {
			t.Errorf("origin=%q: should NOT set UserOriginatedKey for unknown origin", origin)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "2134", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "03", "scenario": "01", "title": "InjectUserOrigin_EmptyString"}
func TestInjectUserOrigin_EmptyString(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/vault/query", nil)
	ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "brain")
	r = r.WithContext(ctx)

	r = injectUserOrigin(r, "")

	got, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
	if got {
		t.Error("empty origin should not set UserOriginatedKey")
	}
}

// TRACE: {"suite": "CORE", "case": "2135", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "04", "scenario": "01", "title": "InjectUserOrigin_NonBrainCallerIgnored"}
func TestInjectUserOrigin_NonBrainCallerIgnored(t *testing.T) {
	for _, caller := range []string{"agent", "user", "connector"} {
		r := httptest.NewRequest("POST", "/v1/vault/query", nil)
		ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, caller)
		r = r.WithContext(ctx)

		r = injectUserOrigin(r, "telegram")

		got, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
		if got {
			t.Errorf("caller=%q: non-brain should not get UserOriginatedKey", caller)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "2136", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "05", "scenario": "01", "title": "InjectUserOrigin_AmbiguousAgentDID"}
func TestInjectUserOrigin_AmbiguousAgentDID(t *testing.T) {
	r := httptest.NewRequest("POST", "/v1/vault/query", nil)
	ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "brain")
	r = r.WithContext(ctx)
	r.Header.Set("X-Agent-DID", "did:key:z6MkAgent")

	r = injectUserOrigin(r, "telegram")

	got, _ := r.Context().Value(middleware.UserOriginatedKey).(bool)
	if got {
		t.Error("should NOT set UserOriginatedKey when X-Agent-DID is present")
	}
}

// ---------------------------------------------------------------------------
// FC1 — KV key blocklist for device-scoped callers
// ---------------------------------------------------------------------------

// TST-CORE-1226
// TRACE: {"suite": "CORE", "case": "2137", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "06", "scenario": "01", "title": "FC1_DeviceBlockedFromUserSettings"}
func TestFC1_DeviceBlockedFromUserSettings(t *testing.T) {
	// Device caller requesting user_settings → blocked
	r := httptest.NewRequest("GET", "/v1/vault/kv/user_settings", nil)
	ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "agent")
	r = r.WithContext(ctx)

	if !kvBlockedForDevice(r, "user_settings") {
		t.Error("FC1: device must be blocked from user_settings KV key")
	}
}

// TST-CORE-1227
// TRACE: {"suite": "CORE", "case": "2138", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "07", "scenario": "01", "title": "FC1_DeviceBlockedFromAdminPrefixKeys"}
func TestFC1_DeviceBlockedFromAdminPrefixKeys(t *testing.T) {
	for _, key := range []string{"admin:config", "admin:secrets"} {
		r := httptest.NewRequest("GET", "/v1/vault/kv/"+key, nil)
		ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "agent")
		r = r.WithContext(ctx)

		if !kvBlockedForDevice(r, key) {
			t.Errorf("FC1: device must be blocked from %q KV key", key)
		}
	}
}

// TST-CORE-1228
// TRACE: {"suite": "CORE", "case": "2139", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "08", "scenario": "01", "title": "FC1_DeviceAllowedOnSafeKeys"}
func TestFC1_DeviceAllowedOnSafeKeys(t *testing.T) {
	for _, key := range []string{"approval:apr-001", "scratchpad:task-1", "session:state"} {
		r := httptest.NewRequest("GET", "/v1/vault/kv/"+key, nil)
		ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, "agent")
		r = r.WithContext(ctx)

		if kvBlockedForDevice(r, key) {
			t.Errorf("FC1: device should NOT be blocked from %q KV key", key)
		}
	}
}

// TST-CORE-1229
// TRACE: {"suite": "CORE", "case": "2140", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "09", "scenario": "01", "title": "FC1_AdminNotBlockedFromUserSettings"}
func TestFC1_AdminNotBlockedFromUserSettings(t *testing.T) {
	// Admin/brain caller → NOT blocked
	for _, caller := range []string{"", "brain"} {
		r := httptest.NewRequest("GET", "/v1/vault/kv/user_settings", nil)
		if caller != "" {
			ctx := context.WithValue(r.Context(), middleware.CallerTypeKey, caller)
			r = r.WithContext(ctx)
		}

		if kvBlockedForDevice(r, "user_settings") {
			t.Errorf("FC1: caller=%q should NOT be blocked from user_settings", caller)
		}
	}
}

// ---------------------------------------------------------------------------
// GH6 — clientError JSON injection prevention
// ---------------------------------------------------------------------------

// TST-CORE-1230
// TRACE: {"suite": "CORE", "case": "2141", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "10", "scenario": "01", "title": "GH6_ClientErrorEscapesQuotes"}
func TestGH6_ClientErrorEscapesQuotes(t *testing.T) {
	rec := httptest.NewRecorder()
	clientError(rec, `msg with "quotes" and \backslash`, 400, nil)

	body := rec.Body.String()
	// Must be valid JSON — json.Unmarshal should succeed.
	var parsed map[string]string
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("GH6: clientError produced invalid JSON: %v\nbody: %s", err, body)
	}
	if parsed["error"] != `msg with "quotes" and \backslash` {
		t.Errorf("GH6: error message not preserved: got %q", parsed["error"])
	}
}

// TST-CORE-1231
// TRACE: {"suite": "CORE", "case": "2142", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "11", "scenario": "01", "title": "GH6_ClientErrorEscapesControlChars"}
func TestGH6_ClientErrorEscapesControlChars(t *testing.T) {
	rec := httptest.NewRecorder()
	clientError(rec, "line1\nline2\ttab", 500, nil)

	var parsed map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("GH6: clientError produced invalid JSON with control chars: %v", err)
	}
	if parsed["error"] != "line1\nline2\ttab" {
		t.Errorf("GH6: control chars not preserved: got %q", parsed["error"])
	}
}

// ---------------------------------------------------------------------------
// GH11 — Import path traversal validation
// ---------------------------------------------------------------------------

// TST-CORE-1232
// TRACE: {"suite": "CORE", "case": "2143", "section": "04", "sectionName": "Vault (SQLCipher)", "subsection": "12", "scenario": "01", "title": "GH11_ImportPathTraversalBlocked"}
func TestGH11_ImportPathTraversalBlocked(t *testing.T) {
	h := &ExportHandler{ExportBaseDir: "/tmp/dina-exports"}

	// Path traversal via ".." rejected.
	_, err := h.validateImportPath("../../etc/passwd")
	if err == nil {
		t.Fatal("GH11: path traversal with .. must be rejected")
	}

	// Absolute path outside base dir rejected.
	_, err = h.validateImportPath("/etc/passwd")
	if err == nil {
		t.Fatal("GH11: absolute path outside base must be rejected")
	}

	// Absolute path inside base dir accepted.
	safe, err := h.validateImportPath("/tmp/dina-exports/backup.tar.gz")
	if err != nil {
		t.Fatalf("GH11: valid absolute path rejected: %v", err)
	}
	if safe != "/tmp/dina-exports/backup.tar.gz" {
		t.Errorf("GH11: got %q, want /tmp/dina-exports/backup.tar.gz", safe)
	}

	// Relative path resolved within base.
	safe, err = h.validateImportPath("backup.tar.gz")
	if err != nil {
		t.Fatalf("GH11: valid relative path rejected: %v", err)
	}
	if safe != "/tmp/dina-exports/backup.tar.gz" {
		t.Errorf("GH11: got %q, want /tmp/dina-exports/backup.tar.gz", safe)
	}
}
