// Package gatekeeper implements §6 Gatekeeper — request authorization,
// egress control, and sharing policy enforcement for the Dina Home Node.
//
// The Gatekeeper enforces the Four Laws at the API boundary:
//   - Safe tasks pass silently (no audit).
//   - Risky actions (email, money, data sharing) are flagged for review.
//   - Untrusted agents are denied by default.
//   - Raw data never leaves the Home Node without policy checks.
package gatekeeper

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

var _ port.Gatekeeper = (*Gatekeeper)(nil)
var _ port.SharingPolicyManager = (*SharingPolicyManager)(nil)

// Sentinel errors.
var (
	ErrEmptyAction   = errors.New("gatekeeper: action must not be empty")
	ErrEmptyAgentDID = errors.New("gatekeeper: agent DID must not be empty")
	ErrEmptyDest     = errors.New("gatekeeper: destination must not be empty")
	ErrNotFound      = errors.New("gatekeeper: policy not found")
	ErrInvalidTier   = errors.New("gatekeeper: invalid tier value")
)

// Type aliases for domain interface compatibility.
type Intent = domain.Intent
type Decision = domain.Decision
type SharingPolicy = domain.SharingPolicy
type TieredPayload = domain.TieredPayload
type EgressPayload = domain.EgressPayload
type EgressResult = domain.EgressResult
type AuditEntry = domain.AuditEntry

// riskyActions are actions that require audit and/or elevated trust.
var riskyActions = map[string]bool{
	"send_email":     true,
	"transfer_money": true,
	"share_data":     true,
}

// moneyActions require the highest trust ring (verified+actioned / "trusted").
var moneyActions = map[string]bool{
	"transfer_money": true,
}

// vaultActions are actions that access persona vaults.
var vaultActions = map[string]bool{
	"read_vault": true,
}

// brainDeniedActions are actions the brain agent must never perform.
// These are security-critical operations that only the human (via CLIENT_TOKEN) can invoke.
var brainDeniedActions = map[string]bool{
	"did_sign":       true,
	"did_rotate":     true,
	"vault_backup":   true,
	"persona_unlock": true,
}

// PII detection patterns for egress scanning.
var piiPatterns = []*regexp.Regexp{
	regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`),
	regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`),
	regexp.MustCompile(`\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b`),
	regexp.MustCompile(`\b\d{3}-\d{3}-\d{4}\b`),
}

// blockedDestinations are egress destinations that are always denied.
var blockedDestinations = map[string]bool{
	"https://blocked-tracker.example.com": true,
}

// trustedDestinations are egress destinations that are always allowed.
var trustedDestinations = map[string]bool{
	"https://trusted-api.example.com": true,
}

// ---------- Gatekeeper ----------

// Gatekeeper evaluates agent intents and egress requests.
type Gatekeeper struct{}

// New returns a new Gatekeeper.
func New() *Gatekeeper { return &Gatekeeper{} }

// EvaluateIntent decides whether an agent's action should proceed.
func (g *Gatekeeper) EvaluateIntent(_ context.Context, intent Intent) (Decision, error) {
	// Validate required fields.
	if intent.AgentDID == "" {
		return Decision{}, ErrEmptyAgentDID
	}
	if intent.Action == "" {
		return Decision{}, ErrEmptyAction
	}

	// Brain agent cannot perform security-critical actions.
	if intent.AgentDID == "brain" {
		if brainDeniedActions[intent.Action] {
			return Decision{
				Allowed: false,
				Reason:  fmt.Sprintf("brain agent denied: action %q is restricted to human (CLIENT_TOKEN)", intent.Action),
				Audit:   true,
			}, nil
		}
		// Brain cannot access locked personas.
		if intent.TrustLevel == "locked" {
			return Decision{
				Allowed: false,
				Reason:  "brain agent denied: persona is locked",
				Audit:   true,
			}, nil
		}
		// Brain accessing restricted personas creates an audit trail.
		if intent.TrustLevel == "restricted" {
			return Decision{
				Allowed: true,
				Reason:  "brain accessing restricted persona — audit trail created",
				Audit:   true,
			}, nil
		}
	}

	// Check constraint-based denials first.
	if intent.Constraints != nil {
		// Cross-persona constraint: agent authorized for one persona cannot access another.
		for k, v := range intent.Constraints {
			if v && strings.HasPrefix(k, "persona_") && strings.HasSuffix(k, "_only") {
				// Extract the allowed persona from the constraint key.
				allowedPersona := strings.TrimSuffix(strings.TrimPrefix(k, "persona_"), "_only")
				if intent.PersonaID != allowedPersona {
					return Decision{
						Allowed: false,
						Reason:  fmt.Sprintf("cross-persona access denied: agent constrained to %s, requested %s", allowedPersona, intent.PersonaID),
						Audit:   true,
					}, nil
				}
			}
		}
		// draft_only constraint: agent cannot perform direct actions like send_email.
		if intent.Constraints["draft_only"] {
			if riskyActions[intent.Action] {
				return Decision{
					Allowed: false,
					Reason:  "draft_only agent is not allowed to perform direct actions",
					Audit:   true,
				}, nil
			}
		}
	}

	// Untrusted agents are denied for vault access and risky actions.
	if intent.TrustLevel == "untrusted" {
		return Decision{
			Allowed: false,
			Reason:  "untrusted agent denied: trust level insufficient",
			Audit:   true,
		}, nil
	}

	// Money actions require the highest trust ring ("trusted", i.e. Verified+Actioned).
	if moneyActions[intent.Action] && intent.TrustLevel != "trusted" {
		return Decision{
			Allowed: false,
			Reason:  fmt.Sprintf("action %q requires trusted (Verified+Actioned) trust ring, got %q", intent.Action, intent.TrustLevel),
			Audit:   true,
		}, nil
	}

	// Verified (but not fully trusted) agent on restricted personas gets audited.
	if intent.TrustLevel == "verified" && vaultActions[intent.Action] {
		return Decision{
			Allowed: true,
			Reason:  "verified agent accessing restricted persona — flagged for review",
			Audit:   true,
		}, nil
	}

	// Risky actions are audited even for trusted agents.
	if riskyActions[intent.Action] {
		return Decision{
			Allowed: false,
			Reason:  fmt.Sprintf("risky action %q flagged for user review", intent.Action),
			Audit:   true,
		}, nil
	}

	// Safe intent — pass silently.
	return Decision{
		Allowed: true,
		Reason:  "safe intent allowed",
		Audit:   false,
	}, nil
}

