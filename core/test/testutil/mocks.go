package testutil

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
)

// Sentinel errors for mock implementations.
var (
	ErrNotImplemented = errors.New("not yet implemented")
	ErrInvalidToken   = errors.New("invalid token")
	ErrPersonaLocked  = errors.New("persona locked — DEK not in RAM")
	ErrNotFound       = errors.New("not found")
	ErrForbidden      = errors.New("forbidden")
	ErrInvalidInput   = errors.New("invalid input")
)

// ---------- Mock Mnemonic Generator ----------

// MockMnemonicGenerator returns deterministic test data.
type MockMnemonicGenerator struct {
	GenerateMnemonic string
	GenerateSeed     []byte
	GenerateErr      error
	ValidateErr      error
	ToSeedResult     []byte
	ToSeedErr        error
}

func (m *MockMnemonicGenerator) Generate() (string, []byte, error) {
	return m.GenerateMnemonic, m.GenerateSeed, m.GenerateErr
}

func (m *MockMnemonicGenerator) Validate(mnemonic string) error {
	return m.ValidateErr
}

func (m *MockMnemonicGenerator) ToSeed(mnemonic, passphrase string) ([]byte, error) {
	return m.ToSeedResult, m.ToSeedErr
}

// ---------- Mock Key Deriver ----------

// MockKeyDeriver returns deterministic keys.
type MockKeyDeriver struct {
	DeriveVaultDEKResult []byte
	DeriveVaultDEKErr    error
	DeriveKEKResult      []byte
	DeriveKEKErr         error
	// Track calls for determinism/isolation assertions.
	VaultDEKCalls []string // persona IDs passed
}

func (m *MockKeyDeriver) DeriveVaultDEK(masterSeed []byte, personaID string, userSalt []byte) ([]byte, error) {
	m.VaultDEKCalls = append(m.VaultDEKCalls, personaID)
	return m.DeriveVaultDEKResult, m.DeriveVaultDEKErr
}

func (m *MockKeyDeriver) DerivePassphraseKEK(passphrase string, salt []byte) ([]byte, error) {
	return m.DeriveKEKResult, m.DeriveKEKErr
}

// ---------- Mock Signer ----------

// MockSigner returns deterministic signatures.
type MockSigner struct {
	Pub           []byte
	Priv          []byte
	GenerateErr   error
	SignResult    []byte
	SignErr       error
	VerifyResult  bool
	VerifyErr     error
}

func (m *MockSigner) GenerateFromSeed(seed []byte) ([]byte, []byte, error) {
	return m.Pub, m.Priv, m.GenerateErr
}

func (m *MockSigner) Sign(privateKey, message []byte) ([]byte, error) {
	return m.SignResult, m.SignErr
}

func (m *MockSigner) Verify(publicKey, message, signature []byte) (bool, error) {
	return m.VerifyResult, m.VerifyErr
}

// ---------- Mock DID Manager ----------

// MockDIDManager tracks DID operations.
type MockDIDManager struct {
	CreateDID    domain.DID
	CreateErr    error
	ResolveDoc   []byte
	ResolveErr   error
	RotateErr    error
	Created      [][]byte // public keys used in Create calls
}

func (m *MockDIDManager) Create(_ context.Context, publicKey []byte) (domain.DID, error) {
	m.Created = append(m.Created, publicKey)
	return m.CreateDID, m.CreateErr
}

func (m *MockDIDManager) Resolve(_ context.Context, did domain.DID) ([]byte, error) {
	return m.ResolveDoc, m.ResolveErr
}

func (m *MockDIDManager) Rotate(_ context.Context, did domain.DID, oldPrivKey, newPubKey []byte) error {
	return m.RotateErr
}

// ---------- Mock Persona Manager ----------

// MockPersonaManager tracks persona state.
type MockPersonaManager struct {
	mu       sync.RWMutex
	Personas map[string]bool // personaID → isLocked
	CreateID string
	CreateErr error
}

func NewMockPersonaManager() *MockPersonaManager {
	return &MockPersonaManager{Personas: make(map[string]bool)}
}

