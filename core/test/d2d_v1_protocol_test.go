package test

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"github.com/mr-tron/base58"
	trustadapter "github.com/rajmohanutopai/dina/core/internal/adapter/trust"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// testMultibaseKey creates a valid multibase-encoded Ed25519 public key for testing.
func testMultibaseKey() string {
	pub := make([]byte, 32) // all zeros — valid for passthrough test
	return "z" + base58.Encode(append([]byte{0xed, 0x01}, pub...))
}

// ==========================================================================
// D2D v1 Protocol Tests — Phases 3, 4, 5
// ==========================================================================

// ---------------------------------------------------------------------------
// Phase 3.1: EvaluateIngress contacts-only behavior
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0452", "section": "07", "sectionName": "Transport Layer", "subsection": "01", "scenario": "01", "title": "D2D_V1_IngressContactsOnly_ExplicitContactAccepted"}
func TestD2D_V1_IngressContactsOnly_ExplicitContactAccepted(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:friend": "trusted",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:friend")
	testutil.RequireTrue(t, decision == domain.IngressAccept, "explicit contact should be accepted")
}

// TRACE: {"suite": "CORE", "case": "0453", "section": "07", "sectionName": "Transport Layer", "subsection": "02", "scenario": "01", "title": "D2D_V1_IngressContactsOnly_NonContactQuarantined"}
func TestD2D_V1_IngressContactsOnly_NonContactQuarantined(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	// Add high trust score in cache but NOT as contact.
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:stranger", TrustScore: 0.95, TrustRing: 3,
		Relationship: "1-hop", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:stranger")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine,
		"v1: non-contact quarantined regardless of trust cache score")
}

// TRACE: {"suite": "CORE", "case": "0454", "section": "07", "sectionName": "Transport Layer", "subsection": "03", "scenario": "01", "title": "D2D_V1_IngressContactsOnly_BlockedContactDropped"}
func TestD2D_V1_IngressContactsOnly_BlockedContactDropped(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:blocked_user": "blocked",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:blocked_user")
	testutil.RequireTrue(t, decision == domain.IngressDrop, "blocked contact should be dropped")
}

// TRACE: {"suite": "CORE", "case": "0455", "section": "07", "sectionName": "Transport Layer", "subsection": "04", "scenario": "01", "title": "D2D_V1_IngressContactsOnly_EmptyDIDQuarantined"}
func TestD2D_V1_IngressContactsOnly_EmptyDIDQuarantined(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "empty DID should be quarantined")
}

// TRACE: {"suite": "CORE", "case": "0456", "section": "07", "sectionName": "Transport Layer", "subsection": "05", "scenario": "01", "title": "D2D_V1_IngressContactsOnly_UnknownTrustLevelAccepted"}
func TestD2D_V1_IngressContactsOnly_UnknownTrustLevelAccepted(t *testing.T) {
	// A contact with trust_level="unknown" is still an explicit contact.
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:new_contact": "unknown",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:new_contact")
	testutil.RequireTrue(t, decision == domain.IngressAccept,
		"contact with unknown trust level should be accepted (they are an explicit contact)")
}

// ---------------------------------------------------------------------------
// Phase 3.3: SendMessage contact gate + scenario gate
// ---------------------------------------------------------------------------

// mockContactLookupForTransport implements port.ContactLookup for transport tests.
type mockContactLookupForTransport struct {
	contacts map[string]bool
}

func (m *mockContactLookupForTransport) GetTrustLevel(did string) string {
	if m.contacts[did] {
		return "trusted"
	}
	return ""
}

func (m *mockContactLookupForTransport) IsContact(did string) bool {
	return m.contacts[did]
}

// mockScenarioPolicyForTransport implements port.ScenarioPolicyManager for transport tests.
type mockScenarioPolicyForTransport struct {
	policies map[string]domain.ScenarioTier // "did|scenario" -> tier
}

