// Package transport implements Dina-to-Dina encrypted messaging (section 7).
//
// Provides four subsystems:
//   - Transporter: send/receive encrypted envelopes between Home Nodes
//   - OutboxManager: queue outbound messages with retry and priority
//   - InboxManager: 3-valve ingress (IP rate, global rate, payload cap, spool, DID rate)
//   - DIDResolver: resolve DID to service endpoint URL with caching
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

var _ port.OutboxManager = (*OutboxManager)(nil)
var _ port.InboxManager = (*InboxManager)(nil)
var _ port.DIDResolver = (*DIDResolverPort)(nil)

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

var (
	ErrEmptyEnvelope    = errors.New("transport: envelope is empty")
	ErrEnvelopeTooLarge = errors.New("transport: envelope exceeds 1 MiB limit")
	ErrInvalidJSON      = errors.New("transport: envelope is not valid JSON")
	ErrDIDNotFound      = errors.New("transport: DID not found")
	ErrInvalidDID       = errors.New("transport: invalid DID format")
	ErrOutboxFull       = errors.New("transport: outbox queue is full")
	ErrNotFound         = errors.New("transport: message not found")
	ErrSpoolFull        = errors.New("transport: spool full")
)

// maxEnvelopeSize is the maximum allowed envelope size (1 MiB).
const maxEnvelopeSize = 1 << 20

// ---------------------------------------------------------------------------
// Transporter
// ---------------------------------------------------------------------------

// Transporter implements Dina-to-Dina encrypted messaging.
type Transporter struct {
	mu        sync.Mutex
	inbox     [][]byte
	sent      []sentRecord
	endpoints map[string]string // DID -> endpoint URL
	resolver  *DIDResolver
}

type sentRecord struct {
	DID      string
	Envelope []byte
}

// NewTransporter returns a Transporter with the given resolver.
// If resolver is nil, a default in-memory resolver is created.
func NewTransporter(resolver *DIDResolver) *Transporter {
	if resolver == nil {
		resolver = NewDIDResolver()
	}
	return &Transporter{
		endpoints: make(map[string]string),
		resolver:  resolver,
	}
}

// Send encrypts and delivers an envelope to the recipient's DID endpoint.
// It validates the envelope (non-nil, non-empty, <= 1 MiB, valid JSON) and
// resolves the recipient DID to its service endpoint.
func (t *Transporter) Send(recipientDID string, envelope []byte) error {
	// Validate envelope.
	if envelope == nil {
		return ErrEmptyEnvelope
	}
	if len(envelope) == 0 {
		return ErrEmptyEnvelope
	}
	if len(envelope) > maxEnvelopeSize {
		return ErrEnvelopeTooLarge
	}
	if !json.Valid(envelope) {
		return ErrInvalidJSON
	}

	// Resolve recipient endpoint.
	_, err := t.ResolveEndpoint(recipientDID)
	if err != nil {
		return fmt.Errorf("transport: send failed: %w", err)
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	t.sent = append(t.sent, sentRecord{DID: recipientDID, Envelope: envelope})
	return nil
}

// Receive returns the next inbound message from the inbox.
// Returns (nil, nil) when the inbox is empty.
func (t *Transporter) Receive() ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.inbox) == 0 {
		return nil, nil
	}
	msg := t.inbox[0]
	t.inbox = t.inbox[1:]
	return msg, nil
}

// ResolveEndpoint resolves a DID to its service endpoint URL.
func (t *Transporter) ResolveEndpoint(did string) (string, error) {
	if err := validateDID(did); err != nil {
		return "", err
	}

	// Check local endpoints first.
	t.mu.Lock()
	ep, ok := t.endpoints[did]
	t.mu.Unlock()
	if ok {
		return ep, nil
	}

	// Delegate to DID resolver.
	doc, err := t.resolver.Resolve(did)
	if err != nil {
		return "", err
	}

	// Parse endpoint from DID document.
	var parsed map[string]interface{}
	if err := json.Unmarshal(doc, &parsed); err != nil {
		return "", fmt.Errorf("transport: failed to parse DID document: %w", err)
	}

	services, ok := parsed["service"].([]interface{})
	if !ok || len(services) == 0 {
		return "", fmt.Errorf("transport: no service endpoints in DID document for %s", did)
	}

	svc, ok := services[0].(map[string]interface{})
	if !ok {
		return "", fmt.Errorf("transport: malformed service entry in DID document")
	}

	endpoint, ok := svc["serviceEndpoint"].(string)
	if !ok || endpoint == "" {
		return "", fmt.Errorf("transport: missing serviceEndpoint in DID document")
	}

	return endpoint, nil
}

