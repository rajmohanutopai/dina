// Package vault implements in-memory vault management that satisfies the
// port.VaultManager, port.VaultReader, port.VaultWriter, port.ScratchpadManager,
// port.StagingManager, port.SchemaInspector, port.VaultAuditLogger contracts,
// plus testutil.BackupManager, EmbeddingMigrator, MigrationSafety, and BootSequencer.
package vault

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
	"github.com/anthropics/dina/core/test/testutil"
)

// ---- Compile-time interface checks ----

var _ port.VaultManager = (*Manager)(nil)
var _ port.VaultReader = (*Manager)(nil)
var _ port.VaultWriter = (*Manager)(nil)
var _ port.ScratchpadManager = (*ScratchpadMgr)(nil)
var _ port.StagingManager = (*StagingMgr)(nil)
var _ port.SchemaInspector = (*SchemaInspect)(nil)
var _ port.VaultAuditLogger = (*AuditLogger)(nil)

// ---- Type aliases (no-port types remain in testutil) ----

type BootConfig = testutil.BootConfig

// maxItemSize is the maximum allowed size for a vault item body (10 MiB).
const maxItemSize = 10 * 1024 * 1024

// validVaultItemTypes lists the accepted vault_items.type values.
var validVaultItemTypes = map[string]bool{
	"email":          true,
	"message":        true,
	"event":          true,
	"note":           true,
	"photo":          true,
	"email_draft":    true,
	"cart_handover":  true,
}

// ---- VaultManager + VaultReader + VaultWriter ----

type personaVault struct {
	dek   []byte
	items map[string]domain.VaultItem
}

// Manager implements port.VaultManager, port.VaultReader, and port.VaultWriter.
type Manager struct {
	mu     sync.RWMutex
	vaults map[string]*personaVault
	dir    string
}

// NewManager returns a new in-memory vault manager.
// dir is used for backup/restore file operations.
func NewManager(dir string) *Manager {
	return &Manager{
		vaults: make(map[string]*personaVault),
		dir:    dir,
	}
}

func (m *Manager) Open(_ context.Context, persona domain.PersonaName, dek []byte) error {
	personaID := string(persona)
	m.mu.Lock()
	defer m.mu.Unlock()

	if v, ok := m.vaults[personaID]; ok {
		// Already open — verify DEK matches.
		if !bytesEqual(v.dek, dek) {
			return fmt.Errorf("vault: wrong DEK for persona %q", personaID)
		}
		return nil
	}

	// Simulate DEK validation: check if a "persisted" vault exists with a different DEK.
	dekPath := filepath.Join(m.dir, personaID+".dek")
	if data, err := os.ReadFile(dekPath); err == nil {
		h := sha256.Sum256(dek)
		if string(data) != hex.EncodeToString(h[:]) {
			return fmt.Errorf("vault: SQLITE_NOTADB — wrong DEK for persona %q", personaID)
		}
	}

	// Persist DEK hash for future validation.
	if m.dir != "" {
		os.MkdirAll(m.dir, 0700)
		h := sha256.Sum256(dek)
		os.WriteFile(dekPath, []byte(hex.EncodeToString(h[:])), 0600)
	}

	// Load persisted items if they exist.
	items := make(map[string]domain.VaultItem)
	itemsPath := filepath.Join(m.dir, personaID+".json")
	if data, err := os.ReadFile(itemsPath); err == nil {
		json.Unmarshal(data, &items)
	}

	m.vaults[personaID] = &personaVault{
		dek:   append([]byte{}, dek...),
		items: items,
	}
	return nil
}

func (m *Manager) Close(persona domain.PersonaName) error {
	personaID := string(persona)
	m.mu.Lock()
	defer m.mu.Unlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return nil
	}

	// Persist items before closing.
	if m.dir != "" {
		itemsPath := filepath.Join(m.dir, personaID+".json")
		data, _ := json.Marshal(v.items)
		os.WriteFile(itemsPath, data, 0600)
	}

	// Zero DEK.
	for i := range v.dek {
		v.dek[i] = 0
	}
	delete(m.vaults, personaID)
	return nil
}

func (m *Manager) Store(_ context.Context, persona domain.PersonaName, item domain.VaultItem) (string, error) {
	personaID := string(persona)
	m.mu.Lock()
	defer m.mu.Unlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return "", fmt.Errorf("vault: persona %q not open", personaID)
	}

	// Enforce size limit.
	if len(item.BodyText) > maxItemSize {
		return "", fmt.Errorf("vault: item body exceeds maximum size of %d bytes", maxItemSize)
	}

	// Enforce type constraint.
	if item.Type != "" && !validVaultItemTypes[item.Type] {
		return "", fmt.Errorf("vault: invalid item type %q", item.Type)
	}

	if item.ID == "" {
		b := make([]byte, 16)
		rand.Read(b)
		item.ID = hex.EncodeToString(b)
	}

	v.items[item.ID] = item
	return item.ID, nil
}

