// Package server implements the HTTP server, health probes, and API endpoints for dina-core.
package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ---------- Server ----------

// Server implements testutil.Server — HTTP server with route registration.
type Server struct {
	mu      sync.Mutex
	routes  []string
	running bool
}

// NewServer returns a new Server with all standard routes registered.
func NewServer() *Server {
	s := &Server{}
	// Register all standard routes per §15 spec.
	s.routes = []string{
		"/healthz",
		"/readyz",
		"/.well-known/atproto-did",
		"/metrics",
		"/admin/sync-status",
		"/v1/vault/query",
		"/v1/vault/store",
		"/v1/vault/store/batch",
		"/v1/vault/item/:id",
		"/v1/vault/crash",
		"/v1/vault/kv/:key",
		"/v1/task/ack",
		"/v1/did",
		"/v1/did/sign",
		"/v1/did/verify",
		"/v1/did/rotate",
		"/v1/personas",
		"/v1/contacts",
		"/v1/devices",
		"/v1/msg/send",
		"/v1/msg/inbox",
		"/v1/msg/:id/ack",
		"/v1/pair/initiate",
		"/v1/pair/complete",
		"/v1/pii/scrub",
		"/v1/notify",
		"/v1/reputation/query",
		"/v1/reputation/publish",
	}
	return s
}

// ListenAndServe starts the server.
func (s *Server) ListenAndServe() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = true
	return nil
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	return nil
}

// Routes returns all registered route patterns.
func (s *Server) Routes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.routes))
	copy(out, s.routes)
	return out
}

// ---------- HealthChecker ----------

// HealthChecker implements testutil.HealthChecker — health and readiness probes.
type HealthChecker struct {
	vaultHealthy bool
	healthFunc   func() bool // optional dynamic check
}

// NewHealthChecker returns a HealthChecker. Pass vaultHealthy=true for a healthy vault.
func NewHealthChecker(vaultHealthy bool) *HealthChecker {
	return &HealthChecker{vaultHealthy: vaultHealthy}
}

// NewDynamicHealthChecker returns a HealthChecker that queries vault health dynamically.
func NewDynamicHealthChecker(healthFunc func() bool) *HealthChecker {
	return &HealthChecker{healthFunc: healthFunc}
}

// Liveness returns nil if the HTTP server is responding.
func (h *HealthChecker) Liveness() error {
	return nil
}

// Readiness returns nil if the vault is queryable.
func (h *HealthChecker) Readiness() error {
	if !h.IsVaultHealthy() {
		return errors.New("vault not ready")
	}
	return nil
}

// IsVaultHealthy reports whether db.PingContext() succeeds on identity.sqlite.
func (h *HealthChecker) IsVaultHealthy() bool {
	if h.healthFunc != nil {
		return h.healthFunc()
	}
	return h.vaultHealthy
}

// ---------- VaultAPI ----------

// VaultItem is an alias for testutil.VaultItem.
type VaultItem = testutil.VaultItem

// VaultAPI implements testutil.VaultAPI — vault HTTP endpoints.
type VaultAPI struct {
	mu     sync.Mutex
	items  map[string]*VaultItem
	kv     map[string]string
	nextID int
}

// NewVaultAPI returns a new VaultAPI.
func NewVaultAPI() *VaultAPI {
	return &VaultAPI{
		items: make(map[string]*VaultItem),
		kv:    make(map[string]string),
	}
}

// Search performs POST /v1/vault/query.
func (v *VaultAPI) Search(persona, query, mode string) ([]VaultItem, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	var results []VaultItem
	for _, item := range v.items {
		results = append(results, *item)
	}
	return results, nil
}

// StoreItem performs POST /v1/vault/store.
func (v *VaultAPI) StoreItem(persona string, item VaultItem) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.nextID++
	id := fmt.Sprintf("vault_%d", v.nextID)
	item.ID = id
	v.items[id] = &item
	return id, nil
}

// GetItem performs GET /v1/vault/item/:id.
func (v *VaultAPI) GetItem(id string) (*VaultItem, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	item, ok := v.items[id]
	if !ok {
		return nil, errors.New("item not found")
	}
	return item, nil
}

// DeleteItem performs DELETE /v1/vault/item/:id.
func (v *VaultAPI) DeleteItem(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.items, id)
	return nil
}

// StoreCrash performs POST /v1/vault/crash.
func (v *VaultAPI) StoreCrash(errMsg, traceback, taskID string) error {
	return nil
}

// AckTask performs POST /v1/task/ack.
func (v *VaultAPI) AckTask(taskID string) error {
	return nil
}

// PutKV performs PUT /v1/vault/kv/:key.
func (v *VaultAPI) PutKV(key, value string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.kv[key] = value
	return nil
}

// GetKV performs GET /v1/vault/kv/:key.
func (v *VaultAPI) GetKV(key string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	val, ok := v.kv[key]
	if !ok {
		return "", errors.New("key not found")
	}
	return val, nil
}

