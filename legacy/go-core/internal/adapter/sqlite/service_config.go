package sqlite

import (
	"database/sql"
	"time"
)

// ServiceConfigStore reads and writes service configuration from identity.sqlite.
type ServiceConfigStore struct {
	pool *Pool
}

// NewServiceConfigStore wraps the identity pool for service config access.
func NewServiceConfigStore(pool *Pool) *ServiceConfigStore {
	return &ServiceConfigStore{pool: pool}
}

func (s *ServiceConfigStore) db() *sql.DB {
	return s.pool.DB("identity")
}

// Get returns the service config JSON, or empty string if not set.
func (s *ServiceConfigStore) Get() (string, error) {
	db := s.db()
	if db == nil {
		return "", nil
	}
	var value string
	err := db.QueryRow(`SELECT value FROM service_config WHERE key = 'config'`).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// Put stores the service config JSON.
func (s *ServiceConfigStore) Put(configJSON string) error {
	db := s.db()
	if db == nil {
		return nil
	}
	_, err := db.Exec(
		`INSERT INTO service_config (key, value, updated_at) VALUES ('config', ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		configJSON, time.Now().Unix(),
	)
	return err
}
