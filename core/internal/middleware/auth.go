package middleware

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"

	"github.com/anthropics/dina/core/internal/port"
)

type contextKey string

const (
	TokenKindKey contextKey = "token_kind"
	AgentDIDKey  contextKey = "agent_did"
)

type Auth struct {
	Tokens port.TokenValidator
}

// publicPaths bypass authentication.
var publicPaths = map[string]bool{
	"/healthz":                 true,
	"/readyz":                  true,
	"/.well-known/atproto-did": true,
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
			// Read and re-arm the request body for downstream handlers.
			bodyBytes, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

			kind, identity, err := a.Tokens.VerifySignature(
				xDID, r.Method, r.URL.Path, xTS, bodyBytes, xSig,
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
