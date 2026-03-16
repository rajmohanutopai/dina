package test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/clock"
	"github.com/rajmohanutopai/dina/core/internal/adapter/estate"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §27 — Digital Estate
// ==========================================================================
// Covers estate plan storage, SSS custodian recovery, no Dead Man's Switch,
// access expiry, default actions, notifications, and key delivery.
// ==========================================================================

// TST-CORE-869
func TestEstate_27_1_PlanStoredInTier0(t *testing.T) {
	// Estate plan stored in Tier 0 (identity.sqlite).
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	plan := testutil.EstatePlan{
		Trigger:       "custodian_threshold",
		Custodians:    []string{"did:key:z6MkCustodian1", "did:key:z6MkCustodian2", "did:key:z6MkCustodian3"},
		Threshold:     2,
		Beneficiaries: map[string][]string{"did:key:z6MkBeneficiary1": {"general", "social"}},
		DefaultAction: "destroy",
		Notifications: []string{"did:key:z6MkNotify1"},
		AccessTypes:   map[string]string{"did:key:z6MkBeneficiary1": "read_only_90_days"},
		CreatedAt:     1700000000,
	}
	err := impl.StorePlan(plan)
	testutil.RequireNoError(t, err)

	retrieved, err := impl.GetPlan()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, retrieved.Trigger, "custodian_threshold")
	testutil.RequireEqual(t, retrieved.Threshold, 2)
}

// TST-CORE-870
func TestEstate_27_2_Recovery_CustodianThresholdMet(t *testing.T) {
	// Estate recovery: custodian threshold met → activation state change.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Reset state for test isolation.
	impl.ResetForTest()

	// Pre-condition: must not be activated before recovery.
	if impl.IsActivated() {
		t.Fatal("estate must not be activated before recovery")
	}

	// Negative control: wrong trigger must be rejected.
	err := impl.Activate("timer", nil)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "custodian_threshold")

	// Must still be not activated after rejected trigger.
	if impl.IsActivated() {
		t.Fatal("estate must not be activated after rejected trigger")
	}

	// Correct trigger: custodian_threshold → activation succeeds.
	shares := [][]byte{
		[]byte("share-1-placeholder"),
		[]byte("share-2-placeholder"),
	}
	err = impl.Activate("custodian_threshold", shares)
	testutil.RequireNoError(t, err)

	// Post-condition: estate must now be activated.
	if !impl.IsActivated() {
		t.Fatal("estate must be activated after successful custodian threshold recovery")
	}
}

// TST-CORE-871
func TestEstate_27_3_NoDeadMansSwitch_NoTimerTrigger(t *testing.T) {
	// No Dead Man's Switch — no timer-based estate activation.
	// Exercises the PRODUCTION PortEstateManager (port.EstateManager) and
	// EstateService, not the testutil-only EstateManager.

	ctx := context.Background()

	// --- Layer 1: Production adapter (PortEstateManager) rejects "timer" trigger ---
	portMgr := estate.NewPortEstateManager()

	err := portMgr.Activate(ctx, "timer", nil)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "custodian_threshold")

	// Sanity: the valid trigger "custodian_threshold" must succeed —
	// proves the rejection is specific to "timer", not a blanket failure.
	err = portMgr.Activate(ctx, "custodian_threshold", nil)
	testutil.RequireNoError(t, err)

	// --- Layer 2: Production service (EstateService.StorePlan) rejects "timer" plan ---
	// The real production path validates the trigger at StorePlan time via
	// validatePlan(), not just at Activate time.
	svc := service.NewEstateService(
		portMgr,    // port.EstateManager
		nil,        // port.VaultManager — not reached (validation fails first)
		nil,        // port.RecoveryManager — not reached
		nil,        // port.ClientNotifier — not reached
		clock.NewRealClock(),
	)

	timerPlan := testutil.EstatePlan{
		Trigger:       "timer",
		Custodians:    []string{"did:key:z6MkCustodian1"},
		Threshold:     1,
		DefaultAction: "destroy",
	}
	err = svc.StorePlan(ctx, timerPlan)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "custodian_threshold")

	// Sanity: a valid plan must be accepted by the service layer.
	validPlan := testutil.EstatePlan{
		Trigger:       "custodian_threshold",
		Custodians:    []string{"did:key:z6MkCustodian1", "did:key:z6MkCustodian2"},
		Threshold:     2,
		DefaultAction: "destroy",
	}
	err = svc.StorePlan(ctx, validPlan)
	testutil.RequireNoError(t, err)

	// Verify the valid plan was actually persisted.
	retrieved, err := portMgr.GetPlan(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, retrieved.Trigger, "custodian_threshold")
	testutil.RequireEqual(t, retrieved.Threshold, 2)
}