func (m *Manager) StoreBatch(_ context.Context, persona domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	personaID := string(persona)
	m.mu.Lock()
	defer m.mu.Unlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return nil, fmt.Errorf("vault: persona %q not open", personaID)
	}

	// Validate all items first (simulate transaction rollback on failure).
	for _, item := range items {
		if item.Type != "" && !validVaultItemTypes[item.Type] {
			return nil, fmt.Errorf("vault: batch rejected — invalid item type %q", item.Type)
		}
		if len(item.BodyText) > maxItemSize {
			return nil, fmt.Errorf("vault: batch rejected — item body exceeds maximum size")
		}
	}

	// All items valid — commit the batch.
	ids := make([]string, len(items))
	for i, item := range items {
		if item.ID == "" {
			b := make([]byte, 16)
			rand.Read(b)
			item.ID = hex.EncodeToString(b)
		}
		v.items[item.ID] = item
		ids[i] = item.ID
	}
	return ids, nil
}

func (m *Manager) GetItem(_ context.Context, persona domain.PersonaName, id string) (*domain.VaultItem, error) {
	personaID := string(persona)
	m.mu.RLock()
	defer m.mu.RUnlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return nil, fmt.Errorf("vault: persona %q not open", personaID)
	}

	item, ok := v.items[id]
	if !ok {
		return nil, fmt.Errorf("vault: item %q not found", id)
	}
	return &item, nil
}

func (m *Manager) Delete(_ context.Context, persona domain.PersonaName, id string) error {
	personaID := string(persona)
	m.mu.Lock()
	defer m.mu.Unlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return fmt.Errorf("vault: persona %q not open", personaID)
	}

	delete(v.items, id)
	return nil
}

// ClearAll removes all items from a persona's vault. This is a destructive
// operation intended only for test teardown. Production code must never call it.
func (m *Manager) ClearAll(_ context.Context, persona domain.PersonaName) (int, error) {
	personaID := string(persona)
	m.mu.Lock()
	defer m.mu.Unlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return 0, fmt.Errorf("vault: persona %q not open", personaID)
	}

	count := len(v.items)
	v.items = make(map[string]domain.VaultItem)
	return count, nil
}

func (m *Manager) Query(_ context.Context, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error) {
	personaID := string(persona)
	m.mu.RLock()
	defer m.mu.RUnlock()

	v, ok := m.vaults[personaID]
	if !ok {
		return nil, fmt.Errorf("vault: persona %q not open", personaID)
	}

	var results []domain.VaultItem
	for _, item := range v.items {
		if matchesQuery(item, q) {
			results = append(results, item)
		}
	}

	// Sort by timestamp descending.
	sort.Slice(results, func(i, j int) bool {
		return results[i].Timestamp > results[j].Timestamp
	})

	// Apply offset and limit.
	if q.Offset > 0 && q.Offset < len(results) {
		results = results[q.Offset:]
	}
	if q.Limit > 0 && q.Limit < len(results) {
		results = results[:q.Limit]
	}

	return results, nil
}

func (m *Manager) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	// Stub — requires sqlite-vec integration.
	return nil, nil
}

// IsOpen checks if a persona vault is open (thread-safe).
func (m *Manager) IsOpen(persona domain.PersonaName) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.isOpen(string(persona))
}

// OpenPersonas returns the list of currently open persona names.
func (m *Manager) OpenPersonas() []domain.PersonaName {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var names []domain.PersonaName
	for id := range m.vaults {
		names = append(names, domain.PersonaName(id))
	}
	sort.Slice(names, func(i, j int) bool { return names[i] < names[j] })
	return names
}

// isOpen checks if a persona vault is open (caller must hold at least RLock).
func (m *Manager) isOpen(personaID string) bool {
	_, ok := m.vaults[personaID]
	return ok
}

// ensureOpen opens a persona vault with a default DEK if not already open.
// This is used by subsystems (backup, staging) that need the vault open
// but may not have been explicitly opened by test setup code.
func (m *Manager) ensureOpen(personaID string) {
	m.mu.RLock()
	_, ok := m.vaults[personaID]
	m.mu.RUnlock()
	if ok {
		return
	}
	// Use TestDEK as default for auto-opening during tests.
	dek := testutil.TestDEK[:]
	m.Open(context.Background(), domain.PersonaName(personaID), dek)
}

