package sqlite

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// StagingInbox is a durable SQLite implementation of port.StagingInbox
// backed by the identity.sqlite database. Items survive Core restarts.
type StagingInbox struct {
	pool          *Pool
	isPersonaOpen func(string) bool
	storeToVault  func(ctx context.Context, persona string, item domain.VaultItem) (string, error)
	// OnDrain is called after each item is successfully drained to vault.
	// Used to trigger post-publication work (e.g. event extraction via Brain).
	// Set by the composition root (main.go).
	OnDrain func(ctx context.Context, persona string, item domain.VaultItem)
}

// Compile-time check.
var _ port.StagingInbox = (*StagingInbox)(nil)

// NewStagingInbox creates a durable staging inbox backed by identity.sqlite.
func NewStagingInbox(
	pool *Pool,
	isPersonaOpen func(string) bool,
	storeToVault func(ctx context.Context, persona string, item domain.VaultItem) (string, error),
) *StagingInbox {
	return &StagingInbox{
		pool:          pool,
		isPersonaOpen: isPersonaOpen,
		storeToVault:  storeToVault,
	}
}

// SetOnDrain sets the callback for post-drain event extraction.
func (s *StagingInbox) SetOnDrain(fn func(ctx context.Context, persona string, item domain.VaultItem)) {
	s.OnDrain = fn
}

func (s *StagingInbox) db() *sql.DB {
	return s.pool.DB("identity")
}

// Ingest stores a raw item in the staging inbox.
// Deduplicates on (producer_id, source, source_id).
func (s *StagingInbox) Ingest(ctx context.Context, item domain.StagingItem) (string, error) {
	db := s.db()
	if db == nil {
		return "", fmt.Errorf("staging: identity database not open")
	}

	// Generate ID.
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return "", fmt.Errorf("staging: generate ID: %w", err)
	}
	id := hex.EncodeToString(idBytes)

	// Compute source_hash.
	sourceHash := item.SourceHash
	if sourceHash == "" && item.Body != "" {
		h := sha256.Sum256([]byte(item.Body))
		sourceHash = hex.EncodeToString(h[:])
	}

	now := time.Now().Unix()
	expiresAt := now + int64(domain.DefaultStagingTTL)
	if item.ExpiresAt > 0 {
		expiresAt = item.ExpiresAt
	}

	res, err := db.ExecContext(ctx,
		`INSERT INTO staging_inbox (id, connector_id, source, source_id, source_hash,
			type, summary, body, sender, metadata, status,
			ingress_channel, origin_did, origin_kind, producer_id,
			expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(producer_id, source, source_id) DO NOTHING`,
		id, item.ConnectorID, item.Source, item.SourceID, sourceHash,
		item.Type, item.Summary, item.Body, item.Sender, item.Metadata,
		item.IngressChannel, item.OriginDID, item.OriginKind, item.ProducerID,
		expiresAt, now, now,
	)
	if err != nil {
		return "", fmt.Errorf("staging: ingest: %w", err)
	}

	// Check if the row was actually inserted (dedup may have skipped it).
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		// Dedup hit — return the existing staging ID.
		var existingID string
		err := db.QueryRowContext(ctx,
			`SELECT id FROM staging_inbox WHERE producer_id=? AND source=? AND source_id=?`,
			item.ProducerID, item.Source, item.SourceID,
		).Scan(&existingID)
		if err != nil {
			return "", fmt.Errorf("staging: dedup lookup: %w", err)
		}
		return existingID, nil
	}

	return id, nil
}

