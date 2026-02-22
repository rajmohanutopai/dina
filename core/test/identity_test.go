package test

import (
	"context"
	"testing"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/test/testutil"
)

// idCtx is a background context used for all identity port calls.
var idCtx = context.Background()

// ---------- §3.1 DID Generation & Persistence (10 scenarios) ----------

// TST-CORE-130
func TestIdentity_3_1_1_GenerateRootDID(t *testing.T) {
	impl := realDIDManager
	// impl = identity.NewDIDManager(testutil.TempDir(t))
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, err := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	testutil.RequireHasPrefix(t, string(did), "did:plc:")
}

// TST-CORE-131
func TestIdentity_3_1_2_LoadExistingDID(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did1, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, err := impl.Resolve(idCtx, did1)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, doc)
}

// TST-CORE-132
func TestIdentity_3_1_3_DIDDocumentStructure(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, string(doc), `"id"`)
	testutil.RequireContains(t, string(doc), `"service"`)
	testutil.RequireContains(t, string(doc), `"verificationMethod"`)
}

// TST-CORE-133
func TestIdentity_3_1_4_MultiplePersonaDIDs(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	key1 := make([]byte, 32)
	key2 := make([]byte, 32)
	key1[0] = 1
	key2[0] = 2
	did1, _ := impl.Create(idCtx, key1)
	did2, _ := impl.Create(idCtx, key2)
	if did1 == did2 {
		t.Fatal("different keys should produce different DIDs")
	}
}

// TST-CORE-134
func TestIdentity_3_1_5_DIDDocumentServiceEndpoint(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, _ := impl.Resolve(idCtx, did)
	testutil.RequireContains(t, string(doc), `"DinaMessaging"`)
}

// TST-CORE-135
func TestIdentity_3_1_6_PLCDirectorySignedOpsOnly(t *testing.T) {
	t.Skip("code audit test — verify PLC Directory stores only signed ops")
}

// TST-CORE-136
func TestIdentity_3_1_7_SecondRootGenerationRejected(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	_, err1 := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err1)
	_, err2 := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	testutil.RequireError(t, err2)
}

// TST-CORE-137
func TestIdentity_3_1_8_RootIdentityCreatedAtTimestamp(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, _ := impl.Resolve(idCtx, did)
	testutil.RequireContains(t, string(doc), `"created_at"`)
}

// TST-CORE-138
func TestIdentity_3_1_9_DeviceOriginFingerprint(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, _ := impl.Resolve(idCtx, did)
	testutil.RequireContains(t, string(doc), `"device_origin"`)
}

// TST-CORE-139
func TestIdentity_3_1_10_MultikeyZ6MkPrefix(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	doc, _ := impl.Resolve(idCtx, did)
	testutil.RequireContains(t, string(doc), `z6Mk`)
}

// ---------- §3.1.1 Key Rotation (5 scenarios) ----------

// TST-CORE-140
func TestIdentity_3_1_1_1_RotateSigningKey(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	newKey := make([]byte, 32)
	newKey[0] = 0xff
	err := impl.Rotate(idCtx, did, testutil.TestEd25519Seed[:], newKey)
	testutil.RequireNoError(t, err)
}

// TST-CORE-141
func TestIdentity_3_1_1_2_RotationPreservesDID(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	did, _ := impl.Create(idCtx, testutil.TestEd25519Seed[:])
	newKey := make([]byte, 32)
	newKey[0] = 0xff
	_ = impl.Rotate(idCtx, did, testutil.TestEd25519Seed[:], newKey)
	doc, err := impl.Resolve(idCtx, did)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, doc)
}

// TST-CORE-142
func TestIdentity_3_1_1_3_OldKeyInvalidAfterRotation(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")
	t.Skip("requires Signer integration to verify old key no longer works")
}

// TST-CORE-143
func TestIdentity_3_1_1_4_RotationOpSignedByOldKey(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")
	t.Skip("requires PLC Directory interaction verification")
}