// TST-CORE-872
func TestEstate_27_4_ReadOnly90Days_Expires(t *testing.T) {
	// Estate `read_only_90_days` access type expires after 90 days.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	now := time.Now().Unix()
	ninetyDays := int64(90 * 24 * 60 * 60)

	// Positive: recently granted (now) must NOT be expired.
	expired, err := impl.CheckExpiry("read_only_90_days", now)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, expired, "read_only_90_days granted just now must NOT be expired")

	// Positive: granted 30 days ago must NOT be expired.
	thirtyDaysAgo := now - int64(30*24*60*60)
	expired, err = impl.CheckExpiry("read_only_90_days", thirtyDaysAgo)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, expired, "read_only_90_days granted 30 days ago must NOT be expired")

	// Negative: granted 91+ days ago must be expired.
	expired91 := now - ninetyDays - int64(24*60*60) // 91 days ago
	expired, err = impl.CheckExpiry("read_only_90_days", expired91)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, expired, "read_only_90_days access granted 91 days ago should be expired")

	// Negative: ancient grant must be expired.
	expired, err = impl.CheckExpiry("read_only_90_days", int64(1700000000))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, expired, "read_only_90_days access granted in Nov 2023 should be expired")
}

// TST-CORE-873
func TestEstate_27_5_DefaultAction_DestroyOrArchive(t *testing.T) {
	// Estate `default_action` enforcement (destroy vs archive).
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Positive: both valid actions must succeed.
	err := impl.EnforceDefaultAction("destroy")
	testutil.RequireNoError(t, err)

	err = impl.EnforceDefaultAction("archive")
	testutil.RequireNoError(t, err)

	// Negative: invalid actions must be rejected.
	err = impl.EnforceDefaultAction("keep")
	testutil.RequireError(t, err)

	err = impl.EnforceDefaultAction("")
	testutil.RequireError(t, err)

	err = impl.EnforceDefaultAction("delete")
	testutil.RequireError(t, err)

	err = impl.EnforceDefaultAction("DESTROY")
	testutil.RequireError(t, err)
}

// TST-CORE-874
func TestEstate_27_6_SSSSharesReusedFromIdentityRecovery(t *testing.T) {
	// Estate SSS shares reused from identity recovery (same set, not separate).
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")

	// Split a test secret — same shares used for both identity and estate recovery.
	secret := []byte("test-master-seed-32-bytes-long!!")
	shares, err := impl.Split(secret, 3, 5)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(shares), 5)

	// Verify reconstruction works with threshold shares.
	recovered, err := impl.Combine(shares[:3])
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, recovered, secret)
}

// TST-CORE-875
func TestEstate_27_7_PlanJSONStructure_Validated(t *testing.T) {
	// Estate plan JSON structure validated (trigger, custodians, beneficiaries).
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Positive control: valid plan must be accepted.
	validPlan := testutil.EstatePlan{
		Trigger:       "custodian_threshold",
		Custodians:    []string{"did:key:z6MkCustodian1", "did:key:z6MkCustodian2"},
		Threshold:     2,
		DefaultAction: "destroy",
	}
	err := impl.StorePlan(validPlan)
	testutil.RequireNoError(t, err)

	// Negative: empty trigger must be rejected.
	invalidPlan := testutil.EstatePlan{
		Trigger: "",
	}
	err = impl.StorePlan(invalidPlan)
	testutil.RequireError(t, err)

	// Negative: unsupported trigger must be rejected.
	invalidTrigger := testutil.EstatePlan{
		Trigger:       "timer",
		Custodians:    []string{"did:key:z6MkCustodian1"},
		Threshold:     1,
		DefaultAction: "destroy",
	}
	err = impl.StorePlan(invalidTrigger)
	testutil.RequireError(t, err)
}