func (m *mockScenarioPolicyForTransport) GetScenarioTier(_ context.Context, contactDID, scenario string) (domain.ScenarioTier, error) {
	key := contactDID + "|" + scenario
	tier, ok := m.policies[key]
	if !ok {
		return domain.ScenarioDenyByDefault, nil
	}
	return tier, nil
}

func (m *mockScenarioPolicyForTransport) SetScenarioPolicy(_ context.Context, _, _ string, _ domain.ScenarioTier) error {
	return nil
}

func (m *mockScenarioPolicyForTransport) ListPolicies(_ context.Context, _ string) (map[string]domain.ScenarioTier, error) {
	return nil, nil
}

func (m *mockScenarioPolicyForTransport) SetDefaultPolicies(_ context.Context, _ string) error {
	return nil
}

// TRACE: {"suite": "CORE", "case": "0457", "section": "07", "sectionName": "Transport Layer", "subsection": "06", "scenario": "01", "title": "D2D_V1_SendMessage_ContactGateBlocksNonContact"}
func TestD2D_V1_SendMessage_ContactGateBlocksNonContact(t *testing.T) {
	svc := service.NewTransportService(
		&mockPassthroughEncryptor{}, &mockTestIdentitySigner{},
		&mockTestKeyConverter{}, newMockTestDIDResolver(),
		newMockTestOutboxManager(), &mockTestInboxManager{},
		&mockTestClock{},
	)
	svc.SetContacts(&mockContactLookupForTransport{
		contacts: map[string]bool{"did:plc:friend": true},
	})

	msg := domain.DinaMessage{
		ID:   "test-1",
		Type: domain.MsgTypeSocialUpdate,
		Body: []byte(`{"text":"hello"}`),
	}

	err := svc.SendMessage(context.Background(), "did:plc:stranger", msg)
	testutil.RequireTrue(t, err != nil, "send to non-contact should fail")
	testutil.RequireTrue(t, errors.Is(err, domain.ErrNotAContact),
		"error should be ErrNotAContact, got: "+err.Error())
}

// TRACE: {"suite": "CORE", "case": "0458", "section": "07", "sectionName": "Transport Layer", "subsection": "07", "scenario": "01", "title": "D2D_V1_SendMessage_ScenarioGateDenyByDefault"}
func TestD2D_V1_SendMessage_ScenarioGateDenyByDefault(t *testing.T) {
	resolver := newMockTestDIDResolver()
	resolver.docs["did:plc:friend"] = &domain.DIDDocument{
		ID: "did:plc:friend",
		VerificationMethod: []domain.VerificationMethod{
			{ID: "did:plc:friend#key-1", PublicKeyMultibase: testMultibaseKey()},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://friend.dina.local/didcomm"},
		},
	}

	svc := service.NewTransportService(
		&mockPassthroughEncryptor{}, &mockTestIdentitySigner{},
		&mockTestKeyConverter{}, resolver,
		newMockTestOutboxManager(), &mockTestInboxManager{},
		&mockTestClock{},
	)
	svc.SetContacts(&mockContactLookupForTransport{
		contacts: map[string]bool{"did:plc:friend": true},
	})
	svc.SetScenarioPolicy(&mockScenarioPolicyForTransport{
		policies: map[string]domain.ScenarioTier{
			"did:plc:friend|trust": domain.ScenarioDenyByDefault,
		},
	})

	msg := domain.DinaMessage{
		ID:   "test-2",
		Type: domain.MsgTypeTrustVouchRequest,
		Body: []byte(`{"subject_did":"did:plc:someone","context":"test"}`),
	}

	err := svc.SendMessage(context.Background(), "did:plc:friend", msg)
	testutil.RequireTrue(t, err != nil, "send with denied scenario should fail")
	testutil.RequireTrue(t, errors.Is(err, domain.ErrEgressBlocked),
		"error should be ErrEgressBlocked, got: "+err.Error())
}

