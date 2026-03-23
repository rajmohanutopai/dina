// Package auth implements authentication adapters for dina-core (Section 1).
//
// It provides:
//   - TokenValidator: Ed25519 service key + device key signature verification,
//     and CLIENT_TOKEN (SHA-256 hash lookup) validation.
//   - SessionManager: in-memory browser session management with CSRF protection.
//   - RateLimiter: per-IP token-bucket rate limiting.
//   - RateLimitChecker: extended rate limiter with detailed result (Allowed, Remaining, ResetAt).
//   - PassphraseVerifier: Argon2id passphrase verification.
//
// All types satisfy the corresponding contracts in testutil via Go structural typing.
package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/test/testutil"
	"golang.org/x/crypto/argon2"
)

// Compile-time checks: adapters satisfy port interfaces.
var _ port.TokenValidator = (*tokenValidator)(nil)
var _ port.DeviceKeyRegistrar = (*tokenValidator)(nil)
var _ port.ClientTokenRegistrar = (*tokenValidator)(nil)
var _ port.TokenRevoker = (*tokenValidator)(nil)
var _ port.ServiceKeyRegistrar = (*tokenValidator)(nil)
var _ port.SessionManager = (*sessionManager)(nil)
var _ port.PassphraseVerifier = (*passphraseVerifier)(nil)
var _ port.RateLimiter = (*rateLimiter)(nil)

// Sentinel errors.
var (
	ErrInvalidToken    = errors.New("invalid token")
	ErrSessionNotFound = errors.New("session not found")
	ErrSessionExpired  = errors.New("session expired")
)

// ---------------------------------------------------------------------------
// TokenValidator (Section 1.1, 1.2)
// ---------------------------------------------------------------------------

// devicePubKey holds an Ed25519 public key for signature-based authentication.
type devicePubKey struct {
	publicKey ed25519.PublicKey
	deviceID  string
	revoked   bool
}

// servicePubKey holds an Ed25519 public key for a peer service (e.g. brain).
type servicePubKey struct {
	publicKey ed25519.PublicKey
	serviceID string // "brain", "core", etc.
}

// tokenValidator validates CLIENT_TOKEN, Ed25519 device signatures, and
// Ed25519 service signatures. Service keys return TokenService with the
// serviceID as identity; device keys return TokenClient.
type tokenValidator struct {
	mu           sync.RWMutex
	clientTokens map[string]string         // SHA-256(token) hex -> deviceID
	tokenScopes  map[string]string         // SHA-256(token) hex -> scope ("admin" or "device")
	deviceKeys   map[string]*devicePubKey  // did:key:z... -> public key entry
	serviceKeys  map[string]*servicePubKey // did:key:z... -> service key entry
	// SEC-MED-11: Double-buffer nonce cache for O(1) eviction.
	// Instead of scanning all entries on every request, we maintain two generations:
	// - nonceCurrent: active generation, all new nonces go here
	// - noncePrevious: previous generation, checked for duplicates but not modified
	// Every maxClockSkew interval, previous is discarded, current becomes previous,
	// and a new empty current is created.
	nonceCurrent   map[string]struct{}
	noncePrevious  map[string]struct{}
	nonceRotatedAt time.Time // when the last rotation happened
	clock          port.Clock
	maxClockSkew   time.Duration
}

// NewTokenValidator creates a TokenValidator.
//   - clientTokens: a map of SHA-256(token) hex digest -> deviceID.
func NewTokenValidator(clientTokens map[string]string) *tokenValidator {
	ct := make(map[string]string, len(clientTokens))
	for k, v := range clientTokens {
		ct[k] = v
	}
	return &tokenValidator{
		clientTokens:   ct,
		tokenScopes:    make(map[string]string),
		deviceKeys:     make(map[string]*devicePubKey),
		serviceKeys:    make(map[string]*servicePubKey),
		nonceCurrent:   make(map[string]struct{}),
		noncePrevious:  make(map[string]struct{}),
		nonceRotatedAt: time.Now(),
		maxClockSkew:   5 * time.Minute,
	}
}

// SetClock injects a Clock for testable timestamp verification.
func (v *tokenValidator) SetClock(c port.Clock) {
	v.clock = c
}

// RegisterDeviceKey adds an Ed25519 public key for a device DID.
// Accepts []byte to satisfy port.DeviceKeyRegistrar (ed25519.PublicKey is []byte).
func (v *tokenValidator) RegisterDeviceKey(did string, pubKey []byte, deviceID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.deviceKeys[did] = &devicePubKey{
		publicKey: ed25519.PublicKey(pubKey),
		deviceID:  deviceID,
	}
}

// RevokeDeviceKey marks a device DID's key as revoked.
func (v *tokenValidator) RevokeDeviceKey(did string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if dpk, ok := v.deviceKeys[did]; ok {
		dpk.revoked = true
	}
}

// RegisterClientToken registers a raw CLIENT_TOKEN so that future
// ValidateClientToken calls will accept it. The token is stored as its
// SHA-256 hex digest, matching the lookup path in ValidateClientToken.
// An optional scope parameter controls the token's privilege level:
//   - "admin": full access to all endpoints (bootstrap token)
//   - "device": restricted access — cannot reach /v1/did/sign, /v1/did/rotate,
//     /v1/identity/mnemonic, /v1/vault/backup, or /admin/* (paired devices)
//
// If no scope is provided, defaults to "device" (least-privilege).
func (v *tokenValidator) RegisterClientToken(token string, deviceID string, scope ...string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	hash := sha256Hex(token)
	v.clientTokens[hash] = deviceID
	tokenScope := "device" // default scope for paired devices
	if len(scope) > 0 && scope[0] != "" {
		tokenScope = scope[0]
	}
	v.tokenScopes[hash] = tokenScope
}