func (m *MockPersonaManager) Create(_ context.Context, name, tier string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.CreateErr != nil {
		return "", m.CreateErr
	}
	id := "persona-" + name
	locked := tier == "locked"
	m.Personas[id] = locked
	return id, nil
}

func (m *MockPersonaManager) List(_ context.Context) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var ids []string
	for id := range m.Personas {
		ids = append(ids, id)
	}
	return ids, nil
}

func (m *MockPersonaManager) Unlock(_ context.Context, personaID, passphrase string, ttlSeconds int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.Personas[personaID]; !ok {
		return ErrNotFound
	}
	m.Personas[personaID] = false
	return nil
}

func (m *MockPersonaManager) Lock(_ context.Context, personaID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.Personas[personaID]; !ok {
		return ErrNotFound
	}
	m.Personas[personaID] = true
	return nil
}

func (m *MockPersonaManager) IsLocked(personaID string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	locked, ok := m.Personas[personaID]
	if !ok {
		return false, ErrNotFound
	}
	return locked, nil
}

func (m *MockPersonaManager) Delete(_ context.Context, personaID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.Personas, personaID)
	return nil
}

// ---------- Mock Vault Manager ----------

// MockVaultManager stores items in memory.
type MockVaultManager struct {
	mu     sync.RWMutex
	Open_  map[string]bool            // personaID → isOpen
	Items  map[string]map[string]VaultItem // personaID → itemID → item
}

func NewMockVaultManager() *MockVaultManager {
	return &MockVaultManager{
		Open_: make(map[string]bool),
		Items: make(map[string]map[string]VaultItem),
	}
}

func (m *MockVaultManager) Open(personaID string, dek []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Open_[personaID] = true
	if m.Items[personaID] == nil {
		m.Items[personaID] = make(map[string]VaultItem)
	}
	return nil
}

func (m *MockVaultManager) Close(personaID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.Open_, personaID)
	return nil
}

func (m *MockVaultManager) Store(personaID string, item VaultItem) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.Open_[personaID] {
		return "", ErrPersonaLocked
	}
	if m.Items[personaID] == nil {
		m.Items[personaID] = make(map[string]VaultItem)
	}
	m.Items[personaID][item.ID] = item
	return item.ID, nil
}

func (m *MockVaultManager) StoreBatch(personaID string, items []VaultItem) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.Open_[personaID] {
		return ErrPersonaLocked
	}
	if m.Items[personaID] == nil {
		m.Items[personaID] = make(map[string]VaultItem)
	}
	for _, item := range items {
		m.Items[personaID][item.ID] = item
	}
	return nil
}

func (m *MockVaultManager) Retrieve(personaID, itemID string) (*VaultItem, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if !m.Open_[personaID] {
		return nil, ErrPersonaLocked
	}
	item, ok := m.Items[personaID][itemID]
	if !ok {
		return nil, ErrNotFound
	}
	return &item, nil
}

func (m *MockVaultManager) Delete(personaID, itemID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.Open_[personaID] {
		return ErrPersonaLocked
	}
	delete(m.Items[personaID], itemID)
	return nil
}

func (m *MockVaultManager) Search(personaID string, query SearchQuery) ([]VaultItem, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if !m.Open_[personaID] {
		return nil, ErrPersonaLocked
	}
	var results []VaultItem
	for _, item := range m.Items[personaID] {
		results = append(results, item)
	}
	if query.Limit > 0 && len(results) > query.Limit {
		results = results[:query.Limit]
	}
	return results, nil
}

// ---------- Mock PII Scrubber ----------

// MockPIIScrubber returns predetermined results (satisfies port.PIIScrubber).
type MockPIIScrubber struct {
	ScrubResultObj *domain.ScrubResult
	ScrubErr       error
}

func (m *MockPIIScrubber) Scrub(_ context.Context, text string) (*domain.ScrubResult, error) {
	if m.ScrubErr != nil {
		return nil, m.ScrubErr
	}
	if m.ScrubResultObj != nil {
		return m.ScrubResultObj, nil
	}
	return &domain.ScrubResult{Scrubbed: text}, nil
}