// TRACE: {"suite": "CORE", "case": "0459", "section": "07", "sectionName": "Transport Layer", "subsection": "08", "scenario": "01", "title": "D2D_V1_SendMessage_ScenarioGateExplicitOnceBlocked"}
func TestD2D_V1_SendMessage_ScenarioGateExplicitOnceBlocked(t *testing.T) {
	resolver := newMockTestDIDResolver()
	resolver.docs["did:plc:friend"] = &domain.DIDDocument{
		ID: "did:plc:friend",
		VerificationMethod: []domain.VerificationMethod{
			{ID: "did:plc:friend#key-1", PublicKeyMultibase: testMultibaseKey()},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://friend.dina.local/didcomm"},
		},
	}

	svc := service.NewTransportService(
		&mockPassthroughEncryptor{}, &mockTestIdentitySigner{},
		&mockTestKeyConverter{}, resolver,
		newMockTestOutboxManager(), &mockTestInboxManager{},
		&mockTestClock{},
	)
	svc.SetContacts(&mockContactLookupForTransport{
		contacts: map[string]bool{"did:plc:friend": true},
	})
	svc.SetScenarioPolicy(&mockScenarioPolicyForTransport{
		policies: map[string]domain.ScenarioTier{
			"did:plc:friend|trust": domain.ScenarioExplicitOnce,
		},
	})

	msg := domain.DinaMessage{
		ID:   "test-3",
		Type: domain.MsgTypeTrustVouchRequest,
		Body: []byte(`{"subject_did":"did:plc:someone","context":"test"}`),
	}

	err := svc.SendMessage(context.Background(), "did:plc:friend", msg)
	testutil.RequireTrue(t, err != nil, "explicit_once should block in v1")
	testutil.RequireTrue(t, errors.Is(err, domain.ErrEgressBlocked),
		"error should be ErrEgressBlocked for explicit_once, got: "+err.Error())
}

// TRACE: {"suite": "CORE", "case": "0460", "section": "07", "sectionName": "Transport Layer", "subsection": "09", "scenario": "01", "title": "D2D_V1_SendMessage_StandingPolicyAllowed"}
func TestD2D_V1_SendMessage_StandingPolicyAllowed(t *testing.T) {
	resolver := newMockTestDIDResolver()
	resolver.docs["did:plc:friend"] = &domain.DIDDocument{
		ID: "did:plc:friend",
		VerificationMethod: []domain.VerificationMethod{
			{ID: "did:plc:friend#key-1", PublicKeyMultibase: testMultibaseKey()},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://friend.dina.local/didcomm"},
		},
	}

	svc := service.NewTransportService(
		&mockPassthroughEncryptor{}, &mockTestIdentitySigner{},
		&mockTestKeyConverter{}, resolver,
		newMockTestOutboxManager(), &mockTestInboxManager{},
		&mockTestClock{},
	)
	svc.SetDeliverer(&mockTestDeliverer{})
	svc.SetVerifier(&mockTestSigner{})
	svc.SetContacts(&mockContactLookupForTransport{
		contacts: map[string]bool{"did:plc:friend": true},
	})
	svc.SetScenarioPolicy(&mockScenarioPolicyForTransport{
		policies: map[string]domain.ScenarioTier{
			"did:plc:friend|social": domain.ScenarioStandingPolicy,
		},
	})
	svc.SetSenderDID("did:plc:sender")

	msg := domain.DinaMessage{
		ID:   "test-4",
		Type: domain.MsgTypeSocialUpdate,
		Body: []byte(`{"text":"hello friend"}`),
	}

	err := svc.SendMessage(context.Background(), "did:plc:friend", msg)
	testutil.RequireTrue(t, err == nil, "standing_policy send should succeed, got: "+errMsg(err))
}

// ---------------------------------------------------------------------------
// Phase 3.4: Strict v1 type enforcement on send and receive
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0461", "section": "07", "sectionName": "Transport Layer", "subsection": "10", "scenario": "01", "title": "D2D_V1_HandleSend_RejectsNonV1Type"}
func TestD2D_V1_HandleSend_RejectsNonV1Type(t *testing.T) {
	// Verify that non-v1 types are rejected by type check before SendMessage.
	// This is implicitly tested by the fact that SendMessage also checks v1 types,
	// but let's verify the domain check directly.
	testutil.RequireTrue(t, !domain.V1MessageFamilies[domain.MessageTypeQuery],
		"dina/query should NOT be in V1MessageFamilies")
	testutil.RequireTrue(t, !domain.V1MessageFamilies[domain.MessageTypeSocial],
		"dina/social/arrival should NOT be in V1MessageFamilies")
	testutil.RequireTrue(t, !domain.V1MessageFamilies[domain.MessageTypeEstate],
		"dina/estate/notify should NOT be in V1MessageFamilies (v2+)")
}