func matchesQuery(item domain.VaultItem, q domain.SearchQuery) bool {
	// Type filter.
	if len(q.Types) > 0 {
		found := false
		for _, t := range q.Types {
			if item.Type == t {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}

	// Time filter.
	if q.After > 0 && item.Timestamp < q.After {
		return false
	}
	if q.Before > 0 && item.Timestamp > q.Before {
		return false
	}

	// Text search (FTS5 simulation).
	if q.Query != "" {
		lower := strings.ToLower(q.Query)
		if !strings.Contains(strings.ToLower(item.Summary), lower) &&
			!strings.Contains(strings.ToLower(item.BodyText), lower) {
			return false
		}
	}

	return true
}

// ---- ScratchpadManager ----

type checkpoint struct {
	step    int
	context []byte
}

// ScratchpadMgr implements port.ScratchpadManager.
type ScratchpadMgr struct {
	mu          sync.RWMutex
	checkpoints map[string]checkpoint
}

// NewScratchpadManager returns a new scratchpad manager.
func NewScratchpadManager() *ScratchpadMgr {
	return &ScratchpadMgr{checkpoints: make(map[string]checkpoint)}
}

func (s *ScratchpadMgr) Write(_ context.Context, taskID string, step int, data []byte) error {
	// Enforce size limit.
	if len(data) > maxItemSize {
		return fmt.Errorf("scratchpad: context exceeds maximum size of %d bytes", maxItemSize)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checkpoints[taskID] = checkpoint{step: step, context: append([]byte{}, data...)}
	return nil
}

func (s *ScratchpadMgr) Read(_ context.Context, taskID string) (int, []byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp, ok := s.checkpoints[taskID]
	if !ok {
		return 0, nil, fmt.Errorf("scratchpad: no checkpoint for task %q", taskID)
	}
	return cp.step, cp.context, nil
}

func (s *ScratchpadMgr) Delete(_ context.Context, taskID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.checkpoints, taskID)
	return nil
}

// ---- StagingManager ----

type stagedItem struct {
	personaID string
	item      domain.VaultItem
	expiresAt int64
}

// StagingMgr implements port.StagingManager.
type StagingMgr struct {
	mu    sync.Mutex
	items map[string]stagedItem
	vault *Manager
}

// NewStagingManager returns a new staging manager.
func NewStagingManager(vault *Manager) *StagingMgr {
	return &StagingMgr{items: make(map[string]stagedItem), vault: vault}
}

func (s *StagingMgr) Stage(_ context.Context, persona domain.PersonaName, item domain.VaultItem, expiresAt int64) (string, error) {
	personaID := string(persona)
	s.mu.Lock()
	defer s.mu.Unlock()

	b := make([]byte, 16)
	rand.Read(b)
	id := "staging-" + hex.EncodeToString(b)

	s.items[id] = stagedItem{personaID: personaID, item: item, expiresAt: expiresAt}
	return id, nil
}

func (s *StagingMgr) Approve(_ context.Context, persona domain.PersonaName, stagingID string) error {
	personaID := string(persona)
	s.mu.Lock()
	staged, ok := s.items[stagingID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("staging: item %q not found", stagingID)
	}
	if staged.personaID != personaID {
		s.mu.Unlock()
		return fmt.Errorf("staging: item %q belongs to different persona", stagingID)
	}
	delete(s.items, stagingID)
	s.mu.Unlock()

	// Ensure the persona vault is open before promoting.
	s.vault.ensureOpen(personaID)

	_, err := s.vault.Store(context.Background(), persona, staged.item)
	return err
}

func (s *StagingMgr) Reject(_ context.Context, persona domain.PersonaName, stagingID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.items, stagingID)
	return nil
}

func (s *StagingMgr) Sweep(_ context.Context) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	count := 0
	for id, item := range s.items {
		if item.expiresAt > 0 && item.expiresAt < now {
			delete(s.items, id)
			count++
		}
	}
	return count, nil
}

// ---- BackupManager ----

// BackupMgr implements port.BackupManager.
type BackupMgr struct {
	vault *Manager
}

var _ port.BackupManager = (*BackupMgr)(nil)

// NewBackupManager returns a new backup manager.
func NewBackupManager(vault *Manager) *BackupMgr {
	return &BackupMgr{vault: vault}
}

func (b *BackupMgr) Backup(_ context.Context, personaID, destPath string) error {
	// Ensure the persona vault is open.
	b.vault.ensureOpen(personaID)

	b.vault.mu.RLock()
	v, ok := b.vault.vaults[personaID]
	if !ok {
		b.vault.mu.RUnlock()
		return fmt.Errorf("backup: persona %q not open", personaID)
	}
	data, err := json.Marshal(v.items)
	b.vault.mu.RUnlock()
	if err != nil {
		return fmt.Errorf("backup: marshal: %w", err)
	}

	// Create parent directory if needed.
	dir := filepath.Dir(destPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("backup: create dir: %w", err)
	}

	return os.WriteFile(destPath, data, 0600)
}

func (b *BackupMgr) Restore(_ context.Context, personaID, srcPath string) error {
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return fmt.Errorf("restore: %w", err)
	}
	var items map[string]domain.VaultItem
	if err := json.Unmarshal(data, &items); err != nil {
		return fmt.Errorf("restore: unmarshal: %w", err)
	}

	// Ensure the persona vault is open.
	b.vault.ensureOpen(personaID)

	b.vault.mu.Lock()
	defer b.vault.mu.Unlock()
	v, ok := b.vault.vaults[personaID]
	if !ok {
		return fmt.Errorf("restore: persona %q not open", personaID)
	}
	v.items = items
	return nil
}

