//go:build cgo

package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

var _ port.PersonStore = (*SQLitePersonStore)(nil)

type SQLitePersonStore struct {
	pool *Pool
}

func NewSQLitePersonStore(pool *Pool) *SQLitePersonStore {
	return &SQLitePersonStore{pool: pool}
}

func (s *SQLitePersonStore) db() *sql.DB {
	return s.pool.DB("identity")
}

// ApplyExtraction atomically applies an extraction result.
func (s *SQLitePersonStore) ApplyExtraction(ctx context.Context, result domain.ExtractionResult) (*port.ApplyExtractionResponse, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("person store: identity database not open")
	}

	// Compute idempotency fingerprint.
	fp := extractionFingerprint(result)

	// Check idempotency.
	var exists int
	err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM person_extraction_log WHERE source_item_id = ? AND extractor_version = ? AND fingerprint = ?`,
		result.SourceItemID, result.ExtractorVersion, fp,
	).Scan(&exists)
	if err == nil && exists > 0 {
		return &port.ApplyExtractionResponse{Skipped: true}, nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("person store: begin tx: %w", err)
	}
	defer tx.Rollback()

	now := time.Now().Unix()
	resp := &port.ApplyExtractionResponse{}

	for _, link := range result.Results {
		// Try to find existing person by matching confirmed role phrase surfaces.
		personID := ""
		for _, se := range link.Surfaces {
			if se.SurfaceType != "role_phrase" {
				continue
			}
			norm := domain.NormalizeAlias(se.Surface)
			var existingPID string
			err := tx.QueryRowContext(ctx,
				`SELECT person_id FROM person_surfaces WHERE normalized_surface = ? AND surface_type = 'role_phrase' AND status = 'confirmed' LIMIT 1`,
				norm,
			).Scan(&existingPID)
			if err == nil && existingPID != "" {
				personID = existingPID
				break
			}
		}

		// Also try matching by canonical name against existing people.
		if personID == "" && link.CanonicalName != "" {
			norm := domain.NormalizeAlias(link.CanonicalName)
			var existingPID string
			// Match name surfaces on existing people.
			err := tx.QueryRowContext(ctx,
				`SELECT ps.person_id FROM person_surfaces ps
				 JOIN people p ON ps.person_id = p.person_id
				 WHERE ps.normalized_surface = ? AND ps.surface_type = 'name' AND ps.status = 'confirmed'
				 AND p.status = 'confirmed' LIMIT 1`,
				norm,
			).Scan(&existingPID)
			if err == nil && existingPID != "" {
				personID = existingPID
			}
		}

		isNew := false
		if personID == "" {
			personID = uuid.New().String()
			isNew = true
		}

		// Determine status from confidence.
		personStatus := domain.PersonStatusSuggested
		for _, se := range link.Surfaces {
			if se.Confidence == "high" {
				personStatus = domain.PersonStatusConfirmed
				break
			}
		}

		if isNew {
			_, err := tx.ExecContext(ctx,
				`INSERT INTO people (person_id, canonical_name, relationship_hint, status, created_from, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				personID, link.CanonicalName, link.RelationshipHint, personStatus,
				"llm", now, now,
			)
			if err != nil {
				return nil, fmt.Errorf("person store: insert person: %w", err)
			}
			resp.Created++
		} else {
			// Update existing person if needed.
			_, err := tx.ExecContext(ctx,
				`UPDATE people SET canonical_name = COALESCE(NULLIF(?, ''), canonical_name),
				 relationship_hint = COALESCE(NULLIF(?, ''), relationship_hint),
				 status = CASE WHEN ? = 'confirmed' THEN 'confirmed' ELSE status END,
				 updated_at = ? WHERE person_id = ?`,
				link.CanonicalName, link.RelationshipHint, personStatus, now, personID,
			)
			if err != nil {
				return nil, fmt.Errorf("person store: update person: %w", err)
			}
			resp.Updated++
		}

		// Insert surfaces.
		for _, se := range link.Surfaces {
			norm := domain.NormalizeAlias(se.Surface)
			surfaceStatus := domain.SurfaceStatusSuggested
			if se.Confidence == "high" {
				surfaceStatus = domain.SurfaceStatusConfirmed
			}

			// Check for role_phrase conflict (different person owns this confirmed role phrase).
			if se.SurfaceType == "role_phrase" {
				var conflictPID string
				err := tx.QueryRowContext(ctx,
					`SELECT person_id FROM person_surfaces
					 WHERE normalized_surface = ? AND surface_type = 'role_phrase' AND status = 'confirmed' AND person_id != ?`,
					norm, personID,
				).Scan(&conflictPID)
				if err == nil && conflictPID != "" {
					resp.Conflicts = append(resp.Conflicts, se.Surface)
					continue // Skip this surface — conflict needs review.
				}
			}

			// Upsert surface.
			var existingID int64
			err := tx.QueryRowContext(ctx,
				`SELECT id FROM person_surfaces WHERE person_id = ? AND normalized_surface = ?`,
				personID, norm,
			).Scan(&existingID)
			if err == nil && existingID > 0 {
				// Update existing.
				_, err = tx.ExecContext(ctx,
					`UPDATE person_surfaces SET confidence = ?, status = CASE WHEN ? = 'confirmed' THEN 'confirmed' ELSE status END,
					 source_item_id = ?, source_excerpt = ?, extractor_version = ?, updated_at = ? WHERE id = ?`,
					se.Confidence, surfaceStatus,
					result.SourceItemID, link.SourceExcerpt, result.ExtractorVersion, now, existingID,
				)
			} else {
				// Insert new.
				_, err = tx.ExecContext(ctx,
					`INSERT INTO person_surfaces (person_id, surface, normalized_surface, surface_type, status, confidence,
					 source_item_id, source_excerpt, extractor_version, created_from, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm', ?, ?)`,
					personID, se.Surface, norm, se.SurfaceType, surfaceStatus, se.Confidence,
					result.SourceItemID, link.SourceExcerpt, result.ExtractorVersion, now, now,
				)
			}
			if err != nil {
				return nil, fmt.Errorf("person store: upsert surface: %w", err)
			}
		}
	}

	// Record idempotency log.
	tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO person_extraction_log (source_item_id, extractor_version, fingerprint, applied_at)
		 VALUES (?, ?, ?, ?)`,
		result.SourceItemID, result.ExtractorVersion, fp, now,
	)

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("person store: commit: %w", err)
	}
	return resp, nil
}

func (s *SQLitePersonStore) GetPerson(ctx context.Context, personID string) (*domain.Person, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("person store: identity database not open")
	}

	var p domain.Person
	err := db.QueryRowContext(ctx,
		`SELECT person_id, COALESCE(canonical_name,''), COALESCE(contact_did,''),
		 COALESCE(relationship_hint,''), status, created_from, created_at, updated_at
		 FROM people WHERE person_id = ?`, personID,
	).Scan(&p.PersonID, &p.CanonicalName, &p.ContactDID, &p.RelationshipHint,
		&p.Status, &p.CreatedFrom, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("person store: person %q not found", personID)
	}
	if err != nil {
		return nil, fmt.Errorf("person store: get person: %w", err)
	}

	surfaces, err := s.loadSurfaces(ctx, db, personID)
	if err != nil {
		return nil, err
	}
	p.Surfaces = surfaces
	return &p, nil
}

func (s *SQLitePersonStore) ListPeople(ctx context.Context) ([]domain.Person, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("person store: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT person_id, COALESCE(canonical_name,''), COALESCE(contact_did,''),
		 COALESCE(relationship_hint,''), status, created_from, created_at, updated_at
		 FROM people WHERE status != 'rejected' ORDER BY updated_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("person store: list: %w", err)
	}
	defer rows.Close()

	var people []domain.Person
	for rows.Next() {
		var p domain.Person
		if err := rows.Scan(&p.PersonID, &p.CanonicalName, &p.ContactDID,
			&p.RelationshipHint, &p.Status, &p.CreatedFrom, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("person store: scan: %w", err)
		}
		surfaces, err := s.loadSurfaces(ctx, db, p.PersonID)
		if err != nil {
			return nil, err
		}
		p.Surfaces = surfaces
		people = append(people, p)
	}
	return people, rows.Err()
}

func (s *SQLitePersonStore) ConfirmPerson(ctx context.Context, personID string) error {
	return s.updatePersonStatus(ctx, personID, domain.PersonStatusConfirmed)
}

func (s *SQLitePersonStore) RejectPerson(ctx context.Context, personID string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}
	now := time.Now().Unix()
	// Reject all surfaces too.
	db.ExecContext(ctx, `UPDATE person_surfaces SET status = 'rejected', updated_at = ? WHERE person_id = ?`, now, personID)
	_, err := db.ExecContext(ctx, `UPDATE people SET status = 'rejected', updated_at = ? WHERE person_id = ?`, now, personID)
	return err
}

func (s *SQLitePersonStore) ConfirmSurface(ctx context.Context, personID string, surfaceID int64) error {
	return s.updateSurfaceStatus(ctx, personID, surfaceID, domain.SurfaceStatusConfirmed)
}

func (s *SQLitePersonStore) RejectSurface(ctx context.Context, personID string, surfaceID int64) error {
	return s.updateSurfaceStatus(ctx, personID, surfaceID, domain.SurfaceStatusRejected)
}

func (s *SQLitePersonStore) DetachSurface(ctx context.Context, personID string, surfaceID int64) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}
	_, err := db.ExecContext(ctx, `DELETE FROM person_surfaces WHERE id = ? AND person_id = ?`, surfaceID, personID)
	return err
}

func (s *SQLitePersonStore) MergePeople(ctx context.Context, keepID, mergeID string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("person store: merge begin: %w", err)
	}
	defer tx.Rollback()

	now := time.Now().Unix()
	// Move surfaces.
	_, err = tx.ExecContext(ctx, `UPDATE person_surfaces SET person_id = ?, updated_at = ? WHERE person_id = ?`, keepID, now, mergeID)
	if err != nil {
		return fmt.Errorf("person store: merge surfaces: %w", err)
	}
	// Tombstone merged person.
	_, err = tx.ExecContext(ctx, `UPDATE people SET status = 'rejected', updated_at = ? WHERE person_id = ?`, now, mergeID)
	if err != nil {
		return fmt.Errorf("person store: tombstone merged: %w", err)
	}
	return tx.Commit()
}

func (s *SQLitePersonStore) DeletePerson(ctx context.Context, personID string) error {
	return s.RejectPerson(ctx, personID)
}

func (s *SQLitePersonStore) LinkContact(ctx context.Context, personID, contactDID string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}
	now := time.Now().Unix()
	_, err := db.ExecContext(ctx, `UPDATE people SET contact_did = ?, updated_at = ? WHERE person_id = ?`, contactDID, now, personID)
	return err
}

func (s *SQLitePersonStore) ResolveConfirmedSurfaces(ctx context.Context) (map[string][]domain.PersonSurface, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("person store: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT ps.id, ps.person_id, ps.surface, ps.normalized_surface, ps.surface_type,
		 ps.status, ps.confidence, COALESCE(ps.source_item_id,''), COALESCE(ps.source_excerpt,''),
		 ps.extractor_version, ps.created_from, ps.created_at, ps.updated_at
		 FROM person_surfaces ps
		 JOIN people p ON ps.person_id = p.person_id
		 WHERE ps.status = 'confirmed' AND p.status != 'rejected'`,
	)
	if err != nil {
		return nil, fmt.Errorf("person store: resolve: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]domain.PersonSurface)
	for rows.Next() {
		var ps domain.PersonSurface
		if err := rows.Scan(&ps.ID, &ps.PersonID, &ps.Surface, &ps.NormalizedSurface,
			&ps.SurfaceType, &ps.Status, &ps.Confidence, &ps.SourceItemID,
			&ps.SourceExcerpt, &ps.ExtractorVersion, &ps.CreatedFrom,
			&ps.CreatedAt, &ps.UpdatedAt); err != nil {
			return nil, fmt.Errorf("person store: scan surface: %w", err)
		}
		result[ps.NormalizedSurface] = append(result[ps.NormalizedSurface], ps)
	}
	return result, rows.Err()
}

func (s *SQLitePersonStore) ClearExcerptsForItem(ctx context.Context, sourceItemID string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}
	now := time.Now().Unix()
	_, err := db.ExecContext(ctx,
		`UPDATE person_surfaces SET source_excerpt = '', updated_at = ? WHERE source_item_id = ?`,
		now, sourceItemID,
	)
	return err
}