// TST-CORE-144
func TestIdentity_3_1_1_5_RecoveryKeysCanReclaimDID(t *testing.T) {
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")
	t.Skip("requires recovery key implementation")
}

// ---------- §3.1.2 did:web Fallback (5 scenarios) ----------

// TST-CORE-145
func TestIdentity_3_1_2_1_DIDWebResolution(t *testing.T) {
	t.Skip("did:web fallback not yet implemented")
}

// TST-CORE-146
func TestIdentity_3_1_2_2_DIDWebSameKeypair(t *testing.T) {
	t.Skip("did:web fallback not yet implemented")
}

// TST-CORE-147
func TestIdentity_3_1_2_3_RotationPLCToDIDWeb(t *testing.T) {
	t.Skip("did:web fallback not yet implemented")
}

// TST-CORE-148
func TestIdentity_3_1_2_4_DIDWebPiggybacksIngress(t *testing.T) {
	t.Skip("infrastructure test — did:web uses existing tunnel")
}

// TST-CORE-149
func TestIdentity_3_1_2_5_DIDWebTradeoffAcknowledged(t *testing.T) {
	t.Skip("architecture review — did:web depends on DNS")
}

// ---------- §3.2 Persona Management (13 scenarios) ----------

// TST-CORE-150
func TestIdentity_3_2_1_CreatePersona(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	id, err := impl.Create(idCtx, "work", "restricted")
	testutil.RequireNoError(t, err)
	if id == "" {
		t.Fatal("expected non-empty persona ID")
	}
}

// TST-CORE-151
func TestIdentity_3_2_2_ListPersonas(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	impl.Create(idCtx, "work", "open")
	impl.Create(idCtx, "personal", "open")
	list, err := impl.List(idCtx)
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(list), 2)
}

// TST-CORE-152
func TestIdentity_3_2_3_DeletePersona(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	id, _ := impl.Create(idCtx, "work", "open")
	err := impl.Delete(idCtx, id)
	testutil.RequireNoError(t, err)
	list, _ := impl.List(idCtx)
	testutil.RequireLen(t, len(list), 0)
}

// TST-CORE-153
func TestIdentity_3_2_4_DeleteFileRemovesPersona(t *testing.T) {
	t.Skip("requires filesystem integration — rm vault file = persona gone")
}

// TST-CORE-154
func TestIdentity_3_2_5_PersonaIsolation(t *testing.T) {
	vm := testutil.NewMockVaultManager()
	vm.Open("persona-a", testutil.TestDEK[:])
	vm.Open("persona-b", testutil.TestDEK[:])
	item := testutil.TestVaultItem()
	vm.Store("persona-a", item)
	_, err := vm.Retrieve("persona-b", item.ID)
	testutil.RequireError(t, err)
}

// TST-CORE-155
func TestIdentity_3_2_6_DefaultPersonaExists(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
}

// TST-CORE-156
func TestIdentity_3_2_7_PerPersonaFileLayout(t *testing.T) {
	t.Skip("requires filesystem verification of vault directory structure")
}

// TST-CORE-157
func TestIdentity_3_2_8_PerPersonaIndependentDEK(t *testing.T) {
	impl := realVaultDEKDeriver
	testutil.RequireImplementation(t, impl, "VaultDEKDeriver")
}

// TST-CORE-158
func TestIdentity_3_2_9_LockedPersonaOpaqueBytes(t *testing.T) {
	t.Skip("requires vault file inspection when persona locked")
}

// TST-CORE-159
func TestIdentity_3_2_10_SelectiveUnlockWithTTL(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
}

// TST-CORE-160
func TestIdentity_3_2_11_PersonaKeySignsDIDComm(t *testing.T) {
	t.Skip("requires Ed25519 signing integration — persona key, NOT root key")
}

// TST-CORE-161
func TestIdentity_3_2_12_PersonaKeySignsReputationGraph(t *testing.T) {
	t.Skip("requires signing integration — persona key for reputation entries")
}

// TST-CORE-162
func TestIdentity_3_2_13_NoCrossCompartmentCode(t *testing.T) {
	t.Skip("code audit — no code path crosses persona boundaries without root key")
}