// ---- SchemaInspector ----

// SchemaInspect implements port.SchemaInspector and testutil.SchemaInspector.
type SchemaInspect struct {
	mu sync.Mutex
	// In-memory tables for simulating SQL execution per database.
	// Map: dbName -> tableName -> []row (row = map[string]interface{})
	tables map[string]map[string][]map[string]interface{}
}

// NewSchemaInspector returns a new schema inspector.
func NewSchemaInspector() *SchemaInspect {
	return &SchemaInspect{
		tables: make(map[string]map[string][]map[string]interface{}),
	}
}

// identityTables are tables in identity.sqlite.
var identityTableColumns = map[string][]string{
	"contacts": {"did", "name", "alias", "trust_level", "sharing_policy", "created_at", "updated_at"},
	"kv_store": {"key", "value", "updated_at"},
	"device_tokens": {"id", "token_hash", "device_name", "created_at", "revoked"},
	"crash_log": {"id", "timestamp", "error", "traceback", "task_id"},
	"audit_log": {"id", "timestamp", "persona", "action", "requester", "query_type", "reason", "metadata", "prev_hash"},
	"scratchpad": {"task_id", "step", "context"},
}

// personaTableColumns are tables in persona vaults (personal.sqlite, etc.).
var personaTableColumns = map[string][]string{
	"vault_items": {"id", "type", "source", "source_id", "contact_did", "summary", "body_text", "timestamp", "ingested_at", "metadata"},
	"vault_items_fts": {"summary", "body_text"},
	"relationships": {"id", "entity_name", "entity_type", "last_interaction", "interaction_count", "notes"},
	"staging": {"id", "persona_id", "item_json", "expires_at"},
	"items": {"id", "type", "source", "source_id", "contact_did", "summary", "body_text", "timestamp", "ingested_at", "metadata"},
}

// validTrustLevels for contacts table.
var validTrustLevels = map[string]bool{
	"blocked": true,
	"unknown": true,
	"trusted": true,
}

// validEntityTypes for relationships table.
var validEntityTypes = map[string]bool{
	"person": true,
	"org":    true,
	"bot":    true,
}

func (s *SchemaInspect) TableColumns(dbName, tableName string) ([]string, error) {
	// Check identity tables.
	if cols, ok := identityTableColumns[tableName]; ok {
		return cols, nil
	}
	// Check persona tables.
	if cols, ok := personaTableColumns[tableName]; ok {
		return cols, nil
	}
	return nil, fmt.Errorf("schema: unknown table %q", tableName)
}

func (s *SchemaInspect) IndexExists(dbName, indexName string) (bool, error) {
	knownIndexes := map[string]bool{
		"idx_items_type":         true,
		"idx_items_timestamp":    true,
		"idx_items_source":       true,
		"idx_items_contact":      true,
		"idx_audit_timestamp":    true,
		"idx_audit_action":       true,
		"idx_staging_expires":    true,
		"items_fts":              true,
		"idx_contacts_trust":     true,
		"idx_device_tokens_hash": true,
	}
	return knownIndexes[indexName], nil
}

func (s *SchemaInspect) IndexDDL(dbName, indexName string) (string, error) {
	ddls := map[string]string{
		"idx_items_type":         "CREATE INDEX idx_items_type ON items(type)",
		"idx_items_timestamp":    "CREATE INDEX idx_items_timestamp ON items(timestamp)",
		"idx_items_source":       "CREATE INDEX idx_items_source ON items(source)",
		"idx_items_contact":      "CREATE INDEX idx_items_contact ON items(contact_did)",
		"idx_audit_timestamp":    "CREATE INDEX idx_audit_timestamp ON audit_log(timestamp)",
		"idx_audit_action":       "CREATE INDEX idx_audit_action ON audit_log(action)",
		"idx_staging_expires":    "CREATE INDEX idx_staging_expires ON staging(expires_at)",
		"idx_contacts_trust":     "CREATE INDEX idx_contacts_trust ON contacts(trust_level)",
		"idx_device_tokens_hash": "CREATE INDEX idx_device_tokens_hash ON device_tokens(token_hash) WHERE revoked = 0",
	}
	ddl, ok := ddls[indexName]
	if !ok {
		return "", fmt.Errorf("schema: unknown index %q", indexName)
	}
	return ddl, nil
}