// ---------- Mock Gatekeeper ----------

// MockGatekeeper allows or blocks based on configurable rules.
type MockGatekeeper struct {
	EvaluateResult Decision
	EvaluateErr    error
	EgressAllowed  bool
	EgressErr      error
}

func (m *MockGatekeeper) EvaluateIntent(_ context.Context, intent Intent) (Decision, error) {
	return m.EvaluateResult, m.EvaluateErr
}

func (m *MockGatekeeper) CheckEgress(_ context.Context, destination string, data []byte) (bool, error) {
	return m.EgressAllowed, m.EgressErr
}

// ---------- Mock Token Validator ----------

// MockTokenValidator validates brain and client tokens.
type MockTokenValidator struct {
	BrainToken      string
	ClientTokens    map[string]string // token → deviceID
}

func NewMockTokenValidator() *MockTokenValidator {
	return &MockTokenValidator{
		BrainToken:   TestBrainToken,
		ClientTokens: make(map[string]string),
	}
}

func (m *MockTokenValidator) ValidateBrainToken(token string) bool {
	return token == m.BrainToken
}

func (m *MockTokenValidator) ValidateClientToken(token string) (string, bool) {
	deviceID, ok := m.ClientTokens[token]
	return deviceID, ok
}

func (m *MockTokenValidator) IdentifyToken(token string) (domain.TokenType, string, error) {
	if token == m.BrainToken {
		return domain.TokenBrain, "brain", nil
	}
	if deviceID, ok := m.ClientTokens[token]; ok {
		return domain.TokenClient, deviceID, nil
	}
	return domain.TokenUnknown, "", ErrInvalidToken
}

// ---------- Mock Task Queuer ----------

// MockTaskQueuer stores tasks in memory.
type MockTaskQueuer struct {
	mu    sync.Mutex
	tasks []Task
	nextID int
}

func (m *MockTaskQueuer) Enqueue(_ context.Context, task Task) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	task.ID = "task-" + intToStr(m.nextID)
	task.Status = "pending"
	m.tasks = append(m.tasks, task)
	return task.ID, nil
}

func (m *MockTaskQueuer) Dequeue(_ context.Context) (*Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.tasks {
		if m.tasks[i].Status == "pending" {
			m.tasks[i].Status = "running"
			t := m.tasks[i]
			return &t, nil
		}
	}
	return nil, nil
}

