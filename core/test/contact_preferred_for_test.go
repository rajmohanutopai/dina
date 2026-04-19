package test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// Contact preferred_for tests (TEST_PLAN §3.4.10 — Contact Preferences).
//
// preferred_for is a user-asserted list of category strings ("dental",
// "tax", etc.) marking a contact as the user's go-to provider for that
// category. The provider-service resolver uses it to route live-state
// queries directly to the chosen contact rather than re-searching
// AppView each time.
//
// Normalisation contract (enforced by both storage layers so
// round-trips are stable): lowercase, trimmed, deduped, empty strings
// dropped. Input order is preserved.

// TST-CORE-1000
// TRACE: {"suite": "CORE", "case": "2087", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "10", "title": "PreferredFor_SetAndGet_Roundtrip"}
func TestIdentity_3_4_10_PreferredForRoundtrip(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()
	did := "did:key:z6MkPrefRoundtrip"

	testutil.RequireNoError(t, impl.Add(ctx, did, "Dr Carl", "unknown", "acquaintance", "care", false))

	// Empty list on a fresh contact.
	got, err := impl.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(got), 0)

	// Set then get returns the normalised list.
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did, []string{"dental"}))
	got, err = impl.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(got), 1)
	testutil.RequireEqual(t, got[0], "dental")
}

// TST-CORE-1001
// TRACE: {"suite": "CORE", "case": "2088", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "11", "title": "PreferredFor_NormalizesInput"}
func TestIdentity_3_4_11_PreferredForNormalization(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()
	did := "did:key:z6MkPrefNormal"

	testutil.RequireNoError(t, impl.Add(ctx, did, "Linda", "unknown", "colleague", "external", false))

	// Messy input: mixed case, whitespace, dupes, empty string.
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did,
		[]string{"  TAX  ", "accounting", "Tax", "", "ACCOUNTING"}))

	got, err := impl.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	// Expect lowercased + trimmed + deduped, preserving first-seen order.
	testutil.RequireEqual(t, len(got), 2)
	testutil.RequireEqual(t, got[0], "tax")
	testutil.RequireEqual(t, got[1], "accounting")
}

// TST-CORE-1002
// TRACE: {"suite": "CORE", "case": "2089", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "12", "title": "PreferredFor_EmptyClears"}
func TestIdentity_3_4_12_PreferredForEmptyClears(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()
	did := "did:key:z6MkPrefClear"

	testutil.RequireNoError(t, impl.Add(ctx, did, "Pete", "unknown", "acquaintance", "external", false))

	// Set, then clear.
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did, []string{"plumbing", "hvac"}))
	got, _ := impl.GetPreferredFor(ctx, did)
	testutil.RequireEqual(t, len(got), 2)

	// Empty input clears all preferences (valid: "no longer my go-to for anything").
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did, []string{}))
	got, err := impl.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(got), 0)
}

// TST-CORE-1003
// TRACE: {"suite": "CORE", "case": "2090", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "13", "title": "PreferredFor_UnknownContactError"}
func TestIdentity_3_4_13_PreferredForUnknownContactError(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()

	// Set on unknown DID → error.
	err := impl.SetPreferredFor(ctx, "did:key:z6MkNoSuch", []string{"dental"})
	testutil.RequireError(t, err)
	testutil.RequireTrue(t, err == identity.ErrContactNotFound,
		"expected ErrContactNotFound, got: "+err.Error())

	// Get on unknown DID → error.
	_, err = impl.GetPreferredFor(ctx, "did:key:z6MkNoSuch")
	testutil.RequireError(t, err)
}

// TST-CORE-1004
// TRACE: {"suite": "CORE", "case": "2091", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "14", "title": "FindByPreferredFor_CaseInsensitive"}
func TestIdentity_3_4_14_FindByPreferredForCaseInsensitive(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()

	did := "did:key:z6MkDentistA"
	testutil.RequireNoError(t, impl.Add(ctx, did, "Dr Carl", "unknown", "acquaintance", "care", false))
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did, []string{"dental"}))

	// Lookup with mixed case must match.
	matches, err := impl.FindByPreferredFor(ctx, "Dental")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(matches), 1)
	testutil.RequireEqual(t, matches[0].DID, did)

	// Whitespace-wrapped lookup also matches.
	matches, err = impl.FindByPreferredFor(ctx, "  DENTAL  ")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(matches), 1)
}