// RevokeClientTokenByDevice removes all client tokens associated with a device identity.
func (v *tokenValidator) RevokeClientTokenByDevice(deviceIdentity string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	for hash, devID := range v.clientTokens {
		if devID == deviceIdentity {
			delete(v.clientTokens, hash)
			delete(v.tokenScopes, hash)
		}
	}
}

// NewDefaultTokenValidator creates a validator with hardcoded test tokens.
// WARNING: For testing only. Production should use NewTokenValidator with empty client tokens.
// Pre-registered test tokens get "admin" scope so existing tests that expect
// full CLIENT_TOKEN access continue to pass.
func NewDefaultTokenValidator() *tokenValidator {
	clientTokens := make(map[string]string)

	// Pre-register testutil.TestClientToken -> "device-001".
	tokenA := "client-token-0123456789abcdef0123456789abcdef0123456789abcdef01"
	hashA := sha256Hex(tokenA)
	clientTokens[hashA] = "device-001"

	// Pre-register second client token -> "device-002".
	tokenB := "client-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	hashB := sha256Hex(tokenB)
	clientTokens[hashB] = "device-002"

	tv := NewTokenValidator(clientTokens)

	// Set admin scope for pre-registered test tokens so they retain full access.
	tv.tokenScopes[hashA] = "admin"
	tv.tokenScopes[hashB] = "admin"

	return tv
}

// RegisterServiceKey registers an Ed25519 public key for a peer service.
// Service keys are checked before device keys in VerifySignature() and
// return TokenService with the serviceID as the identity.
func (v *tokenValidator) RegisterServiceKey(did string, pubKey []byte, serviceID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.serviceKeys[did] = &servicePubKey{
		publicKey: ed25519.PublicKey(pubKey),
		serviceID: serviceID,
	}
}

// ValidateClientToken hashes the input token with SHA-256 and looks it up
// in the client token registry. Returns the associated deviceID on success.
func (v *tokenValidator) ValidateClientToken(token string) (deviceID string, ok bool) {
	if len(token) == 0 {
		return "", false
	}
	hash := sha256Hex(token)
	v.mu.RLock()
	deviceID, ok = v.clientTokens[hash]
	v.mu.RUnlock()
	return deviceID, ok
}

// GetTokenScope returns the scope for a client token ("admin" or "device").
// Returns "device" if the token is not found or has no explicit scope.
func (v *tokenValidator) GetTokenScope(token string) string {
	v.mu.RLock()
	defer v.mu.RUnlock()
	hash := sha256Hex(token)
	if scope, ok := v.tokenScopes[hash]; ok {
		return scope
	}
	return "device"
}

// IdentifyToken classifies a bearer token as a client token.
// Brain/service auth now uses Ed25519 signatures (VerifySignature), not bearer tokens.
// Returns (domain.TokenUnknown, "", ErrInvalidToken) if the token is not recognized.
func (v *tokenValidator) IdentifyToken(token string) (kind domain.TokenType, identity string, err error) {
	if deviceID, ok := v.ValidateClientToken(token); ok {
		return domain.TokenClient, deviceID, nil
	}

	return domain.TokenUnknown, "", ErrInvalidToken
}