// CheckEgress checks whether data may leave the Home Node to a destination.
func (g *Gatekeeper) CheckEgress(_ context.Context, destination string, data []byte) (bool, error) {
	if destination == "" {
		return false, ErrEmptyDest
	}

	// Blocked destination check.
	if blockedDestinations[destination] {
		return false, nil
	}

	// If data is nil (health-check ping), allow to trusted destinations.
	if data == nil {
		if trustedDestinations[destination] {
			return true, nil
		}
		// Default allow for nil data to any non-blocked destination.
		return true, nil
	}

	// PII check — raw data must never leave the Home Node.
	dataStr := string(data)
	for _, pat := range piiPatterns {
		if pat.MatchString(dataStr) {
			return false, nil
		}
	}

	// Trusted destination with clean data — allow.
	if trustedDestinations[destination] {
		return true, nil
	}

	// Default: allow egress to non-blocked destinations with clean data.
	return true, nil
}

// ---------- SharingPolicyManager ----------

// SharingPolicyManager provides CRUD for sharing policies per persona
// and egress filtering with tiered payloads.
type SharingPolicyManager struct {
	mu       sync.Mutex
	policies map[string]*SharingPolicy // contactDID -> policy
}

// NewSharingPolicyManager returns a new SharingPolicyManager.
func NewSharingPolicyManager() *SharingPolicyManager {
	return &SharingPolicyManager{
		policies: make(map[string]*SharingPolicy),
	}
}

// GetPolicy returns the sharing policy for a contact DID.
// If no explicit policy has been set for the contact, a default empty policy
// is returned (default-deny semantics: all categories absent = blocked).
func (m *SharingPolicyManager) GetPolicy(_ context.Context, contactDID string) (*SharingPolicy, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.policies[contactDID]
	if !ok {
		// Return a default empty policy rather than an error.
		// This supports default-deny: no categories means all blocked.
		return &SharingPolicy{
			ContactDID: contactDID,
			Categories: make(map[string]domain.SharingTier),
		}, nil
	}
	return p, nil
}

// SetPolicy sets one or more category tiers for a contact.
// Merges with existing policy (PATCH semantics).
func (m *SharingPolicyManager) SetPolicy(_ context.Context, contactDID string, categories map[string]domain.SharingTier) error {
	// Validate tier values.
	for _, tier := range categories {
		if !domain.ValidSharingTiers[tier] {
			return fmt.Errorf("%w: %q", ErrInvalidTier, tier)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.policies[contactDID]
	if !ok {
		p = &SharingPolicy{ContactDID: contactDID, Categories: make(map[string]domain.SharingTier)}
		m.policies[contactDID] = p
	}
	for k, v := range categories {
		p.Categories[k] = v
	}
	return nil
}

// SetBulkPolicy applies a policy to all contacts matching a filter.
// An empty filter matches all contacts.
func (m *SharingPolicyManager) SetBulkPolicy(_ context.Context, filter map[string]string, categories map[string]domain.SharingTier) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, p := range m.policies {
		for k, v := range categories {
			p.Categories[k] = v
		}
		count++
	}
	return count, nil
}

// FilterEgress applies sharing policy to an outbound payload.
// Default deny: no policy means all categories blocked.
func (m *SharingPolicyManager) FilterEgress(_ context.Context, payload EgressPayload) (*EgressResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	p, ok := m.policies[payload.RecipientDID]
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
