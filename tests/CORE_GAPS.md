# Core Test Plan — Architecture Gap Tracker

> Cross-reference of architecture documents (`docs/architecture/`) against Core test plan (`core/test/TEST_PLAN.md`) and test code (`core/test/*_test.go`).

**Context:** This is a TDD project. Architecture was written first, then test plans, then test stubs with `RequireImplementation` (which auto-skip until the real Go implementation is wired in). 933 test plan scenarios exist with 933 corresponding test stubs — all passing traceability (100.0%).

**Resolution:** All 105 gaps closed. 76 new test plan entries (TST-CORE-858 through TST-CORE-933), 3 new test plan sections (§25 Bot Interface, §26 Client Sync Protocol, §27 Digital Estate), 4 new test files, 15 modified test files, 5 new interfaces in `testutil/interfaces.go`, 4 mismatch values fixed, 22 coverage gaps enhanced.

**What this file tracks:**
- **TRUE GAP** = Architecture behavior with no test plan entry and no test stub
- **COVERAGE GAP** = Test stub exists but doesn't fully capture the architecture requirement (needs enhancement)
- **MISMATCH** = Test plan/stub values disagree with architecture values

**Status legend:** OPEN = needs fix | CLOSED = fixed | SKIP = not testable or deferred

---

## HIGH Severity Gaps (21 total)

### §4-6: Data Flow, Identity, Storage

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| H1 | §4 | `/v1/vault/crash` rejects requests missing required fields (error, traceback) | `TestAPIContract_VaultCrashMissingFieldsRejected` | CLOSED |
| H2 | §5 | Key generation verified to use `crypto/rand` (not weak entropy source) | `TestCrypto_KeyGenerationUsesSecureRandom` | CLOSED |
| H3 | §6 | Archive key survives backup key rotation (separate HKDF derivations) | `TestCrypto_ArchiveKeySurvivesBackupKeyRotation` | CLOSED |
| H4 | §6 | Tier 5 Deep Archive: encrypted snapshot to cold storage with compliance lock | `TestVault_Tier5DeepArchive_EncryptedSnapshot` | CLOSED |

### §7-10: Ingestion, Reputation, D2D, Bot Interface

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| H5 | §8 | `com.dina.reputation.bot` and `com.dina.trust.membership` Lexicons untested | `TestPDS_BotLexiconValidation` | CLOSED |
| H6 | §9 | Egress audit 90-day rolling retention policy (auto-purge old entries) | `TestAuditLog_90DayRollingRetention` | CLOSED |
| H7 | §9 | Contact `updated_at` refreshed on sharing policy mutation | `TestContacts_UpdatedAtRefreshedOnPolicyChange` | CLOSED |
| H8 | §10 | Bot query sanitization: no DID, no medical, no financial in outbound queries | `TestBotInterface_QuerySanitizationNoDIDNoMedical` | CLOSED |
| H9 | §10 | Bot communication protocol (POST /query schema, bot_signature, attribution) | `TestBotInterface_QueryProtocolSchema` | CLOSED |

### §11-14: Intelligence, Action, Client Sync, Digital Estate

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| H10 | §11 | PII de-sanitization endpoint — restores tokens from replacement map | `TestPII_DeSanitizeEndpoint_RestoresTokensFromMap` | CLOSED |
| H11 | §11 | PII scrubber makes zero outbound network calls (hard invariant) | `TestPII_ScrubEndpoint_NoOutboundNetworkCalls` | CLOSED |
| H12 | §12 | Draft confidence score: low -> flagged for review, high-risk -> draft blocked | `TestStaging_DraftConfidenceScore_Validated` | CLOSED |
| H13 | §12 | Agent `draft_only: true` constraint enforced, no raw vault data to agents | `TestGatekeeper_AgentConstraint_DraftOnlyEnforced` | CLOSED |
| H14 | §13 | Client sync protocol: checkpoint-based sync, changed-items-since-X | `TestSync_ClientSendsCheckpoint_CoreReturnsChangedItems` | CLOSED |
| H15 | §13 | Real-time vault item push to connected clients via WebSocket | `TestSync_NewVaultItem_PushedToConnectedClients` | CLOSED |
| H16 | §14 | Digital Estate plan storage in Tier 0 (identity.sqlite) | `TestEstate_PlanStoredInTier0` | CLOSED |
| H17 | §14 | Estate recovery: custodian threshold, per-beneficiary DEK derivation | `TestEstate_Recovery_CustodianThresholdMet` | CLOSED |
| H18 | §14 | No Dead Man's Switch — no timer-based estate activation | `TestEstate_NoDeadMansSwitch_NoTimerTrigger` | CLOSED |

