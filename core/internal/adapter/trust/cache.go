// Package trust implements the local trust neighborhood cache.
// It provides microsecond DID lookups for the ingress gatekeeper
// by keeping an in-memory mirror of the trust_cache SQLite table.
package trust

import (
	"database/sql"
	_ "embed"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

//go:embed schema.sql
var migrationSQL string

var _ port.TrustCache = (*Cache)(nil)

// Cache is an in-memory trust cache backed by identity.sqlite.
// All Lookup calls use the in-memory map (RLock, O(1)).
// Writes go to both the map and SQLite for persistence.
type Cache struct {
	mu      sync.RWMutex
	entries map[string]*domain.TrustEntry // DID -> entry
	db      *sql.DB                       // identity.sqlite handle (nil for pure in-memory)
}

// NewCache creates a trust cache. If db is non-nil, it runs the
// schema migration and loads existing entries into memory.
func NewCache(db *sql.DB) *Cache {
	c := &Cache{
		entries: make(map[string]*domain.TrustEntry),
		db:      db,
	}

	if db != nil {
		if err := c.migrate(); err != nil {
			slog.Warn("trust_cache: migration failed, running in-memory only", "error", err)
			c.db = nil
		} else {
			if err := c.loadFromDB(); err != nil {
				slog.Warn("trust_cache: load failed, starting empty", "error", err)
			}
		}
	}

	return c
}

// NewInMemoryCache creates a pure in-memory trust cache (for tests).
func NewInMemoryCache() *Cache {
	return &Cache{
		entries: make(map[string]*domain.TrustEntry),
	}
}

// migrate applies the trust_cache schema to identity.sqlite.
func (c *Cache) migrate() error {
	_, err := c.db.Exec(migrationSQL)
	return err
}

// loadFromDB loads all trust_cache rows into memory.
func (c *Cache) loadFromDB() error {
	rows, err := c.db.Query(`SELECT did, display_name, trust_score, trust_ring, relationship, source, last_verified_at, updated_at FROM trust_cache`)
	if err != nil {
		return fmt.Errorf("trust_cache: query failed: %w", err)
	}
	defer rows.Close()

	c.mu.Lock()
	defer c.mu.Unlock()

	for rows.Next() {
		var e domain.TrustEntry
		if err := rows.Scan(&e.DID, &e.DisplayName, &e.TrustScore, &e.TrustRing, &e.Relationship, &e.Source, &e.LastVerifiedAt, &e.UpdatedAt); err != nil {
			slog.Warn("trust_cache: scan failed", "error", err)
			continue
		}
		c.entries[e.DID] = &e
	}

	slog.Info("trust_cache: loaded entries", "count", len(c.entries))
	return rows.Err()
}

// Lookup returns the trust entry for a DID, or nil if not cached.
// O(1) in-memory read with RLock — safe for hot-path ingress calls.
func (c *Cache) Lookup(did string) (*domain.TrustEntry, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	e, ok := c.entries[did]
	if !ok {
		return nil, nil
	}
	// Return a copy to prevent data races.
	cp := *e
	return &cp, nil
}

// List returns all entries in the trust cache.
func (c *Cache) List() ([]domain.TrustEntry, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make([]domain.TrustEntry, 0, len(c.entries))
	for _, e := range c.entries {
		result = append(result, *e)
	}
	return result, nil
}

// Upsert inserts or updates a trust entry in both memory and SQLite.
func (c *Cache) Upsert(entry domain.TrustEntry) error {
	now := time.Now().Unix()
	entry.UpdatedAt = now

	c.mu.Lock()
	c.entries[entry.DID] = &entry
	c.mu.Unlock()

	if c.db != nil {
		_, err := c.db.Exec(`
			INSERT INTO trust_cache (did, display_name, trust_score, trust_ring, relationship, source, last_verified_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(did) DO UPDATE SET
				display_name = excluded.display_name,
				trust_score = excluded.trust_score,
				trust_ring = excluded.trust_ring,
				relationship = excluded.relationship,
				source = excluded.source,
				last_verified_at = excluded.last_verified_at,
				updated_at = excluded.updated_at`,
			entry.DID, entry.DisplayName, entry.TrustScore, entry.TrustRing,
			entry.Relationship, entry.Source, entry.LastVerifiedAt, now,
		)
		if err != nil {
			return fmt.Errorf("trust_cache: upsert failed: %w", err)
		}
	}

	return nil
}

// Remove deletes a DID from both memory and SQLite.
func (c *Cache) Remove(did string) error {
	c.mu.Lock()
	delete(c.entries, did)
	c.mu.Unlock()

	if c.db != nil {
		if _, err := c.db.Exec(`DELETE FROM trust_cache WHERE did = ?`, did); err != nil {
			return fmt.Errorf("trust_cache: delete failed: %w", err)
		}
	}

	return nil
}

// Stats returns cache entry count and last sync timestamp.
func (c *Cache) Stats() (domain.TrustCacheStats, error) {
	c.mu.RLock()
	count := len(c.entries)
	c.mu.RUnlock()

	var lastSync int64
	if c.db != nil {
		row := c.db.QueryRow(`SELECT value FROM kv_store WHERE key = 'trust_sync_last'`)
		var val string
		if err := row.Scan(&val); err == nil {
			fmt.Sscanf(val, "%d", &lastSync)
		}
	}

	return domain.TrustCacheStats{
		Count:      count,
		LastSyncAt: lastSync,
	}, nil
}

// SetLastSync updates the last sync timestamp in kv_store.
func (c *Cache) SetLastSync(ts int64) error {
	if c.db == nil {
		return nil
	}
	_, err := c.db.Exec(`
		INSERT INTO kv_store (key, value, updated_at)
		VALUES ('trust_sync_last', ?, CAST(strftime('%s', 'now') AS INTEGER))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		fmt.Sprintf("%d", ts),
	)
	return err
}