func (m *MockTaskQueuer) Complete(_ context.Context, taskID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.tasks {
		if m.tasks[i].ID == taskID {
			m.tasks[i].Status = "completed"
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockTaskQueuer) Fail(_ context.Context, taskID, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.tasks {
		if m.tasks[i].ID == taskID {
			m.tasks[i].Status = "failed"
			m.tasks[i].Error = reason
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockTaskQueuer) Retry(_ context.Context, taskID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.tasks {
		if m.tasks[i].ID == taskID && m.tasks[i].Status == "failed" {
			m.tasks[i].Status = "pending"
			m.tasks[i].Retries++
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockTaskQueuer) Cancel(_ context.Context, taskID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.tasks {
		if m.tasks[i].ID == taskID {
			m.tasks[i].Status = "cancelled"
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockTaskQueuer) RecoverRunning(_ context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for i := range m.tasks {
		if m.tasks[i].Status == "running" {
			m.tasks[i].Status = "pending"
			m.tasks[i].Retries++
			count++
		}
	}
	return count, nil
}

func (m *MockTaskQueuer) GetByID(_ context.Context, taskID string) (*Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.tasks {
		if m.tasks[i].ID == taskID {
			t := m.tasks[i]
			return &t, nil
		}
	}
	return nil, ErrNotFound
}

func (m *MockTaskQueuer) SetMaxRetries(_ int) {
	// Mock does not enforce max retries.
}

// ---------- Mock Brain Client ----------

// MockBrainClient simulates brain communication.
type MockBrainClient struct {
	ProcessResult []byte
	ProcessErr    error
	HealthErr     error
	Available     bool
}

func (m *MockBrainClient) ProcessEvent(event []byte) ([]byte, error) {
	return m.ProcessResult, m.ProcessErr
}

func (m *MockBrainClient) Health() error {
	return m.HealthErr
}

func (m *MockBrainClient) IsAvailable() bool {
	return m.Available
}

func (m *MockBrainClient) SetCooldown(d time.Duration) {}

func (m *MockBrainClient) SetMaxFailures(n int) {}

func (m *MockBrainClient) CircuitState() string {
	if m.Available {
		return "closed"
	}
	return "open"
}

func (m *MockBrainClient) ResetForTest() {
	m.Available = true
	m.HealthErr = nil
	m.ProcessErr = nil
}

// ---------- Mock Transporter ----------

// MockTransporter records sent messages.
type MockTransporter struct {
	mu       sync.Mutex
	Sent     []struct{ DID string; Envelope []byte }
	Inbox    [][]byte
	Endpoints map[string]string // DID → endpoint URL
	SendErr  error
}

func NewMockTransporter() *MockTransporter {
	return &MockTransporter{Endpoints: make(map[string]string)}
}

func (m *MockTransporter) Send(recipientDID string, envelope []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Sent = append(m.Sent, struct{ DID string; Envelope []byte }{recipientDID, envelope})
	return m.SendErr
}

func (m *MockTransporter) Receive() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.Inbox) == 0 {
		return nil, nil
	}
	msg := m.Inbox[0]
	m.Inbox = m.Inbox[1:]
	return msg, nil
}

func (m *MockTransporter) ResolveEndpoint(did string) (string, error) {
	ep, ok := m.Endpoints[did]
	if !ok {
		return "", ErrNotFound
	}
	return ep, nil
}

// ---------- Mock WS Hub ----------

// MockWSHub tracks WebSocket connections and messages.
type MockWSHub struct {
	mu         sync.RWMutex
	Clients    map[string]bool
	Broadcasts [][]byte
	Messages   map[string][][]byte
}

func NewMockWSHub() *MockWSHub {
	return &MockWSHub{
		Clients:  make(map[string]bool),
		Messages: make(map[string][][]byte),
	}
}

func (m *MockWSHub) Register(clientID string, conn interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Clients[clientID] = true
	return nil
}

func (m *MockWSHub) Unregister(clientID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.Clients, clientID)
	return nil
}

func (m *MockWSHub) Broadcast(message []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Broadcasts = append(m.Broadcasts, message)
	return nil
}

func (m *MockWSHub) Send(clientID string, message []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.Clients[clientID] {
		return ErrNotFound
	}
	m.Messages[clientID] = append(m.Messages[clientID], message)
	return nil
}

func (m *MockWSHub) ConnectedClients() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.Clients)
}

// ---------- Mock Sharing Policy Manager ----------

// MockSharingPolicyManager stores sharing policies in memory.
type MockSharingPolicyManager struct {
	mu       sync.Mutex
	Policies map[string]*SharingPolicy // contactDID → policy
}

func NewMockSharingPolicyManager() *MockSharingPolicyManager {
	return &MockSharingPolicyManager{Policies: make(map[string]*SharingPolicy)}
}

func (m *MockSharingPolicyManager) GetPolicy(_ context.Context, contactDID string) (*SharingPolicy, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.Policies[contactDID]
	if !ok {
		return nil, ErrNotFound
	}
	return p, nil
}

func (m *MockSharingPolicyManager) SetPolicy(_ context.Context, contactDID string, categories map[string]SharingTier) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.Policies[contactDID]
	if !ok {
		p = &SharingPolicy{ContactDID: contactDID, Categories: make(map[string]SharingTier)}
		m.Policies[contactDID] = p
	}
	for k, v := range categories {
		p.Categories[k] = v
	}
	return nil
}

func (m *MockSharingPolicyManager) SetBulkPolicy(_ context.Context, filter map[string]string, categories map[string]SharingTier) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for did, p := range m.Policies {
		_ = did
		for k, v := range categories {
			p.Categories[k] = v
		}
		count++
	}
	return count, nil
}

func (m *MockSharingPolicyManager) FilterEgress(_ context.Context, payload EgressPayload) (*EgressResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.Policies[payload.RecipientDID]
	if !ok {
		// Default deny — no policy means everything blocked.
		var denied []string
		for cat := range payload.Categories {
			denied = append(denied, cat)
		}
		return &EgressResult{
			RecipientDID: payload.RecipientDID,
			Filtered:     make(map[string]string),
			Denied:       denied,
		}, nil
	}
	result := &EgressResult{
		RecipientDID: payload.RecipientDID,
		Filtered:     make(map[string]string),
	}
	for cat, val := range payload.Categories {
		tier, hasTier := p.Categories[cat]
		if !hasTier || tier == "none" {
			result.Denied = append(result.Denied, cat)
			result.AuditEntries = append(result.AuditEntries, AuditEntry{
				Action: "egress_check", ContactDID: payload.RecipientDID,
				Category: cat, Decision: "denied", Reason: "tier_none",
			})
			continue
		}
		tp, isTP := val.(TieredPayload)
		if !isTP {
			// Malformed payload — deny.
			result.Denied = append(result.Denied, cat)
			result.AuditEntries = append(result.AuditEntries, AuditEntry{
				Action: "egress_check", ContactDID: payload.RecipientDID,
				Category: cat, Decision: "denied", Reason: "malformed",
			})
			continue
		}
		selected := ""
		switch tier {
		case "summary", "eta_only", "free_busy":
			selected = tp.Summary
		case "full", "exact_location":
			selected = tp.Full
		default:
			selected = tp.Summary
		}
		result.Filtered[cat] = selected
		result.AuditEntries = append(result.AuditEntries, AuditEntry{
			Action: "egress_check", ContactDID: payload.RecipientDID,
			Category: cat, Decision: "allowed", Reason: "tier_" + string(tier),
		})
	}
	return result, nil
}

// ---------- Mock Outbox Manager ----------

// MockOutboxManager stores outbox messages in memory.
type MockOutboxManager struct {
	mu       sync.Mutex
	messages []OutboxMessage
	nextID   int
	MaxQueue int
}

func NewMockOutboxManager() *MockOutboxManager {
	return &MockOutboxManager{MaxQueue: 100}
}

func (m *MockOutboxManager) Enqueue(_ context.Context, msg OutboxMessage) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.messages) >= m.MaxQueue {
		return "", errors.New("outbox full")
	}
	m.nextID++
	msg.ID = "outbox-" + intToStr(m.nextID)
	msg.Status = "pending"
	m.messages = append(m.messages, msg)
	return msg.ID, nil
}

