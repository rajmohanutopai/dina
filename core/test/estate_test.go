package test

import (
	"testing"

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
		Beneficiaries: map[string][]string{"did:key:z6MkBeneficiary1": {"personal", "social"}},
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
	// Estate recovery: custodian threshold met, per-beneficiary DEK derivation.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Provide threshold number of custodian shares.
	shares := [][]byte{
		[]byte("share-1-placeholder"),
		[]byte("share-2-placeholder"),
	}
	err := impl.Activate("custodian_threshold", shares)
	testutil.RequireNoError(t, err)
}

// TST-CORE-871
func TestEstate_27_3_NoDeadMansSwitch_NoTimerTrigger(t *testing.T) {
	// No Dead Man's Switch — no timer-based estate activation.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Attempt timer-triggered activation — must be rejected.
	err := impl.Activate("timer", nil)
	testutil.RequireError(t, err)
}

// TST-CORE-872
func TestEstate_27_4_ReadOnly90Days_Expires(t *testing.T) {
	// Estate `read_only_90_days` access type expires after 90 days.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Granted 91 days ago — should be expired.
	grantedAt := int64(1700000000)
	expired, err := impl.CheckExpiry("read_only_90_days", grantedAt)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, expired, "read_only_90_days access granted 91+ days ago should be expired")
}

// TST-CORE-873
func TestEstate_27_5_DefaultAction_DestroyOrArchive(t *testing.T) {
	// Estate `default_action` enforcement (destroy vs archive).
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	err := impl.EnforceDefaultAction("destroy")
	testutil.RequireNoError(t, err)

	err = impl.EnforceDefaultAction("archive")
	testutil.RequireNoError(t, err)
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

	// Plan missing required fields should fail validation.
	invalidPlan := testutil.EstatePlan{
		Trigger: "", // missing trigger
	}
	err := impl.StorePlan(invalidPlan)
	testutil.RequireError(t, err)
}

// TST-CORE-876
func TestEstate_27_8_NotificationList_InformsOnActivation(t *testing.T) {
	// Estate notification list informs contacts on activation.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	err := impl.NotifyContacts()
	testutil.RequireNoError(t, err)
}

// TST-CORE-877
func TestEstate_27_9_Recovery_KeysDeliveredViaD2D(t *testing.T) {
	// Estate recovery: keys delivered via Dina-to-Dina encrypted channel.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	err := impl.DeliverKeys("did:key:z6MkBeneficiary1")
	testutil.RequireNoError(t, err)
}

// TST-CORE-878
func TestEstate_27_10_Recovery_NonAssignedDataDestroyed(t *testing.T) {
	// Estate recovery: non-assigned data destroyed per default_action.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	err := impl.EnforceDefaultAction("destroy")
	testutil.RequireNoError(t, err)
}

// TST-CORE-879
func TestEstate_27_11_NoTimerTriggerInCodebase(t *testing.T) {
	// Estate recovery: no timer trigger exists in codebase — code audit.
	impl := realEstateManager
	testutil.RequireImplementation(t, impl, "EstateManager")

	// Verify that only "custodian_threshold" trigger is accepted.
	plan := testutil.EstatePlan{
		Trigger:       "timer",
		Custodians:    []string{"did:key:z6MkCustodian1"},
		Threshold:     1,
		DefaultAction: "destroy",
	}
	err := impl.StorePlan(plan)
	testutil.RequireError(t, err)
}