// Claim marks up to `limit` received items as classifying with a lease.
func (s *StagingInbox) Claim(ctx context.Context, limit int, leaseDuration time.Duration) ([]domain.StagingItem, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("staging: identity database not open")
	}

	now := time.Now().Unix()
	leaseUntil := now + int64(leaseDuration.Seconds())

	// Atomically claim items.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("staging: begin tx: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx,
		`SELECT id, connector_id, source, source_id, source_hash, type, summary, body,
		        sender, metadata, status, target_persona, classified_item, error,
		        retry_count, claimed_at, lease_until, expires_at, created_at, updated_at,
		        ingress_channel, origin_did, origin_kind, producer_id
		 FROM staging_inbox WHERE status = 'received' LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("staging: query received: %w", err)
	}

	var items []domain.StagingItem
	for rows.Next() {
		var it domain.StagingItem
		if err := rows.Scan(&it.ID, &it.ConnectorID, &it.Source, &it.SourceID,
			&it.SourceHash, &it.Type, &it.Summary, &it.Body, &it.Sender,
			&it.Metadata, &it.Status, &it.TargetPersona, &it.ClassifiedItem,
			&it.Error, &it.RetryCount, &it.ClaimedAt, &it.LeaseUntil,
			&it.ExpiresAt, &it.CreatedAt, &it.UpdatedAt,
			&it.IngressChannel, &it.OriginDID, &it.OriginKind, &it.ProducerID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("staging: scan: %w", err)
		}
		items = append(items, it)
	}
	rows.Close()

	// Mark claimed. Only keep items where the UPDATE actually changed a row
	// (status was still 'received' at UPDATE time — prevents double-claim).
	var claimed []domain.StagingItem
	for _, it := range items {
		res, err := tx.ExecContext(ctx,
			`UPDATE staging_inbox SET status='classifying', claimed_at=?, lease_until=?, updated_at=?
			 WHERE id=? AND status='received'`,
			now, leaseUntil, now, it.ID)
		if err != nil {
			return nil, fmt.Errorf("staging: mark classifying: %w", err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			it.Status = domain.StagingClassifying
			it.ClaimedAt = now
			it.LeaseUntil = leaseUntil
			claimed = append(claimed, it)
		}
	}
	items = claimed

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("staging: commit claim: %w", err)
	}

	return items, nil
}

// Resolve processes a classified item. Core decides stored vs pending_unlock.
func (s *StagingInbox) Resolve(ctx context.Context, id, targetPersona string, classifiedItem domain.VaultItem) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("staging: identity database not open")
	}

	classifiedJSON, err := json.Marshal(classifiedItem)
	if err != nil {
		return fmt.Errorf("staging: marshal classified item: %w", err)
	}

	now := time.Now().Unix()

	if s.isPersonaOpen != nil && s.isPersonaOpen(targetPersona) {
		// Set deterministic ID for idempotent vault writes.
		if classifiedItem.ID == "" {
			classifiedItem.ID = "stg-" + id
		}
		// Store to vault.
		if s.storeToVault != nil {
			if _, err := s.storeToVault(ctx, targetPersona, classifiedItem); err != nil {
				// Mark failed.
				db.ExecContext(ctx,
					`UPDATE staging_inbox SET status='failed', error=?, updated_at=? WHERE id=?`,
					fmt.Sprintf("vault store failed: %v", err), now, id)
				return err
			}
		}
		// Mark stored, clear raw body.
		_, err = db.ExecContext(ctx,
			`UPDATE staging_inbox SET status='stored', target_persona=?, classified_item='',
			 body='', updated_at=? WHERE id=?`,
			targetPersona, now, id)
	} else {
		// Persona locked — keep classified item for later drain.
		_, err = db.ExecContext(ctx,
			`UPDATE staging_inbox SET status='pending_unlock', target_persona=?,
			 classified_item=?, body='', updated_at=? WHERE id=?`,
			targetPersona, string(classifiedJSON), now, id)
	}

	return err
}

// ResolveMulti stores a classified item to multiple target personas.
// Core decides stored vs pending_unlock for each persona independently.
func (s *StagingInbox) ResolveMulti(ctx context.Context, id string, targets []domain.ResolveTarget) error {
	if len(targets) == 0 {
		return fmt.Errorf("staging: no targets provided")
	}
	// Primary target: uses full Resolve logic (updates staging record).
	primary := targets[0]
	if err := s.Resolve(ctx, id, primary.Persona, primary.ClassifiedItem); err != nil {
		return err
	}
	// Additional targets: Core decides stored vs pending_unlock for each.
	// Errors are collected but don't prevent other targets from being processed.
	db := s.db()
	now := time.Now().Unix()
	var errs []string
	for _, target := range targets[1:] {
		item := target.ClassifiedItem
		if item.ID == "" {
			item.ID = "stg-" + id + "-" + target.Persona
		}
		if s.isPersonaOpen != nil && s.isPersonaOpen(target.Persona) {
			if s.storeToVault != nil {
				if _, err := s.storeToVault(ctx, target.Persona, item); err != nil {
					errs = append(errs, fmt.Sprintf("%s: vault store: %v", target.Persona, err))
				}
			}
		} else if db != nil {
			classifiedJSON, _ := json.Marshal(item)
			secondaryID := id + "-" + target.Persona
			if _, err := db.ExecContext(ctx,
				`INSERT OR IGNORE INTO staging_inbox (id, connector_id, source, source_id, status,
					target_persona, classified_item, expires_at, created_at, updated_at)
				 VALUES (?, '', '', ?, 'pending_unlock', ?, ?, ?, ?, ?)`,
				secondaryID, item.SourceID, target.Persona, string(classifiedJSON),
				now+int64(domain.DefaultStagingTTL), now, now); err != nil {
				errs = append(errs, fmt.Sprintf("%s: pending_unlock: %v", target.Persona, err))
			}
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("staging: secondary resolve errors: %s", strings.Join(errs, "; "))
	}
	return nil
}

// MarkFailed records a classification failure.
func (s *StagingInbox) MarkFailed(ctx context.Context, id, errMsg string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("staging: identity database not open")
	}
	now := time.Now().Unix()
	_, err := db.ExecContext(ctx,
		`UPDATE staging_inbox SET status='failed', error=?, retry_count=retry_count+1, updated_at=? WHERE id=?`,
		errMsg, now, id)
	return err
}

// DrainPending promotes pending_unlock items for a persona to stored.
func (s *StagingInbox) DrainPending(ctx context.Context, persona string) (int, error) {
	db := s.db()
	if db == nil {
		return 0, fmt.Errorf("staging: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT id, classified_item FROM staging_inbox
		 WHERE status='pending_unlock' AND target_persona=?`, persona)
	if err != nil {
		return 0, err
	}

	type pending struct {
		id             string
		classifiedJSON string
	}
	var items []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.classifiedJSON); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, p)
	}
	rows.Close()

	now := time.Now().Unix()
	count := 0
	for _, p := range items {
		if p.classifiedJSON == "" || p.classifiedJSON == "{}" {
			continue
		}
		var vaultItem domain.VaultItem
		if err := json.Unmarshal([]byte(p.classifiedJSON), &vaultItem); err != nil {
			continue
		}
		// Use staging ID as vault item ID for idempotent writes.
		// If drain runs twice, the upsert overwrites instead of duplicating.
		if vaultItem.ID == "" {
			vaultItem.ID = "stg-" + p.id
		}
		if s.storeToVault != nil {
			if _, err := s.storeToVault(ctx, persona, vaultItem); err != nil {
				continue
			}
		}
		// Only count if the status update succeeds.
		res, err := db.ExecContext(ctx,
			`UPDATE staging_inbox SET status='stored', classified_item='', updated_at=? WHERE id=?`,
			now, p.id)
		if err != nil {
			continue
		}
		if n, _ := res.RowsAffected(); n > 0 {
			count++
			// Post-publication hook: trigger event extraction for drained items.
			if s.OnDrain != nil {
				s.OnDrain(ctx, persona, vaultItem)
			}
		}
	}

	return count, nil
}