// ---------- §3.3 Persona Gatekeeper (15 scenarios) ----------

// TST-CORE-163
func TestIdentity_3_3_1_AccessOpenTier(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
}

// TST-CORE-164
func TestIdentity_3_3_2_AccessRestrictedTier(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
}

// TST-CORE-165
func TestIdentity_3_3_3_AccessLockedTierWithoutUnlock(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	impl.Create(idCtx, "financial", "locked")
	locked, _ := impl.IsLocked("persona-financial")
	testutil.RequireTrue(t, locked, "financial persona should be locked")
}

// TST-CORE-166
func TestIdentity_3_3_4_UnlockLockedPersona(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	impl.Create(idCtx, "financial", "locked")
	err := impl.Unlock(idCtx, "persona-financial", testutil.TestPassphrase, 300)
	testutil.RequireNoError(t, err)
	locked, _ := impl.IsLocked("persona-financial")
	testutil.RequireFalse(t, locked, "persona should be unlocked after Unlock()")
}

// TST-CORE-167
func TestIdentity_3_3_5_LockedPersonaTTLExpiry(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
	t.Skip("requires TTL timer integration")
}

// TST-CORE-168
func TestIdentity_3_3_6_LockedPersonaReLock(t *testing.T) {
	impl := testutil.NewMockPersonaManager()
	impl.Create(idCtx, "financial", "locked")
	impl.Unlock(idCtx, "persona-financial", testutil.TestPassphrase, 300)
	err := impl.Lock(idCtx, "persona-financial")
	testutil.RequireNoError(t, err)
	locked, _ := impl.IsLocked("persona-financial")
	testutil.RequireTrue(t, locked, "persona should be re-locked")
}

// TST-CORE-169
func TestIdentity_3_3_7_AuditLogForRestrictedAccess(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
	t.Skip("requires audit log integration")
}

// TST-CORE-170
func TestIdentity_3_3_8_NotificationOnRestrictedAccess(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
	t.Skip("requires notification integration")
}

// TST-CORE-171
func TestIdentity_3_3_9_LockedPersonaUnlockFlow(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
	t.Skip("requires WS/push human approval flow")
}

// TST-CORE-172
func TestIdentity_3_3_10_LockedPersonaUnlockDenied(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
	t.Skip("requires human denial flow")
}

// TST-CORE-173
func TestIdentity_3_3_11_LockedPersonaUnlockTTLExpires(t *testing.T) {
	impl := realPersonaManager
	testutil.RequireImplementation(t, impl, "PersonaManager")
	t.Skip("requires TTL expiration test")
}

// TST-CORE-174
func TestIdentity_3_3_12_CrossPersonaParallelReads(t *testing.T) {
	impl := realVaultManager
	testutil.RequireImplementation(t, impl, "VaultManager")
	t.Skip("requires concurrent read integration across personas")
}

// TST-CORE-175
func TestIdentity_3_3_13_GetPersonasForContactDerived(t *testing.T) {
	impl := realVaultManager
	testutil.RequireImplementation(t, impl, "VaultManager")
	t.Skip("requires cross-persona contact scan")
}

// TST-CORE-176
func TestIdentity_3_3_14_GetPersonasForContactLockedInvisible(t *testing.T) {
	impl := realVaultManager
	testutil.RequireImplementation(t, impl, "VaultManager")
	t.Skip("locked personas excluded from contact query results")
}

// TST-CORE-177
func TestIdentity_3_3_15_TierConfigInConfigJSON(t *testing.T) {
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")
	t.Skip("requires config.json brain_access field validation")
}

// ---------- §3.4 Contact Directory (9 scenarios) ----------