// TST-CORE-1005
// TRACE: {"suite": "CORE", "case": "2092", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "15", "title": "FindByPreferredFor_MultipleMatches"}
func TestIdentity_3_4_15_FindByPreferredForMultipleMatches(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()

	// Sancho (friend who is also a dentist) + Dr Carl (primarily dentist).
	// Sharp user-behavior case: the friend's primary relationship isn't
	// dental, but he has the category preference too.
	sancho := "did:key:z6MkSancho"
	testutil.RequireNoError(t, impl.Add(ctx, sancho, "Sancho", "trusted", "friend", "external", false))
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, sancho, []string{"dental"}))

	carl := "did:key:z6MkDrCarl"
	testutil.RequireNoError(t, impl.Add(ctx, carl, "Dr Carl", "unknown", "acquaintance", "care", false))
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, carl, []string{"dental"}))

	// Unrelated contact to make sure filter actually filters.
	other := "did:key:z6MkOther"
	testutil.RequireNoError(t, impl.Add(ctx, other, "Mike", "unknown", "friend", "external", false))
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, other, []string{"plumbing"}))

	matches, err := impl.FindByPreferredFor(ctx, "dental")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(matches), 2)

	// Both dental-tagged contacts are returned; the plumbing contact is not.
	dids := map[string]bool{}
	for _, c := range matches {
		dids[c.DID] = true
	}
	testutil.RequireTrue(t, dids[sancho], "Sancho should be among dental matches")
	testutil.RequireTrue(t, dids[carl], "Dr Carl should be among dental matches")
	testutil.RequireFalse(t, dids[other], "Mike (plumbing) must not match dental")
}

// TST-CORE-1006
// TRACE: {"suite": "CORE", "case": "2093", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "16", "title": "FindByPreferredFor_EmptyReturnsNothing"}
func TestIdentity_3_4_16_FindByPreferredForEmpty(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()

	did := "did:key:z6MkHasPref"
	testutil.RequireNoError(t, impl.Add(ctx, did, "Contact", "unknown", "friend", "external", false))
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did, []string{"dental"}))

	// Empty category → no results (resolver must always pass a concrete intent).
	matches, err := impl.FindByPreferredFor(ctx, "")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(matches), 0)

	// Whitespace-only category → also no results.
	matches, err = impl.FindByPreferredFor(ctx, "   ")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(matches), 0)

	// Unknown category → no results (but not an error).
	matches, err = impl.FindByPreferredFor(ctx, "astrology")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(matches), 0)
}

// TST-CORE-1008
// TRACE: {"suite": "CORE", "case": "2095", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "18", "title": "HTTP_PUTContact_AcceptsPreferredFor"}
func TestIdentity_3_4_18_PUTContactAcceptsPreferredFor(t *testing.T) {
	// HTTP-level test: PUT /v1/contacts/{did} with {"preferred_for": [...]}
	// must update the contact via SetPreferredFor.
	cd := identity.NewContactDirectory()
	ctx := context.Background()
	did := "did:key:z6MkPutPref"
	testutil.RequireNoError(t, cd.Add(ctx, did, "Dr Carl", "unknown", "acquaintance", "care", false))

	h := &handler.ContactHandler{Contacts: cd}
	body, _ := json.Marshal(map[string]any{"preferred_for": []string{"dental"}})
	req := httptest.NewRequest(http.MethodPut, "/v1/contacts/"+did, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleUpdateContact(rec, req)

	testutil.RequireEqual(t, rec.Code, http.StatusOK)
	got, err := cd.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(got), 1)
	testutil.RequireEqual(t, got[0], "dental")
}

// TST-CORE-1009
// TRACE: {"suite": "CORE", "case": "2096", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "19", "title": "HTTP_PUTContact_NilPreferredForDoesNotTouch"}
func TestIdentity_3_4_19_PUTContactNilPreferredForNoop(t *testing.T) {
	// Tri-state semantics: nil preferred_for means "don't touch".
	// The handler must not clear existing preferences when the PUT
	// body omits the field entirely. A PUT with ONLY a name change
	// should leave the existing preferred_for intact.
	cd := identity.NewContactDirectory()
	ctx := context.Background()
	did := "did:key:z6MkNoopPref"
	testutil.RequireNoError(t, cd.Add(ctx, did, "Linda", "unknown", "colleague", "external", false))
	testutil.RequireNoError(t, cd.SetPreferredFor(ctx, did, []string{"tax", "accounting"}))

	h := &handler.ContactHandler{Contacts: cd}
	// Body only updates name. preferred_for field omitted entirely.
	body, _ := json.Marshal(map[string]any{"name": "Linda Smith"})
	req := httptest.NewRequest(http.MethodPut, "/v1/contacts/"+did, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleUpdateContact(rec, req)

	testutil.RequireEqual(t, rec.Code, http.StatusOK)
	got, err := cd.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(got), 2) // preserved
}