// TRACE: {"suite": "CORE", "case": "0462", "section": "07", "sectionName": "Transport Layer", "subsection": "11", "scenario": "01", "title": "D2D_V1_HandleSend_AcceptsV1Type"}
func TestD2D_V1_HandleSend_AcceptsV1Type(t *testing.T) {
	for mt := range domain.V1MessageFamilies {
		testutil.RequireTrue(t, domain.V1MessageFamilies[mt],
			string(mt)+" should be in V1MessageFamilies")
	}
}

// TRACE: {"suite": "CORE", "case": "0463", "section": "07", "sectionName": "Transport Layer", "subsection": "12", "scenario": "01", "title": "D2D_V1_SendMessage_NonV1TypeRejected"}
func TestD2D_V1_SendMessage_NonV1TypeRejected(t *testing.T) {
	resolver := newMockTestDIDResolver()
	resolver.docs["did:plc:friend"] = &domain.DIDDocument{
		ID: "did:plc:friend",
		VerificationMethod: []domain.VerificationMethod{
			{ID: "did:plc:friend#key-1", PublicKeyMultibase: testMultibaseKey()},
		},
		Service: []domain.ServiceEndpoint{
			{ID: "#didcomm", ServiceEndpoint: "https://friend.dina.local/didcomm"},
		},
	}

	svc := service.NewTransportService(
		&mockPassthroughEncryptor{}, &mockTestIdentitySigner{},
		&mockTestKeyConverter{}, resolver,
		newMockTestOutboxManager(), &mockTestInboxManager{},
		&mockTestClock{},
	)
	svc.SetContacts(&mockContactLookupForTransport{
		contacts: map[string]bool{"did:plc:friend": true},
	})
	// No scenario policy = deny_by_default for all. But type check is after scenario check.
	// Set standing_policy so scenario passes, then type check rejects.
	svc.SetScenarioPolicy(&mockScenarioPolicyForTransport{
		policies: map[string]domain.ScenarioTier{},
	})

	msg := domain.DinaMessage{
		ID:   "test-5",
		Type: domain.MessageTypeQuery, // legacy v0 type
		Body: []byte(`{"q":"test"}`),
	}

	err := svc.SendMessage(context.Background(), "did:plc:friend", msg)
	testutil.RequireTrue(t, err != nil, "non-v1 type send should fail")
	// The scenario check happens first (deny_by_default for empty scenario) and
	// returns ErrEgressBlocked. But MessageTypeQuery has MsgTypeToScenario returning "",
	// so no scenario lookup is done, and we reach the type check.
	testutil.RequireTrue(t, errors.Is(err, domain.ErrUnknownMessageType),
		"error should be ErrUnknownMessageType, got: "+err.Error())
}

// ---------------------------------------------------------------------------
// Phase 3.4: Sweeper benign drop for unknown types
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0464", "section": "07", "sectionName": "Transport Layer", "subsection": "13", "scenario": "01", "title": "D2D_V1_MsgTypeToScenario_AllV1Covered"}
func TestD2D_V1_MsgTypeToScenario_AllV1Covered(t *testing.T) {
	// service.* types intentionally return empty scenario — they bypass the
	// contact/scenario policy system entirely and use the query window instead.
	exemptFromScenario := map[domain.MessageType]bool{
		domain.MsgTypeServiceQuery:    true,
		domain.MsgTypeServiceResponse: true,
	}
	for mt := range domain.V1MessageFamilies {
		if exemptFromScenario[mt] {
			testutil.RequireTrue(t, domain.MsgTypeToScenario(mt) == "",
				string(mt)+" should return empty scenario (bypasses scenario policy)")
			continue
		}
		scenario := domain.MsgTypeToScenario(mt)
		testutil.RequireTrue(t, scenario != "",
			string(mt)+" should have a non-empty scenario mapping")
	}
}

