package handler

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/middleware"
)

// ---------------------------------------------------------------------------
// injectUserOrigin — Core-enforced allowlist for user_origin values
// ---------------------------------------------------------------------------

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
