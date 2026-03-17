package middleware

import (
	"bytes"
	"context"
	crypto_rand "crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ContextKey is the type used for request context keys in Dina middleware.
// Exported so adapters can read values set by the auth middleware.
type ContextKey string

// contextKey is an alias for internal use.
type contextKey = ContextKey

const (
	TokenKindKey      ContextKey = "token_kind"
	AgentDIDKey       ContextKey = "agent_did"
	TokenScopeKey     ContextKey = "token_scope"
	CallerTypeKey     ContextKey = "caller_type"
	SessionNameKey    ContextKey = "session_name"
	ServiceIDKey      ContextKey = "service_id"
	UserOriginatedKey ContextKey = "user_originated" // true when Brain sends user_origin (Telegram/admin)
	UserOriginKey     ContextKey = "user_origin"     // "telegram", "admin", etc. for audit
	RequestIDKey      ContextKey = "request_id"      // cross-service audit correlation
)

// AuthzChecker is the interface for endpoint-level authorization checks.
// It determines whether a given token kind (e.g. "brain", "client") is
// allowed to access a specific URL path. The optional scope parameter
// differentiates privilege levels within a kind (e.g. "admin" vs "device"
// for client tokens).
type AuthzChecker interface {
	AllowedForTokenKind(kind, path string, scope ...string) bool
}

// TokenScopeResolver resolves the scope of a client token.
// Implemented by tokenValidator; optional for the Auth middleware.
type TokenScopeResolver interface {
	GetTokenScope(token string) string
}

type Auth struct {
	Tokens        port.TokenValidator
	ScopeResolver TokenScopeResolver // optional — set to enable scope-aware authz
}

// publicPaths bypass authentication entirely.
var publicPaths = map[string]bool{
	"/healthz":                 true,
	"/readyz":                  true,
	"/.well-known/atproto-did": true,
}

// optionalAuthPaths allow unauthenticated requests through (auth is optional).
// The handler itself validates the request using other means (e.g. pairing code).
var optionalAuthPaths = map[string]bool{
	"/v1/pair/complete": true, // pairing code is the auth, not Ed25519/token
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
		// Public endpoints bypass auth entirely.
		if publicPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		// /admin/* is authenticated by Brain admin session/login middleware.
		// Core acts as a transport proxy for this path.
		if r.URL.Path == "/admin" || strings.HasPrefix(r.URL.Path, "/admin/") {
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
		xNonce := r.Header.Get("X-Nonce")

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
				xDID, r.Method, r.URL.Path, r.URL.RawQuery, xTS, xNonce, bodyBytes, xSig,
			)
			if err != nil {
				http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), TokenKindKey, string(kind))
			ctx = context.WithValue(ctx, AgentDIDKey, identity)
			if string(kind) == "client" {
				// Device key: CallerType=agent, scope=device.
				ctx = context.WithValue(ctx, TokenScopeKey, "device")
				ctx = context.WithValue(ctx, CallerTypeKey, "agent")
			} else {
				// Service key. The identity is the registered serviceID
				// (e.g. "brain", "admin", "connector"). Store it as both
				// ServiceIDKey (for downstream logic) and TokenScopeKey
				// (for per-service authz allowlists).
				serviceID := identity
				ctx = context.WithValue(ctx, ServiceIDKey, serviceID)
				ctx = context.WithValue(ctx, TokenScopeKey, serviceID)

				// CallerType depends on which service:
				//   brain     → "brain" (vault operations on behalf of itself)
				//   admin     → "user"  (admin backend acts as the user)
				//   connector → "brain" (ingestion, same privilege as brain for vault writes)
				callerType := "brain"
				switch serviceID {
				case "admin":
					callerType = "user"
				}

				// If service forwards X-Agent-DID, attribute access to the
				// originating agent for persona approval/grant enforcement.
				if agentOverride := r.Header.Get("X-Agent-DID"); agentOverride != "" {
					ctx = context.WithValue(ctx, AgentDIDKey, agentOverride)
					callerType = "agent"
				}
				ctx = context.WithValue(ctx, CallerTypeKey, callerType)
			}
			// Extract session name from X-Session header (agent sessions).
			if sess := r.Header.Get("X-Session"); sess != "" {
				ctx = context.WithValue(ctx, SessionNameKey, sess)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		// --- Legacy Bearer token auth ---
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			// Optional auth paths: allow unauthenticated if no Ed25519 and no Bearer.
			if optionalAuthPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
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
		// Bearer path only produces client tokens (services use Ed25519 signatures).
		// Resolve scope and set CallerType accordingly.
		if a.ScopeResolver != nil {
			tokenScope := a.ScopeResolver.GetTokenScope(token)
			ctx = context.WithValue(ctx, TokenScopeKey, tokenScope)
			if tokenScope == "admin" {
				ctx = context.WithValue(ctx, CallerTypeKey, "user")
			} else {
				ctx = context.WithValue(ctx, CallerTypeKey, "agent")
			}
		} else {
			ctx = context.WithValue(ctx, CallerTypeKey, "user")
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// SocketAdminAuth returns middleware that pre-authenticates requests as admin.
// Used for the Unix socket listener where socket access = admin auth.
// No token validation is performed — the real trust boundary is docker exec
// access to the container; whoever can exec in can reach the socket.
func SocketAdminAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), TokenKindKey, "client")
		ctx = context.WithValue(ctx, AgentDIDKey, "socket-local")
		ctx = context.WithValue(ctx, TokenScopeKey, "admin")
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequestIDMiddleware extracts X-Request-ID from incoming requests for
// cross-service audit correlation. If absent, generates a new one.
// The ID is stored in context and echoed back in the response header.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get("X-Request-ID")
		if rid == "" {
			// Generate a short unique ID (12 hex chars from crypto/rand).
			b := make([]byte, 6)
			if _, err := io.ReadFull(crypto_rand.Reader, b); err == nil {
				rid = fmt.Sprintf("%x", b)
			}
		}
		ctx := context.WithValue(r.Context(), RequestIDKey, rid)
		w.Header().Set("X-Request-ID", rid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// NewAuthzMiddleware creates middleware that enforces endpoint-level authorization
// based on the caller's token kind and scope. It reads token_kind and
// token_scope from the request context (set by the auth middleware) and checks
// with the AuthzChecker whether that token kind/scope is allowed to access
// the requested path.
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
			// Read token_scope from context (set by Auth.Handler for client tokens).
			scope, _ := r.Context().Value(TokenScopeKey).(string)
			if !checker.AllowedForTokenKind(kind, r.URL.Path, scope) {
				http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