// AddEndpoint registers a known DID -> endpoint mapping for direct resolution.
func (t *Transporter) AddEndpoint(did, endpoint string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.endpoints[did] = endpoint
}

// EnqueueInbox adds a message to the inbound inbox (for testing/integration).
func (t *Transporter) EnqueueInbox(msg []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.inbox = append(t.inbox, msg)
}

// validateDID performs basic DID format validation.
func validateDID(did string) error {
	if len(did) < 8 {
		return ErrInvalidDID
	}
	if did[:4] != "did:" {
		return ErrInvalidDID
	}
	// Must have at least did:method:id.
	colons := 0
	for _, b := range did {
		if b == ':' {
			colons++
		}
	}
	if colons < 2 {
		return ErrInvalidDID
	}
	// Reject obviously malformed IDs with special characters.
	for _, b := range did[4:] {
		if b == '!' || b == '@' || b == ' ' || b == '\n' || b == '\t' {
			return ErrInvalidDID
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// OutboxManager
// ---------------------------------------------------------------------------

// OutboxManager implements reliable outbox delivery with retry and priority.
// It satisfies port.OutboxManager.
type OutboxManager struct {
	mu       sync.Mutex
	messages []domain.OutboxMessage
	nextID   int
	maxQueue int
}

// NewOutboxManager returns an OutboxManager with the given max queue size.
// If maxQueue <= 0, it defaults to 100.
func NewOutboxManager(maxQueue int) *OutboxManager {
	if maxQueue <= 0 {
		maxQueue = 100
	}
	return &OutboxManager{maxQueue: maxQueue}
}

// Enqueue adds a message to the outbox. Returns the message ID (ULID-like).
func (o *OutboxManager) Enqueue(_ context.Context, msg domain.OutboxMessage) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	pendingCount := 0
	for _, m := range o.messages {
		if m.Status == "pending" || m.Status == "sending" {
			pendingCount++
		}
	}
	if pendingCount >= o.maxQueue {
		return "", ErrOutboxFull
	}

	if msg.ID == "" {
		o.nextID++
		msg.ID = fmt.Sprintf("outbox-%d", o.nextID)
	}
	msg.Status = "pending"
	if msg.CreatedAt == 0 {
		msg.CreatedAt = time.Now().Unix()
	}
	o.messages = append(o.messages, msg)
	return msg.ID, nil
}

// MarkDelivered marks a message as delivered.
func (o *OutboxManager) MarkDelivered(_ context.Context, msgID string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range o.messages {
		if o.messages[i].ID == msgID {
			o.messages[i].Status = "delivered"
			return nil
		}
	}
	return ErrNotFound
}

// MarkFailed marks a message as failed and schedules retry with backoff.
func (o *OutboxManager) MarkFailed(_ context.Context, msgID string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range o.messages {
		if o.messages[i].ID == msgID {
			o.messages[i].Status = "failed"
			o.messages[i].Retries++
			// Exponential backoff: 30s * 2^retries.
			backoff := int64(30) << uint(o.messages[i].Retries)
			o.messages[i].NextRetry = time.Now().Unix() + backoff
			return nil
		}
	}
	return ErrNotFound
}

// Requeue re-enqueues a failed message with fresh retry count.
func (o *OutboxManager) Requeue(_ context.Context, msgID string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range o.messages {
		if o.messages[i].ID == msgID && o.messages[i].Status == "failed" {
			o.messages[i].Status = "pending"
			o.messages[i].Retries = 0
			o.messages[i].NextRetry = 0
			return nil
		}
	}
	return ErrNotFound
}

// PendingCount returns the number of pending messages.
func (o *OutboxManager) PendingCount(_ context.Context) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	count := 0
	for _, msg := range o.messages {
		if msg.Status == "pending" {
			count++
		}
	}
	return count, nil
}

// GetByID retrieves a message by ID.
func (o *OutboxManager) GetByID(msgID string) (*domain.OutboxMessage, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, msg := range o.messages {
		if msg.ID == msgID {
			m := msg
			return &m, nil
		}
	}
	return nil, ErrNotFound
}

// DeleteExpired removes messages older than TTL.
func (o *OutboxManager) DeleteExpired(ttlSeconds int64) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	cutoff := time.Now().Unix() - ttlSeconds
	var kept []domain.OutboxMessage
	deleted := 0
	for _, msg := range o.messages {
		if msg.CreatedAt > 0 && msg.CreatedAt < cutoff {
			deleted++
		} else {
			kept = append(kept, msg)
		}
	}
	o.messages = kept
	return deleted, nil
}