### §15-18: Architecture Decisions, Tech Stack, Infrastructure

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| H19 | §16 | System watchdog (1h interval): connector liveness, disk usage, brain health | `TestWatchdog_SystemTicker_1HourInterval` | CLOSED |
| H20 | §17 | Sensitive persona (health/financial) mandatory PII scrub before cloud LLM | `TestSensitivePersona_MandatoryPIIScrubBeforeCloudLLM` | CLOSED |
| H21 | §17 | Import/restore invalidates all device tokens, forces re-pair | `TestPortability_ImportInvalidatesAllDeviceTokens` | CLOSED |

---

## MEDIUM Severity Gaps (40 total)

### §1-3: System Overview, Home Node, Sidecar

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| M1 | §1 | No Go `plugin.Open()` or dynamic library loading (kernel guarantee) | `TestSecurity_NoGoPluginImport` | CLOSED |
| M2 | §3 | CSRF token injected as `X-CSRF-Token` in proxied response to browser | `TestAdminProxy_CSRFTokenInjectedInResponse` | CLOSED |

### §4-6: Data Flow, Identity, Storage

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| M3 | §4 | Vault query full response schema (id, type, persona, summary, relevance, pagination) | `TestAPIContract_VaultQueryResponseSchema` | CLOSED |
| M4 | §4 | Vault store response ID format (`vault_` prefix) | `TestAPIContract_VaultStoreResponseIDFormat` | CLOSED |
| M5 | §4 | Vault query: missing `persona` field -> 400 Bad Request | `TestAPIContract_VaultQueryMissingPersonaField` | CLOSED |
| M6 | §4 | Docker compose logging rotation config validated | `TestObservability_DockerComposeLoggingRotationConfig` | CLOSED |
| M7 | §4 | Single watchdog sweep cleans both audit AND crash logs together | `TestWatchdog_SingleSweepCleansAuditAndCrashLogs` | CLOSED |
| M8 | §5 | Audit log retention configurable via config.json (`retention_days`) | `TestAuditLog_RetentionConfigurableViaConfigJSON` | CLOSED |
| M9 | §6 | FTS5 with Indic scripts (Hindi, Tamil, Kannada) — multilingual claim | `TestVaultSearch_FTS5WithIndicScripts` | CLOSED |
| M10 | §6 | Verify sqlite-vec used (not deprecated sqlite-vss) | `TestVaultSearch_UsesSqliteVecNotVSS` | CLOSED |
| M11 | §6 | FTS5 remains available during sqlite-vec re-indexing | `TestVault_EmbeddingMigration_FTS5AvailableDuringReindex` | CLOSED |
| M12 | §6 | Client sync key used for sync encryption, reputation key for signing | `TestCrypto_ClientSyncKeyUsedForSyncEncryption` | CLOSED |

### §7-10: Ingestion, Reputation, D2D, Bot Interface

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| M13 | §7 | Binary blob storage rejected — vault enforces reference-only for attachments | `TestIngestion_NoBinaryBlobsInVault` | CLOSED |
| M14 | §8 | Outcome data schema (reporter_trust_ring, outcome, satisfaction, issues) | `TestPDS_OutcomeDataSchemaValidation` | CLOSED |
| M15 | §8 | Attestation optional fields URI format (sourceUrl, deepLink) | `TestPDS_AttestationOptionalFieldsURIFormat` | CLOSED |
| M16 | §8 | Reputation query response includes signed payloads | `TestReputation_QueryResponseIncludesSignedPayloads` | CLOSED |
| M17 | §9 | Outbox retry backoff includes jitter (not just exponential) | `TestTransport_OutboxRetryBackoffIncludesJitter` | CLOSED |
| M18 | §10 | Bot reputation scoring: local score tracking, threshold-based routing | `TestBotInterface_LocalBotScoreTracking` | CLOSED |
| M19 | §10 | Deep Link attribution validation + penalty for stripping attribution | `TestBotInterface_DeepLinkAttributionValidation` | CLOSED |
| M20 | §8 | DID Document contains DIDComm service endpoint for D2D communication | `TestIdentity_DIDDocContainsDIDCommServiceEndpoint` | CLOSED |