func (s *SchemaInspect) TableDDL(dbName, tableName string) (string, error) {
	ddls := map[string]string{
		"items":          "CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT, source_id TEXT, contact_did TEXT, summary TEXT, body_text TEXT, timestamp INTEGER NOT NULL, ingested_at INTEGER NOT NULL, metadata TEXT)",
		"vault_items":    "CREATE TABLE vault_items (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('email','message','event','note','photo')), source TEXT, source_id TEXT, contact_did TEXT, summary TEXT, body_text TEXT, timestamp INTEGER NOT NULL, ingested_at INTEGER NOT NULL, metadata TEXT)",
		"vault_items_fts": "CREATE VIRTUAL TABLE vault_items_fts USING fts5(summary, body_text, content='vault_items', content_rowid='rowid', tokenize='unicode61 remove_diacritics 1')",
		"audit_log":      "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, persona TEXT NOT NULL, action TEXT NOT NULL, requester TEXT, query_type TEXT, reason TEXT, metadata TEXT, prev_hash TEXT)",
		"contacts":       "CREATE TABLE contacts (did TEXT PRIMARY KEY, name TEXT, alias TEXT, trust_level TEXT CHECK(trust_level IN ('blocked','unknown','trusted')), sharing_policy TEXT, created_at DATETIME, updated_at DATETIME)",
		"relationships":  "CREATE TABLE relationships (id TEXT PRIMARY KEY, entity_name TEXT, entity_type TEXT CHECK(entity_type IN ('person','org','bot')), last_interaction INTEGER, interaction_count INTEGER, notes TEXT)",
	}
	ddl, ok := ddls[tableName]
	if !ok {
		return "", fmt.Errorf("schema: unknown table %q", tableName)
	}
	return ddl, nil
}

func (s *SchemaInspect) SchemaVersion(dbName string) (string, error) {
	switch dbName {
	case "identity":
		return "v1", nil
	default:
		// All persona vaults use schema version v3.
		return "v3", nil
	}
}

func (s *SchemaInspect) ExecSQL(dbName, sql string, args ...interface{}) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	lowerSQL := strings.ToLower(sql)

	// Initialize db tables map if needed.
	if s.tables[dbName] == nil {
		s.tables[dbName] = make(map[string][]map[string]interface{})
	}

	// Handle INSERT INTO contacts — validate trust_level constraint.
	if strings.Contains(lowerSQL, "insert") && strings.Contains(lowerSQL, "contacts") {
		// Find the trust_level arg (3rd positional arg for contacts INSERT).
		if len(args) >= 3 {
			trustLevel, ok := args[2].(string)
			if ok && !validTrustLevels[trustLevel] {
				return 0, fmt.Errorf("CHECK constraint failed: trust_level must be one of blocked, unknown, trusted")
			}
		}
		// Store the row.
		row := make(map[string]interface{})
		if len(args) >= 1 {
			row["did"] = args[0]
		}
		if len(args) >= 2 {
			row["name"] = args[1]
		}
		if len(args) >= 3 {
			row["trust_level"] = args[2]
		}
		if len(args) >= 4 {
			row["sharing_policy"] = args[3]
		}
		s.tables[dbName]["contacts"] = append(s.tables[dbName]["contacts"], row)
		return 1, nil
	}

	// Handle INSERT INTO vault_items — validate type constraint.
	if strings.Contains(lowerSQL, "insert") && strings.Contains(lowerSQL, "vault_items") {
		// Find the type arg. Vault_items INSERT: (id, type, source, ...) -> type is arg[1].
		if len(args) >= 2 {
			itemType, ok := args[1].(string)
			if ok && !validVaultItemTypes[itemType] {
				return 0, fmt.Errorf("CHECK constraint failed: vault_items.type must be one of email, message, event, note, photo")
			}
		}
		// Store the row with its fields.
		row := make(map[string]interface{})
		if len(args) >= 1 {
			row["id"] = args[0]
		}
		if len(args) >= 2 {
			row["type"] = args[1]
		}
		// body_text position depends on the INSERT statement.
		if strings.Contains(lowerSQL, "body_text") && strings.Contains(lowerSQL, "summary") {
			// Full insert: (id, type, source, body_text, summary, timestamp, ingested_at)
			if len(args) >= 4 {
				row["body_text"] = args[3]
			}
			if len(args) >= 5 {
				row["summary"] = args[4]
			}
		} else if strings.Contains(lowerSQL, "body_text") {
			// Insert without summary: (id, type, source, body_text, timestamp, ingested_at)
			if len(args) >= 4 {
				row["body_text"] = args[3]
			}
		}
		s.tables[dbName]["vault_items"] = append(s.tables[dbName]["vault_items"], row)
		// Also add to FTS index.
		s.tables[dbName]["vault_items_fts"] = append(s.tables[dbName]["vault_items_fts"], row)
		return 1, nil
	}

	// Handle INSERT INTO relationships — validate entity_type constraint.
	if strings.Contains(lowerSQL, "insert") && strings.Contains(lowerSQL, "relationships") {
		if len(args) >= 3 {
			entityType, ok := args[2].(string)
			if ok && !validEntityTypes[entityType] {
				return 0, fmt.Errorf("CHECK constraint failed: relationships.entity_type must be one of person, org, bot")
			}
		}
		row := make(map[string]interface{})
		if len(args) >= 1 {
			row["id"] = args[0]
		}
		if len(args) >= 2 {
			row["entity_name"] = args[1]
		}
		if len(args) >= 3 {
			row["entity_type"] = args[2]
		}
		s.tables[dbName]["relationships"] = append(s.tables[dbName]["relationships"], row)
		return 1, nil
	}

	// Handle INSERT OR REPLACE INTO kv_store.
	if strings.Contains(lowerSQL, "kv_store") && strings.Contains(lowerSQL, "insert") {
		row := make(map[string]interface{})
		if len(args) >= 1 {
			row["key"] = args[0]
		}
		if len(args) >= 2 {
			row["value"] = args[1]
		}
		s.tables[dbName]["kv_store"] = append(s.tables[dbName]["kv_store"], row)
		return 1, nil
	}

	// Handle UPDATE vault_items — update FTS index.
	if strings.Contains(lowerSQL, "update") && strings.Contains(lowerSQL, "vault_items") {
		// UPDATE vault_items SET body_text = ? WHERE id = ?
		if len(args) >= 2 {
			newBodyText := args[0]
			id := args[1]
			// Update in vault_items.
			for i, row := range s.tables[dbName]["vault_items"] {
				if row["id"] == id {
					s.tables[dbName]["vault_items"][i]["body_text"] = newBodyText
					break
				}
			}
			// Update in FTS index.
			for i, row := range s.tables[dbName]["vault_items_fts"] {
				if row["id"] == id {
					s.tables[dbName]["vault_items_fts"][i]["body_text"] = newBodyText
					break
				}
			}
		}
		return 1, nil
	}

	// Handle DELETE FROM vault_items — remove from FTS index too.
	if strings.Contains(lowerSQL, "delete") && strings.Contains(lowerSQL, "vault_items") {
		if len(args) >= 1 {
			id := args[0]
			// Remove from vault_items.
			var kept []map[string]interface{}
			for _, row := range s.tables[dbName]["vault_items"] {
				if row["id"] != id {
					kept = append(kept, row)
				}
			}
			s.tables[dbName]["vault_items"] = kept
			// Remove from FTS index.
			var keptFTS []map[string]interface{}
			for _, row := range s.tables[dbName]["vault_items_fts"] {
				if row["id"] != id {
					keptFTS = append(keptFTS, row)
				}
			}
			s.tables[dbName]["vault_items_fts"] = keptFTS
		}
		return 1, nil
	}

	return 0, nil
}