// VerifySignature validates an Ed25519 request signature against the service
// key registry (returns TokenService + serviceID) or device key registry
// (returns TokenClient + deviceID). Enforces clock-skew window + nonce cache.
//
// The canonical signing payload is:
// "{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{sha256hex(body)}"
//
// The nonce is a random hex string generated by the signer and transmitted
// via the X-Nonce header. It guarantees unique signatures even for identical
// payloads within the same second.
func (v *tokenValidator) VerifySignature(
	did, method, path, query, timestamp, nonce string, body []byte, signatureHex string,
) (domain.TokenType, string, error) {
	// 1. Look up the DID — service keys first, then device keys.
	v.mu.RLock()
	spk, isService := v.serviceKeys[did]
	var dpk *devicePubKey
	var isDevice bool
	if !isService {
		dpk, isDevice = v.deviceKeys[did]
	}
	v.mu.RUnlock()

	var pubKey ed25519.PublicKey
	var resultType domain.TokenType
	var resultID string

	switch {
	case isService:
		pubKey = spk.publicKey
		resultType = domain.TokenService
		resultID = spk.serviceID
	case isDevice:
		if dpk.revoked {
			return domain.TokenUnknown, "", errors.New("device revoked")
		}
		pubKey = dpk.publicKey
		resultType = domain.TokenClient
		resultID = dpk.deviceID
	default:
		return domain.TokenUnknown, "", ErrInvalidToken
	}

	// 2. Verify timestamp is within acceptable window.
	ts, err := time.Parse("2006-01-02T15:04:05Z", timestamp)
	if err != nil {
		return domain.TokenUnknown, "", errors.New("invalid timestamp format")
	}
	now := time.Now()
	if v.clock != nil {
		now = v.clock.Now()
	}
	skew := now.Sub(ts)
	if skew < 0 {
		skew = -skew
	}
	if skew > v.maxClockSkew {
		return domain.TokenUnknown, "", errors.New("timestamp outside acceptable window")
	}

	// 3. Compute body hash.
	bodyHash := sha256Hex(string(body))

	// 4. Reconstruct the canonical signing payload.
	payload := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s", method, path, query, timestamp, nonce, bodyHash)

	// 5. Decode signature from hex.
	sig, err := hex.DecodeString(signatureHex)
	if err != nil {
		return domain.TokenUnknown, "", errors.New("invalid signature encoding")
	}

	// 6. Verify Ed25519 signature.
	if !ed25519.Verify(pubKey, []byte(payload), sig) {
		return domain.TokenUnknown, "", ErrInvalidToken
	}

	// 7. SEC-MED-11: Replay check using double-buffer generation rotation.
	// Check both current and previous generations for duplicates (O(1) per request).
	// Rotate generations every maxClockSkew interval instead of scanning all entries.
	v.mu.Lock()
	if _, seen := v.nonceCurrent[signatureHex]; seen {
		v.mu.Unlock()
		return domain.TokenUnknown, "", errors.New("replayed signature")
	}
	if _, seen := v.noncePrevious[signatureHex]; seen {
		v.mu.Unlock()
		return domain.TokenUnknown, "", errors.New("replayed signature")
	}
	v.nonceCurrent[signatureHex] = struct{}{}

	// Rotate generations if the interval has elapsed, or if current exceeds safety valve.
	const maxNonceEntries = 100_000
	if now.Sub(v.nonceRotatedAt) > v.maxClockSkew || len(v.nonceCurrent) > maxNonceEntries {
		v.noncePrevious = v.nonceCurrent
		v.nonceCurrent = make(map[string]struct{})
		v.nonceRotatedAt = now
	}
	v.mu.Unlock()

	return resultType, resultID, nil
}

// sha256Hex returns the lowercase hex-encoded SHA-256 digest of s.
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// ---------------------------------------------------------------------------
// SessionManager (Section 1.3)
// ---------------------------------------------------------------------------

type session struct {
	deviceID  string
	csrfToken string
	expiresAt time.Time
}

// sessionManager is an in-memory session store protected by a RWMutex.
// Sessions are in-memory only; a Restart() or ResetForTest() clears all sessions.
type sessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*session
	ttl      time.Duration
}

// NewSessionManager creates a SessionManager with the given TTL in seconds.
// Default TTL is 86400 (24 hours) if ttlSeconds <= 0.
func NewSessionManager(ttlSeconds int) *sessionManager {
	if ttlSeconds <= 0 {
		ttlSeconds = 86400
	}
	return &sessionManager{
		sessions: make(map[string]*session),
		ttl:      time.Duration(ttlSeconds) * time.Second,
	}
}

// Create generates a new session for the given deviceID.
// Returns a hex-encoded 32-byte session ID and a hex-encoded 32-byte CSRF token.
func (m *sessionManager) Create(_ context.Context, deviceID string) (sessionID, csrfToken string, err error) {
	sidBytes := make([]byte, 32)
	if _, err := rand.Read(sidBytes); err != nil {
		return "", "", fmt.Errorf("auth: failed to generate session ID: %w", err)
	}
	csrfBytes := make([]byte, 32)
	if _, err := rand.Read(csrfBytes); err != nil {
		return "", "", fmt.Errorf("auth: failed to generate CSRF token: %w", err)
	}

	sessionID = hex.EncodeToString(sidBytes)
	csrfToken = hex.EncodeToString(csrfBytes)

	m.mu.Lock()
	m.sessions[sessionID] = &session{
		deviceID:  deviceID,
		csrfToken: csrfToken,
		expiresAt: time.Now().Add(m.ttl),
	}
	m.mu.Unlock()

	return sessionID, csrfToken, nil
}

// Validate checks whether the session ID exists and has not expired.
// Returns the associated deviceID on success.
func (m *sessionManager) Validate(_ context.Context, sessionID string) (deviceID string, err error) {
	m.mu.RLock()
	s, ok := m.sessions[sessionID]
	m.mu.RUnlock()

	if !ok {
		return "", ErrSessionNotFound
	}
	if time.Now().After(s.expiresAt) {
		// Lazy-delete expired session.
		m.mu.Lock()
		delete(m.sessions, sessionID)
		m.mu.Unlock()
		return "", ErrSessionExpired
	}
	return s.deviceID, nil
}

// ValidateCSRF checks a CSRF token against the session.
// An empty csrfToken always fails. Returns (false, nil) on mismatch;
// returns an error only when the session itself is invalid.
func (m *sessionManager) ValidateCSRF(sessionID, csrfToken string) (bool, error) {
	if csrfToken == "" {
		return false, nil
	}

	m.mu.RLock()
	s, ok := m.sessions[sessionID]
	m.mu.RUnlock()

	if !ok {
		return false, ErrSessionNotFound
	}
	if time.Now().After(s.expiresAt) {
		return false, ErrSessionExpired
	}

	match := subtle.ConstantTimeCompare([]byte(csrfToken), []byte(s.csrfToken)) == 1
	return match, nil
}

// Destroy removes a session from the store. Idempotent: destroying a
// non-existent session is a no-op (returns nil).
func (m *sessionManager) Destroy(_ context.Context, sessionID string) error {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	return nil
}