### §11-14: Intelligence, Action, Client Sync, Digital Estate

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| M21 | §11 | Cloud LLM consent flag stored and enforced before cloud routing | `TestConfig_CloudLLMConsentFlag` | CLOSED |
| M22 | §13 | Conflict resolution: last-write-wins, earlier version logged as recoverable | `TestSync_ConflictResolution_LastWriteWins` | CLOSED |
| M23 | §13 | Thin client: query via WebSocket, no local cache model | `TestSync_ThinClient_QueryViaWebSocket` | CLOSED |
| M24 | §13 | Backup scheduling to blob store (S3/Backblaze/NAS), configurable frequency | `TestBackup_BlobStoreDestination_ConfigurableFrequency` | CLOSED |
| M25 | §14 | Estate `read_only_90_days` access type expires after 90 days | `TestEstate_ReadOnly90Days_Expires` | CLOSED |
| M26 | §14 | Estate `default_action` enforcement (destroy vs archive) | `TestEstate_DefaultAction_DestroyOrArchive` | CLOSED |
| M27 | §14 | Estate SSS shares reused from identity recovery (same set, not separate) | `TestEstate_SSSSharesReusedFromIdentityRecovery` | CLOSED |

### §15-18: Architecture Decisions, Tech Stack, Infrastructure

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| M28 | §16 | `/metrics` Prometheus endpoint: exists, requires CLIENT_TOKEN | `TestServer_MetricsEndpointExists` | CLOSED |
| M29 | §17 | Push notifications: FCM/APNs wake-up payload is data-free | `TestPushNotification_FCMWakeupPayloadEmpty` | CLOSED |
| M30 | §15 | Outcome and Bot Lexicon signing and validation | `TestPDS_OutcomeRecordSigning` | CLOSED |
| M31 | §17 | WebSocket `last_seen` timestamp updated on auth | `TestWS_AuthOK_UpdatesLastSeenTimestamp` | CLOSED |
| M32 | §13 | New device full sync from zero checkpoint | `TestSync_NewDeviceFullSync` | CLOSED |
| M33 | §13 | Connection drop: client queues changes, syncs on reconnect | `TestSync_OfflineQueueSyncsOnReconnect` | CLOSED |
| M34 | §14 | Estate plan JSON structure validated (trigger, custodians, beneficiaries) | `TestEstate_PlanJSONStructure_Validated` | CLOSED |
| M35 | §14 | Estate notification list informs contacts on activation | `TestEstate_NotificationList_InformsOnActivation` | CLOSED |
| M36 | §14 | Estate recovery: keys delivered via Dina-to-Dina encrypted channel | `TestEstate_Recovery_KeysDeliveredViaD2D` | CLOSED |
| M37 | §14 | Estate recovery: non-assigned data destroyed per default_action | `TestEstate_Recovery_NonAssignedDataDestroyed` | CLOSED |
| M38 | §12 | Cart handover: structured fields (method, intent_uri, merchant, amount) | `TestStaging_CartHandover_StructuredFields` | CLOSED |
| M39 | §12 | Cart handover: no payment credentials stored in staging | `TestStaging_CartHandover_NoPaymentCredentials` | CLOSED |
| M40 | §12 | Agent outcomes recorded in Tier 3 for reputation scoring | `TestGatekeeper_AgentOutcome_RecordedForReputation` | CLOSED |

---

## MISMATCH: Test Values Disagree With Architecture (4 total — ALL FIXED)

Tests updated to match architecture values.

| # | Section | Architecture Says | Test Now Says | File | Status |
|---|---------|-------------------|---------------|------|--------|
| X1 | §4 | Healthcheck wget: `--no-verbose --tries=1 --spider` | `--no-verbose --tries=1 --spider` | `observability_test.go` | CLOSED |
| X2 | §4 | Healthcheck interval: `60s`, start_period: `20s` | `60s`, `20s` | `observability_test.go` | CLOSED |
| X3 | §4 | Restart policy: `always` | `always` | `observability_test.go` | CLOSED |
| X4 | §11 | PII token format: `[CC_NUM]` | `[CC_NUM]` | `pii_test.go` | CLOSED |

---

## LOW Severity Gaps (18 total)