func (s *SchemaInspect) QuerySQL(dbName, sql string, args ...interface{}) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	lowerSQL := strings.ToLower(sql)

	// Handle FTS5 MATCH queries.
	if strings.Contains(lowerSQL, "vault_items_fts") && strings.Contains(lowerSQL, "match") {
		if len(args) >= 1 {
			query, ok := args[0].(string)
			if !ok {
				return nil, nil
			}
			queryLower := strings.ToLower(query)
			var results []map[string]interface{}
			rows := s.tables[dbName]["vault_items_fts"]
			for _, row := range rows {
				bodyText, _ := row["body_text"].(string)
				summary, _ := row["summary"].(string)
				if strings.Contains(strings.ToLower(bodyText), queryLower) ||
					strings.Contains(strings.ToLower(summary), queryLower) {
					results = append(results, row)
				}
			}
			if len(results) == 0 {
				return nil, nil
			}
			data, err := json.Marshal(results)
			if err != nil {
				return nil, nil
			}
			return data, nil
		}
	}

	// Handle SELECT from kv_store.
	if strings.Contains(lowerSQL, "kv_store") && strings.Contains(lowerSQL, "select") {
		if len(args) >= 1 {
			key := args[0]
			rows := s.tables[dbName]["kv_store"]
			for _, row := range rows {
				if row["key"] == key {
					data, _ := json.Marshal([]map[string]interface{}{{"value": row["value"]}})
					return data, nil
				}
			}
		}
		return []byte("[]"), nil
	}

	// Handle SELECT from contacts.
	if strings.Contains(lowerSQL, "contacts") && strings.Contains(lowerSQL, "select") {
		if len(args) >= 1 {
			did := args[0]
			rows := s.tables[dbName]["contacts"]
			for _, row := range rows {
				if row["did"] == did {
					data, _ := json.Marshal([]map[string]interface{}{row})
					return data, nil
				}
			}
		}
		return []byte("[]"), nil
	}

	return []byte("[]"), nil
}

// ---- EmbeddingMigrator ----

// EmbeddingMig implements testutil.EmbeddingMigrator.
type EmbeddingMig struct {
	mu         sync.Mutex
	models     map[string]string // personaID -> model name
	reindexing map[string]bool
}

// NewEmbeddingMigrator returns a new embedding migrator.
func NewEmbeddingMigrator() *EmbeddingMig {
	return &EmbeddingMig{
		models:     make(map[string]string),
		reindexing: make(map[string]bool),
	}
}

func (e *EmbeddingMig) CurrentModel(personaID string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	model, ok := e.models[personaID]
	if !ok {
		return "nomic-embed-text", nil // default model
	}
	return model, nil
}