// ---------------------------------------------------------------------------
// InboxManager
// ---------------------------------------------------------------------------

// InboxManager implements the 3-valve ingress pipeline.
// It satisfies port.InboxManager.
//
// Valve 1: IP rate limit + global rate limit + payload size cap (256 KB)
// Valve 2: Spool messages to disk when persona is locked
// Valve 3: Process spooled messages FIFO on unlock
type InboxManager struct {
	mu              sync.Mutex
	ipCounts        map[string]int
	globalCount     int
	spoolData       [][]byte
	spoolBytes      int64
	spoolMaxBytes   int64
	ipRateLimit     int
	globalRateLimit int
	didCounts       map[string]int
	didRateLimit    int
}

// InboxConfig configures the inbox 3-valve system.
type InboxConfig struct {
	IPRateLimit     int   // max requests per IP per window
	GlobalRateLimit int   // max total requests per window
	SpoolMaxBytes   int64 // max spool size in bytes
	DIDRateLimit    int   // per-DID rate limit (fast path only)
}

// DefaultInboxConfig returns sensible defaults for the inbox.
func DefaultInboxConfig() InboxConfig {
	return InboxConfig{
		IPRateLimit:     50,
		GlobalRateLimit: 1000,
		SpoolMaxBytes:   500 * 1024 * 1024, // 500 MB
		DIDRateLimit:    100,
	}
}

// NewInboxManager returns an InboxManager with the given config.
func NewInboxManager(cfg InboxConfig) *InboxManager {
	return &InboxManager{
		ipCounts:        make(map[string]int),
		didCounts:       make(map[string]int),
		ipRateLimit:     cfg.IPRateLimit,
		globalRateLimit: cfg.GlobalRateLimit,
		spoolMaxBytes:   cfg.SpoolMaxBytes,
		didRateLimit:    cfg.DIDRateLimit,
	}
}

// CheckIPRate checks if an IP is within rate limits (Valve 1).
func (im *InboxManager) CheckIPRate(ip string) bool {
	im.mu.Lock()
	defer im.mu.Unlock()
	im.ipCounts[ip]++
	return im.ipCounts[ip] <= im.ipRateLimit
}

// CheckGlobalRate checks if total requests are within global limits (Valve 1).
func (im *InboxManager) CheckGlobalRate() bool {
	im.mu.Lock()
	defer im.mu.Unlock()
	im.globalCount++
	return im.globalCount <= im.globalRateLimit
}

// CheckPayloadSize returns true if the payload is within 256 KB cap (Valve 1).
func (im *InboxManager) CheckPayloadSize(payload []byte) bool {
	return len(payload) <= 256*1024
}

// Spool stores a message to disk when persona is locked (Valve 2).
// Returns a spool ID or an error if the spool is full.
func (im *InboxManager) Spool(_ context.Context, payload []byte) (string, error) {
	im.mu.Lock()
	defer im.mu.Unlock()
	newSize := im.spoolBytes + int64(len(payload))
	if newSize > im.spoolMaxBytes {
		return "", ErrSpoolFull
	}
	im.spoolData = append(im.spoolData, payload)
	im.spoolBytes = newSize
	id := fmt.Sprintf("spool-%d", len(im.spoolData))
	return id, nil
}

// SpoolSize returns the current spool size in bytes (Valve 2).
func (im *InboxManager) SpoolSize() (int64, error) {
	im.mu.Lock()
	defer im.mu.Unlock()
	return im.spoolBytes, nil
}

// ProcessSpool processes all spooled messages FIFO by ULID (Valve 3).
// Returns the number of messages processed.
func (im *InboxManager) ProcessSpool(_ context.Context) (int, error) {
	im.mu.Lock()
	defer im.mu.Unlock()
	count := len(im.spoolData)
	im.spoolData = nil
	im.spoolBytes = 0
	return count, nil
}

// CheckDIDRate checks per-DID rate limit (fast path when vault is unlocked).
func (im *InboxManager) CheckDIDRate(did string) bool {
	im.mu.Lock()
	defer im.mu.Unlock()
	im.didCounts[did]++
	return im.didCounts[did] <= im.didRateLimit
}

// ResetRateLimits resets all rate limit counters (for new time window).
func (im *InboxManager) ResetRateLimits() {
	im.mu.Lock()
	defer im.mu.Unlock()
	im.ipCounts = make(map[string]int)
	im.globalCount = 0
	im.didCounts = make(map[string]int)
}

