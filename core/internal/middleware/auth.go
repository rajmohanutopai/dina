package middleware

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

type contextKey string

const (
	TokenKindKey contextKey = "token_kind"
	AgentDIDKey  contextKey = "agent_did"
)

// AuthzChecker is the interface for endpoint-level authorization checks.
// It determines whether a given token kind (e.g. "brain", "client") is
// allowed to access a specific URL path.
type AuthzChecker interface {
	AllowedForTokenKind(kind, path string) bool
}

type Auth struct {
	Tokens port.TokenValidator
}

// publicPaths bypass authentication.
var publicPaths = map[string]bool{
	"/healthz":                 true,
	"/readyz":                  true,
	"/.well-known/atproto-did": true,
}

// isTimestampValid checks whether a timestamp string is within
// 5 minutes of the current time.
func isTimestampValid(ts string) bool {
	t, err := time.Parse("2006-01-02T15:04:05Z", ts)
	if err != nil {
		return false
	}
	skew := time.Since(t)
	if skew < 0 {
		skew = -skew
	}
	return skew <= 5*time.Minute
}

func (a *Auth) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Public endpoints bypass auth.
		if publicPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		// POST /msg is the NaCl ingress endpoint — authenticated by the sealed box itself.
		if r.URL.Path == "/msg" && r.Method == http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}

		// --- Ed25519 signature auth (preferred for CLI devices) ---
		xDID := r.Header.Get("X-DID")
		xSig := r.Header.Get("X-Signature")
		xTS := r.Header.Get("X-Timestamp")

		if xDID != "" && xSig != "" && xTS != "" {
			// Fast-fail: reject expired timestamps before reading body.
			if !isTimestampValid(xTS) {
				http.Error(w, `{"error":"invalid or expired timestamp"}`, http.StatusUnauthorized)
				return
			}

			// Bound body read to prevent memory exhaustion.
			const maxSignedBodySize = 1 << 20 // 1 MB
			r.Body = http.MaxBytesReader(w, r.Body, maxSignedBodySize)
			bodyBytes, err := io.ReadAll(r.Body)
			if err != nil {
				var maxBytesErr *http.MaxBytesError
				if errors.As(err, &maxBytesErr) {
					http.Error(w, `{"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
					return
				}
				http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

			kind, identity, err := a.Tokens.VerifySignature(
				xDID, r.Method, r.URL.Path, r.URL.RawQuery, xTS, bodyBytes, xSig,
			)
			if err != nil {
				http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), TokenKindKey, string(kind))
			ctx = context.WithValue(ctx, AgentDIDKey, identity)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		// --- Legacy Bearer token auth ---
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, `{"error":"missing or invalid Authorization header"}`, http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")

		// Identify token type.
		kind, identity, err := a.Tokens.IdentifyToken(token)
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}

		// Set context values for downstream handlers.
		ctx := context.WithValue(r.Context(), TokenKindKey, string(kind))
		ctx = context.WithValue(ctx, AgentDIDKey, identity)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// NewAuthzMiddleware creates middleware that enforces endpoint-level authorization
// based on the caller's token kind. It reads token_kind from the request context
// (set by the auth middleware) and checks with the AuthzChecker whether
// that token kind is allowed to access the requested path.
func NewAuthzMiddleware(checker AuthzChecker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Read token_kind from context (set by Auth.Handler).
			kind, _ := r.Context().Value(TokenKindKey).(string)
			if kind == "" {
				// No token kind in context = unauthenticated (public path or pre-auth).
				next.ServeHTTP(w, r)
				return
			}
			if !checker.AllowedForTokenKind(kind, r.URL.Path) {
				http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