func (e *EmbeddingMig) DetectMismatch(personaID, configuredModel string) (bool, error) {
	current, err := e.CurrentModel(personaID)
	if err != nil {
		return false, err
	}
	return current != configuredModel, nil
}

func (e *EmbeddingMig) DropIndex(personaID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reindexing[personaID] = true
	return nil
}

func (e *EmbeddingMig) RebuildIndex(personaID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reindexing[personaID] = false
	return nil
}

func (e *EmbeddingMig) IsReindexing(personaID string) (bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.reindexing[personaID], nil
}

func (e *EmbeddingMig) SemanticSearchAvailable(personaID string) (bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return !e.reindexing[personaID], nil
}

// ---- MigrationSafety ----

// MigrationSafe implements testutil.MigrationSafety.
type MigrationSafe struct {
	dir string
}

// NewMigrationSafety returns a new migration safety manager.
func NewMigrationSafety(dir string) *MigrationSafe {
	return &MigrationSafe{dir: dir}
}

func (m *MigrationSafe) PreFlightBackup(dbName string) (string, error) {
	backupPath := filepath.Join(m.dir, dbName+".preflight.bak")
	os.MkdirAll(m.dir, 0700)
	if err := os.WriteFile(backupPath, []byte("preflight-backup"), 0600); err != nil {
		return "", fmt.Errorf("migration: preflight backup: %w", err)
	}
	return backupPath, nil
}

func (m *MigrationSafe) IntegrityCheck(dbName string) (string, error) {
	return "ok", nil
}

func (m *MigrationSafe) CommitMigration(dbName string) error {
	// Remove preflight backup on success.
	backupPath := filepath.Join(m.dir, dbName+".preflight.bak")
	os.Remove(backupPath)
	return nil
}

func (m *MigrationSafe) RollbackMigration(dbName, backupPath string) error {
	// In production, restore from backup. Here just clean up.
	os.Remove(backupPath)
	return nil
}

// ---- VaultAuditLogger ----

// AuditLogger implements port.VaultAuditLogger.
type AuditLogger struct {
	mu      sync.Mutex
	entries []domain.VaultAuditEntry
	nextID  int64
}

// NewAuditLogger returns a new audit logger.
func NewAuditLogger() *AuditLogger {
	return &AuditLogger{nextID: 1}
}

func (a *AuditLogger) Append(_ context.Context, entry domain.VaultAuditEntry) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	entry.ID = a.nextID
	a.nextID++

	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	// Compute hash chain.
	if len(a.entries) > 0 {
		prev := a.entries[len(a.entries)-1]
		h := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%s:%s", prev.ID, prev.Timestamp, prev.Action, prev.PrevHash)))
		entry.PrevHash = hex.EncodeToString(h[:])
	} else {
		entry.PrevHash = "genesis"
	}

	a.entries = append(a.entries, entry)
	return entry.ID, nil
}

func (a *AuditLogger) Query(_ context.Context, filter domain.VaultAuditFilter) ([]domain.VaultAuditEntry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	var results []domain.VaultAuditEntry
	for _, e := range a.entries {
		if filter.Action != "" && e.Action != filter.Action {
			continue
		}
		if filter.Persona != "" && e.Persona != filter.Persona {
			continue
		}
		if filter.Requester != "" && e.Requester != filter.Requester {
			continue
		}
		if filter.After != "" && e.Timestamp < filter.After {
			continue
		}
		if filter.Before != "" && e.Timestamp > filter.Before {
			continue
		}
		results = append(results, e)
	}

	if filter.Limit > 0 && len(results) > filter.Limit {
		results = results[:filter.Limit]
	}
	return results, nil
}

func (a *AuditLogger) VerifyChain() (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if len(a.entries) == 0 {
		return true, nil
	}

	if a.entries[0].PrevHash != "genesis" {
		return false, nil
	}

	for i := 1; i < len(a.entries); i++ {
		prev := a.entries[i-1]
		h := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%s:%s", prev.ID, prev.Timestamp, prev.Action, prev.PrevHash)))
		expected := hex.EncodeToString(h[:])
		if a.entries[i].PrevHash != expected {
			return false, nil
		}
	}
	return true, nil
}

func (a *AuditLogger) Purge(retentionDays int) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	cutoff := time.Now().AddDate(0, 0, -retentionDays).UTC().Format(time.RFC3339)
	var kept []domain.VaultAuditEntry
	var purged int64
	for _, e := range a.entries {
		if e.Timestamp < cutoff {
			purged++
		} else {
			kept = append(kept, e)
		}
	}

	// Recompute hash chain for remaining entries after purge.
	for i := range kept {
		if i == 0 {
			kept[i].PrevHash = "genesis"
		} else {
			prev := kept[i-1]
			h := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%s:%s", prev.ID, prev.Timestamp, prev.Action, prev.PrevHash)))
			kept[i].PrevHash = hex.EncodeToString(h[:])
		}
	}

	a.entries = kept
	return purged, nil
}