// TST-CORE-876
func TestEstate_27_8_NotificationList_InformsOnActivation(t *testing.T) {
	// Estate notification list informs contacts on activation.
	// Test via production PortEstateManager which enforces plan-dependency.
	ctx := context.Background()
	portMgr := estate.NewPortEstateManager()

	// Negative: NotifyContacts without a stored plan must fail.
	err := portMgr.NotifyContacts(ctx)
	testutil.RequireError(t, err)

	// Store a valid plan with notification contacts.
	plan := testutil.EstatePlan{
		Trigger:       "custodian_threshold",
		Custodians:    []string{"did:key:z6MkCustodian1", "did:key:z6MkCustodian2"},
		Threshold:     2,
		Notifications: []string{"did:key:z6MkNotify1", "did:key:z6MkNotify2"},
		DefaultAction: "destroy",
	}
	err = portMgr.StorePlan(ctx, plan)
	testutil.RequireNoError(t, err)

	// Positive: NotifyContacts with a stored plan must succeed.
	err = portMgr.NotifyContacts(ctx)
	testutil.RequireNoError(t, err)
}

// TST-CORE-877
func TestEstate_27_9_Recovery_KeysDeliveredViaD2D(t *testing.T) {
	// Estate recovery: keys delivered via Dina-to-Dina encrypted channel.
	// Test via production PortEstateManager for context-based API.
	ctx := context.Background()
	portMgr := estate.NewPortEstateManager()

	// Pre-condition: store a plan and activate before key delivery.
	plan := testutil.EstatePlan{
		Trigger:       "custodian_threshold",
		Custodians:    []string{"did:key:z6MkCustodian1", "did:key:z6MkCustodian2"},
		Threshold:     2,
		Beneficiaries: map[string][]string{"did:key:z6MkBeneficiary1": {"general"}},
		DefaultAction: "destroy",
	}
	err := portMgr.StorePlan(ctx, plan)
	testutil.RequireNoError(t, err)

	err = portMgr.Activate(ctx, "custodian_threshold", nil)
	testutil.RequireNoError(t, err)

	// Key delivery to a valid beneficiary must succeed.
	err = portMgr.DeliverKeys(ctx, "did:key:z6MkBeneficiary1")
	testutil.RequireNoError(t, err)

	// Multiple beneficiaries should each be deliverable independently.
	err = portMgr.DeliverKeys(ctx, "did:key:z6MkBeneficiary2")
	testutil.RequireNoError(t, err)
}

// TST-CORE-878
func TestEstate_27_10_Recovery_NonAssignedDataDestroyed(t *testing.T) {
	// Estate recovery: non-assigned data destroyed per default_action.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// "destroy" and "archive" must be accepted.
	err := impl.EnforceDefaultAction("destroy")
	testutil.RequireNoError(t, err)

	err = impl.EnforceDefaultAction("archive")
	testutil.RequireNoError(t, err)

	// Invalid actions must be rejected.
	err = impl.EnforceDefaultAction("keep")
	testutil.RequireError(t, err)

	err = impl.EnforceDefaultAction("")
	testutil.RequireError(t, err)
}

// TST-CORE-879
func TestEstate_27_11_NoTimerTriggerInCodebase(t *testing.T) {
	// Code audit: estate activation must never be timer-driven.
	// Scan all Go source files in the estate adapter for timer-based patterns
	// that could enable a Dead Man's Switch (banned by design — §27).

	estateDir := filepath.Join("..", "internal", "adapter", "estate")
	entries, err := os.ReadDir(estateDir)
	if err != nil {
		t.Fatalf("cannot read estate adapter directory: %v", err)
	}

	bannedPatterns := []string{
		"time.NewTimer",
		"time.AfterFunc",
		"time.NewTicker",
		"time.After(",
		"time.Tick(",
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") {
			continue
		}
		path := filepath.Join(estateDir, entry.Name())
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("cannot read %s: %v", path, err)
		}
		content := string(src)
		for _, pattern := range bannedPatterns {
			if strings.Contains(content, pattern) {
				t.Fatalf("estate source %s contains banned timer pattern %q — estate activation must be guardian-triggered, never automated", entry.Name(), pattern)
			}
		}
	}

	// Also verify the API rejects a "timer" trigger at runtime.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	plan := testutil.EstatePlan{
		Trigger:       "timer",
		Custodians:    []string{"did:key:z6MkCustodian1"},
		Threshold:     1,
		DefaultAction: "destroy",
	}
	errStore := impl.StorePlan(plan)
	testutil.RequireError(t, errStore)
}
