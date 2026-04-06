//go:build cgo

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time interface checks.
var _ port.ContactDirectory = (*SQLiteContactDirectory)(nil)
var _ port.ContactLookup = (*SQLiteContactDirectory)(nil)

// SQLiteContactDirectory implements port.ContactDirectory using the contacts
// table in the identity SQLite database.
type SQLiteContactDirectory struct {
	pool *Pool
}

// NewSQLiteContactDirectory returns a persistent contact directory backed by
// identity.sqlite.
func NewSQLiteContactDirectory(pool *Pool) *SQLiteContactDirectory {
	return &SQLiteContactDirectory{pool: pool}
}

func (d *SQLiteContactDirectory) db() *sql.DB {
	return d.pool.DB("identity")
}

// GetTrustLevel returns the trust_level for a DID, or "" if not a contact.
// Implements port.ContactLookup for trust-based ingress decisions.
func (d *SQLiteContactDirectory) GetTrustLevel(did string) string {
	db := d.db()
	if db == nil {
		return ""
	}

	var trustLevel string
	err := db.QueryRow(`SELECT trust_level FROM contacts WHERE did = ?`, did).Scan(&trustLevel)
	if err != nil {
		return ""
	}
	return trustLevel
}

// Add inserts a new contact. If the DID already exists the call is a no-op
// (INSERT OR IGNORE) so callers can safely retry.
// Validates relationship and data_responsibility at the storage boundary.
func (d *SQLiteContactDirectory) Add(ctx context.Context, did, name, trustLevel, relationship, dataResponsibility string, responsibilityExplicit bool) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	if !domain.ValidContactRelationships[relationship] {
		return fmt.Errorf("sqlite contacts: invalid relationship %q", relationship)
	}
	if !domain.ValidDataResponsibility[dataResponsibility] {
		return fmt.Errorf("sqlite contacts: invalid data_responsibility %q", dataResponsibility)
	}

	now := time.Now().Unix()
	explicit := 0
	if responsibilityExplicit {
		explicit = 1
	}
	_, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO contacts (did, display_name, trust_level, relationship, data_responsibility, responsibility_explicit, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		did, name, trustLevel, relationship, dataResponsibility, explicit, now, now,
	)
	if err != nil {
		return fmt.Errorf("sqlite contacts: add: %w", err)
	}
	return nil
}

// Resolve looks up a contact by display_name and returns the DID.
func (d *SQLiteContactDirectory) Resolve(ctx context.Context, name string) (string, error) {
	db := d.db()
	if db == nil {
		return "", fmt.Errorf("sqlite contacts: identity database not open")
	}

	var did string
	err := db.QueryRowContext(ctx,
		`SELECT did FROM contacts WHERE display_name = ?`, name,
	).Scan(&did)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("sqlite contacts: contact %q not found", name)
	}
	if err != nil {
		return "", fmt.Errorf("sqlite contacts: resolve: %w", err)
	}
	return did, nil
}

// UpdateTrust changes a contact's trust_level.
func (d *SQLiteContactDirectory) UpdateTrust(ctx context.Context, did, trustLevel string) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	now := time.Now().Unix()
	res, err := db.ExecContext(ctx,
		`UPDATE contacts SET trust_level = ?, updated_at = ? WHERE did = ?`,
		trustLevel, now, did,
	)
	if err != nil {
		return fmt.Errorf("sqlite contacts: update trust: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("sqlite contacts: contact %q not found", did)
	}
	return nil
}

// UpdateName changes a contact's display_name.
func (d *SQLiteContactDirectory) UpdateName(ctx context.Context, did, name string) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	now := time.Now().Unix()
	res, err := db.ExecContext(ctx,
		`UPDATE contacts SET display_name = ?, updated_at = ? WHERE did = ?`,
		name, now, did,
	)
	if err != nil {
		return fmt.Errorf("sqlite contacts: update name: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("sqlite contacts: contact %q not found", did)
	}
	return nil
}

// UpdateRelationship changes a contact's relationship. If data_responsibility
// was auto-defaulted (responsibility_explicit=false), it is recomputed from
// the new relationship. If the user explicitly set it, it is preserved.
func (d *SQLiteContactDirectory) UpdateRelationship(ctx context.Context, did, relationship string) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	if !domain.ValidContactRelationships[relationship] {
		return fmt.Errorf("sqlite contacts: invalid relationship %q", relationship)
	}

	now := time.Now().Unix()

	// Read current explicit flag.
	var explicit int
	err := db.QueryRowContext(ctx,
		`SELECT COALESCE(responsibility_explicit, 0) FROM contacts WHERE did = ?`, did,
	).Scan(&explicit)
	if err == sql.ErrNoRows {
		return fmt.Errorf("sqlite contacts: contact %q not found", did)
	}
	if err != nil {
		return fmt.Errorf("sqlite contacts: read explicit flag: %w", err)
	}

	if explicit == 0 {
		// Auto-defaulted: recompute data_responsibility from new relationship.
		newResp := domain.DefaultResponsibility(relationship)
		_, err = db.ExecContext(ctx,
			`UPDATE contacts SET relationship = ?, data_responsibility = ?, updated_at = ? WHERE did = ?`,
			relationship, newResp, now, did,
		)
	} else {
		// Explicitly set: preserve data_responsibility.
		_, err = db.ExecContext(ctx,
			`UPDATE contacts SET relationship = ?, updated_at = ? WHERE did = ?`,
			relationship, now, did,
		)
	}
	if err != nil {
		return fmt.Errorf("sqlite contacts: update relationship: %w", err)
	}
	return nil
}