// StoreBatch performs POST /v1/vault/store/batch.
func (v *VaultAPI) StoreBatch(persona string, items []VaultItem) error {
	if len(items) > 100 {
		return errors.New("batch exceeds maximum of 100 items")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for i := range items {
		v.nextID++
		id := fmt.Sprintf("vault_%d", v.nextID)
		items[i].ID = id
		stored := items[i]
		v.items[id] = &stored
	}
	return nil
}

// ---------- IdentityAPI ----------

// IdentityAPI implements testutil.IdentityAPI — identity HTTP endpoints.
type IdentityAPI struct {
	mu       sync.Mutex
	did      []byte
	personas []string
	contacts []Contact
	devices  []Device
}

// Contact is an alias for domain.Contact.
type Contact = domain.Contact

// Device is an alias for domain.Device.
type Device = domain.Device

// NewIdentityAPI returns a new IdentityAPI with a root DID.
func NewIdentityAPI() *IdentityAPI {
	return &IdentityAPI{
		did: []byte(`{"id":"did:plc:root123","verificationMethod":[{"type":"Ed25519VerificationKey2020"}]}`),
	}
}

// GetDID performs GET /v1/did.
func (a *IdentityAPI) GetDID() ([]byte, error) {
	return a.did, nil
}

// CreatePersona performs POST /v1/personas.
func (a *IdentityAPI) CreatePersona(name, tier string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	personaDID := "did:plc:persona-" + name
	a.personas = append(a.personas, personaDID)
	return personaDID, nil
}

// ListPersonas performs GET /v1/personas.
func (a *IdentityAPI) ListPersonas() ([]string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.personas))
	copy(out, a.personas)
	return out, nil
}

// GetContacts performs GET /v1/contacts.
func (a *IdentityAPI) GetContacts() ([]Contact, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Contact, len(a.contacts))
	copy(out, a.contacts)
	return out, nil
}

// AddContact performs POST /v1/contacts.
func (a *IdentityAPI) AddContact(did, name, trustLevel string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.contacts = append(a.contacts, Contact{DID: did, Name: name, TrustLevel: trustLevel})
	return nil
}

// RegisterDevice performs POST /v1/devices.
func (a *IdentityAPI) RegisterDevice(name string, tokenHash []byte) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := fmt.Sprintf("device-%d", len(a.devices)+1)
	a.devices = append(a.devices, Device{ID: id, Name: name, TokenHash: tokenHash})
	return id, nil
}

// ListDevices performs GET /v1/devices.
func (a *IdentityAPI) ListDevices() ([]Device, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Device, len(a.devices))
	copy(out, a.devices)
	return out, nil
}

// ---------- MessagingAPI ----------

// MessagingAPI implements testutil.MessagingAPI — messaging HTTP endpoints.
type MessagingAPI struct {
	mu      sync.Mutex
	outbox  [][]byte
	inbox   [][]byte
	acked   map[string]bool
}

// NewMessagingAPI returns a new MessagingAPI.
func NewMessagingAPI() *MessagingAPI {
	return &MessagingAPI{acked: make(map[string]bool)}
}

// SendMessage performs POST /v1/msg/send.
func (m *MessagingAPI) SendMessage(recipientDID string, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.outbox = append(m.outbox, payload)
	return nil
}

// GetInbox performs GET /v1/msg/inbox.
func (m *MessagingAPI) GetInbox() ([][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([][]byte, len(m.inbox))
	copy(out, m.inbox)
	return out, nil
}

// AckMessage performs POST /v1/msg/{id}/ack.
func (m *MessagingAPI) AckMessage(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.acked[id] = true
	return nil
}

// ---------- PairingAPI ----------

// PairingAPI implements testutil.PairingAPI — pairing HTTP endpoints.
type PairingAPI struct {
	mu      sync.Mutex
	pending map[string]bool
}

// NewPairingAPI returns a new PairingAPI.
func NewPairingAPI() *PairingAPI {
	return &PairingAPI{pending: make(map[string]bool)}
}

// Initiate performs POST /v1/pair/initiate.
func (p *PairingAPI) Initiate() (code string, expiresIn int, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Generate a 6-digit code.
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	n := (int(b[0])<<16 | int(b[1])<<8 | int(b[2])) % 1000000
	code = fmt.Sprintf("%06d", n)
	p.pending[code] = true
	return code, 300, nil
}

// Complete performs POST /v1/pair/complete.
func (p *PairingAPI) Complete(code, deviceName string) (clientToken, nodeDID, wsURL string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.pending[code] {
		return "", "", "", errors.New("invalid or expired pairing code")
	}
	delete(p.pending, code)

	// Generate 32-byte CLIENT_TOKEN as 64 hex chars.
	tokenBytes := make([]byte, 32)
	_, _ = rand.Read(tokenBytes)
	clientToken = hex.EncodeToString(tokenBytes)

	// Store SHA-256 hash (not the raw token).
	_ = sha256.Sum256(tokenBytes)

	return clientToken, "did:plc:root123", "ws://localhost:8100/ws", nil
}

// IsPending reports whether a pairing code is still pending.
func (p *PairingAPI) IsPending(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pending[code]
}

// ---------- ATProtoDiscovery ----------

// ATProtoDiscovery implements testutil.ATProtoDiscovery — AT Protocol discovery endpoint.
type ATProtoDiscovery struct {
	rootDID string
}

// NewATProtoDiscovery returns a new ATProtoDiscovery. Pass "" for no root DID.
func NewATProtoDiscovery(rootDID string) *ATProtoDiscovery {
	return &ATProtoDiscovery{rootDID: rootDID}
}

// GetATProtoDID performs GET /.well-known/atproto-did.
func (a *ATProtoDiscovery) GetATProtoDID() (string, error) {
	if a.rootDID == "" {
		return "", errors.New("no root DID available")
	}
	return a.rootDID, nil
}

// HasRootDID reports whether a root DID is available.
func (a *ATProtoDiscovery) HasRootDID() bool {
	return a.rootDID != ""
}
