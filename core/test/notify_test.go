package test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §35 — Core-Enforced Notification Discipline (Silence First)
// ==========================================================================
// Law #1 (Silence First): Never push content unless the human asked, or
// unless silence would cause harm. Three priority levels determine routing:
//   - Fiduciary: interrupt — silence causes harm (e.g., flight cancelled)
//   - Solicited: notify — user explicitly asked (e.g., search results)
//   - Engagement: save for briefing — silence merely misses an opportunity
//
// Core is the enforcement point. Brain classifies, Core routes. Brain cannot
// bypass the routing rules.
// ==========================================================================

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// mockNotifier implements port.ClientNotifier for test assertions.
// It records all broadcasts so tests can verify which messages were pushed.
type mockNotifier struct {
	broadcasts [][]byte
}

func (m *mockNotifier) Notify(_ context.Context, deviceID string, payload []byte) error {
	return nil
}

func (m *mockNotifier) Broadcast(_ context.Context, payload []byte) error {
	m.broadcasts = append(m.broadcasts, payload)
	return nil
}

// mockDNDChecker implements port.DNDChecker with controllable DND state.
type mockDNDChecker struct {
	active bool
}

func (m *mockDNDChecker) IsDNDActive(_ context.Context) bool {
	return m.active
}

// newNotifyHandler creates a NotifyHandler with a test mock notifier (DND off).
func newNotifyHandler() (*handler.NotifyHandler, *mockNotifier) {
	notifier := &mockNotifier{}
	h := &handler.NotifyHandler{Notifier: notifier}
	return h, notifier
}

// newNotifyHandlerWithDND creates a NotifyHandler with controllable DND state.
func newNotifyHandlerWithDND(dndActive bool) (*handler.NotifyHandler, *mockNotifier, *mockDNDChecker) {
	notifier := &mockNotifier{}
	dnd := &mockDNDChecker{active: dndActive}
	h := &handler.NotifyHandler{Notifier: notifier, DNDChecker: dnd}
	return h, notifier, dnd
}

// postNotify sends a POST request to the notify handler with the given JSON body.
func postNotify(h *handler.NotifyHandler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/notify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.HandleNotify(rr, req)
	return rr
}

// decodeResponse parses the JSON response body into a map.
func decodeResponse(t *testing.T, rr *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var resp map[string]interface{}
	body, _ := io.ReadAll(rr.Result().Body)
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("failed to decode response body %q: %v", string(body), err)
	}
	return resp
}

// ---------------------------------------------------------------------------
// TST-CORE-1132 — WebSocket push requires explicit priority
// ---------------------------------------------------------------------------
// §35.1 Requirement: POST /v1/notify with no `priority` field must be
// rejected with 400. Core refuses to push without classification.
// Brain must classify every notification into one of three Silence First
// tiers before Core will accept it.

func TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority(t *testing.T) {
	h, notifier := newNotifyHandler()

	t.Run("missing_priority_rejected_with_400", func(t *testing.T) {
		// POST /v1/notify with message but no priority field.
		// Core must reject this — it cannot route without knowing the tier.
		rr := postNotify(h, `{"message":"sync complete"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusBadRequest)
		// Verify the notifier was NOT called — no broadcast happened.
		if len(notifier.broadcasts) > 0 {
			t.Fatal("notification without priority must NOT be broadcast")
		}
	})

	t.Run("empty_priority_string_rejected", func(t *testing.T) {
		// Empty string is not a valid priority — must be an explicit tier.
		rr := postNotify(h, `{"message":"test","priority":""}`)
		testutil.RequireEqual(t, rr.Code, http.StatusBadRequest)
	})

	t.Run("invalid_priority_value_rejected", func(t *testing.T) {
		// Arbitrary strings are not valid priorities.
		// Only fiduciary, solicited, and engagement are accepted.
		rr := postNotify(h, `{"message":"test","priority":"urgent"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusBadRequest)
	})

	t.Run("case_sensitive_priority_rejected", func(t *testing.T) {
		// Priority must be lowercase — "Fiduciary" is not "fiduciary".
		// This prevents ambiguity and ensures Brain uses the canonical values.
		rr := postNotify(h, `{"message":"test","priority":"Fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusBadRequest)
	})

	t.Run("error_message_lists_valid_priorities", func(t *testing.T) {
		// The error response must tell Brain what the valid values are.
		// This aids debugging when Brain sends an invalid priority.
		rr := postNotify(h, `{"message":"test"}`)
		body, _ := io.ReadAll(rr.Result().Body)
		bodyStr := string(body)
		if !strings.Contains(bodyStr, "fiduciary") ||
			!strings.Contains(bodyStr, "solicited") ||
			!strings.Contains(bodyStr, "engagement") {
			t.Fatalf("error response should list valid priorities, got: %s", bodyStr)
		}
	})

	t.Run("fiduciary_priority_accepted", func(t *testing.T) {
		// Fiduciary = interrupt. Silence would cause harm (§35.1).
		// Core must broadcast immediately.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"flight cancelled","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary notification should be sent, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("fiduciary must trigger exactly 1 broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("solicited_priority_accepted", func(t *testing.T) {
		// Solicited = user asked for this. Notify them (§35.1).
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"search results ready","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("solicited notification should be sent, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("solicited must trigger exactly 1 broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("engagement_priority_queued_not_pushed", func(t *testing.T) {
		// Engagement = silence merely misses an opportunity (§35.1).
		// Must NOT push via WebSocket — queue for daily briefing instead.
		// This is the core of Silence First: engagement content NEVER interrupts.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"new product review","priority":"engagement"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "queued" {
			t.Fatalf("engagement notification must be queued (not sent), got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("engagement must NOT trigger any broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("message_still_required_with_priority", func(t *testing.T) {
		// Priority alone is not enough — the message content is also required.
		rr := postNotify(h, `{"priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusBadRequest)
	})

	t.Run("three_valid_priorities_exist", func(t *testing.T) {
		// Verify that exactly three priority tiers exist — no more, no less.
		// Adding a fourth tier would undermine the Silence First classification.
		validPriorities := handler.ValidNotificationPriorities
		if len(validPriorities) != 3 {
			t.Fatalf("expected exactly 3 valid priorities (fiduciary, solicited, engagement), got %d", len(validPriorities))
		}
		for _, p := range []string{"fiduciary", "solicited", "engagement"} {
			if !validPriorities[p] {
				t.Fatalf("priority %q must be in ValidNotificationPriorities", p)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-1137 — Brain cannot bypass priority classification
// ---------------------------------------------------------------------------
// §35.1 Requirement: Brain calls POST /v1/notify with {force_push: true}.
// Core must IGNORE the force_push field — it has zero effect on routing.
// Priority alone determines the notification path. This prevents a
// compromised or misbehaving Brain from bypassing Silence First.

func TestNotify_35_1_6_BrainCannotBypassPriorityClassification(t *testing.T) {
	h, notifier := newNotifyHandler()

	t.Run("force_push_true_with_engagement_still_queued", func(t *testing.T) {
		// The critical test: Brain sets force_push=true on an engagement
		// notification. Core must IGNORE force_push and still queue it.
		// If force_push were honored, Brain could bypass Silence First
		// and push engagement content to the user, violating Law #1.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"deal of the day","priority":"engagement","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "queued" {
			t.Fatalf("engagement + force_push must still be queued, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("engagement + force_push must NOT trigger broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("force_push_true_with_fiduciary_sends_normally", func(t *testing.T) {
		// Fiduciary with force_push=true should send normally.
		// force_push doesn't add anything — fiduciary already sends.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"flight cancelled","priority":"fiduciary","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary + force_push should still send, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("fiduciary should broadcast once, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("force_push_true_with_solicited_sends_normally", func(t *testing.T) {
		// Solicited with force_push=true should send normally.
		// force_push doesn't add anything — solicited already sends.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"results ready","priority":"solicited","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("solicited + force_push should still send, got status=%v", resp["status"])
		}
	})

	t.Run("force_push_false_no_effect", func(t *testing.T) {
		// force_push=false should behave identically to no force_push.
		// The field is always ignored regardless of its value.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"sync done","priority":"fiduciary","force_push":false}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary + force_push=false should send, got status=%v", resp["status"])
		}
	})

	t.Run("force_push_without_priority_still_rejected", func(t *testing.T) {
		// force_push cannot substitute for a missing priority.
		// Even if Brain sends force_push=true, priority is still required.
		rr := postNotify(h, `{"message":"test","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusBadRequest)
	})

	t.Run("unknown_fields_ignored_gracefully", func(t *testing.T) {
		// Brain might send additional fields (e.g., "bypass_dnd": true).
		// Core should decode without error but ignore all non-standard fields.
		// Only "message" and "priority" determine behavior.
		notifier.broadcasts = nil
		rr := postNotify(h, `{"message":"test","priority":"fiduciary","bypass_dnd":true,"admin_override":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-938 — Empty signature passes (backward compatibility)
// ---------------------------------------------------------------------------
// §29.1 Requirement: When a request arrives with empty X-Signature header
// (or missing Ed25519 auth headers), the auth middleware must fall through
// to Bearer token authentication. This provides backward compatibility for
// legacy clients that use Bearer tokens instead of Ed25519 signatures.
//
// The security model is: signature auth is PREFERRED (for CLI, paired devices)
// but Bearer tokens remain valid. An empty signature does NOT mean "skip all
// auth" — it means "try the next auth method."

func TestAuth_29_1_5_EmptySignatureBackwardCompatibility(t *testing.T) {
	// Set up a token validator with a registered client token.
	tokenValidator := auth.NewDefaultTokenValidator()
	testClientToken := "test-backward-compat-token-12345"
	tokenValidator.RegisterClientToken(testClientToken, "legacy-device", "admin")

	authMW := &middleware.Auth{Tokens: tokenValidator}

	// Echo handler records that the request made it through.
	echoHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kind, _ := r.Context().Value(middleware.TokenKindKey).(string)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok:" + kind))
	})

	mw := authMW.Handler(echoHandler)

	t.Run("empty_X_Signature_falls_through_to_Bearer", func(t *testing.T) {
		// Request with X-DID and X-Timestamp set but X-Signature empty.
		// The middleware checks `xDID != "" && xSig != "" && xTS != ""`
		// so empty X-Signature means it skips Ed25519 path entirely and
		// falls through to Bearer token auth.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		req.Header.Set("X-DID", "did:key:zSomeLegacyDevice")
		req.Header.Set("X-Timestamp", "2025-01-01T00:00:00Z")
		req.Header.Set("X-Signature", "") // empty — trigger fallthrough
		req.Header.Set("Authorization", "Bearer "+testClientToken)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		// Must succeed via Bearer token path.
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		body, _ := io.ReadAll(rr.Result().Body)
		if !strings.Contains(string(body), "ok:client") {
			t.Fatalf("expected token_kind=client via Bearer fallback, got %q", string(body))
		}
	})

	t.Run("missing_all_signature_headers_falls_through_to_Bearer", func(t *testing.T) {
		// No Ed25519 headers at all — pure legacy Bearer token client.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		req.Header.Set("Authorization", "Bearer "+testClientToken)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		body, _ := io.ReadAll(rr.Result().Body)
		if !strings.Contains(string(body), "ok:client") {
			t.Fatalf("expected Bearer auth to work when no Ed25519 headers present, got %q", string(body))
		}
	})

	t.Run("empty_X_DID_falls_through_to_Bearer", func(t *testing.T) {
		// Only X-Timestamp and X-Signature set, X-DID missing.
		// Condition `xDID != ""` fails → fallthrough to Bearer.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		req.Header.Set("X-Timestamp", "2025-01-01T00:00:00Z")
		req.Header.Set("X-Signature", "abcdef1234567890")
		req.Header.Set("Authorization", "Bearer "+testClientToken)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusOK)
	})

	t.Run("empty_X_Timestamp_falls_through_to_Bearer", func(t *testing.T) {
		// X-DID and X-Signature set but X-Timestamp empty.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		req.Header.Set("X-DID", "did:key:zSomeDevice")
		req.Header.Set("X-Signature", "abcdef1234567890")
		req.Header.Set("X-Timestamp", "") // empty
		req.Header.Set("Authorization", "Bearer "+testClientToken)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusOK)
	})

	t.Run("empty_signature_no_Bearer_returns_401", func(t *testing.T) {
		// Empty X-Signature AND no Bearer token → auth fails entirely.
		// Backward compatibility doesn't mean "no auth required."
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		req.Header.Set("X-DID", "did:key:zSomeDevice")
		req.Header.Set("X-Timestamp", "2025-01-01T00:00:00Z")
		req.Header.Set("X-Signature", "")
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusUnauthorized)
	})

	t.Run("no_auth_at_all_returns_401", func(t *testing.T) {
		// No Ed25519 headers, no Bearer token → 401.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusUnauthorized)
	})

	t.Run("invalid_Bearer_after_empty_signature_returns_401", func(t *testing.T) {
		// Empty X-Signature → falls through to Bearer → Bearer is invalid → 401.
		// The fallthrough doesn't grant free access.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		req.Header.Set("X-DID", "did:key:zSomeDevice")
		req.Header.Set("X-Signature", "")
		req.Header.Set("X-Timestamp", "2025-01-01T00:00:00Z")
		req.Header.Set("Authorization", "Bearer invalid-token")
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusUnauthorized)
	})

	t.Run("public_paths_bypass_auth_entirely", func(t *testing.T) {
		// /healthz is a public path — no auth headers needed at all.
		// This is independent of empty-signature logic, but verifies
		// that public paths work regardless of auth state.
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)

		testutil.RequireEqual(t, rr.Code, http.StatusOK)
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-1133 — Engagement-tier notification never pushed via WebSocket
// ---------------------------------------------------------------------------
// §35.1 Requirement: POST /v1/notify {priority: "engagement"} must NEVER
// trigger a WebSocket push. Engagement content is queued for the daily
// briefing. This is the core expression of Silence First — engagement
// notifications represent opportunities, not obligations. Pushing them
// would turn Dina into a notification firehose, exactly what Law #1 forbids.
//
// The test must validate that engagement is never pushed regardless of
// DND state, force_push flags, or any other request parameters.

func TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket(t *testing.T) {

	t.Run("engagement_without_DND_queued_not_broadcast", func(t *testing.T) {
		// Normal operation (DND off): engagement is queued.
		// The notifier must NOT be called — no broadcast, no per-device push.
		h, notifier := newNotifyHandler()
		rr := postNotify(h, `{"message":"trending article","priority":"engagement"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "queued" {
			t.Fatalf("engagement must be queued, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("engagement must NOT broadcast, got %d broadcasts", len(notifier.broadcasts))
		}
	})

	t.Run("engagement_with_DND_active_still_queued", func(t *testing.T) {
		// DND active: engagement is STILL queued (same behavior as without DND).
		// DND only affects solicited — engagement is always queued regardless.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		rr := postNotify(h, `{"message":"new coupon available","priority":"engagement"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "queued" {
			t.Fatalf("engagement + DND must still be queued, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("engagement + DND must NOT broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("engagement_with_force_push_still_queued", func(t *testing.T) {
		// force_push=true on engagement: STILL queued.
		// Brain cannot promote engagement to push via force_push.
		h, notifier := newNotifyHandler()
		rr := postNotify(h, `{"message":"limited offer","priority":"engagement","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "queued" {
			t.Fatalf("engagement + force_push must be queued, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatal("engagement + force_push must NOT broadcast")
		}
	})

	t.Run("engagement_with_DND_and_force_push_still_queued", func(t *testing.T) {
		// Maximum escalation attempt: DND active + force_push=true + engagement.
		// Must still be queued. No combination of flags can override engagement routing.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		rr := postNotify(h, `{"message":"flash sale","priority":"engagement","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "queued" {
			t.Fatalf("engagement + DND + force_push must be queued, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatal("engagement + DND + force_push must NOT broadcast")
		}
	})

	t.Run("multiple_engagement_notifications_all_queued", func(t *testing.T) {
		// Send multiple engagement notifications — ALL must be queued, none pushed.
		h, notifier := newNotifyHandler()
		messages := []string{
			`{"message":"news digest","priority":"engagement"}`,
			`{"message":"weekly recap","priority":"engagement"}`,
			`{"message":"product update","priority":"engagement"}`,
		}
		for i, msg := range messages {
			rr := postNotify(h, msg)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
			resp := decodeResponse(t, rr)
			if resp["status"] != "queued" {
				t.Fatalf("engagement #%d must be queued, got status=%v", i+1, resp["status"])
			}
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("no engagement notification should broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("engagement_returns_200_not_202", func(t *testing.T) {
		// Engagement returns 200 (accepted and queued), not 202 (accepted for processing).
		// The notification is immediately queued — no async processing pending.
		h, _ := newNotifyHandler()
		rr := postNotify(h, `{"message":"suggestion","priority":"engagement"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-1134 — Fiduciary notification pushed even during DND
// ---------------------------------------------------------------------------
// §35.1 Requirement: POST /v1/notify {priority: "fiduciary"} while user
// DND is active must STILL push via WebSocket. Fiduciary means "silence
// would cause harm" — flight cancelled, security breach, payment failure.
// DND cannot suppress fiduciary: that's the purpose of the tier system.
// If DND could block fiduciary, there would be no way to reach the user
// in an emergency.

func TestNotify_35_1_3_FiduciaryPushedEvenDuringDND(t *testing.T) {

	t.Run("fiduciary_broadcast_when_DND_active", func(t *testing.T) {
		// DND is active, but fiduciary overrides it. The notification must
		// be broadcast to all connected clients immediately.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		rr := postNotify(h, `{"message":"flight LH123 cancelled","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary + DND must be sent (not deferred), got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("fiduciary + DND must trigger exactly 1 broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("fiduciary_broadcast_when_DND_inactive", func(t *testing.T) {
		// Baseline: fiduciary without DND sends normally.
		h, notifier, _ := newNotifyHandlerWithDND(false)
		rr := postNotify(h, `{"message":"security alert","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary without DND must be sent, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("fiduciary without DND must broadcast once, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("fiduciary_message_content_preserved_during_DND", func(t *testing.T) {
		// The broadcast message must be the original content, not a
		// summary or placeholder. The user needs the full details.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		msg := "payment of $1500 failed — card expired"
		body := `{"message":"` + msg + `","priority":"fiduciary"}`
		rr := postNotify(h, body)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("expected 1 broadcast, got %d", len(notifier.broadcasts))
		}
		if string(notifier.broadcasts[0]) != msg {
			t.Fatalf("broadcast content must be original message %q, got %q", msg, string(notifier.broadcasts[0]))
		}
	})

	t.Run("fiduciary_status_is_sent_not_deferred_during_DND", func(t *testing.T) {
		// The response status must be "sent", not "deferred".
		// Brain needs to know the notification was actually pushed so it
		// doesn't retry or queue a follow-up.
		h, _, _ := newNotifyHandlerWithDND(true)
		rr := postNotify(h, `{"message":"account compromised","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary during DND must return 'sent', got %v", resp["status"])
		}
	})

	t.Run("multiple_fiduciary_during_DND_all_sent", func(t *testing.T) {
		// Multiple fiduciary notifications during DND: ALL must be pushed.
		// DND is not a "one interrupt allowed" policy — every fiduciary goes through.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		messages := []string{
			`{"message":"flight cancelled","priority":"fiduciary"}`,
			`{"message":"hotel booking error","priority":"fiduciary"}`,
			`{"message":"card charged twice","priority":"fiduciary"}`,
		}
		for i, msg := range messages {
			rr := postNotify(h, msg)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
			resp := decodeResponse(t, rr)
			if resp["status"] != "sent" {
				t.Fatalf("fiduciary #%d during DND must be sent, got %v", i+1, resp["status"])
			}
		}
		if len(notifier.broadcasts) != 3 {
			t.Fatalf("all 3 fiduciary notifications must broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("fiduciary_with_nil_DND_checker_still_sends", func(t *testing.T) {
		// When DNDChecker is nil (not configured), fiduciary sends normally.
		// nil = DND not configured = DND inactive (safe default).
		h, notifier := newNotifyHandler() // no DND checker set
		rr := postNotify(h, `{"message":"urgent","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary with nil DNDChecker must send, got %v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatal("fiduciary with nil DNDChecker must broadcast")
		}
	})

	t.Run("DND_toggle_off_then_on_fiduciary_always_pushes", func(t *testing.T) {
		// Toggle DND mid-session: fiduciary must always push regardless.
		h, notifier, dnd := newNotifyHandlerWithDND(false)

		// DND off → fiduciary sends.
		rr := postNotify(h, `{"message":"msg1","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)

		// DND on → fiduciary still sends.
		dnd.active = true
		rr = postNotify(h, `{"message":"msg2","priority":"fiduciary"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("fiduciary must send after DND toggle, got %v", resp["status"])
		}

		if len(notifier.broadcasts) != 2 {
			t.Fatalf("both fiduciary notifications must broadcast, got %d", len(notifier.broadcasts))
		}
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-1135 — Solicited notification deferred during DND
// ---------------------------------------------------------------------------
// §35.1 Requirement: POST /v1/notify {priority: "solicited"} while DND
// is active must NOT push via WebSocket. Instead it must be DEFERRED —
// meaning it is preserved for delivery when DND ends. Critically:
//   - Deferred ≠ dropped: the notification is NOT lost
//   - Deferred ≠ queued: it's not saved for the daily briefing like engagement
//   - Deferred = temporarily held back, delivered when DND ends
//
// The user said "search for X" (solicited), but they also said "don't
// interrupt me" (DND). The DND wins because solicited is not urgent —
// the results will still be valid later.

func TestNotify_35_1_4_SolicitedDeferredDuringDND(t *testing.T) {

	t.Run("solicited_deferred_when_DND_active", func(t *testing.T) {
		// DND active + solicited → deferred. No broadcast.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		rr := postNotify(h, `{"message":"search results for chairs","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "deferred" {
			t.Fatalf("solicited during DND must be deferred, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("solicited during DND must NOT broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("solicited_sent_when_DND_inactive", func(t *testing.T) {
		// DND inactive + solicited → sent. Normal delivery.
		h, notifier, _ := newNotifyHandlerWithDND(false)
		rr := postNotify(h, `{"message":"search results ready","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("solicited without DND must be sent, got status=%v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("solicited without DND must broadcast once, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("solicited_with_nil_DND_checker_sends_normally", func(t *testing.T) {
		// When DNDChecker is nil (not configured), solicited sends normally.
		// nil = DND not configured = DND inactive.
		h, notifier := newNotifyHandler()
		rr := postNotify(h, `{"message":"results ready","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("solicited with nil DNDChecker must send, got %v", resp["status"])
		}
		if len(notifier.broadcasts) != 1 {
			t.Fatal("solicited with nil DNDChecker must broadcast")
		}
	})

	t.Run("deferred_status_distinct_from_queued", func(t *testing.T) {
		// "deferred" (solicited during DND) must be different from "queued"
		// (engagement). Brain uses the status to decide follow-up behavior:
		//   - "queued" → don't retry, it's in the daily briefing
		//   - "deferred" → will auto-deliver when DND ends
		//   - "sent" → delivered immediately
		h, _, _ := newNotifyHandlerWithDND(true)
		solicitedRR := postNotify(h, `{"message":"results","priority":"solicited"}`)
		engagementRR := postNotify(h, `{"message":"deal","priority":"engagement"}`)

		solicitedResp := decodeResponse(t, solicitedRR)
		engagementResp := decodeResponse(t, engagementRR)

		if solicitedResp["status"] == engagementResp["status"] {
			t.Fatalf("deferred (solicited+DND) must differ from queued (engagement); both returned %v", solicitedResp["status"])
		}
		if solicitedResp["status"] != "deferred" {
			t.Fatalf("solicited+DND must be 'deferred', got %v", solicitedResp["status"])
		}
		if engagementResp["status"] != "queued" {
			t.Fatalf("engagement must be 'queued', got %v", engagementResp["status"])
		}
	})

	t.Run("multiple_solicited_during_DND_all_deferred", func(t *testing.T) {
		// Multiple solicited notifications during DND: ALL must be deferred.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		messages := []string{
			`{"message":"search results 1","priority":"solicited"}`,
			`{"message":"search results 2","priority":"solicited"}`,
			`{"message":"calendar check","priority":"solicited"}`,
		}
		for i, msg := range messages {
			rr := postNotify(h, msg)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
			resp := decodeResponse(t, rr)
			if resp["status"] != "deferred" {
				t.Fatalf("solicited #%d during DND must be deferred, got %v", i+1, resp["status"])
			}
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatalf("no solicited during DND should broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("DND_toggle_affects_solicited_routing", func(t *testing.T) {
		// DND on → solicited deferred. DND off → solicited sent.
		// The routing must reflect the current DND state at request time.
		h, notifier, dnd := newNotifyHandlerWithDND(true)

		// DND on → deferred.
		rr1 := postNotify(h, `{"message":"results","priority":"solicited"}`)
		resp1 := decodeResponse(t, rr1)
		if resp1["status"] != "deferred" {
			t.Fatalf("solicited with DND on must be deferred, got %v", resp1["status"])
		}

		// Toggle DND off.
		dnd.active = false

		// DND off → sent.
		rr2 := postNotify(h, `{"message":"more results","priority":"solicited"}`)
		resp2 := decodeResponse(t, rr2)
		if resp2["status"] != "sent" {
			t.Fatalf("solicited with DND off must be sent, got %v", resp2["status"])
		}

		// Only the second should have broadcast.
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("only 1 broadcast expected (DND-off request), got %d", len(notifier.broadcasts))
		}
	})

	t.Run("solicited_with_force_push_still_deferred_during_DND", func(t *testing.T) {
		// force_push=true cannot override DND for solicited.
		// Brain cannot bypass DND — that's Core's policy.
		h, notifier, _ := newNotifyHandlerWithDND(true)
		rr := postNotify(h, `{"message":"results","priority":"solicited","force_push":true}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "deferred" {
			t.Fatalf("solicited + DND + force_push must be deferred, got %v", resp["status"])
		}
		if len(notifier.broadcasts) != 0 {
			t.Fatal("solicited + DND + force_push must NOT broadcast")
		}
	})

	t.Run("mixed_priorities_during_DND_routed_correctly", func(t *testing.T) {
		// During DND, each priority tier routes independently:
		//   fiduciary → sent (override DND)
		//   solicited → deferred (respect DND)
		//   engagement → queued (always, regardless of DND)
		h, notifier, _ := newNotifyHandlerWithDND(true)

		fidRR := postNotify(h, `{"message":"flight cancelled","priority":"fiduciary"}`)
		solRR := postNotify(h, `{"message":"search done","priority":"solicited"}`)
		engRR := postNotify(h, `{"message":"new deal","priority":"engagement"}`)

		fidResp := decodeResponse(t, fidRR)
		solResp := decodeResponse(t, solRR)
		engResp := decodeResponse(t, engRR)

		if fidResp["status"] != "sent" {
			t.Fatalf("fiduciary during DND must be sent, got %v", fidResp["status"])
		}
		if solResp["status"] != "deferred" {
			t.Fatalf("solicited during DND must be deferred, got %v", solResp["status"])
		}
		if engResp["status"] != "queued" {
			t.Fatalf("engagement during DND must be queued, got %v", engResp["status"])
		}

		// Only fiduciary should have broadcast.
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("only fiduciary should broadcast during DND, got %d broadcasts", len(notifier.broadcasts))
		}
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-1136 — Notification rate limiting per client
// ---------------------------------------------------------------------------
// §35.1 Requirement: 50 notifications in 1 second to the same WebSocket
// must be throttled — the client must never be flooded. This prevents a
// misbehaving Brain from overwhelming all connected clients with rapid-fire
// notifications.
//
// Critical constraints:
//   - Fiduciary notifications are EXEMPT from rate limiting. Rate limiting
//     must never suppress safety-critical alerts (flight cancelled, security
//     breach). If fiduciary were rate-limited, the system could silently
//     drop alerts that require immediate human action.
//   - Rate limiting resets after the configured window expires.
//   - When RateLimit=0, no rate limiting is applied (unconfigured).
//   - Engagement notifications never reach the rate limiter — they are
//     queued before the rate check even runs.

func TestNotify_35_1_5_NotificationRateLimitingPerClient(t *testing.T) {

	// newRateLimitedHandler creates a handler with a tight rate limit for testing.
	newRateLimitedHandler := func(limit int, window time.Duration) (*handler.NotifyHandler, *mockNotifier) {
		notifier := &mockNotifier{}
		h := &handler.NotifyHandler{
			Notifier:   notifier,
			RateLimit:  limit,
			RateWindow: window,
		}
		return h, notifier
	}

	t.Run("rapid_solicited_notifications_hit_rate_limit", func(t *testing.T) {
		// Send more solicited notifications than the rate limit allows.
		// Notifications beyond the limit must be rejected with 429.
		// This is the core protection against Brain flooding clients.
		h, notifier := newRateLimitedHandler(3, 10*time.Second)

		// First 3 should succeed (within limit).
		for i := 0; i < 3; i++ {
			rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
			if rr.Code != http.StatusOK {
				t.Fatalf("solicited #%d within limit should succeed, got %d", i+1, rr.Code)
			}
		}
		if len(notifier.broadcasts) != 3 {
			t.Fatalf("expected 3 broadcasts within limit, got %d", len(notifier.broadcasts))
		}

		// 4th should be rejected with 429.
		rr := postNotify(h, `{"message":"overflow","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusTooManyRequests)
		// No additional broadcast should have occurred.
		if len(notifier.broadcasts) != 3 {
			t.Fatalf("rate-limited notification must NOT broadcast, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("fiduciary_exempt_from_rate_limiting", func(t *testing.T) {
		// Fiduciary notifications must NEVER be rate-limited.
		// Even when the rate limit is exhausted, fiduciary goes through.
		// Safety-critical alerts cannot be suppressed by a rate limiter.
		h, notifier := newRateLimitedHandler(2, 10*time.Second)

		// Exhaust the rate limit with solicited notifications.
		for i := 0; i < 2; i++ {
			rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
		}
		// Solicited is now rate-limited.
		rr := postNotify(h, `{"message":"blocked","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusTooManyRequests)

		// But fiduciary MUST still go through.
		for i := 0; i < 5; i++ {
			rr = postNotify(h, `{"message":"flight cancelled","priority":"fiduciary"}`)
			if rr.Code != http.StatusOK {
				t.Fatalf("fiduciary #%d must bypass rate limit, got %d", i+1, rr.Code)
			}
			resp := decodeResponse(t, rr)
			if resp["status"] != "sent" {
				t.Fatalf("fiduciary must be sent even when rate-limited, got %v", resp["status"])
			}
		}
		// All fiduciary notifications should have broadcast (2 solicited + 5 fiduciary = 7).
		if len(notifier.broadcasts) != 7 {
			t.Fatalf("expected 7 broadcasts (2 solicited + 5 fiduciary), got %d", len(notifier.broadcasts))
		}
	})

	t.Run("rate_limit_resets_after_window_expires", func(t *testing.T) {
		// Use a very short window so we can test the reset.
		// After the window expires, the counter resets and new notifications
		// should be accepted again.
		h, notifier := newRateLimitedHandler(2, 50*time.Millisecond)

		// Exhaust the limit.
		for i := 0; i < 2; i++ {
			rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
		}
		// Confirm rate-limited.
		rr := postNotify(h, `{"message":"blocked","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusTooManyRequests)

		// Wait for the window to expire.
		time.Sleep(60 * time.Millisecond)

		// Should accept again after window reset.
		rr = postNotify(h, `{"message":"after reset","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		resp := decodeResponse(t, rr)
		if resp["status"] != "sent" {
			t.Fatalf("notification after window reset should be sent, got %v", resp["status"])
		}
		// 2 initial + 1 after reset = 3 broadcasts.
		if len(notifier.broadcasts) != 3 {
			t.Fatalf("expected 3 broadcasts (2 before + 1 after reset), got %d", len(notifier.broadcasts))
		}
	})

	t.Run("no_rate_limit_when_limit_is_zero", func(t *testing.T) {
		// RateLimit=0 means unlimited — no rate limiting configured.
		// All notifications should pass through regardless of volume.
		h, notifier := newRateLimitedHandler(0, time.Second)

		for i := 0; i < 50; i++ {
			rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
			if rr.Code != http.StatusOK {
				t.Fatalf("solicited #%d with no rate limit should succeed, got %d", i+1, rr.Code)
			}
		}
		if len(notifier.broadcasts) != 50 {
			t.Fatalf("all 50 should broadcast when rate limit is disabled, got %d", len(notifier.broadcasts))
		}
	})

	t.Run("engagement_unaffected_by_rate_limiting", func(t *testing.T) {
		// Engagement notifications are queued BEFORE the rate limiter runs.
		// They should always return "queued" regardless of rate limit state.
		h, notifier := newRateLimitedHandler(1, 10*time.Second)

		// Exhaust the rate limit.
		rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusOK)
		// Solicited is now rate-limited.
		rr = postNotify(h, `{"message":"blocked","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusTooManyRequests)

		// Engagement should still be queued — it doesn't go through the rate limiter.
		for i := 0; i < 5; i++ {
			rr = postNotify(h, `{"message":"deal","priority":"engagement"}`)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
			resp := decodeResponse(t, rr)
			if resp["status"] != "queued" {
				t.Fatalf("engagement #%d must be queued even when rate-limited, got %v", i+1, resp["status"])
			}
		}
		// Only the 1 solicited should have broadcast.
		if len(notifier.broadcasts) != 1 {
			t.Fatalf("only solicited should broadcast, not engagement; got %d", len(notifier.broadcasts))
		}
	})

	t.Run("rate_limit_429_response_includes_error_message", func(t *testing.T) {
		// The 429 response must include a meaningful error message so Brain
		// knows why the notification was rejected and can back off.
		h, _ := newRateLimitedHandler(1, 10*time.Second)

		postNotify(h, `{"message":"msg","priority":"solicited"}`) // exhaust
		rr := postNotify(h, `{"message":"overflow","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusTooManyRequests)

		body, _ := io.ReadAll(rr.Result().Body)
		bodyStr := string(body)
		if !strings.Contains(bodyStr, "rate limit") {
			t.Fatalf("429 response must mention rate limit, got: %s", bodyStr)
		}
	})

	t.Run("default_rate_limit_constants_reasonable", func(t *testing.T) {
		// Verify the default rate limit constants are sensible.
		// DefaultNotifyRateLimit should allow a reasonable burst.
		// DefaultNotifyRateWindow should be short (1 second).
		if handler.DefaultNotifyRateLimit < 1 {
			t.Fatal("DefaultNotifyRateLimit must be at least 1")
		}
		if handler.DefaultNotifyRateLimit > 100 {
			t.Fatalf("DefaultNotifyRateLimit seems too high: %d", handler.DefaultNotifyRateLimit)
		}
		if handler.DefaultNotifyRateWindow < 100*time.Millisecond {
			t.Fatal("DefaultNotifyRateWindow is unreasonably short")
		}
		if handler.DefaultNotifyRateWindow > 1*time.Minute {
			t.Fatalf("DefaultNotifyRateWindow seems too long: %v", handler.DefaultNotifyRateWindow)
		}
	})

	t.Run("fiduciary_does_not_consume_rate_limit_quota", func(t *testing.T) {
		// Fiduciary notifications must not count against the rate limit.
		// If they did, a burst of fiduciary alerts could prevent subsequent
		// solicited notifications from being delivered.
		h, _ := newRateLimitedHandler(3, 10*time.Second)

		// Send 10 fiduciary notifications — these must NOT consume quota.
		for i := 0; i < 10; i++ {
			rr := postNotify(h, `{"message":"alert","priority":"fiduciary"}`)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
		}

		// Solicited should still have full quota (3) available.
		for i := 0; i < 3; i++ {
			rr := postNotify(h, `{"message":"result","priority":"solicited"}`)
			if rr.Code != http.StatusOK {
				t.Fatalf("solicited #%d should succeed after fiduciary burst, got %d", i+1, rr.Code)
			}
		}
	})

	t.Run("rate_limit_with_DND_interaction", func(t *testing.T) {
		// Rate limiting and DND are orthogonal features.
		// During DND: solicited → deferred (before rate check).
		// When DND is off: rate limiting applies normally to solicited.
		notifier := &mockNotifier{}
		dnd := &mockDNDChecker{active: true}
		h := &handler.NotifyHandler{
			Notifier:   notifier,
			DNDChecker: dnd,
			RateLimit:  2,
			RateWindow: 10 * time.Second,
		}

		// DND active: solicited deferred (doesn't hit rate limiter).
		for i := 0; i < 5; i++ {
			rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
			resp := decodeResponse(t, rr)
			if resp["status"] != "deferred" {
				t.Fatalf("solicited #%d during DND must be deferred, got %v", i+1, resp["status"])
			}
		}

		// Turn off DND — now rate limiting kicks in.
		dnd.active = false
		for i := 0; i < 2; i++ {
			rr := postNotify(h, `{"message":"msg","priority":"solicited"}`)
			testutil.RequireEqual(t, rr.Code, http.StatusOK)
		}
		// 3rd without DND should be rate-limited.
		rr := postNotify(h, `{"message":"overflow","priority":"solicited"}`)
		testutil.RequireEqual(t, rr.Code, http.StatusTooManyRequests)
	})
}