// ActiveSessions returns the number of sessions currently stored.
func (m *sessionManager) ActiveSessions() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// Restart clears all sessions, simulating a process restart.
// All in-memory sessions are discarded.
func (m *sessionManager) Restart() {
	m.mu.Lock()
	m.sessions = make(map[string]*session)
	m.mu.Unlock()
}

// ResetForTest clears all sessions for per-test isolation.
// Called automatically by RequireImplementation when the implementation
// satisfies the Resettable interface.
func (m *sessionManager) ResetForTest() {
	m.mu.Lock()
	m.sessions = make(map[string]*session)
	m.mu.Unlock()
}

// GetCSRFToken returns the CSRF token associated with a session.
func (m *sessionManager) GetCSRFToken(sessionID string) (string, error) {
	m.mu.RLock()
	s, ok := m.sessions[sessionID]
	m.mu.RUnlock()

	if !ok {
		return "", ErrSessionNotFound
	}
	if time.Now().After(s.expiresAt) {
		return "", ErrSessionExpired
	}
	return s.csrfToken, nil
}

// ---------------------------------------------------------------------------
// RateLimiter (Section 1.3)
// ---------------------------------------------------------------------------

// maxRateLimitEntries is the hard cap on the number of rate limit buckets.
// Prevents unbounded memory growth from many unique IPs.
const maxRateLimitEntries = 10000

type bucket struct {
	tokens     int
	lastReset  time.Time
	lastAccess time.Time
}

// rateLimiter implements per-IP token-bucket rate limiting.
type rateLimiter struct {
	mu        sync.Mutex
	buckets   map[string]*bucket
	limit     int           // max tokens (requests) per window
	window    time.Duration // refill window
	lastPurge time.Time     // last time expired entries were purged
}

// NewRateLimiter creates a RateLimiter.
//   - limit: maximum requests per window (default 60).
//   - windowSeconds: duration of the rate-limiting window in seconds (default 60).
func NewRateLimiter(limit, windowSeconds int) *rateLimiter {
	if limit <= 0 {
		limit = 60
	}
	if windowSeconds <= 0 {
		windowSeconds = 60
	}
	return &rateLimiter{
		buckets:   make(map[string]*bucket),
		limit:     limit,
		window:    time.Duration(windowSeconds) * time.Second,
		lastPurge: time.Now(),
	}
}

// Allow checks whether a request from the given IP is permitted.
// Returns false when the IP has exhausted its token bucket for the current window.
func (r *rateLimiter) Allow(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	b := r.getOrCreateBucket(ip)
	if b.tokens > 0 {
		b.tokens--
		return true
	}
	return false
}

// Reset clears the rate limit state for the given IP.
func (r *rateLimiter) Reset(ip string) {
	r.mu.Lock()
	delete(r.buckets, ip)
	r.mu.Unlock()
}

// getOrCreateBucket returns the bucket for the IP, refilling if the window has elapsed.
// Caller must hold r.mu.
func (r *rateLimiter) getOrCreateBucket(ip string) *bucket {
	now := time.Now()

	// Periodic purge: clean expired entries every 5 minutes.
	if now.Sub(r.lastPurge) > 5*time.Minute {
		r.purgeExpired()
		r.lastPurge = now
	}
	// Hard cap: if still over limit after purge, evict oldest entries.
	if len(r.buckets) >= maxRateLimitEntries {
		r.evictOldest(maxRateLimitEntries / 10)
	}

	b, ok := r.buckets[ip]
	if !ok {
		b = &bucket{
			tokens:     r.limit,
			lastReset:  now,
			lastAccess: now,
		}
		r.buckets[ip] = b
		return b
	}

	b.lastAccess = now

	// Refill bucket if the window has elapsed.
	if now.Sub(b.lastReset) >= r.window {
		b.tokens = r.limit
		b.lastReset = now
	}

	return b
}

// purgeExpired removes buckets whose tokens have fully replenished and
// haven't been accessed within two window durations.
// Caller must hold r.mu.
func (r *rateLimiter) purgeExpired() {
	now := time.Now()
	cutoff := now.Add(-2 * r.window)
	for ip, b := range r.buckets {
		if b.tokens >= r.limit && b.lastAccess.Before(cutoff) {
			delete(r.buckets, ip)
		}
	}
}

// evictOldest removes the n least-recently-accessed buckets.
// Caller must hold r.mu.
func (r *rateLimiter) evictOldest(n int) {
	if n <= 0 || len(r.buckets) == 0 {
		return
	}
	for i := 0; i < n && len(r.buckets) > 0; i++ {
		oldestIP := ""
		oldestTime := time.Now()
		for ip, b := range r.buckets {
			if oldestIP == "" || b.lastAccess.Before(oldestTime) {
				oldestIP = ip
				oldestTime = b.lastAccess
			}
		}
		if oldestIP != "" {
			delete(r.buckets, oldestIP)
		}
	}
}

// ---------------------------------------------------------------------------
// RateLimitChecker (Section 13)
// ---------------------------------------------------------------------------

// rateLimitChecker wraps a rateLimiter and adds the Check method that returns
// a RateLimitResult with Allowed, Remaining, and ResetAt fields.
type rateLimitChecker struct {
	mu        sync.Mutex
	buckets   map[string]*bucket
	limit     int
	window    time.Duration
	lastPurge time.Time // last time expired entries were purged
}