// UpdateDataResponsibility explicitly sets data_responsibility and marks it
// as user-overridden (responsibility_explicit=true). "self" is rejected.
func (d *SQLiteContactDirectory) UpdateDataResponsibility(ctx context.Context, did, dataResponsibility string) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	if !domain.ValidDataResponsibility[dataResponsibility] {
		return fmt.Errorf("sqlite contacts: invalid data_responsibility %q", dataResponsibility)
	}

	now := time.Now().Unix()
	res, err := db.ExecContext(ctx,
		`UPDATE contacts SET data_responsibility = ?, responsibility_explicit = 1, updated_at = ? WHERE did = ?`,
		dataResponsibility, now, did,
	)
	if err != nil {
		return fmt.Errorf("sqlite contacts: update data_responsibility: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("sqlite contacts: contact %q not found", did)
	}
	return nil
}

// Delete removes a contact by DID.
func (d *SQLiteContactDirectory) Delete(ctx context.Context, did string) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	res, err := db.ExecContext(ctx,
		`DELETE FROM contacts WHERE did = ?`, did,
	)
	if err != nil {
		return fmt.Errorf("sqlite contacts: delete: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("sqlite contacts: contact %q not found", did)
	}
	return nil
}

// List returns all contacts from the directory.
func (d *SQLiteContactDirectory) List(ctx context.Context) ([]domain.Contact, error) {
	db := d.db()
	if db == nil {
		return nil, fmt.Errorf("sqlite contacts: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT did, display_name, trust_level, sharing_tier, notes,
		        created_at, updated_at,
		        COALESCE(source, ''), COALESCE(source_confidence, ''),
		        COALESCE(last_contact, 0),
		        COALESCE(relationship, 'unknown'),
		        COALESCE(data_responsibility, 'external'),
		        COALESCE(responsibility_explicit, 0)
		 FROM contacts`,
	)
	if err != nil {
		return nil, fmt.Errorf("sqlite contacts: list: %w", err)
	}
	defer rows.Close()

	var contacts []domain.Contact
	for rows.Next() {
		var (
			c                                domain.Contact
			sharingTier, notes               string
			createdAt, updatedAt             int64
			source, sourceConfidence         string
			lastContact                      int64
			explicit                         int
		)
		if err := rows.Scan(
			&c.DID, &c.Name, &c.TrustLevel,
			&sharingTier, &notes,
			&createdAt, &updatedAt,
			&source, &sourceConfidence, &lastContact,
			&c.Relationship, &c.DataResponsibility, &explicit,
		); err != nil {
			return nil, fmt.Errorf("sqlite contacts: scan: %w", err)
		}
		c.SharingPolicy = sharingTier
		c.Source = source
		c.SourceConfidence = sourceConfidence
		c.LastContact = lastContact
		c.ResponsibilityExplicit = explicit == 1
		contacts = append(contacts, c)
	}
	return contacts, rows.Err()
}

// IsContact returns true if the DID exists in the local contact directory.
// Implements port.ContactLookup. Used by D2D v1 ingress: only explicit contacts
// pass; unknown senders are quarantined regardless of trust cache score.
func (d *SQLiteContactDirectory) IsContact(did string) bool {
	db := d.db()
	if db == nil {
		return false
	}

	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE did = ?`, did).Scan(&count)
	if err != nil {
		return false
	}
	return count > 0
}

// UpdateLastContact sets the last_contact timestamp for a contact.
// This is called automatically during ingestion to track interaction recency.
func (d *SQLiteContactDirectory) UpdateLastContact(ctx context.Context, did string, timestamp int64) error {
	db := d.db()
	if db == nil {
		return fmt.Errorf("sqlite contacts: identity database not open")
	}

	now := time.Now().Unix()
	_, err := db.ExecContext(ctx,
		`UPDATE contacts SET last_contact = ?, updated_at = ? WHERE did = ?`,
		timestamp, now, did,
	)
	if err != nil {
		return fmt.Errorf("sqlite contacts: update last_contact: %w", err)
	}
	return nil
}