func (s *SQLitePersonStore) GarbageCollect(ctx context.Context, maxAgeDays int) (int, error) {
	db := s.db()
	if db == nil {
		return 0, fmt.Errorf("person store: identity database not open")
	}

	cutoff := time.Now().Unix() - int64(maxAgeDays*86400)
	// Find suggested people with no confirmed surfaces and older than cutoff.
	res, err := db.ExecContext(ctx,
		`UPDATE people SET status = 'rejected', updated_at = CAST(strftime('%s','now') AS INTEGER)
		 WHERE status = 'suggested' AND updated_at < ?
		 AND person_id NOT IN (SELECT DISTINCT person_id FROM person_surfaces WHERE status = 'confirmed')`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("person store: gc: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// --- helpers ---

func (s *SQLitePersonStore) loadSurfaces(ctx context.Context, db *sql.DB, personID string) ([]domain.PersonSurface, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, person_id, surface, normalized_surface, surface_type, status, confidence,
		 COALESCE(source_item_id,''), COALESCE(source_excerpt,''), extractor_version, created_from,
		 created_at, updated_at
		 FROM person_surfaces WHERE person_id = ? AND status != 'rejected' ORDER BY created_at`, personID,
	)
	if err != nil {
		return nil, fmt.Errorf("person store: load surfaces: %w", err)
	}
	defer rows.Close()

	var surfaces []domain.PersonSurface
	for rows.Next() {
		var ps domain.PersonSurface
		if err := rows.Scan(&ps.ID, &ps.PersonID, &ps.Surface, &ps.NormalizedSurface,
			&ps.SurfaceType, &ps.Status, &ps.Confidence, &ps.SourceItemID,
			&ps.SourceExcerpt, &ps.ExtractorVersion, &ps.CreatedFrom,
			&ps.CreatedAt, &ps.UpdatedAt); err != nil {
			return nil, fmt.Errorf("person store: scan surface: %w", err)
		}
		surfaces = append(surfaces, ps)
	}
	return surfaces, rows.Err()
}

func (s *SQLitePersonStore) updatePersonStatus(ctx context.Context, personID, status string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}
	now := time.Now().Unix()
	res, err := db.ExecContext(ctx, `UPDATE people SET status = ?, updated_at = ? WHERE person_id = ?`, status, now, personID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("person store: person %q not found", personID)
	}
	return nil
}

func (s *SQLitePersonStore) updateSurfaceStatus(ctx context.Context, personID string, surfaceID int64, status string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("person store: identity database not open")
	}
	now := time.Now().Unix()
	_, err := db.ExecContext(ctx,
		`UPDATE person_surfaces SET status = ?, updated_at = ? WHERE id = ? AND person_id = ?`,
		status, now, surfaceID, personID,
	)
	return err
}

func extractionFingerprint(result domain.ExtractionResult) string {
	var parts []string
	for _, link := range result.Results {
		for _, se := range link.Surfaces {
			parts = append(parts, domain.NormalizeAlias(se.Surface)+":"+se.SurfaceType)
		}
	}
	sort.Strings(parts)
	h := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return fmt.Sprintf("%x", h[:8])
}