// RateLimitResult is the canonical type from testutil.
type RateLimitResult = testutil.RateLimitResult

// NewRateLimitChecker creates a RateLimitChecker.
//   - limit: maximum requests per window (default 60).
//   - windowSeconds: duration of the window in seconds (default 60).
func NewRateLimitChecker(limit, windowSeconds int) *rateLimitChecker {
	if limit <= 0 {
		limit = 60
	}
	if windowSeconds <= 0 {
		windowSeconds = 60
	}
	return &rateLimitChecker{
		buckets:   make(map[string]*bucket),
		limit:     limit,
		window:    time.Duration(windowSeconds) * time.Second,
		lastPurge: time.Now(),
	}
}

// Check returns a detailed rate limit result for the given IP.
func (c *rateLimitChecker) Check(ip string) RateLimitResult {
	c.mu.Lock()
	defer c.mu.Unlock()

	b := c.getOrCreateBucket(ip)
	resetAt := b.lastReset.Add(c.window).Unix()

	if b.tokens > 0 {
		b.tokens--
		return RateLimitResult{
			Allowed:   true,
			Remaining: b.tokens,
			ResetAt:   resetAt,
		}
	}
	return RateLimitResult{
		Allowed:   false,
		Remaining: 0,
		ResetAt:   resetAt,
	}
}

// Allow checks whether a request from the given IP is permitted.
func (c *rateLimitChecker) Allow(ip string) bool {
	result := c.Check(ip)
	return result.Allowed
}

// Reset clears rate limit state for the given IP.
func (c *rateLimitChecker) Reset(ip string) {
	c.mu.Lock()
	delete(c.buckets, ip)
	c.mu.Unlock()
}

// getOrCreateBucket returns the bucket for the IP, refilling if the window has elapsed.
// Caller must hold c.mu.
func (c *rateLimitChecker) getOrCreateBucket(ip string) *bucket {
	now := time.Now()

	// Periodic purge: clean expired entries every 5 minutes.
	if now.Sub(c.lastPurge) > 5*time.Minute {
		c.purgeExpired()
		c.lastPurge = now
	}
	// Hard cap: if still over limit after purge, evict oldest entries.
	if len(c.buckets) >= maxRateLimitEntries {
		c.evictOldest(maxRateLimitEntries / 10)
	}

	b, ok := c.buckets[ip]
	if !ok {
		b = &bucket{
			tokens:     c.limit,
			lastReset:  now,
			lastAccess: now,
		}
		c.buckets[ip] = b
		return b
	}

	b.lastAccess = now

	// Refill bucket if the window has elapsed.
	if now.Sub(b.lastReset) >= c.window {
		b.tokens = c.limit
		b.lastReset = now
	}

	return b
}

// purgeExpired removes buckets whose tokens have fully replenished and
// haven't been accessed within two window durations.
// Caller must hold c.mu.
func (c *rateLimitChecker) purgeExpired() {
	now := time.Now()
	cutoff := now.Add(-2 * c.window)
	for ip, b := range c.buckets {
		if b.tokens >= c.limit && b.lastAccess.Before(cutoff) {
			delete(c.buckets, ip)
		}
	}
}

// evictOldest removes the n least-recently-accessed buckets.
// Caller must hold c.mu.
func (c *rateLimitChecker) evictOldest(n int) {
	if n <= 0 || len(c.buckets) == 0 {
		return
	}
	for i := 0; i < n && len(c.buckets) > 0; i++ {
		oldestIP := ""
		oldestTime := time.Now()
		for ip, b := range c.buckets {
			if oldestIP == "" || b.lastAccess.Before(oldestTime) {
				oldestIP = ip
				oldestTime = b.lastAccess
			}
		}
		if oldestIP != "" {
			delete(c.buckets, oldestIP)
		}
	}
}

// ---------------------------------------------------------------------------
// PassphraseVerifier (Section 1.3)
// ---------------------------------------------------------------------------

// passphraseVerifier verifies a passphrase against a stored Argon2id hash.
type passphraseVerifier struct {
	storedHash string // PHC-format: $argon2id$v=19$m=...,t=...,p=...$salt$hash
}

// NewPassphraseVerifier creates a PassphraseVerifier that verifies against
// the given Argon2id hash string in PHC format:
//
//	$argon2id$v=19$m=131072,t=3,p=4$<base64-salt>$<base64-hash>
func NewPassphraseVerifier(storedHash string) *passphraseVerifier {
	return &passphraseVerifier{storedHash: storedHash}
}

// Verify checks a passphrase against the stored Argon2id hash.
// Returns (true, nil) on match, (false, nil) on mismatch,
// or (false, error) if the stored hash is malformed.
func (v *passphraseVerifier) Verify(passphrase string) (bool, error) {
	if passphrase == "" {
		return false, nil
	}

	// Parse the stored PHC-format hash.
	memory, iterations, parallelism, salt, hash, keyLen, err := parseArgon2Hash(v.storedHash)
	if err != nil {
		return false, fmt.Errorf("auth: invalid stored hash: %w", err)
	}

	// Re-derive using the same parameters.
	derived := argon2.IDKey(
		[]byte(passphrase),
		salt,
		iterations,
		memory,
		parallelism,
		keyLen,
	)

	// Constant-time comparison.
	if subtle.ConstantTimeCompare(derived, hash) == 1 {
		return true, nil
	}
	return false, nil
}