| # | Section | Gap | Suggested Test | Status |
|---|---------|-----|----------------|--------|
| L1 | §1 | Device type (rich/thin) recorded during pairing | `TestPairing_DeviceTypeRecorded` | CLOSED |
| L2 | §1 | DID Document endpoint update on ingress tier change | `TestIdentity_IngressTierChange_DIDDocRotation` | CLOSED |
| L3 | §4 | Core has no external OAuth token storage (code audit) | `TestSecurity_NoExternalOAuthTokenStorage` | CLOSED |
| L4 | §5 | Trust ring level enum defined in code | `TestIdentity_TrustRingLevelsDefinedInCode` | CLOSED |
| L5 | §7 | `DINA_HISTORY_DAYS` config default 365 | `TestConfig_HistoryDaysDefault365` | CLOSED |
| L6 | §7 | Sync status API endpoint for admin UI | `TestAdmin_SyncStatusEndpoint` | CLOSED |
| L7 | §9 | Message category namespace validation (beyond prefix) | `TestTransport_MessageCategoryNamespaceValidation` | CLOSED |
| L8 | §8 | No MCP/OpenClaw credential can access vault endpoints | `TestAuth_NoMCPOrOpenClawVaultAccess` | CLOSED |
| L9 | §11 | Silence rules stored and retrievable from vault | `TestVault_SilenceRules_StoredAndRetrievable` | CLOSED |
| L10 | §13 | No vector clocks, no CRDTs (simplicity code audit) | `TestSync_NoVectorClocks_NoCRDTs` | CLOSED |
| L11 | §17 | mDNS auto-discovery broadcast on LAN | `TestPairing_mDNS_AutoDiscoveryBroadcast` | CLOSED |
| L12 | §17 | install.sh bootstrap: token gen, dirs, permissions | `TestBootstrap_InstallSH` | CLOSED |
| L13 | §17 | Data volume layout matches architecture spec | `TestInfra_DataVolumeLayout` | CLOSED |
| L14 | §15 | PDS Type A: fallback to external HTTPS push | `TestPDS_TypeA_FallbackToExternalHTTPS` | CLOSED |
| L15 | §3 | Core calls only documented brain endpoints | `TestAPIContract_CoreCallsOnlyDocumentedBrainEndpoints` | CLOSED |
| L16 | §2 | Spool file naming uses ULID format | `TestInbox_SpoolFileNaming_ULIDFormat` | CLOSED |
| L17 | §3 | All cookies stripped before brain proxy (not just session) | `TestAdminProxy_AllCookiesStripped` | CLOSED |
| L18 | §7 | Device push via authenticated WebSocket | `TestIngestion_DevicePushViaAuthenticatedWebSocket` | CLOSED |

---

## COVERAGE GAPS: Test Stub Exists But Incomplete (27 total)

These test plan entries and stubs exist but don't fully capture the architecture requirement. The stub needs enhancement so that when the implementation is wired in, the test actually validates what the architecture describes.

### HIGH Priority Coverage Gaps

| # | Existing TST-CORE | Section | What Architecture Says | What the Stub Misses | Status |
|---|-------------------|---------|----------------------|---------------------|--------|
| C1 | TST-CORE-624/625 | §1 | Plaintext discarded from memory after vault read response | No test verifies plaintext is zeroed from Go memory after response sent | CLOSED |
| C2 | TST-CORE-334 | §2 | Wrong passphrase: core starts in degraded mode with dead drop active | Stub verifies vault stays locked but not that dead drop HTTP ingress is active | CLOSED |
| C3 | TST-CORE-724 | §2 | Export archive cannot be opened without passphrase | No test attempts to open archive without passphrase to verify it fails | CLOSED |
| C4 | TST-CORE-387 | §9 | Malformed egress payloads: missing summary key, null values, nested objects | Stub only tests raw string; doesn't test missing keys, nulls, or nested objects | CLOSED |
| C5 | TST-CORE-633/634 | §17 | BRAIN_TOKEN read from `/run/secrets/brain_token` file path | Config test uses `DINA_BRAIN_TOKEN_FILE` env var, doesn't test Docker Secrets path convention | CLOSED |

### MEDIUM Priority Coverage Gaps

