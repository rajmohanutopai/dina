package test

import (
	"testing"

	trustadapter "github.com/rajmohanutopai/dina/core/internal/adapter/trust"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Trust Cache & Ingress Gatekeeper Tests
// ==========================================================================
// Tests the local trust neighborhood cache (in-memory), the trust-based
// ingress evaluation (accept/quarantine/drop), and the mock resolver.

// --------------------------------------------------------------------------
// Trust Cache — In-Memory Operations
// --------------------------------------------------------------------------

func TestGatekeeper_6_CacheUpsertAndLookup(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()

	entry := domain.TrustEntry{
		DID:          "did:plc:test123",
		DisplayName:  "Test User",
		TrustScore:   0.75,
		TrustRing:    2,
		Relationship: "contact",
		Source:        "manual",
	}

	err := cache.Upsert(entry)
	testutil.RequireTrue(t, err == nil, "upsert should not error")

	got, err := cache.Lookup("did:plc:test123")
	testutil.RequireTrue(t, err == nil, "lookup should not error")
	testutil.RequireTrue(t, got != nil, "entry should be found")
	testutil.RequireTrue(t, got.DID == "did:plc:test123", "DID should match")
	testutil.RequireTrue(t, got.TrustScore == 0.75, "score should match")
	testutil.RequireTrue(t, got.TrustRing == 2, "ring should match")
	testutil.RequireTrue(t, got.Relationship == "contact", "relationship should match")
}

func TestGatekeeper_6_CacheLookupNotFound(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()

	got, err := cache.Lookup("did:plc:nonexistent")
	testutil.RequireTrue(t, err == nil, "lookup should not error")
	testutil.RequireTrue(t, got == nil, "entry should be nil for unknown DID")
}

func TestGatekeeper_6_CacheList(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()

	entries := []domain.TrustEntry{
		{DID: "did:plc:a", TrustScore: 0.9, TrustRing: 3, Relationship: "contact", Source: "manual"},
		{DID: "did:plc:b", TrustScore: 0.5, TrustRing: 2, Relationship: "1-hop", Source: "appview_sync"},
		{DID: "did:plc:c", TrustScore: 0.1, TrustRing: 1, Relationship: "2-hop", Source: "appview_sync"},
	}
	for _, e := range entries {
		cache.Upsert(e)
	}

	list, err := cache.List()
	testutil.RequireTrue(t, err == nil, "list should not error")
	testutil.RequireTrue(t, len(list) == 3, "should have 3 entries")
}

func TestGatekeeper_6_CacheRemove(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()

	cache.Upsert(domain.TrustEntry{DID: "did:plc:remove_me", TrustScore: 0.5, TrustRing: 1, Relationship: "unknown", Source: "manual"})

	err := cache.Remove("did:plc:remove_me")
	testutil.RequireTrue(t, err == nil, "remove should not error")

	got, _ := cache.Lookup("did:plc:remove_me")
	testutil.RequireTrue(t, got == nil, "removed entry should not be found")
}

func TestGatekeeper_6_CacheUpsertOverwrites(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()

	cache.Upsert(domain.TrustEntry{DID: "did:plc:update", TrustScore: 0.3, TrustRing: 1, Relationship: "unknown", Source: "manual"})
	cache.Upsert(domain.TrustEntry{DID: "did:plc:update", TrustScore: 0.8, TrustRing: 3, Relationship: "contact", Source: "appview_sync"})

	got, _ := cache.Lookup("did:plc:update")
	testutil.RequireTrue(t, got != nil, "entry should exist")
	testutil.RequireTrue(t, got.TrustScore == 0.8, "score should be updated to 0.8")
	testutil.RequireTrue(t, got.TrustRing == 3, "ring should be updated to 3")
}

func TestGatekeeper_6_CacheStats(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()

	cache.Upsert(domain.TrustEntry{DID: "did:plc:x", TrustScore: 0.5, TrustRing: 1, Relationship: "unknown", Source: "manual"})
	cache.Upsert(domain.TrustEntry{DID: "did:plc:y", TrustScore: 0.7, TrustRing: 2, Relationship: "contact", Source: "manual"})

	stats, err := cache.Stats()
	testutil.RequireTrue(t, err == nil, "stats should not error")
	testutil.RequireTrue(t, stats.Count == 2, "count should be 2")
}

// --------------------------------------------------------------------------
// Trust Service — Ingress Evaluation
// --------------------------------------------------------------------------

// mockContactLookup implements port.ContactLookup for tests.
type mockContactLookup struct {
	contacts map[string]string // DID -> trust_level
}

func (m *mockContactLookup) GetTrustLevel(did string) string {
	return m.contacts[did]
}

func (m *mockContactLookup) IsContact(did string) bool {
	_, ok := m.contacts[did]
	return ok
}

func TestGatekeeper_6_IngressBlockedContactDrop(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:bad_actor": "blocked",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:bad_actor")
	testutil.RequireTrue(t, decision == domain.IngressDrop, "blocked contact should be dropped")
}

func TestGatekeeper_6_IngressTrustedContactAccept(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:friend": "trusted",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:friend")
	testutil.RequireTrue(t, decision == domain.IngressAccept, "trusted contact should be accepted")
}

func TestGatekeeper_6_IngressVerifiedContactAccept(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:verified_user": "verified",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:verified_user")
	testutil.RequireTrue(t, decision == domain.IngressAccept, "verified contact should be accepted")
}