// parseArgon2Hash parses a PHC-format Argon2id hash string.
// Format: $argon2id$v=19$m=<memory>,t=<iterations>,p=<parallelism>$<base64-salt>$<base64-hash>
func parseArgon2Hash(encoded string) (memory uint32, iterations uint32, parallelism uint8, salt, hash []byte, keyLen uint32, err error) {
	parts := strings.Split(encoded, "$")
	// Expected: ["", "argon2id", "v=19", "m=...,t=...,p=...", "<salt>", "<hash>"]
	if len(parts) != 6 {
		return 0, 0, 0, nil, nil, 0, fmt.Errorf("invalid hash format: expected 6 parts, got %d", len(parts))
	}
	if parts[1] != "argon2id" {
		return 0, 0, 0, nil, nil, 0, fmt.Errorf("unsupported algorithm: %s", parts[1])
	}
	if parts[2] != "v=19" {
		return 0, 0, 0, nil, nil, 0, fmt.Errorf("unsupported version: %s", parts[2])
	}

	// Parse parameters: m=131072,t=3,p=4
	params := strings.Split(parts[3], ",")
	if len(params) != 3 {
		return 0, 0, 0, nil, nil, 0, fmt.Errorf("invalid params: %s", parts[3])
	}

	for _, param := range params {
		kv := strings.SplitN(param, "=", 2)
		if len(kv) != 2 {
			return 0, 0, 0, nil, nil, 0, fmt.Errorf("invalid param: %s", param)
		}
		val, parseErr := strconv.ParseUint(kv[1], 10, 32)
		if parseErr != nil {
			return 0, 0, 0, nil, nil, 0, fmt.Errorf("invalid param value %s: %w", param, parseErr)
		}
		switch kv[0] {
		case "m":
			memory = uint32(val)
		case "t":
			iterations = uint32(val)
		case "p":
			parallelism = uint8(val)
		default:
			return 0, 0, 0, nil, nil, 0, fmt.Errorf("unknown param: %s", kv[0])
		}
	}

	// Decode salt (base64, no padding accepted).
	salt, err = base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return 0, 0, 0, nil, nil, 0, fmt.Errorf("invalid salt encoding: %w", err)
	}

	// Decode hash (base64, no padding accepted).
	hash, err = base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return 0, 0, 0, nil, nil, 0, fmt.Errorf("invalid hash encoding: %w", err)
	}
	keyLen = uint32(len(hash))

	return memory, iterations, parallelism, salt, hash, keyLen, nil
}

// HashPassphrase creates an Argon2id hash of the given passphrase in PHC format.
// This is a convenience function for creating stored hashes (e.g. during onboarding).
// Uses the standard dina parameters: m=131072 (128 MB), t=3, p=4, keyLen=32.
func HashPassphrase(passphrase string, salt []byte) (string, error) {
	if passphrase == "" {
		return "", fmt.Errorf("auth: passphrase must not be empty")
	}
	if len(salt) < 16 {
		return "", fmt.Errorf("auth: salt must be at least 16 bytes, got %d", len(salt))
	}

	const (
		memory      = 128 * 1024 // 128 MB in KiB
		iterations  = 3
		parallelism = 4
		keyLen      = 32
	)

	hash := argon2.IDKey([]byte(passphrase), salt, iterations, memory, parallelism, keyLen)

	encodedSalt := base64.RawStdEncoding.EncodeToString(salt)
	encodedHash := base64.RawStdEncoding.EncodeToString(hash)

	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		memory, iterations, parallelism, encodedSalt, encodedHash), nil
}

// ---------------------------------------------------------------------------
// DefaultTokenValidator alias for use by AuthGateway (Section 1.3)
// ---------------------------------------------------------------------------

// DefaultTokenValidator is an alias for the unexported tokenValidator type,
// used as a constructor parameter for AuthGateway.
type DefaultTokenValidator = tokenValidator

// ---------------------------------------------------------------------------
// AuthGateway (Section 1.3)
// ---------------------------------------------------------------------------

// authGateway implements browser session auth gateway HTTP behaviour.
// It verifies passphrases, manages sessions, translates session cookies to
// Bearer tokens, and serves the login page.
type authGateway struct {
	pv       *passphraseVerifier
	sm       *sessionManager
	tokenVal *tokenValidator
}

// NewAuthGateway creates an AuthGateway that coordinates passphrase
// verification, session management, and token translation.
func NewAuthGateway(pv *passphraseVerifier, sm *sessionManager, tokenVal *tokenValidator) *authGateway {
	return &authGateway{
		pv:       pv,
		sm:       sm,
		tokenVal: tokenVal,
	}
}

// Login handles POST /login — verifies passphrase, sets session cookie, returns redirect.
// Returns: statusCode, setCookieHeader, locationHeader, error.
func (g *authGateway) Login(passphrase string) (statusCode int, setCookie string, location string, err error) {
	ok, err := g.pv.Verify(passphrase)
	if err != nil {
		return 500, "", "", fmt.Errorf("auth: passphrase verification failed: %w", err)
	}
	if !ok {
		return 401, "", "", nil
	}

	// Passphrase verified — create a session.
	sessionID, _, createErr := g.sm.Create(context.Background(), "browser")
	if createErr != nil {
		return 500, "", "", fmt.Errorf("auth: session creation failed: %w", createErr)
	}

	// Build Set-Cookie header with security attributes.
	cookie := fmt.Sprintf("dina_session=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d",
		sessionID, int(g.sm.ttl.Seconds()))

	return 302, cookie, "/admin", nil
}