| # | Existing TST-CORE | Section | What Architecture Says | What the Stub Misses | Status |
|---|-------------------|---------|----------------------|---------------------|--------|
| C6 | TST-CORE-417 | §2 | Spool cap boundary: check includes size of new blob being written | No test for exact boundary: 499MB spool + 2MB message > 500MB cap | CLOSED |
| C7 | TST-CORE-049/170 | §3 | Restricted persona access dispatches daily briefing notification | Stub checks `decision.Audit` but not that a notification was dispatched for daily briefing | CLOSED |
| C8 | TST-CORE-326 | §2 | Brain notification: exact payload `{event: "vault_unlocked"}` + retry on failure | Stub documents expectation but doesn't verify payload format or retry behavior | CLOSED |
| C9 | TST-CORE-255/256 | §4 | `include_content` defaults false when field **omitted entirely** from JSON | Tests explicit true/false but not the omitted-field default behavior | CLOSED |
| C10 | TST-CORE-458 | §4 | Task `timeout_at` set to exactly `now() + 5 minutes` on processing | Stub tests status change to "processing" but not the timeout value | CLOSED |
| C11 | TST-CORE-084 | §5 | HKDF info string `:v1` version suffix convention | Stub tests full info string set but not the version suffix as a structured convention | CLOSED |
| C12 | TST-CORE-206-212 | §6 | Read pool `MaxOpenConns = cpu_count * 2` formula | Connection pool tests exist but don't verify the exact CPU-based formula | CLOSED |
| C13 | TST-CORE-279 | §4 | Scratchpad entries stored in Tier 4 staging tables specifically | Stub verifies identity.sqlite location but not that scratchpad uses staging tables | CLOSED |
| C14 | TST-CORE-605 | §4 | `Content-Type: application/json` enforced on vault API contract endpoints | Generic Content-Type test exists but not on vault-specific endpoints | CLOSED |
| C15 | TST-CORE-571-574 | §7 | KV cursor upsert updates `updated_at` timestamp atomically | Stub tests store/read/upsert but not the timestamp update on upsert | CLOSED |
| C16 | TST-CORE-711 | §8 | Outcome data uses wrong schema fields (attestation fields instead of outcome fields) | Stub uses `expertDid`/`verdict` instead of `reporter_trust_ring`/`outcome`/`satisfaction` | CLOSED |
| C17 | TST-CORE-391 | §9 | Audit entry must include all 5 fields: timestamp, contact_did, category, decision, reason | Stub checks `Action` and `Decision` but not `contact_did` and `category` in every entry | CLOSED |
| C18 | TST-CORE-595 | §17 | AT Protocol discovery: `Content-Type: text/plain` response header | Test code checks DID string is non-empty but doesn't assert Content-Type header | CLOSED |
| C19 | TST-CORE-320-342 | §17 | `DINA_VAULT_MODE` env var selects Security vs Convenience | Config tests use `DINA_MODE`, architecture says `DINA_VAULT_MODE` — naming mismatch | CLOSED |
| C20 | TST-CORE-514-516 | §17 | WebSocket reconnection triggers automatic buffer replay in order | Buffer primitives tested but not the reconnection-triggered replay orchestration | CLOSED |
| C21 | TST-CORE-201 | §16 | SQLCipher `PRAGMA cipher_page_size = 4096` not verified in test code | Test plan mentions it but no assertion in vault_test.go for this specific PRAGMA | CLOSED |
| C22 | TST-CORE-611/296 | §16 | `VACUUM INTO` — automated CI-level grep (CVE-level vulnerability) | Security test declares intent to audit but doesn't implement automated grep | CLOSED |

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| **HIGH (true gap)** | 21 | ALL CLOSED — TST-CORE-858–861, 880–882, 886–893, 914–916, 925, 888 |
| **MEDIUM (true gap)** | 40 | ALL CLOSED — TST-CORE-862–879, 894, 897–902, 906–913, 917–924, 929–933 |
| **COVERAGE GAP** | 22 | ALL CLOSED — existing stubs enhanced with additional assertions |
| **MISMATCH** | 4 | ALL CLOSED — X1-X3 fixed in observability_test.go, X4 fixed in pii_test.go |
| **LOW (true gap)** | 18 | ALL CLOSED — TST-CORE-895–896, 926–928, 903–905, 930 + others |
| **Total** | **105/105 CLOSED** | |

### New Test Infrastructure

| Asset | Details |
|-------|---------|
| New test plan sections | §25 Bot Interface, §26 Client Sync Protocol, §27 Digital Estate |
| New test files | `bot_test.go`, `sync_test.go`, `estate_test.go`, `watchdog_test.go` |
| New interfaces | `BotQueryHandler`, `ClientSyncManager`, `EstateManager`, `SystemWatchdog`, `PIIDeSanitizer` |
| New test plan entries | 76 (TST-CORE-858 through TST-CORE-933) |
| Total scenarios | 933 (up from 857) |
| Traceability | 933/933 (100.0%) via `verify_tests.py` |