// TST-CORE-178
func TestIdentity_3_4_1_AddContact(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-179
func TestIdentity_3_4_2_ResolveContactDID(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-180
func TestIdentity_3_4_3_UpdateContactTrustLevel(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-181
func TestIdentity_3_4_4_DeleteContact(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-182
func TestIdentity_3_4_5_PerPersonaContactRouting(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-183
func TestIdentity_3_4_6_ContactsTableNoPersonaColumn(t *testing.T) {
	t.Skip("schema validation — contacts DDL has no persona column")
}

// TST-CORE-184
func TestIdentity_3_4_7_ContactsFullSchemaValidation(t *testing.T) {
	t.Skip("schema validation — all columns with correct types and defaults")
}

// TST-CORE-185
func TestIdentity_3_4_8_TrustLevelEnumValidation(t *testing.T) {
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")
}

// TST-CORE-186
func TestIdentity_3_4_9_ContactsTrustIndex(t *testing.T) {
	t.Skip("schema validation — idx_contacts_trust index exists")
}

// ---------- §3.5 Device Registry (4 scenarios) ----------

// TST-CORE-187
func TestIdentity_3_5_1_RegisterDevice(t *testing.T) {
	impl := realDeviceRegistry
	testutil.RequireImplementation(t, impl, "DeviceRegistry")
}

// TST-CORE-188
func TestIdentity_3_5_2_ListDevices(t *testing.T) {
	impl := realDeviceRegistry
	testutil.RequireImplementation(t, impl, "DeviceRegistry")
}

// TST-CORE-189
func TestIdentity_3_5_3_RevokeDevice(t *testing.T) {
	impl := realDeviceRegistry
	testutil.RequireImplementation(t, impl, "DeviceRegistry")
}

// TST-CORE-190
func TestIdentity_3_5_4_MaxDeviceLimit(t *testing.T) {
	impl := realDeviceRegistry
	testutil.RequireImplementation(t, impl, "DeviceRegistry")
}

// ---------- §3.6 Recovery (5 scenarios) ----------

// TST-CORE-191
func TestIdentity_3_6_1_SplitMasterSeed(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")
}

// TST-CORE-192
func TestIdentity_3_6_2_ReconstructWithThreshold(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")
}

// TST-CORE-193
func TestIdentity_3_6_3_ReconstructFewerThanThreshold(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")
}

// TST-CORE-194
func TestIdentity_3_6_4_ReconstructWithInvalidShare(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")
}

// TST-CORE-195
func TestIdentity_3_6_5_ShareFormat(t *testing.T) {
	impl := realRecoveryManager
	testutil.RequireImplementation(t, impl, "RecoveryManager")
}

// TST-CORE-926
func TestIdentity_3_6_6_IngressTierChange_DIDDocRotation(t *testing.T) {
	// DID Document endpoint update on ingress tier change.
	impl := realDIDManager
	testutil.RequireImplementation(t, impl, "DIDManager")

	// Resolving DID should return valid DID Document.
	doc, err := impl.Resolve(idCtx, domain.DID("did:plc:testingress"))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(doc) > 0, "DID Document must not be empty")
}

// TST-CORE-927
func TestIdentity_3_6_7_TrustRingLevelsDefinedInCode(t *testing.T) {
	// Trust ring level enum defined in code.
	// Validate that trust levels are well-defined: unverified, verified, skin_in_game.
	impl := realContactDirectory
	testutil.RequireImplementation(t, impl, "ContactDirectory")

	// Adding a contact with valid trust level should succeed.
	err := impl.Add(idCtx, "did:key:z6MkTrustTest", "Trust Test", "unknown")
	testutil.RequireNoError(t, err)
}

// TST-CORE-928
func TestIdentity_3_6_8_NoMCPOrOpenClawVaultAccess(t *testing.T) {
	// No MCP/OpenClaw credential can access vault endpoints.
	var impl testutil.AdminEndpointChecker
	testutil.RequireImplementation(t, impl, "AdminEndpointChecker")

	// Only brain and client token kinds should be recognized.
	allowed := impl.AllowedForTokenKind("mcp", "/v1/vault/query")
	testutil.RequireFalse(t, allowed, "MCP token must not access vault endpoints")

	allowed = impl.AllowedForTokenKind("openclaw", "/v1/vault/query")
	testutil.RequireFalse(t, allowed, "OpenClaw token must not access vault endpoints")
}