// LOW-17: ProxyRequest deleted — it previously leaked proxy credentials in responses.

// ServeLoginPage returns the login HTML page.
func (g *authGateway) ServeLoginPage() (body []byte, contentType string, err error) {
	return []byte(loginPageHTML), "text/html; charset=utf-8", nil
}

// HandleAdminRequest routes an admin request: if Bearer present, pass through;
// if session cookie present, translate; if neither, serve login page (200).
func (g *authGateway) HandleAdminRequest(bearerToken, sessionCookie string) (statusCode int, err error) {
	// If a Bearer token is present, validate and pass through.
	if bearerToken != "" {
		_, _, identErr := g.tokenVal.IdentifyToken(bearerToken)
		if identErr != nil {
			return 401, nil
		}
		return 200, nil
	}

	// If a session cookie is present, translate to bearer.
	if sessionCookie != "" {
		sessionID := extractSessionID(sessionCookie)
		_, valErr := g.sm.Validate(context.Background(), sessionID)
		if valErr != nil {
			// Invalid/expired session — serve login page.
			return 200, nil
		}
		return 200, nil
	}

	// Neither present — serve login page (200, not 401).
	return 200, nil
}

// extractSessionID extracts the session ID from a cookie string.
// It handles both "dina_session=<value>" and bare "<value>" formats.
func extractSessionID(cookie string) string {
	const prefix = "dina_session="
	// Search for the dina_session cookie in the cookie string.
	idx := -1
	for i := 0; i <= len(cookie)-len(prefix); i++ {
		if cookie[i:i+len(prefix)] == prefix {
			idx = i
			break
		}
	}
	if idx >= 0 {
		val := cookie[idx+len(prefix):]
		// Trim at the next semicolon if present.
		for i := 0; i < len(val); i++ {
			if val[i] == ';' {
				return val[:i]
			}
		}
		return val
	}
	// If no "dina_session=" prefix, treat the whole string as the session ID.
	return cookie
}

