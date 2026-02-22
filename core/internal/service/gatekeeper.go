package service

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// GatekeeperService is the safety layer for autonomous agents.
// Any agent acting on behalf of the user submits intent here first.
// Safe tasks pass silently; risky actions (email, money, data sharing)
// are flagged for review. Every decision is appended to the audit log.
type GatekeeperService struct {
	vault      port.VaultManager
	reader     port.VaultReader
	gatekeeper port.Gatekeeper
	auditor    port.VaultAuditLogger
	notifier   port.ClientNotifier
	clock      port.Clock
}

// NewGatekeeperService constructs a GatekeeperService with the given port dependencies.
func NewGatekeeperService(
	vault port.VaultManager,
	reader port.VaultReader,
	gatekeeper port.Gatekeeper,
	auditor port.VaultAuditLogger,
	notifier port.ClientNotifier,
	clock port.Clock,
) *GatekeeperService {
	return &GatekeeperService{
		vault:      vault,
		reader:     reader,
		gatekeeper: gatekeeper,
		auditor:    auditor,
		notifier:   notifier,
		clock:      clock,
	}
}

// CheckAccess evaluates an agent's intent against the gatekeeper rules,
// verifies the target persona's tier allows the requested action,
// and records the decision in the audit log.
//
// Returns the gatekeeper decision. If the persona is locked, access is
// always denied regardless of gatekeeper rules.
func (s *GatekeeperService) CheckAccess(ctx context.Context, intent domain.Intent) (domain.Decision, error) {
	// If the intent targets a specific persona, verify it is open.
	if intent.PersonaID != "" {
		personaName, err := domain.NewPersonaName(intent.PersonaID)
		if err != nil {
			return domain.Decision{}, fmt.Errorf("check access: %w", err)
		}
		if !s.vault.IsOpen(personaName) {
			denied := domain.Decision{
				Allowed: false,
				Reason:  "persona is locked",
				Audit:   true,
			}
			// Audit the denial.
			s.appendAudit(ctx, intent, denied)
			return denied, nil
		}
	}

	// Evaluate intent against gatekeeper rules.
	decision, err := s.gatekeeper.EvaluateIntent(ctx, intent)
	if err != nil {
		return domain.Decision{}, fmt.Errorf("check access: gatekeeper evaluation failed: %w", err)
	}

	// Always audit gatekeeper decisions.
	s.appendAudit(ctx, intent, decision)

	// If the action was denied and is auditable, notify connected clients.
	if !decision.Allowed && decision.Audit {
		s.notifyDenial(ctx, intent, decision)
	}

	return decision, nil
}

// EnforceEgress checks whether outbound data to a destination is allowed
// by the gatekeeper, and records the decision in the audit log.
//
// Returns true if egress is permitted, false otherwise.
func (s *GatekeeperService) EnforceEgress(ctx context.Context, destination string, data []byte) (bool, error) {
	allowed, err := s.gatekeeper.CheckEgress(ctx, destination, data)
	if err != nil {
		return false, fmt.Errorf("enforce egress: %w", err)
	}

	// Build an audit entry for the egress check.
	entry := domain.VaultAuditEntry{
		Timestamp: s.clock.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Action:    "egress_check",
		Requester: destination,
		QueryType: "egress",
	}

	if allowed {
		entry.Reason = "allowed"
	} else {
		entry.Reason = "denied"
	}

	if _, auditErr := s.auditor.Append(ctx, entry); auditErr != nil {
		// Audit failure should not block the egress decision,
		// but we wrap it for observability.
		return allowed, fmt.Errorf("enforce egress: audit append failed (egress %v): %w", allowed, auditErr)
	}

	// Notify clients of denied egress attempts.
	if !allowed {
		s.notifyEgressDenial(ctx, destination)
	}

	return allowed, nil
}

// appendAudit writes a gatekeeper decision to the audit log.
// Errors are silently ignored to avoid blocking the access decision.
func (s *GatekeeperService) appendAudit(ctx context.Context, intent domain.Intent, decision domain.Decision) {
	decisionStr := "denied"
	if decision.Allowed {
		decisionStr = "allowed"
	}

	metadata, _ := json.Marshal(map[string]string{
		"agent_did": intent.AgentDID,
		"action":    intent.Action,
		"target":    intent.Target,
	})

	entry := domain.VaultAuditEntry{
		Timestamp: s.clock.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Persona:   intent.PersonaID,
		Action:    "access_check",
		Requester: intent.AgentDID,
		QueryType: intent.Action,
		Reason:    decisionStr + ": " + decision.Reason,
		Metadata:  string(metadata),
	}

	// Best-effort audit; do not propagate errors.
	_, _ = s.auditor.Append(ctx, entry)
}

// notifyDenial broadcasts a denial notification to connected client devices.
func (s *GatekeeperService) notifyDenial(ctx context.Context, intent domain.Intent, decision domain.Decision) {
	payload, _ := json.Marshal(map[string]string{
		"type":    "gatekeeper_denial",
		"agent":   intent.AgentDID,
		"action":  intent.Action,
		"target":  intent.Target,
		"persona": intent.PersonaID,
		"reason":  decision.Reason,
	})

	// Best-effort notification; do not propagate errors.
	_ = s.notifier.Broadcast(ctx, payload)
}

// notifyEgressDenial broadcasts an egress denial notification to connected clients.
func (s *GatekeeperService) notifyEgressDenial(ctx context.Context, destination string) {
	payload, _ := json.Marshal(map[string]string{
		"type":        "egress_denial",
		"destination": destination,
	})

	// Best-effort notification; do not propagate errors.
	_ = s.notifier.Broadcast(ctx, payload)
}