// TRACE: {"suite": "CORE", "case": "0465", "section": "07", "sectionName": "Transport Layer", "subsection": "14", "scenario": "01", "title": "D2D_V1_MsgTypeToScenario_LegacyReturnsEmpty"}
func TestD2D_V1_MsgTypeToScenario_LegacyReturnsEmpty(t *testing.T) {
	testutil.RequireTrue(t, domain.MsgTypeToScenario(domain.MessageTypeQuery) == "",
		"legacy types should return empty scenario")
}

// ---------------------------------------------------------------------------
// Phase 5: Scenario-driven staging
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0466", "section": "07", "sectionName": "Transport Layer", "subsection": "15", "scenario": "01", "title": "D2D_V1_D2DMemoryTypes_OnlyRelationshipAndTrust"}
func TestD2D_V1_D2DMemoryTypes_OnlyRelationshipAndTrust(t *testing.T) {
	// Only social.update and trust.vouch.response produce vault items.
	testutil.RequireTrue(t, domain.D2DMemoryTypes[domain.MsgTypeSocialUpdate] == "relationship_note",
		"social.update should produce relationship_note")
	testutil.RequireTrue(t, domain.D2DMemoryTypes[domain.MsgTypeTrustVouchResponse] == "trust_attestation",
		"trust.vouch.response should produce trust_attestation")

	// Verify non-memory types are absent.
	_, hasPresence := domain.D2DMemoryTypes[domain.MsgTypePresenceSignal]
	testutil.RequireTrue(t, !hasPresence, "presence.signal should NOT produce vault items")

	_, hasSafety := domain.D2DMemoryTypes[domain.MsgTypeSafetyAlert]
	testutil.RequireTrue(t, !hasSafety, "safety.alert should NOT produce vault items")

	_, hasCoordReq := domain.D2DMemoryTypes[domain.MsgTypeCoordinationRequest]
	testutil.RequireTrue(t, !hasCoordReq, "coordination.request should NOT produce vault items")
}

// TRACE: {"suite": "CORE", "case": "0467", "section": "07", "sectionName": "Transport Layer", "subsection": "16", "scenario": "01", "title": "D2D_V1_ScenarioTier_Constants"}
func TestD2D_V1_ScenarioTier_Constants(t *testing.T) {
	testutil.RequireTrue(t, domain.ScenarioStandingPolicy == "standing_policy",
		"ScenarioStandingPolicy value should be 'standing_policy'")
	testutil.RequireTrue(t, domain.ScenarioExplicitOnce == "explicit_once",
		"ScenarioExplicitOnce value should be 'explicit_once'")
	testutil.RequireTrue(t, domain.ScenarioDenyByDefault == "deny_by_default",
		"ScenarioDenyByDefault value should be 'deny_by_default'")
}

// TRACE: {"suite": "CORE", "case": "0468", "section": "07", "sectionName": "Transport Layer", "subsection": "17", "scenario": "01", "title": "D2D_V1_SafetyAlwaysPassesInbound"}
func TestD2D_V1_SafetyAlwaysPassesInbound(t *testing.T) {
	// Verify safety scenario constant.
	scenario := domain.MsgTypeToScenario(domain.MsgTypeSafetyAlert)
	testutil.RequireTrue(t, scenario == "safety",
		"safety.alert should map to 'safety' scenario")
}

// ---------------------------------------------------------------------------
// Test helpers (lightweight mocks for transport service)
// ---------------------------------------------------------------------------

type mockPassthroughEncryptor struct{}

func (m *mockPassthroughEncryptor) SealAnonymous(pt, _ []byte) ([]byte, error) { return pt, nil }
func (m *mockPassthroughEncryptor) OpenAnonymous(ct, _, _ []byte) ([]byte, error) {
	return ct, nil
}