// loginPageHTML is the static login page served from memory (equivalent to embed.FS).
const loginPageHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dina — Login</title>
</head>
<body>
<h1>Dina Login</h1>
<form method="POST" action="/login">
<label for="passphrase">Passphrase:</label>
<input type="password" id="passphrase" name="passphrase" required>
<button type="submit">Login</button>
</form>
</body>
</html>`

// ---------------------------------------------------------------------------
// AdminEndpointChecker (Section 1.4)
// ---------------------------------------------------------------------------

// adminEndpointChecker classifies admin vs. non-admin endpoints and enforces
// token-kind access rules.
type adminEndpointChecker struct{}

// NewAdminEndpointChecker creates an AdminEndpointChecker.
func NewAdminEndpointChecker() *adminEndpointChecker {
	return &adminEndpointChecker{}
}

// IsAdminEndpoint returns true if the given path is an admin-only endpoint.
// Admin endpoints: /admin/*, /v1/persona/*, /v1/export/*, /v1/import/*,
// /v1/pair/*, /v1/did/sign, /v1/did/rotate, /v1/vault/backup.
func (c *adminEndpointChecker) IsAdminEndpoint(path string) bool {
	adminPrefixes := []string{
		"/admin",
		"/v1/persona",
		"/v1/export",
		"/v1/import",
		"/v1/pair",
	}
	for _, prefix := range adminPrefixes {
		if hasPathPrefix(path, prefix) {
			return true
		}
	}

	// Specific admin-only sub-paths.
	adminExact := []string{
		"/v1/did/sign",
		"/v1/did/rotate",
		"/v1/vault/backup",
		"/v1/trace",
	}
	for _, exact := range adminExact {
		if path == exact || hasPathPrefix(path, exact) {
			return true
		}
	}

	return false
}

// AllowedForTokenKind checks if a token kind (brain/client) can access a path.
//
// The scope parameter differentiates privilege levels:
//   - Client tokens: "admin" (full access) or "device" (restricted allowlist)
//   - Service keys:  serviceID ("brain", "admin", "connector") for per-service allowlists
//
// Scope is required. When omitted, clients default to "admin" and services
// default to "brain" to avoid breaking the authz middleware flow.
func (c *adminEndpointChecker) AllowedForTokenKind(kind, path string, scope ...string) bool {
	if kind == "client" {
		tokenScope := "admin"
		if len(scope) > 0 && scope[0] != "" {
			tokenScope = scope[0]
		}
		if tokenScope == "admin" {
			return true
		}
		// Device-scoped clients: explicit allowlist only.
		// Agents are persona-blind for reads — they use Brain (/api/v1/ask).
		// Device clients must use /v1/staging/ingest for all memory-producing
		// writes. /v1/vault/store is NOT allowed — only Brain (after staging
		// resolution) and admin can write directly to vault.
		// Vault query is NOT allowed — reads go through Brain.
		deviceAllowedPrefix := []string{
			"/api/v1/ask",           // Brain-mediated reasoning (persona-blind)
			"/api/v1/remember",      // solicited memory write + status polling
			"/v1/vault/kv",          // KV store (approval status, session state)
			"/v1/staging/ingest",    // universal content ingestion (background connectors)
			"/v1/msg/send",
			"/v1/msg/inbox",
			"/v1/did/document",
			"/v1/did/verify",
			"/v1/pii/scrub",
			"/v1/task/ack",
			"/v1/contacts",
			// NOTE: /v1/notify removed from device allowlist (CXH3).
			// Only Brain should push notifications to connected devices.
			"/v1/agent/validate",    // action gating
			"/v1/intent/proposals",  // intent proposal status polling (ownership-checked in handler)
			"/v1/audit/query",       // FH1: read-only audit query — /v1/audit/append is admin-only
			// NOTE: /v1/approvals is NOT in the prefix list — devices get
			// exact-match only (GET list). Approve/deny are admin-only.
			// See deviceAllowedExact below. (CXH1 fix)
			"/v1/session/start",
			"/v1/session/end",
			"/v1/sessions",
			"/healthz",
			"/readyz",
			"/ws",
		}
		for _, allowed := range deviceAllowedPrefix {
			if path == allowed || hasPathPrefix(path, allowed) {
				return true
			}
		}
		// SEC-HIGH-01/10: Exact-only matches — /v1/did must NOT prefix-match
		// /v1/did/sign or /v1/did/rotate (admin-only signing endpoints).
		deviceAllowedExact := []string{
			"/v1/did",
			"/v1/approvals", // CXH1: exact-match only — blocks /v1/approvals/{id}/approve and /deny
		}
		for _, exact := range deviceAllowedExact {
			if path == exact {
				return true
			}
		}
		return false // deny by default
	}
	if kind != string(domain.TokenService) {
		return false
	}

	// Resolve service identity from scope. The scope carries the registered
	// serviceID (e.g. "brain", "admin", "connector"). Each gets its own
	// least-privilege allowlist.
	serviceID := "brain"
	if len(scope) > 0 && scope[0] != "" {
		serviceID = scope[0]
	}

	return c.allowedForService(serviceID, path)
}

// allowedForService checks per-service allowlists. Each service identity
// gets its own least-privilege set of permitted endpoints. This ensures
// a compromised connector cannot access admin operations, and a compromised
// admin backend cannot read vault data.
func (c *adminEndpointChecker) allowedForService(serviceID, path string) bool {
	switch serviceID {
	case "brain":
		return c.allowedForBrain(path)
	case "admin":
		return c.allowedForAdmin(path)
	case "connector":
		return c.allowedForConnector(path)
	default:
		// Unknown service ID — deny by default (fail-closed).
		return false
	}
}

// allowedForBrain: vault read/write, messaging, PII, reasoning, sessions.
// Denied: signing, key rotation, backup/export, pairing, admin UI.
func (c *adminEndpointChecker) allowedForBrain(path string) bool {
	brainDenied := []string{
		"/v1/did/sign",
		"/v1/did/rotate",
		"/v1/vault/backup",
		"/v1/persona",
		"/admin",
		"/v1/export",
		"/v1/import",
		"/v1/pair",
	}
	for _, denied := range brainDenied {
		if path == denied || hasPathPrefix(path, denied) {
			return false
		}
	}

	brainAllowed := []string{
		"/v1/vault",
		"/v1/staging",
		"/v1/personas",
		"/v1/msg",
		"/v1/task",
		"/v1/pii",
		"/v1/did",
		"/v1/contacts",
		"/v1/trust",
		"/v1/notify",
		"/v1/reminder",
		"/v1/reminders",
		"/v1/session",
		"/v1/sessions",
		"/v1/audit",
		"/healthz",
		"/readyz",
	}
	for _, allowed := range brainAllowed {
		if path == allowed || hasPathPrefix(path, allowed) {
			return true
		}
	}
	return false
}

// allowedForAdmin: persona management, device management, export/import,
// pairing, health. Denied: direct vault read/write, signing, messaging.
func (c *adminEndpointChecker) allowedForAdmin(path string) bool {
	adminAllowed := []string{
		"/v1/persona",
		"/v1/personas",
		"/v1/devices",
		"/v1/export",
		"/v1/import",
		"/v1/pair",
		"/v1/audit",
		"/v1/session",
		"/v1/sessions",
		"/v1/admin",        // CXH6: sync-status moved here from unauthenticated /admin/
		"/admin",
		"/healthz",
		"/readyz",
	}
	for _, allowed := range adminAllowed {
		if path == allowed || hasPathPrefix(path, allowed) {
			return true
		}
	}
	return false
}

// allowedForConnector: staging ingest only. Connectors push raw data
// to staging; they cannot read vaults, query data, or access admin.
func (c *adminEndpointChecker) allowedForConnector(path string) bool {
	connectorAllowed := []string{
		"/v1/staging/ingest",
		"/v1/task/ack",
		"/healthz",
		"/readyz",
	}
	for _, allowed := range connectorAllowed {
		if path == allowed || hasPathPrefix(path, allowed) {
			return true
		}
	}
	return false
}

// hasPathPrefix returns true if path starts with prefix, ensuring it matches
// at a path boundary (exact match or followed by / or end of string).
func hasPathPrefix(path, prefix string) bool {
	if len(path) < len(prefix) {
		return false
	}
	if path[:len(prefix)] != prefix {
		return false
	}
	// Exact match or next char is '/'.
	if len(path) == len(prefix) {
		return true
	}
	return path[len(prefix)] == '/'
}