// MaxRetryCount is the maximum number of times a failed item is retried
// before it is left in failed state for operator review.
const MaxRetryCount = 3

// Sweep expires items past TTL, reverts expired classifying leases,
// and requeues retryable failed items back to received.
func (s *StagingInbox) Sweep(ctx context.Context) (int, error) {
	db := s.db()
	if db == nil {
		return 0, fmt.Errorf("staging: identity database not open")
	}

	now := time.Now().Unix()
	count := 0

	// Delete expired items (all statuses including failed past TTL).
	res, err := db.ExecContext(ctx,
		`DELETE FROM staging_inbox WHERE expires_at > 0 AND expires_at < ?`, now)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			count += int(n)
		}
	}

	// Revert expired classifying leases back to received.
	res, err = db.ExecContext(ctx,
		`UPDATE staging_inbox SET status='received', claimed_at=0, lease_until=0, updated_at=?
		 WHERE status='classifying' AND lease_until > 0 AND lease_until < ?`,
		now, now)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			count += int(n)
		}
	}

	// Requeue retryable failed items back to received.
	// Items beyond MaxRetryCount stay failed for operator review.
	res, err = db.ExecContext(ctx,
		`UPDATE staging_inbox SET status='received', error='', claimed_at=0, lease_until=0, updated_at=?
		 WHERE status='failed' AND retry_count <= ?`,
		now, MaxRetryCount)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			count += int(n)
		}
	}

	return count, nil
}

// ListByStatus returns staging items matching the given status.
func (s *StagingInbox) ListByStatus(ctx context.Context, status string, limit int) ([]domain.StagingItem, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("staging: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT id, connector_id, source, source_id, source_hash, type, summary, body,
		        sender, metadata, status, target_persona, classified_item, error,
		        retry_count, claimed_at, lease_until, expires_at, created_at, updated_at
		 FROM staging_inbox WHERE status = ? LIMIT ?`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []domain.StagingItem
	for rows.Next() {
		var it domain.StagingItem
		if err := rows.Scan(&it.ID, &it.ConnectorID, &it.Source, &it.SourceID,
			&it.SourceHash, &it.Type, &it.Summary, &it.Body, &it.Sender,
			&it.Metadata, &it.Status, &it.TargetPersona, &it.ClassifiedItem,
			&it.Error, &it.RetryCount, &it.ClaimedAt, &it.LeaseUntil,
			&it.ExpiresAt, &it.CreatedAt, &it.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, it)
	}

	return items, nil
}