// TST-CORE-1011
// TRACE: {"suite": "CORE", "case": "2098", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "21", "title": "HTTP_GETContactsByPreference"}
func TestIdentity_3_4_21_GETContactsByPreference(t *testing.T) {
	// GET /v1/contacts/by-preference?category=X returns contacts whose
	// preferred_for list contains that category.
	cd := identity.NewContactDirectory()
	ctx := context.Background()

	dentistDID := "did:key:z6MkPrefDentist"
	testutil.RequireNoError(t, cd.Add(ctx, dentistDID, "Dr Carl", "unknown", "acquaintance", "care", false))
	testutil.RequireNoError(t, cd.SetPreferredFor(ctx, dentistDID, []string{"dental"}))

	lawyerDID := "did:key:z6MkPrefLawyer"
	testutil.RequireNoError(t, cd.Add(ctx, lawyerDID, "Kate Jones", "unknown", "colleague", "external", false))
	testutil.RequireNoError(t, cd.SetPreferredFor(ctx, lawyerDID, []string{"legal"}))

	h := &handler.ContactHandler{Contacts: cd}

	// Category=dental returns only Dr Carl.
	req := httptest.NewRequest(http.MethodGet, "/v1/contacts/by-preference?category=dental", nil)
	rec := httptest.NewRecorder()
	h.HandleFindContactsByPreference(rec, req)
	testutil.RequireEqual(t, rec.Code, http.StatusOK)

	var body map[string]any
	testutil.RequireNoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	contacts, _ := body["contacts"].([]any)
	testutil.RequireEqual(t, len(contacts), 1)
	first := contacts[0].(map[string]any)
	testutil.RequireEqual(t, first["did"].(string), dentistDID)
}

// TST-CORE-1012
// TRACE: {"suite": "CORE", "case": "2099", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "22", "title": "HTTP_GETContactsByPreference_EmptyCategoryIs400"}
func TestIdentity_3_4_22_GETContactsByPreferenceEmptyIs400(t *testing.T) {
	// The resolver must always pass a concrete intent category. An
	// empty / missing category returns 400 — there is no "match
	// anything" semantics (would collapse the whole directory).
	cd := identity.NewContactDirectory()
	h := &handler.ContactHandler{Contacts: cd}

	// Missing param, empty value, and whitespace-only value all 400.
	// Whitespace is passed URL-encoded (%20) so httptest.NewRequest
	// accepts it.
	for _, query := range []string{
		"/v1/contacts/by-preference",
		"/v1/contacts/by-preference?category=",
		"/v1/contacts/by-preference?category=%20%20%20",
	} {
		req := httptest.NewRequest(http.MethodGet, query, nil)
		rec := httptest.NewRecorder()
		h.HandleFindContactsByPreference(rec, req)
		testutil.RequireEqual(t, rec.Code, http.StatusBadRequest)
	}
}

// TST-CORE-1010
// TRACE: {"suite": "CORE", "case": "2097", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "20", "title": "HTTP_PUTContact_EmptyPreferredForClears"}
func TestIdentity_3_4_20_PUTContactEmptyPreferredForClears(t *testing.T) {
	// Tri-state semantics: empty list means "clear all preferences".
	// The pointer-to-slice in the request body distinguishes this
	// from nil (don't touch).
	cd := identity.NewContactDirectory()
	ctx := context.Background()
	did := "did:key:z6MkClearPref"
	testutil.RequireNoError(t, cd.Add(ctx, did, "Pete", "unknown", "friend", "external", false))
	testutil.RequireNoError(t, cd.SetPreferredFor(ctx, did, []string{"plumbing"}))

	h := &handler.ContactHandler{Contacts: cd}
	body, _ := json.Marshal(map[string]any{"preferred_for": []string{}})
	req := httptest.NewRequest(http.MethodPut, "/v1/contacts/"+did, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleUpdateContact(rec, req)

	testutil.RequireEqual(t, rec.Code, http.StatusOK)
	got, err := cd.GetPreferredFor(ctx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(got), 0)
}

// TST-CORE-1007
// TRACE: {"suite": "CORE", "case": "2094", "section": "03", "sectionName": "Identity (DID)", "subsection": "04", "scenario": "17", "title": "List_IncludesPreferredFor"}
func TestIdentity_3_4_17_ListIncludesPreferredFor(t *testing.T) {
	impl := identity.NewContactDirectory()
	ctx := context.Background()

	did := "did:key:z6MkListPref"
	testutil.RequireNoError(t, impl.Add(ctx, did, "Dr Carl", "unknown", "acquaintance", "care", false))
	testutil.RequireNoError(t, impl.SetPreferredFor(ctx, did, []string{"dental", "orthodontics"}))

	contacts, err := impl.List(ctx)
	testutil.RequireNoError(t, err)

	// Find our contact and verify PreferredFor round-trips through List.
	var found bool
	for _, c := range contacts {
		if c.DID != did {
			continue
		}
		found = true
		testutil.RequireEqual(t, len(c.PreferredFor), 2)
		testutil.RequireEqual(t, c.PreferredFor[0], "dental")
		testutil.RequireEqual(t, c.PreferredFor[1], "orthodontics")
	}
	testutil.RequireTrue(t, found, "contact should appear in List output")
}