type mockTestIdentitySigner struct{}

func (m *mockTestIdentitySigner) Sign(_ context.Context, data []byte) ([]byte, error) {
	return []byte("mock-sig"), nil
}
func (m *mockTestIdentitySigner) PublicKey() ed25519.PublicKey {
	return ed25519.PublicKey(make([]byte, 32))
}

type mockTestKeyConverter struct{}

func (m *mockTestKeyConverter) Ed25519ToX25519Private(priv []byte) ([]byte, error) { return priv, nil }
func (m *mockTestKeyConverter) Ed25519ToX25519Public(pub []byte) ([]byte, error)   { return pub, nil }

type mockTestDIDResolver struct {
	docs map[string]*domain.DIDDocument
}

func newMockTestDIDResolver() *mockTestDIDResolver {
	return &mockTestDIDResolver{docs: make(map[string]*domain.DIDDocument)}
}

func (m *mockTestDIDResolver) Resolve(_ context.Context, did domain.DID) (*domain.DIDDocument, error) {
	doc, ok := m.docs[string(did)]
	if !ok {
		return nil, domain.ErrDIDNotFound
	}
	return doc, nil
}

func (m *mockTestDIDResolver) InvalidateCache(_ domain.DID) {}

type mockTestOutboxManager struct {
	messages []domain.OutboxMessage
}

func newMockTestOutboxManager() *mockTestOutboxManager {
	return &mockTestOutboxManager{}
}

func (m *mockTestOutboxManager) Enqueue(_ context.Context, msg domain.OutboxMessage) (string, error) {
	if msg.ID == "" {
		msg.ID = "outbox-1"
	}
	m.messages = append(m.messages, msg)
	return msg.ID, nil
}
func (m *mockTestOutboxManager) MarkDelivered(_ context.Context, _ string) error  { return nil }
func (m *mockTestOutboxManager) MarkFailed(_ context.Context, _ string) error     { return nil }
func (m *mockTestOutboxManager) Requeue(_ context.Context, _ string) error        { return nil }
func (m *mockTestOutboxManager) PendingCount(_ context.Context) (int, error)      { return 0, nil }
func (m *mockTestOutboxManager) ListPending(_ context.Context) ([]domain.OutboxMessage, error) {
	return nil, nil
}
func (m *mockTestOutboxManager) DeleteExpired(_ context.Context, _ int64) (int, error) { return 0, nil }
func (m *mockTestOutboxManager) ResumeAfterApproval(_ context.Context, _ string) error { return nil }

type mockTestInboxManager struct{}

func (m *mockTestInboxManager) CheckIPRate(_ string) bool                       { return true }
func (m *mockTestInboxManager) CheckGlobalRate() bool                           { return true }
func (m *mockTestInboxManager) CheckPayloadSize(_ []byte) bool                  { return true }
func (m *mockTestInboxManager) Spool(_ context.Context, _ []byte) (string, error) { return "s-1", nil }
func (m *mockTestInboxManager) SpoolSize() (int64, error)                       { return 0, nil }
func (m *mockTestInboxManager) ProcessSpool(_ context.Context) (int, error)     { return 0, nil }
func (m *mockTestInboxManager) DrainSpool(_ context.Context) ([][]byte, error)  { return nil, nil }

type mockTestClock struct{}

func (m *mockTestClock) Now() time.Time                         { return time.Now() }
func (m *mockTestClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (m *mockTestClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

type mockTestDeliverer struct{}

func (m *mockTestDeliverer) Deliver(_ context.Context, _ string, _ []byte) error { return nil }

type mockTestSigner struct{}

func (m *mockTestSigner) GenerateFromSeed(_ []byte) ([]byte, []byte, error) {
	return make([]byte, 32), make([]byte, 64), nil
}
func (m *mockTestSigner) Sign(_ []byte, _ []byte) ([]byte, error) { return []byte("sig"), nil }
func (m *mockTestSigner) Verify(_ []byte, _ []byte, _ []byte) (bool, error) { return true, nil }

func errMsg(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}