func TestGatekeeper_6_IngressHighScoreCacheQuarantineV1(t *testing.T) {
	// D2D v1: trust cache no longer grants acceptance — only explicit contacts pass.
	// A high-score non-contact is quarantined.
	cache := trustadapter.NewInMemoryCache()
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:cached_good", TrustScore: 0.7, TrustRing: 2,
		Relationship: "1-hop", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:cached_good")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "v1: high-score non-contact should be quarantined")
}

func TestGatekeeper_6_IngressLowScoreCacheQuarantine(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:cached_bad", TrustScore: 0.1, TrustRing: 1,
		Relationship: "2-hop", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:cached_bad")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "low-score cached DID should be quarantined")
}

func TestGatekeeper_6_IngressUnknownDIDQuarantine(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:total_stranger")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "unknown DID should be quarantined")
}

func TestGatekeeper_6_IngressEmptyDIDQuarantine(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "empty DID should be quarantined")
}

func TestGatekeeper_6_IngressBoundaryScoreQuarantineV1(t *testing.T) {
	// D2D v1: trust cache no longer grants acceptance — only explicit contacts pass.
	// A boundary-score non-contact is quarantined.
	cache := trustadapter.NewInMemoryCache()
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:boundary", TrustScore: 0.3, TrustRing: 1,
		Relationship: "frequent", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:boundary")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "v1: boundary-score non-contact should be quarantined")
}

func TestGatekeeper_6_IngressJustBelowBoundaryQuarantineV1(t *testing.T) {
	// D2D v1: trust cache no longer grants acceptance — only explicit contacts pass.
	cache := trustadapter.NewInMemoryCache()
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:just_below", TrustScore: 0.29, TrustRing: 1,
		Relationship: "2-hop", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:just_below")
	testutil.RequireTrue(t, decision == domain.IngressQuarantine, "score 0.29 should be quarantined")
}

// --------------------------------------------------------------------------
// Trust Service — Contact Takes Priority Over Cache
// --------------------------------------------------------------------------

func TestGatekeeper_6_IngressBlockedOverridesCache(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	// DID has high trust in cache but is blocked in contacts
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:high_but_blocked", TrustScore: 0.95, TrustRing: 3,
		Relationship: "contact", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:high_but_blocked": "blocked",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:high_but_blocked")
	testutil.RequireTrue(t, decision == domain.IngressDrop, "blocked contact overrides high cache score")
}

func TestGatekeeper_6_IngressTrustedOverridesLowCache(t *testing.T) {
	cache := trustadapter.NewInMemoryCache()
	// DID has low trust in cache but is trusted in contacts
	cache.Upsert(domain.TrustEntry{
		DID: "did:plc:low_but_trusted", TrustScore: 0.05, TrustRing: 1,
		Relationship: "unknown", Source: "appview_sync",
	})
	contacts := &mockContactLookup{contacts: map[string]string{
		"did:plc:low_but_trusted": "trusted",
	}}
	svc := service.NewTrustService(cache, trustadapter.NewResolver(""), contacts)

	decision := svc.EvaluateIngress("did:plc:low_but_trusted")
	testutil.RequireTrue(t, decision == domain.IngressAccept, "trusted contact overrides low cache score")
}

// --------------------------------------------------------------------------
// Trust Resolver — Empty AppView URL
// --------------------------------------------------------------------------

func TestGatekeeper_6_ResolverNoAppViewReturnsNil(t *testing.T) {
	resolver := trustadapter.NewResolver("")

	profile, err := resolver.ResolveProfile("did:plc:test")
	testutil.RequireTrue(t, err == nil, "should not error")
	testutil.RequireTrue(t, profile == nil, "should return nil when no AppView URL")

	entries, err := resolver.ResolveNeighborhood("did:plc:test", 2, 500)
	testutil.RequireTrue(t, err == nil, "should not error")
	testutil.RequireTrue(t, entries == nil, "should return nil when no AppView URL")
}

// --------------------------------------------------------------------------
// Trust Domain Types — Validation
// --------------------------------------------------------------------------

func TestGatekeeper_6_DomainValidRings(t *testing.T) {
	testutil.RequireTrue(t, domain.ValidTrustRings[1], "ring 1 should be valid")
	testutil.RequireTrue(t, domain.ValidTrustRings[2], "ring 2 should be valid")
	testutil.RequireTrue(t, domain.ValidTrustRings[3], "ring 3 should be valid")
	testutil.RequireTrue(t, !domain.ValidTrustRings[0], "ring 0 should be invalid")
	testutil.RequireTrue(t, !domain.ValidTrustRings[4], "ring 4 should be invalid")
}

func TestGatekeeper_6_DomainValidRelationships(t *testing.T) {
	testutil.RequireTrue(t, domain.ValidRelationships["contact"], "contact should be valid")
	testutil.RequireTrue(t, domain.ValidRelationships["frequent"], "frequent should be valid")
	testutil.RequireTrue(t, domain.ValidRelationships["1-hop"], "1-hop should be valid")
	testutil.RequireTrue(t, domain.ValidRelationships["2-hop"], "2-hop should be valid")
	testutil.RequireTrue(t, domain.ValidRelationships["unknown"], "unknown should be valid")
	testutil.RequireTrue(t, !domain.ValidRelationships["friend"], "friend should be invalid")
}

func TestGatekeeper_6_DomainIngressDecisionConstants(t *testing.T) {
	testutil.RequireTrue(t, domain.IngressAccept == "accept", "IngressAccept should be 'accept'")
	testutil.RequireTrue(t, domain.IngressQuarantine == "quarantine", "IngressQuarantine should be 'quarantine'")
	testutil.RequireTrue(t, domain.IngressDrop == "drop", "IngressDrop should be 'drop'")
}