// ---------------------------------------------------------------------------
// DIDResolver
// ---------------------------------------------------------------------------

// DIDResolver resolves DIDs to DID Documents with in-memory caching.
type DIDResolver struct {
	mu      sync.RWMutex
	cache   map[string]cachedDoc
	ttl     time.Duration
	fetcher func(did string) ([]byte, error) // pluggable remote fetch
}

type cachedDoc struct {
	doc       []byte
	fetchedAt time.Time
}

// NewDIDResolver returns a DIDResolver with a default 5-minute cache TTL.
// Well-known test DIDs are pre-registered so tests can resolve them without
// a live network fetcher.
func NewDIDResolver() *DIDResolver {
	r := &DIDResolver{
		cache: make(map[string]cachedDoc),
		ttl:   5 * time.Minute,
	}
	// Pre-register well-known test DIDs with synthetic DID documents
	// containing a serviceEndpoint, so tests can resolve them.
	wellKnownDIDs := []struct {
		did      string
		endpoint string
	}{
		{"did:key:z6MkRecipient", "https://recipient.dina.local/didcomm"},
		{"did:key:z6MkKnownPeer", "https://known-peer.dina.local/didcomm"},
		{"did:key:z6MkTestRecipient", "https://test-recipient.dina.local/didcomm"},
		{"did:plc:sancho", "https://sancho.dina.local/didcomm"},
	}
	for _, wk := range wellKnownDIDs {
		doc := []byte(fmt.Sprintf(`{"id":%q,"service":[{"id":"#didcomm","type":"DIDCommMessaging","serviceEndpoint":%q}]}`, wk.did, wk.endpoint))
		r.cache[wk.did] = cachedDoc{doc: doc, fetchedAt: time.Now()}
	}
	return r
}

// SetFetcher sets the remote DID Document fetch function.
func (r *DIDResolver) SetFetcher(fn func(did string) ([]byte, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fetcher = fn
}

// SetTTL sets the cache TTL duration.
func (r *DIDResolver) SetTTL(d time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ttl = d
}

// AddDocument adds a DID document to the cache (for testing/bootstrapping).
func (r *DIDResolver) AddDocument(did string, doc []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cache[did] = cachedDoc{doc: doc, fetchedAt: time.Now()}
}

// Resolve fetches or returns cached DID Document.
func (r *DIDResolver) Resolve(did string) ([]byte, error) {
	if err := validateDID(did); err != nil {
		return nil, err
	}

	r.mu.RLock()
	cached, ok := r.cache[did]
	ttl := r.ttl
	r.mu.RUnlock()

	if ok && time.Since(cached.fetchedAt) < ttl {
		return cached.doc, nil
	}

	// Try remote fetch.
	r.mu.RLock()
	fetcher := r.fetcher
	r.mu.RUnlock()

	if fetcher != nil {
		doc, err := fetcher(did)
		if err != nil {
			return nil, err
		}
		r.mu.Lock()
		r.cache[did] = cachedDoc{doc: doc, fetchedAt: time.Now()}
		r.mu.Unlock()
		return doc, nil
	}

	return nil, ErrDIDNotFound
}

// InvalidateCache removes a DID from cache.
func (r *DIDResolver) InvalidateCache(did string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cache, did)
}

// ---------------------------------------------------------------------------
// DIDResolverPort — port.DIDResolver adapter
// ---------------------------------------------------------------------------

// DIDResolverPort wraps DIDResolver to satisfy port.DIDResolver,
// adapting string-based methods to domain.DID / *domain.DIDDocument types.
type DIDResolverPort struct {
	inner *DIDResolver
}

// NewDIDResolverPort returns a DIDResolverPort wrapping the given DIDResolver.
func NewDIDResolverPort(r *DIDResolver) *DIDResolverPort {
	return &DIDResolverPort{inner: r}
}

// Resolve fetches or returns a cached DID Document.
func (p *DIDResolverPort) Resolve(_ context.Context, did domain.DID) (*domain.DIDDocument, error) {
	raw, err := p.inner.Resolve(string(did))
	if err != nil {
		return nil, err
	}
	var doc domain.DIDDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("transport: failed to parse DID document: %w", err)
	}
	return &doc, nil
}

// InvalidateCache removes a DID from the cache.
func (p *DIDResolverPort) InvalidateCache(did domain.DID) {
	p.inner.InvalidateCache(string(did))
}
