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

// ScenarioPolicyManager is a durable SQLite implementation of
// port.ScenarioPolicyManager backed by the identity.sqlite database.
// Policies survive Core restarts.
type ScenarioPolicyManager struct {
	pool *Pool
}

// Compile-time check.
var _ port.ScenarioPolicyManager = (*ScenarioPolicyManager)(nil)

// NewScenarioPolicyManager creates a ScenarioPolicyManager backed by identity.sqlite.
func NewScenarioPolicyManager(pool *Pool) *ScenarioPolicyManager {
	return &ScenarioPolicyManager{pool: pool}
}

func (m *ScenarioPolicyManager) db() *sql.DB {
	return m.pool.DB("identity")
}

// GetScenarioTier returns the policy tier for a contact+scenario pair.
// Returns ScenarioDenyByDefault if no explicit policy has been set.
func (m *ScenarioPolicyManager) GetScenarioTier(ctx context.Context, contactDID, scenario string) (domain.ScenarioTier, error) {
	db := m.db()
	if db == nil {
		return domain.ScenarioDenyByDefault, fmt.Errorf("scenario_policy: identity database not open")
	}

	var tier string
	err := db.QueryRowContext(ctx,
		`SELECT tier FROM scenario_policies WHERE contact_did=? AND scenario=?`,
		contactDID, scenario,
	).Scan(&tier)
	if err == sql.ErrNoRows {
		return domain.ScenarioDenyByDefault, nil
	}
	if err != nil {
		return domain.ScenarioDenyByDefault, fmt.Errorf("scenario_policy: get tier: %w", err)
	}
	return domain.ScenarioTier(tier), nil
}

// SetScenarioPolicy sets (or replaces) the tier for a contact+scenario pair.
func (m *ScenarioPolicyManager) SetScenarioPolicy(ctx context.Context, contactDID, scenario string, tier domain.ScenarioTier) error {
	db := m.db()
	if db == nil {
		return fmt.Errorf("scenario_policy: identity database not open")
	}

	now := time.Now().Unix()
	_, err := db.ExecContext(ctx,
		`INSERT OR REPLACE INTO scenario_policies (contact_did, scenario, tier, updated_at)
		 VALUES (?, ?, ?, ?)`,
		contactDID, scenario, string(tier), now,
	)
	if err != nil {
		return fmt.Errorf("scenario_policy: set policy: %w", err)
	}
	return nil
}

// ListPolicies returns all scenario→tier mappings for a contact.
// Returns an empty map (not an error) when no policies have been set.
func (m *ScenarioPolicyManager) ListPolicies(ctx context.Context, contactDID string) (map[string]domain.ScenarioTier, error) {
	db := m.db()
	if db == nil {
		return nil, fmt.Errorf("scenario_policy: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT scenario, tier FROM scenario_policies WHERE contact_did=?`,
		contactDID,
	)
	if err != nil {
		return nil, fmt.Errorf("scenario_policy: list policies: %w", err)
	}
	defer rows.Close()

	policies := make(map[string]domain.ScenarioTier)
	for rows.Next() {
		var scenario, tier string
		if err := rows.Scan(&scenario, &tier); err != nil {
			return nil, fmt.Errorf("scenario_policy: scan: %w", err)
		}
		policies[scenario] = domain.ScenarioTier(tier)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("scenario_policy: rows: %w", err)
	}
	return policies, nil
}

// v1DefaultPolicies are the six default scenario policies for a new contact.
// They reflect the principle of standing trust for common social signals and
// explicit approval for identity-sensitive operations.
var v1DefaultPolicies = []struct {
	scenario string
	tier     domain.ScenarioTier
}{
	{"presence", domain.ScenarioStandingPolicy},
	{"coordination", domain.ScenarioStandingPolicy},
	{"social", domain.ScenarioStandingPolicy},
	{"trust", domain.ScenarioExplicitOnce},
	{"safety", domain.ScenarioStandingPolicy},
}

// SetDefaultPolicies inserts the six v1 default policies for a new contact.
// Existing policies are not overwritten (INSERT OR IGNORE semantics).
func (m *ScenarioPolicyManager) SetDefaultPolicies(ctx context.Context, contactDID string) error {
	db := m.db()
	if db == nil {
		return fmt.Errorf("scenario_policy: identity database not open")
	}

	now := time.Now().Unix()
	for _, p := range v1DefaultPolicies {
		_, err := db.ExecContext(ctx,
			`INSERT OR IGNORE INTO scenario_policies (contact_did, scenario, tier, updated_at)
			 VALUES (?, ?, ?, ?)`,
			contactDID, p.scenario, string(p.tier), now,
		)
		if err != nil {
			return fmt.Errorf("scenario_policy: set defaults for %q: %w", p.scenario, err)
		}
	}
	return nil
}