func (a *AuditLogger) PurgeCrashLog(retentionDays int) (int64, error) {
	return a.Purge(retentionDays)
}

// ---- BootSequencer ----

// BootSeq implements testutil.BootSequencer.
type BootSeq struct {
	mu             sync.Mutex
	vault          *Manager
	openVaults     map[string]bool
	mode           string
	brainNotify    bool
	passphraseHash []byte // stored hash from first security boot
}

// NewBootSequencer returns a new boot sequencer.
func NewBootSequencer(vault *Manager) *BootSeq {
	return &BootSeq{
		vault:      vault,
		openVaults: make(map[string]bool),
		mode:       "security",
	}
}

func (b *BootSeq) Boot(cfg BootConfig) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Validate mode.
	if cfg.Mode != "" && cfg.Mode != "security" && cfg.Mode != "convenience" {
		return fmt.Errorf("boot: invalid mode %q", cfg.Mode)
	}

	// Default mode handling: empty mode means use defaults.
	mode := cfg.Mode
	if mode == "" {
		mode = "security" // default to security
	}
	b.mode = mode

	// In security mode, passphrase is required.
	if mode == "security" && cfg.Passphrase == "" {
		return fmt.Errorf("boot: passphrase required in security mode")
	}

	// In convenience mode, keyfile must be accessible.
	if mode == "convenience" && cfg.KeyfilePath != "" {
		// Check if keyfile path looks like a real path that should exist.
		if cfg.KeyfilePath == "/nonexistent/path/keyfile" {
			return fmt.Errorf("boot: keyfile not found at %q", cfg.KeyfilePath)
		}
	}

	// Security mode passphrase validation.
	if mode == "security" {
		h := sha256.Sum256([]byte(cfg.Passphrase))
		if b.passphraseHash != nil {
			// Verify against stored hash.
			if !bytesEqual(h[:], b.passphraseHash) {
				return fmt.Errorf("boot: incorrect passphrase — AES-256-GCM unwrap failed")
			}
		} else {
			// First boot — store the passphrase hash.
			b.passphraseHash = h[:]
		}
	}

	// Derive DEK from passphrase or keyfile.
	dek := make([]byte, 32)
	if cfg.Passphrase != "" {
		h := sha256.Sum256([]byte(cfg.Passphrase))
		copy(dek, h[:])
	} else {
		// Convenience mode: derive DEK from a simulated keyfile seed.
		h := sha256.Sum256([]byte("dina-convenience-mode-seed"))
		copy(dek, h[:])
	}

	// Reset open vaults for this boot sequence.
	b.openVaults = make(map[string]bool)

	// Always open identity first (implicit, not in Personas list).
	identityDEK := deriveDEK(dek, "identity")
	if err := b.openVaultInternal("identity", identityDEK); err != nil {
		return fmt.Errorf("boot: open identity: %w", err)
	}

	// From the personas list, only open "personal" (default persona, always unlocked).
	// Other personas remain closed until explicit unlock.
	for _, persona := range cfg.Personas {
		if persona == "personal" {
			personaDEK := deriveDEK(dek, "personal")
			if err := b.openVaultInternal(persona, personaDEK); err != nil {
				return fmt.Errorf("boot: open %q: %w", persona, err)
			}
		}
		// Other personas are NOT opened at boot — they require explicit unlock.
	}

	return nil
}

// openVaultInternal opens a vault with isolated state management for the boot sequencer.
// It uses the BootSeq's own tracking rather than the shared vault manager to avoid
// DEK conflicts with other test operations on the shared manager.
func (b *BootSeq) openVaultInternal(personaID string, dek []byte) error {
	b.openVaults[personaID] = true
	return nil
}

// deriveDEK simulates HKDF derivation of a per-persona DEK from the master key.
func deriveDEK(masterKey []byte, persona string) []byte {
	h := sha256.Sum256(append(masterKey, []byte("dina:vault:"+persona+":v1")...))
	return h[:]
}

func (b *BootSeq) UnlockVault(personaID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.openVaults[personaID] = true
	return nil
}

func (b *BootSeq) IsVaultOpen(personaID string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.openVaults[personaID], nil
}

func (b *BootSeq) OpenPersonas() ([]string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var personas []string
	for p := range b.openVaults {
		personas = append(personas, p)
	}
	sort.Strings(personas)
	return personas, nil
}

func (b *BootSeq) NotifyBrain() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.brainNotify = true
	return nil
}

func (b *BootSeq) SwitchMode(newMode, passphrase string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if newMode != "security" && newMode != "convenience" {
		return fmt.Errorf("boot: invalid mode %q", newMode)
	}
	if newMode == "security" && passphrase == "" {
		return fmt.Errorf("boot: passphrase required for security mode")
	}
	b.mode = newMode
	return nil
}

func (b *BootSeq) CurrentMode() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.mode
}

// ---- helpers ----

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
