package test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ==========================================================================
// §D2D-v1 — Domain model tests
//
// Tests verify:
//   1. ValidateV1Body accepts valid bodies for all v1 families
//   2. ValidateV1Body returns ErrUnknownMessageType for non-v1 types
//   3. ValidateV1Body returns ErrInvalidD2DBody for malformed/missing fields
//   4. V1MessageFamilies contains exactly the 7 expected types
//   5. MsgTypeToScenario returns the correct scenario for each type
//   6. D2DMemoryTypes contains only the 2 memory-producing types
// ==========================================================================

// ---------------------------------------------------------------------------
// V1MessageFamilies
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0422", "section": "07", "sectionName": "Transport Layer", "subsection": "01", "scenario": "01", "title": "V1MessageFamilies_ContainsExpectedTypes"}
func TestV1MessageFamilies_ContainsExpectedTypes(t *testing.T) {
	expected := []domain.MessageType{
		domain.MsgTypePresenceSignal,
		domain.MsgTypeSocialUpdate,
		domain.MsgTypeSafetyAlert,
		domain.MsgTypeTrustVouchRequest,
		domain.MsgTypeTrustVouchResponse,
		domain.MsgTypeCoordinationRequest,
		domain.MsgTypeCoordinationResponse,
	}

	if len(domain.V1MessageFamilies) != len(expected) {
		t.Errorf("V1MessageFamilies has %d entries, want %d", len(domain.V1MessageFamilies), len(expected))
	}

	for _, mt := range expected {
		if !domain.V1MessageFamilies[mt] {
			t.Errorf("V1MessageFamilies missing %q", mt)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "0423", "section": "07", "sectionName": "Transport Layer", "subsection": "02", "scenario": "01", "title": "V1MessageFamilies_ExcludesLegacyTypes"}
func TestV1MessageFamilies_ExcludesLegacyTypes(t *testing.T) {
	legacyTypes := []domain.MessageType{
		domain.MessageTypeEstate,
		domain.MessageTypeKeyDeliver,
		"dina/social/arrival",
		"dina/query",
		"dina/response",
		"dina/ack",
		"dina/heartbeat",
	}
	for _, mt := range legacyTypes {
		if domain.V1MessageFamilies[mt] {
			t.Errorf("V1MessageFamilies should NOT contain legacy type %q", mt)
		}
	}
}

// ---------------------------------------------------------------------------
// MsgTypeToScenario
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0424", "section": "07", "sectionName": "Transport Layer", "subsection": "03", "scenario": "01", "title": "MsgTypeToScenario_KnownTypes"}
func TestMsgTypeToScenario_KnownTypes(t *testing.T) {
	cases := []struct {
		msgType  domain.MessageType
		scenario string
	}{
		{domain.MsgTypePresenceSignal, "presence"},
		{domain.MsgTypeSocialUpdate, "social"},
		{domain.MsgTypeSafetyAlert, "safety"},
		{domain.MsgTypeTrustVouchRequest, "trust"},
		{domain.MsgTypeTrustVouchResponse, "trust"},
		{domain.MsgTypeCoordinationRequest, "coordination"},
		{domain.MsgTypeCoordinationResponse, "coordination"},
	}

	for _, tc := range cases {
		got := domain.MsgTypeToScenario(tc.msgType)
		if got != tc.scenario {
			t.Errorf("MsgTypeToScenario(%q) = %q, want %q", tc.msgType, got, tc.scenario)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "0425", "section": "07", "sectionName": "Transport Layer", "subsection": "04", "scenario": "01", "title": "MsgTypeToScenario_UnknownType_ReturnsEmpty"}
func TestMsgTypeToScenario_UnknownType_ReturnsEmpty(t *testing.T) {
	got := domain.MsgTypeToScenario("totally.unknown")
	if got != "" {
		t.Errorf("MsgTypeToScenario(unknown) = %q, want %q", got, "")
	}
}

// ---------------------------------------------------------------------------
// D2DMemoryTypes
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0426", "section": "07", "sectionName": "Transport Layer", "subsection": "05", "scenario": "01", "title": "D2DMemoryTypes_OnlyMemoryProducingTypes"}
func TestD2DMemoryTypes_OnlyMemoryProducingTypes(t *testing.T) {
	// Exactly 2 types produce memory in v1.
	if len(domain.D2DMemoryTypes) != 2 {
		t.Errorf("D2DMemoryTypes has %d entries, want 2", len(domain.D2DMemoryTypes))
	}

	if domain.D2DMemoryTypes[domain.MsgTypeSocialUpdate] != "relationship_note" {
		t.Errorf("social.update should map to relationship_note")
	}
	if domain.D2DMemoryTypes[domain.MsgTypeTrustVouchResponse] != "trust_attestation" {
		t.Errorf("trust.vouch.response should map to trust_attestation")
	}

	// Ephemeral types must NOT produce memory.
	ephemeral := []domain.MessageType{
		domain.MsgTypePresenceSignal,
		domain.MsgTypeSafetyAlert,
		domain.MsgTypeTrustVouchRequest,
		domain.MsgTypeCoordinationRequest,
		domain.MsgTypeCoordinationResponse,
	}
	for _, mt := range ephemeral {
		if _, ok := domain.D2DMemoryTypes[mt]; ok {
			t.Errorf("D2DMemoryTypes should NOT contain ephemeral type %q", mt)
		}
	}
}

// ---------------------------------------------------------------------------
// ValidateV1Body — happy paths
// ---------------------------------------------------------------------------

func mustJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

// TRACE: {"suite": "CORE", "case": "0427", "section": "07", "sectionName": "Transport Layer", "subsection": "06", "scenario": "01", "title": "ValidateV1Body_PresenceSignal_Valid"}
func TestValidateV1Body_PresenceSignal_Valid(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"status": "online",
	})
	if err := domain.ValidateV1Body(domain.MsgTypePresenceSignal, body); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0428", "section": "07", "sectionName": "Transport Layer", "subsection": "07", "scenario": "01", "title": "ValidateV1Body_PresenceSignal_WithOptionalFields"}
func TestValidateV1Body_PresenceSignal_WithOptionalFields(t *testing.T) {
	eta := 10
	body := mustJSON(t, map[string]interface{}{
		"status":         "en_route",
		"eta_minutes":    eta,
		"location_label": "downtown",
	})
	if err := domain.ValidateV1Body(domain.MsgTypePresenceSignal, body); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0429", "section": "07", "sectionName": "Transport Layer", "subsection": "08", "scenario": "01", "title": "ValidateV1Body_SocialUpdate_Valid"}
func TestValidateV1Body_SocialUpdate_Valid(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"text":     "Just finished a big project!",
		"category": "life_event",
	})
	if err := domain.ValidateV1Body(domain.MsgTypeSocialUpdate, body); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0430", "section": "07", "sectionName": "Transport Layer", "subsection": "09", "scenario": "01", "title": "ValidateV1Body_SafetyAlert_Valid"}
func TestValidateV1Body_SafetyAlert_Valid(t *testing.T) {
	for _, severity := range []string{"low", "medium", "high", "critical"} {
		body := mustJSON(t, map[string]interface{}{
			"message":  "Test alert",
			"severity": severity,
		})
		if err := domain.ValidateV1Body(domain.MsgTypeSafetyAlert, body); err != nil {
			t.Errorf("severity=%q: unexpected error: %v", severity, err)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "0431", "section": "07", "sectionName": "Transport Layer", "subsection": "10", "scenario": "01", "title": "ValidateV1Body_TrustVouchRequest_Valid"}
func TestValidateV1Body_TrustVouchRequest_Valid(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"subject_did": "did:plc:abc123",
		"context":     "We met at the conference",
	})
	if err := domain.ValidateV1Body(domain.MsgTypeTrustVouchRequest, body); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0432", "section": "07", "sectionName": "Transport Layer", "subsection": "11", "scenario": "01", "title": "ValidateV1Body_TrustVouchResponse_Valid"}
func TestValidateV1Body_TrustVouchResponse_Valid(t *testing.T) {
	for _, vouch := range []string{"yes", "no", "partial"} {
		body := mustJSON(t, map[string]interface{}{
			"subject_did": "did:plc:abc123",
			"vouch":       vouch,
		})
		if err := domain.ValidateV1Body(domain.MsgTypeTrustVouchResponse, body); err != nil {
			t.Errorf("vouch=%q: unexpected error: %v", vouch, err)
		}
	}
}

// TRACE: {"suite": "CORE", "case": "0433", "section": "07", "sectionName": "Transport Layer", "subsection": "12", "scenario": "01", "title": "ValidateV1Body_CoordinationRequest_Valid"}
func TestValidateV1Body_CoordinationRequest_Valid(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"action":  "propose_time",
		"context": "Lunch at Koshy's?",
		"proposed_time": 1710000000,
	})
	if err := domain.ValidateV1Body(domain.MsgTypeCoordinationRequest, body); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0434", "section": "07", "sectionName": "Transport Layer", "subsection": "13", "scenario": "01", "title": "ValidateV1Body_CoordinationResponse_Valid"}
func TestValidateV1Body_CoordinationResponse_Valid(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"action": "accept",
		"note":   "See you there!",
	})
	if err := domain.ValidateV1Body(domain.MsgTypeCoordinationResponse, body); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// ValidateV1Body — ErrUnknownMessageType
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0435", "section": "07", "sectionName": "Transport Layer", "subsection": "14", "scenario": "01", "title": "ValidateV1Body_UnknownType"}
func TestValidateV1Body_UnknownType(t *testing.T) {
	unknownTypes := []domain.MessageType{
		"dina/social/update",
		"dina/trust/attestation",
		"totally.unknown",
		"",
		domain.MessageTypeEstate,
		domain.MessageTypeKeyDeliver,
	}
	for _, mt := range unknownTypes {
		body := mustJSON(t, map[string]interface{}{"x": 1})
		err := domain.ValidateV1Body(mt, body)
		if err == nil {
			t.Errorf("type=%q: expected ErrUnknownMessageType, got nil", mt)
			continue
		}
		if !errors.Is(err, domain.ErrUnknownMessageType) {
			t.Errorf("type=%q: expected ErrUnknownMessageType, got %v", mt, err)
		}
	}
}

// ---------------------------------------------------------------------------
// ValidateV1Body — ErrInvalidD2DBody (missing required fields)
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0436", "section": "07", "sectionName": "Transport Layer", "subsection": "15", "scenario": "01", "title": "ValidateV1Body_PresenceSignal_MissingStatus"}
func TestValidateV1Body_PresenceSignal_MissingStatus(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"eta_minutes": 5,
	})
	err := domain.ValidateV1Body(domain.MsgTypePresenceSignal, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0437", "section": "07", "sectionName": "Transport Layer", "subsection": "16", "scenario": "01", "title": "ValidateV1Body_SocialUpdate_MissingText"}
func TestValidateV1Body_SocialUpdate_MissingText(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"category": "life_event",
	})
	err := domain.ValidateV1Body(domain.MsgTypeSocialUpdate, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0438", "section": "07", "sectionName": "Transport Layer", "subsection": "17", "scenario": "01", "title": "ValidateV1Body_SafetyAlert_MissingMessage"}
func TestValidateV1Body_SafetyAlert_MissingMessage(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"severity": "high",
	})
	err := domain.ValidateV1Body(domain.MsgTypeSafetyAlert, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0439", "section": "07", "sectionName": "Transport Layer", "subsection": "18", "scenario": "01", "title": "ValidateV1Body_SafetyAlert_MissingSeverity"}
func TestValidateV1Body_SafetyAlert_MissingSeverity(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"message": "Something happened",
	})
	err := domain.ValidateV1Body(domain.MsgTypeSafetyAlert, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0440", "section": "07", "sectionName": "Transport Layer", "subsection": "19", "scenario": "01", "title": "ValidateV1Body_SafetyAlert_InvalidSeverity"}
func TestValidateV1Body_SafetyAlert_InvalidSeverity(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"message":  "Something happened",
		"severity": "extreme", // not a valid value
	})
	err := domain.ValidateV1Body(domain.MsgTypeSafetyAlert, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0441", "section": "07", "sectionName": "Transport Layer", "subsection": "20", "scenario": "01", "title": "ValidateV1Body_TrustVouchRequest_MissingSubjectDID"}
func TestValidateV1Body_TrustVouchRequest_MissingSubjectDID(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"context": "met at conference",
	})
	err := domain.ValidateV1Body(domain.MsgTypeTrustVouchRequest, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0442", "section": "07", "sectionName": "Transport Layer", "subsection": "21", "scenario": "01", "title": "ValidateV1Body_TrustVouchResponse_MissingSubjectDID"}
func TestValidateV1Body_TrustVouchResponse_MissingSubjectDID(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"vouch": "yes",
	})
	err := domain.ValidateV1Body(domain.MsgTypeTrustVouchResponse, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0443", "section": "07", "sectionName": "Transport Layer", "subsection": "22", "scenario": "01", "title": "ValidateV1Body_TrustVouchResponse_InvalidVouch"}
func TestValidateV1Body_TrustVouchResponse_InvalidVouch(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"subject_did": "did:plc:abc",
		"vouch":       "maybe", // not a valid value
	})
	err := domain.ValidateV1Body(domain.MsgTypeTrustVouchResponse, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0444", "section": "07", "sectionName": "Transport Layer", "subsection": "23", "scenario": "01", "title": "ValidateV1Body_TrustVouchResponse_MissingVouch"}
func TestValidateV1Body_TrustVouchResponse_MissingVouch(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"subject_did": "did:plc:abc",
	})
	err := domain.ValidateV1Body(domain.MsgTypeTrustVouchResponse, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0445", "section": "07", "sectionName": "Transport Layer", "subsection": "24", "scenario": "01", "title": "ValidateV1Body_CoordinationRequest_MissingAction"}
func TestValidateV1Body_CoordinationRequest_MissingAction(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"context": "Lunch?",
	})
	err := domain.ValidateV1Body(domain.MsgTypeCoordinationRequest, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0446", "section": "07", "sectionName": "Transport Layer", "subsection": "25", "scenario": "01", "title": "ValidateV1Body_CoordinationRequest_MissingContext"}
func TestValidateV1Body_CoordinationRequest_MissingContext(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"action": "propose_time",
	})
	err := domain.ValidateV1Body(domain.MsgTypeCoordinationRequest, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// TRACE: {"suite": "CORE", "case": "0447", "section": "07", "sectionName": "Transport Layer", "subsection": "26", "scenario": "01", "title": "ValidateV1Body_CoordinationResponse_MissingAction"}
func TestValidateV1Body_CoordinationResponse_MissingAction(t *testing.T) {
	body := mustJSON(t, map[string]interface{}{
		"note": "sounds good",
	})
	err := domain.ValidateV1Body(domain.MsgTypeCoordinationResponse, body)
	if !errors.Is(err, domain.ErrInvalidD2DBody) {
		t.Errorf("expected ErrInvalidD2DBody, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// ValidateV1Body — malformed JSON
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0448", "section": "07", "sectionName": "Transport Layer", "subsection": "27", "scenario": "01", "title": "ValidateV1Body_MalformedJSON"}
func TestValidateV1Body_MalformedJSON(t *testing.T) {
	types := []domain.MessageType{
		domain.MsgTypePresenceSignal,
		domain.MsgTypeSocialUpdate,
		domain.MsgTypeSafetyAlert,
		domain.MsgTypeTrustVouchRequest,
		domain.MsgTypeTrustVouchResponse,
		domain.MsgTypeCoordinationRequest,
		domain.MsgTypeCoordinationResponse,
	}
	for _, mt := range types {
		err := domain.ValidateV1Body(mt, []byte(`{not valid json`))
		if !errors.Is(err, domain.ErrInvalidD2DBody) {
			t.Errorf("type=%q: expected ErrInvalidD2DBody for malformed JSON, got %v", mt, err)
		}
	}
}

// ---------------------------------------------------------------------------
// OutboxStatus constants
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0449", "section": "07", "sectionName": "Transport Layer", "subsection": "28", "scenario": "01", "title": "OutboxStatusConstants"}
func TestOutboxStatusConstants(t *testing.T) {
	// Verify all 5 constants are distinct strings.
	statuses := []domain.OutboxStatus{
		domain.OutboxPending,
		domain.OutboxPendingApproval,
		domain.OutboxSending,
		domain.OutboxDelivered,
		domain.OutboxFailed,
	}
	seen := make(map[domain.OutboxStatus]bool)
	for _, s := range statuses {
		if seen[s] {
			t.Errorf("duplicate OutboxStatus constant: %q", s)
		}
		seen[s] = true
	}
	if len(seen) != 5 {
		t.Errorf("expected 5 distinct OutboxStatus constants, got %d", len(seen))
	}

	// Verify specific values match the SQL CHECK constraint.
	if domain.OutboxPending != "pending" {
		t.Errorf("OutboxPending = %q, want 'pending'", domain.OutboxPending)
	}
	if domain.OutboxPendingApproval != "pending_approval" {
		t.Errorf("OutboxPendingApproval = %q, want 'pending_approval'", domain.OutboxPendingApproval)
	}
	if domain.OutboxSending != "sending" {
		t.Errorf("OutboxSending = %q, want 'sending'", domain.OutboxSending)
	}
	if domain.OutboxDelivered != "delivered" {
		t.Errorf("OutboxDelivered = %q, want 'delivered'", domain.OutboxDelivered)
	}
	if domain.OutboxFailed != "failed" {
		t.Errorf("OutboxFailed = %q, want 'failed'", domain.OutboxFailed)
	}
}

// ---------------------------------------------------------------------------
// ScenarioTier constants
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0450", "section": "07", "sectionName": "Transport Layer", "subsection": "29", "scenario": "01", "title": "ScenarioTierConstants"}
func TestScenarioTierConstants(t *testing.T) {
	tiers := []domain.ScenarioTier{
		domain.ScenarioStandingPolicy,
		domain.ScenarioExplicitOnce,
		domain.ScenarioDenyByDefault,
	}
	seen := make(map[domain.ScenarioTier]bool)
	for _, tier := range tiers {
		if seen[tier] {
			t.Errorf("duplicate ScenarioTier: %q", tier)
		}
		seen[tier] = true
	}

	if domain.ScenarioStandingPolicy != "standing_policy" {
		t.Errorf("ScenarioStandingPolicy = %q, want 'standing_policy'", domain.ScenarioStandingPolicy)
	}
	if domain.ScenarioExplicitOnce != "explicit_once" {
		t.Errorf("ScenarioExplicitOnce = %q, want 'explicit_once'", domain.ScenarioExplicitOnce)
	}
	if domain.ScenarioDenyByDefault != "deny_by_default" {
		t.Errorf("ScenarioDenyByDefault = %q, want 'deny_by_default'", domain.ScenarioDenyByDefault)
	}
}

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0451", "section": "07", "sectionName": "Transport Layer", "subsection": "30", "scenario": "01", "title": "D2VSentinelErrors"}
func TestD2VSentinelErrors(t *testing.T) {
	// ErrUnknownMessageType, ErrInvalidD2DBody, ErrNotAContact must be distinct.
	errs := []error{
		domain.ErrUnknownMessageType,
		domain.ErrInvalidD2DBody,
		domain.ErrNotAContact,
	}
	for i, a := range errs {
		for j, b := range errs {
			if i != j && errors.Is(a, b) {
				t.Errorf("errors.Is(%v, %v) = true; they should be distinct", a, b)
			}
		}
	}
}