func (m *MockOutboxManager) MarkDelivered(_ context.Context, msgID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.messages {
		if m.messages[i].ID == msgID {
			m.messages[i].Status = "delivered"
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockOutboxManager) MarkFailed(_ context.Context, msgID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.messages {
		if m.messages[i].ID == msgID {
			m.messages[i].Status = "failed"
			m.messages[i].Retries++
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockOutboxManager) Requeue(_ context.Context, msgID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.messages {
		if m.messages[i].ID == msgID && m.messages[i].Status == "failed" {
			m.messages[i].Status = "pending"
			m.messages[i].Retries = 0
			return nil
		}
	}
	return ErrNotFound
}

func (m *MockOutboxManager) PendingCount(_ context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, msg := range m.messages {
		if msg.Status == "pending" {
			count++
		}
	}
	return count, nil
}

func (m *MockOutboxManager) GetByID(msgID string) (*OutboxMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, msg := range m.messages {
		if msg.ID == msgID {
			return &msg, nil
		}
	}
	return nil, ErrNotFound
}

func (m *MockOutboxManager) DeleteExpired(ttlSeconds int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var kept []OutboxMessage
	deleted := 0
	for _, msg := range m.messages {
		if msg.CreatedAt > 0 && msg.CreatedAt < ttlSeconds {
			deleted++
		} else {
			kept = append(kept, msg)
		}
	}
	m.messages = kept
	return deleted, nil
}

// ---------- Mock Inbox Manager ----------

// MockInboxManager simulates 3-valve ingress.
type MockInboxManager struct {
	mu           sync.Mutex
	IPCounts     map[string]int
	GlobalCount  int
	SpoolData    [][]byte
	SpoolBytes   int64
	SpoolMaxBytes int64
	IPRateLimit  int
	GlobalRateLimit int
	DIDCounts    map[string]int
	DIDRateLimit int
}

func NewMockInboxManager() *MockInboxManager {
	return &MockInboxManager{
		IPCounts:        make(map[string]int),
		DIDCounts:       make(map[string]int),
		IPRateLimit:     50,
		GlobalRateLimit: 1000,
		SpoolMaxBytes:   500 * 1024 * 1024, // 500MB
		DIDRateLimit:    100,
	}
}

func (m *MockInboxManager) CheckIPRate(ip string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.IPCounts[ip]++
	return m.IPCounts[ip] <= m.IPRateLimit
}

func (m *MockInboxManager) CheckGlobalRate() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.GlobalCount++
	return m.GlobalCount <= m.GlobalRateLimit
}

func (m *MockInboxManager) CheckPayloadSize(payload []byte) bool {
	return len(payload) <= 256*1024
}

func (m *MockInboxManager) Spool(_ context.Context, payload []byte) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	newSize := m.SpoolBytes + int64(len(payload))
	if newSize > m.SpoolMaxBytes {
		return "", errors.New("spool full")
	}
	m.SpoolData = append(m.SpoolData, payload)
	m.SpoolBytes = newSize
	id := "spool-" + intToStr(len(m.SpoolData))
	return id, nil
}

func (m *MockInboxManager) SpoolSize() (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.SpoolBytes, nil
}

func (m *MockInboxManager) ProcessSpool(_ context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := len(m.SpoolData)
	m.SpoolData = nil
	m.SpoolBytes = 0
	return count, nil
}

func (m *MockInboxManager) CheckDIDRate(did string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.DIDCounts[did]++
	return m.DIDCounts[did] <= m.DIDRateLimit
}

// ---------- Mock Reminder Scheduler ----------

// MockReminderScheduler stores reminders in memory.
type MockReminderScheduler struct {
	mu        sync.Mutex
	reminders []Reminder
	nextID    int
}

func NewMockReminderScheduler() *MockReminderScheduler {
	return &MockReminderScheduler{}
}

func (m *MockReminderScheduler) StoreReminder(_ context.Context, r Reminder) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	r.ID = "reminder-" + intToStr(m.nextID)
	r.Fired = false
	m.reminders = append(m.reminders, r)
	return r.ID, nil
}

func (m *MockReminderScheduler) NextPending(_ context.Context) (*Reminder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *Reminder
	for i := range m.reminders {
		if !m.reminders[i].Fired {
			if best == nil || m.reminders[i].TriggerAt < best.TriggerAt {
				r := m.reminders[i]
				best = &r
			}
		}
	}
	return best, nil
}

func (m *MockReminderScheduler) MarkFired(_ context.Context, reminderID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.reminders {
		if m.reminders[i].ID == reminderID {
			m.reminders[i].Fired = true
			return nil
		}
	}
	return ErrNotFound
}

// ---------- Mock Crash Logger ----------

// MockCrashLogger stores crash entries in memory (satisfies testutil.CrashLogger / port.CrashLogger).
type MockCrashLogger struct {
	mu      sync.Mutex
	entries []domain.CrashEntry
}

func (m *MockCrashLogger) Store(_ context.Context, entry domain.CrashEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = append(m.entries, entry)
	return nil
}

func (m *MockCrashLogger) Query(_ context.Context, since string) ([]domain.CrashEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []domain.CrashEntry
	for _, e := range m.entries {
		if e.Timestamp >= since || since == "" {
			results = append(results, e)
		}
	}
	return results, nil
}

func (m *MockCrashLogger) Purge(_ context.Context, retentionDays int) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// In a mock, just return 0 deleted.
	var deleted int64
	return deleted, nil
}
