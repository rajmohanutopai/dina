export * from './crypto';
export * from './auth/canonical';
export * from './auth/timestamp';
export { NonceCache } from './auth/nonce';
export { NonceReplayCache, DEFAULT_NONCE_TTL_MS } from './rpc/nonce_replay_cache';
export type { NonceReplayCacheOptions } from './rpc/nonce_replay_cache';
export { isAuthorized, getAuthorizationMatrix } from './auth/authz';
export type { CallerType } from './auth/authz';
export { PerDIDRateLimiter } from './auth/ratelimit';
export type { RateLimitConfig } from './auth/ratelimit';
export * from './identity/did';
export * from './identity/did_document';
export {
  buildCreationOperation,
  signOperation,
  dagCborEncode,
  derivePLCDID,
  createDIDPLC,
  resolveDIDPLC,
} from './identity/directory';
export type {
  PLCCreateParams,
  PLCCreateResult,
  PLCDirectoryConfig,
} from './identity/directory';
// Handle picker — Bluesky-style availability check + suggestion generator
// used by mobile + Lite + main-Dina onboarding to pick a clean alsoKnownAs
// handle instead of always appending a random hex suffix.
export {
  sanitizeHandlePrefix,
  validateHandleFormat,
  checkHandleAvailability,
  generateCandidates,
  pickHandle,
} from './identity/handle_picker';
export type {
  AvailabilityKind,
  AvailabilityResult,
  PickerOptions,
  PickHandleResult,
} from './identity/handle_picker';
// PLC namespace update composer (TN-IDENT-005 / TN-IDENT-008).
// Pure-functional composers — add a namespace key, or remove one.
// Submission to the PLC directory is the concern of TN-IDENT-006.
export {
  cidForOperation,
  namespaceFragment,
  composeNamespaceUpdate,
  composeAndSignNamespaceUpdate,
  composeNamespaceDisable,
  composeAndSignNamespaceDisable,
} from './identity/plc_namespace_update';
export type {
  ComposeNamespaceUpdateParams,
  ComposedNamespaceUpdate,
  ComposeAndSignNamespaceUpdateParams,
  SignedNamespaceUpdate,
  ComposeNamespaceDisableParams,
  ComposedNamespaceDisable,
  ComposeAndSignNamespaceDisableParams,
  SignedNamespaceDisable,
} from './identity/plc_namespace_update';
// PLC-op submission with retry + backoff (TN-IDENT-006). Pure-ish
// HTTP submitter — caller injects fetch/sleep for testability.
// Classifies failures: permanent (4xx) vs transient (5xx / network).
export {
  submitPlcOperation,
  computePLCBackoff,
  PLCSubmitError,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_BASE_MS,
} from './identity/plc_submit';
export type {
  SubmitPlcOperationParams,
  SubmitPlcOperationConfig,
  SubmitPlcOperationResult,
} from './identity/plc_submit';
// Namespace creation orchestrator (TN-IDENT-007). Wraps the four
// lower-level primitives (derive → compose → sign → submit) into a
// single tested call. Steps 6 (publish namespaceProfile) + 7 (poll
// AppView) of plan §3.5.3 are caller responsibility.
export {
  createNamespace,
  nextAvailableNamespaceIndex,
} from './identity/namespace_create_flow';
export type {
  CreateNamespaceFlowParams,
  CreateNamespaceFlowResult,
} from './identity/namespace_create_flow';
export type { DIDDocument, VerificationMethod, ServiceEndpoint } from './identity/did_document';
export * from './d2d/envelope';
export type { DinaMessage, D2DPayload } from './d2d/envelope';
export * from './d2d/families';
export * from './d2d/service_bodies';
export type {
  ServiceQueryBody,
  ServiceResponseBody,
  ServiceResponseStatus,
} from './d2d/service_bodies';
export * from './service/query_window';
export type { QueryWindowOptions } from './service/query_window';
export {
  providerWindow,
  requesterWindow,
  setProviderWindow,
  releaseProviderWindow,
  setRequesterWindow,
  startServiceWindowCleanup,
  stopServiceWindowCleanup,
  resetServiceWindows,
  DEFAULT_WINDOW_CLEANUP_INTERVAL_MS,
} from './service/windows';
export {
  ConfigEventChannel,
  configEventChannel,
  setConfigEventChannel,
  resetConfigEventChannel,
} from './service/config_event_channel';
export type {
  ConfigChangedEvent,
  ConfigEventListener,
  ConfigEventChannelOptions,
  ConfigEventKind,
} from './service/config_event_channel';
export { evaluateServiceEgressBypass, evaluateServiceIngressBypass } from './service/bypass';
export {
  AllowedOrigins,
  isAllowedOrigin,
  isTerminal,
  isValidTransition,
  ValidTransitions,
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
} from './workflow/domain';
export type { WorkflowTask, WorkflowEvent } from './workflow/domain';
export {
  WorkflowConflictError,
  SQLiteWorkflowRepository,
  InMemoryWorkflowRepository,
  setWorkflowRepository,
  getWorkflowRepository,
} from './workflow/repository';
export type { WorkflowRepository } from './workflow/repository';
export {
  WorkflowService,
  WorkflowValidationError,
  WorkflowTransitionError,
  setWorkflowService,
  getWorkflowService,
} from './workflow/service';
export type {
  WorkflowServiceOptions,
  CreateWorkflowTaskInput,
  ResponseBridgeSender,
  ServiceQueryBridgeContext,
} from './workflow/service';
export { makeServiceResponseBridgeSender } from './workflow/response_bridge_sender';
export type {
  ResponseBridgeD2DSender,
  MakeResponseBridgeSenderOptions,
} from './workflow/response_bridge_sender';
export { LeaseExpirySweeper } from './workflow/lease_expiry_sweeper';
export type {
  LeaseExpirySweeperOptions,
  LeaseExpirySweepResult,
} from './workflow/lease_expiry_sweeper';
export { TaskExpirySweeper } from './workflow/task_expiry_sweeper';
export type {
  TaskExpirySweeperOptions,
  TaskExpirySweepResult,
} from './workflow/task_expiry_sweeper';
export { LocalDelegationRunner } from './workflow/local_delegation_runner';
export type {
  LocalDelegationRunnerOptions,
  LocalCapabilityRunner,
} from './workflow/local_delegation_runner';
export {
  setServiceQuerySender,
  getServiceQuerySender,
  canonicalJSON as serviceQueryCanonicalJSON,
  computeIdempotencyKey as computeServiceQueryIdempotencyKey,
} from './server/routes/service_query';
export type { ServiceQuerySender } from './server/routes/service_query';
export { setServiceRespondSender, getServiceRespondSender } from './server/routes/service_respond';
export type { ServiceRespondSender } from './server/routes/service_respond';
export type {
  ServiceBypassDecision,
  BypassDenyReason,
  ProviderServiceResolver,
  LocalCapabilityChecker,
  RequesterWindowView,
} from './service/bypass';
export { AppViewServiceResolver } from './appview/service_resolver';
export type {
  AppViewServiceResolverOptions,
  IsDiscoverableResult,
} from './appview/service_resolver';
export {
  getServiceConfig,
  setServiceConfig,
  clearServiceConfig,
  hydrateServiceConfig,
  onServiceConfigChanged,
  isCapabilityConfigured,
  validateServiceConfig,
  resetServiceConfigState,
} from './service/service_config';
export type {
  ServiceConfig,
  ServiceCapabilityConfig,
  ServiceCapabilitySchemas,
  ServiceResponsePolicy,
  ConfigChangeListener,
} from './service/service_config';
export {
  setServiceConfigRepository,
  getServiceConfigRepository,
  SQLiteServiceConfigRepository,
  InMemoryServiceConfigRepository,
} from './service/service_config_repository';
export type { ServiceConfigRepository } from './service/service_config_repository';
export * from './d2d/gates';
export type { EgressCheckResult } from './d2d/gates';
export * from './d2d/signature';
export * from './pii/patterns';
// PIIScrubResult here is the HTTP-wire shape re-exported via the
// client block below — not the raw scrubber's per-entity result. The
// raw type (`ScrubResult`) is an internal detail consumers reach via
// direct imports; no alias on the public surface.
export type { PIIMatch } from './pii/patterns';
export { scrubTier1, rehydrate, scrubProcessRehydrate } from './pii/scrub';
export { evaluateIntent, isBrainDenied, getDefaultRiskLevel } from './gatekeeper/intent';
export type { RiskLevel as GatekeeperRiskLevel, IntentDecision } from './gatekeeper/intent';
export { checkSharingPolicy, getSharingTier, filterByTier } from './gatekeeper/sharing';
export type { SharingTier, SharingDecision } from './gatekeeper/sharing';
export * from './vault/lifecycle';
export * from './vault/tiered_content';
export type { TieredItem, TieredLoadConfig } from './vault/tiered_content';
export * from './vault/crud';
export * from './staging/state_machine';
export type { StagingStatus, StagingTransition } from './staging/state_machine';
// Staging service functions — exported at the root so apps (mobile,
// home-node-lite) can call `ingest()` etc. via `@dina/core` without
// deep-importing `@dina/core/src/staging/service`. Metro bundler has
// known issues caching the same file under different resolution paths
// (relative + `@`-prefixed) as SEPARATE module instances, which leaves
// the staging `inbox` Map split across copies and the drain tick sees
// an empty queue. Funnelling callers through the root import ensures
// one module instance.
export {
  ingest as stagingIngest,
  claim as stagingClaim,
  resolve as stagingResolve,
  resolveMulti as stagingResolveMulti,
  fail as stagingFail,
  extendLease as stagingExtendLease,
  getItem as stagingGetItem,
} from './staging/service';
export type { StagingItem } from './staging/service';
export * from './trust/levels';
export type { TrustLevel, TrustRing } from './trust/levels';
export * from './trust/source_trust';
export type {
  SenderTrust,
  Confidence,
  RetrievalPolicy,
  SourceTrustResult,
} from './trust/source_trust';
export * from './audit/hash_chain';
export type { AuditEntry as AuditHashEntry } from './audit/hash_chain';
export * from './export/archive';
export type { ArchiveHeader, ArchiveManifest } from './export/archive';
export { generateCLIKeypair, signCLIRequest, verifyCLIRequest } from './auth/cli_signing';
export type { CLIKeypair } from './auth/cli_signing';
export { canonicalize, signCanonical, verifyCanonical } from './identity/signing';
export {
  serializeDIDDocument,
  deserializeDIDDocument,
  verifyJsonRoundtrip,
} from './identity/did_models';
export * from './identity/keypair';
export type { IdentityKeypair } from './identity/keypair';
export * from './models/product_verdict';
export type { ProductVerdict, VerdictValue } from './models/product_verdict';
export * from './api/contract';
export type { APIErrorResponse, APIListResponse } from './api/contract';
export { CoreHTTPClient } from './brain_client/http';
export type { BrainClientConfig } from './brain_client/http';
export * from './task/queue';
export type { TaskRecord } from './task/queue';
export * from './pairing/ceremony';
export type { PairingCode, PairingResult } from './pairing/ceremony';
export * from './session/lifecycle';
export type { AgentSession, SessionGrant } from './session/lifecycle';
export * from './config/loading';
export type { CoreConfig } from './config/loading';
export * from './notify/priority';
export type { GuardianTier, NotificationPriority } from './notify/priority';
export * from './transport/outbox';
export type { OutboxEntry } from './transport/outbox';
export * from './transport/delivery';
export type { ServiceType, DeliveryResult } from './transport/delivery';
export * from './transport/adversarial';
export * from './ws/framing';
export type { WSMessageType, WSMessage } from './ws/framing';
export * from './onboarding/portable';
export type { OnboardingResult } from './onboarding/portable';
export * from './trust/pds_publish';
export type { Attestation, SignedAttestation } from './trust/pds_publish';
export * from './approval/pending_reason';
export type { PendingReasonRecord } from './approval/pending_reason';
export * from './schema/identity';
export * from './schema/persona';
export * from './cli/session';
export type { PIISessionData } from './cli/session';
export * from './cli/task';
export type { TaskValidation } from './cli/task';
export * from './cli/client';
export * from './sync/client';
export * from './background/timers';
export * from './relay/rpc_envelope';
export type { CoreRPCRequest, CoreRPCResponse } from './relay/rpc_envelope';
export * from './relay/rpc_response';
export * from './relay/identity_binding';
// msgbox_ws's isAuthenticated collides with sync/client's; disambiguate
// by renaming the relay one so both remain reachable from the package
// index without an ambiguous `export *` collision.
export {
  setIdentity as setMsgBoxIdentity,
  setWSFactory,
  connectToMsgBox,
  disconnect as disconnectMsgBox,
  isConnected as isMsgBoxConnected,
  isAuthenticated as isMsgBoxAuthenticated,
  sendEnvelope,
  completeHandshake,
  resetConnectionState as resetMsgBoxConnectionState,
  onD2DMessage,
  onRPCRequest,
  onRPCCancel,
  buildHandshakePayload,
  computeReconnectDelay,
  signHandshake,
  getIdentity as getMsgBoxIdentity,
} from './relay/msgbox_ws';
export type { MsgBoxEnvelope, EnvelopeHandler, WSFactory, WSLike } from './relay/msgbox_ws';
export * from './relay/msgbox_forward';
export type { ForwardHeaders } from './relay/msgbox_forward';
export * from './process/model';
export type { Platform } from './process/model';
export * from './lifecycle/sleep_wake';
export type { AppState } from './lifecycle/sleep_wake';
export * from './trust/network_search';
export * from './trust/cache';
export type { TrustScore } from './trust/cache';
export { TrustQueryClient } from './trust/query_client';
export type {
  TrustProfile,
  AttestationSummary,
  ReviewerStats,
  QueryConfig,
  QueryError,
  QueryResult,
  AttestationSearchParams,
  AttestationSearchHit,
  SearchResult,
} from './trust/query_client';
export * from './relay/msgbox_handlers';
export { bootstrapMsgBox } from './relay/msgbox_boot';
export type { MsgBoxBootConfig } from './relay/msgbox_boot';

// Storage port interfaces — surfaced so platform adapter packages
// (@dina/storage-node, @dina/storage-expo) can implement DatabaseAdapter
// and DBProvider without reaching into core's internal paths. Task 1.14.3a.
export { InMemoryDatabaseAdapter } from './storage/db_adapter';
export type { DatabaseAdapter, DBRow } from './storage/db_adapter';
export {
  setDBProvider,
  getDBProvider,
  resetDBProvider,
  getIdentityDB,
  getPersonaDB,
} from './storage/db_provider';
export type { DBProvider } from './storage/db_provider';

// Migration runner + canonical schemas — exported so platform adapter
// packages can run the real identity/persona schemas against their
// backends (task 3.17: @dina/core suite green with the storage-node
// backend uses these to exercise the full DDL under real SQLCipher).
export {
  applyMigrations,
  getCurrentVersion,
  listAppliedMigrations,
} from './storage/migration';
export type { Migration as CoreMigration } from './storage/migration';
export { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from './storage/schemas';

// Transport-agnostic Core client (Phase 1c task 1.28) — Brain imports
// only this interface; concrete transports (`InProcessTransport`,
// `HttpCoreTransport`) implement it and are injected at app-assembly
// time. Keeps Brain identical on server + mobile targets.
// ServiceConfig is already re-exported above (from service/service_config,
// which imports it from @dina/protocol). Don't duplicate it here — the
// client block just names the types the CoreClient interface introduces.
export type {
  CoreClient,
  CoreHealth,
  VaultQuery,
  VaultQueryResult,
  VaultItemInput,
  VaultStoreResult,
  VaultListOptions,
  VaultListResult,
  VaultDeleteResult,
  SignResult,
  CanonicalSignRequest,
  SignedHeaders,
  PIIScrubResult,
  PIIRehydrateResult,
  NotifyRequest,
  NotifyResult,
  NotifyPriority,
  PersonaTier,
  PersonaStatusResult,
  PersonaUnlockResult,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  MemoryToCOptions,
  MemoryToCResult,
  TocEntry,
  StagingClaimResult,
  StagingResolveRequest,
  StagingResolveResult,
  StagingFailResult,
  StagingExtendLeaseResult,
  MsgSendRequest,
  MsgSendResult,
  ScratchpadEntry,
  ScratchpadCheckpointResult,
  ScratchpadClearResult,
  ServiceRespondRequestBody,
  ServiceRespondResult,
  ListWorkflowEventsOptions,
  FailWorkflowEventOptions,
  ListWorkflowTasksFilter,
  CreateWorkflowTaskResult,
  MemoryTouchParams,
  MemoryTouchResult,
  UpdateContactParams,
  Contact,
} from './client/core-client';
// Relay / MsgBox RPC envelope helpers — used by the home-node-lite
// core-server's MsgBox client to seal/unseal CoreRPCRequest +
// CoreRPCResponse envelopes over the relay.
export {
  buildRPCRequest,
  sealRPCRequest,
  unsealRPCRequest,
  validateInnerAuth,
} from './relay/rpc_envelope';
export {
  buildResponseCanonical,
  buildSignedResponse,
  verifyResponseSignature,
  sealRPCResponse,
} from './relay/rpc_response';

export { InProcessTransport } from './client/in-process-transport';
export { HttpCoreTransport } from './client/http-transport';
// Working-memory / ToC primitives (WM-CORE-04..06). Exposed so
// apps/home-node-lite/core-server can register `GET /v1/memory/toc`
// against the service + assert EWMA math against the scoring helpers.
export {
  MemoryService,
  setMemoryService,
  getMemoryService,
} from './memory/service';
export type {
  MemoryServiceOptions,
  TopicRepositoryResolver,
  OpenPersonaLister,
} from './memory/service';
export {
  computeSalience,
  stemLite,
  isConsonant,
} from './memory/scoring';
export {
  isTopicKind,
  TOPIC_TAU_SHORT_DAYS,
  TOPIC_TAU_LONG_DAYS,
  TOPIC_SHORT_MIX,
} from './memory/domain';
export type { Topic, TopicKind, TopicAlias, TouchRequest } from './memory/domain';
export type { TopicRepository } from './memory/repository';
export {
  InMemoryTopicRepository,
  setTopicRepository,
  getTopicRepository,
  listTopicRepositoryPersonas,
  resetTopicRepositories,
} from './memory/repository';
// People graph — the identity-DB layer that records who Dina knows
// (humans, possibly bound to a contact DID, possibly with multiple
// surface forms). The repository handles writes (extraction +
// confirm/reject + GC); the resolver provides read-side lookups for
// the reminder planner, D2D speaker naming, and recall expansion.
export type {
  Person,
  PersonSurface,
  PersonStatus,
  SurfaceStatus,
  SurfaceConfidence,
  SurfaceType,
  CreatedFrom,
  ExtractionResult,
  ExtractionPersonLink,
  ExtractionSurfaceEntry,
  ApplyExtractionResponse,
} from './people/domain';
export {
  PERSON_STATUS_SUGGESTED,
  PERSON_STATUS_CONFIRMED,
  PERSON_STATUS_REJECTED,
  SURFACE_STATUS_SUGGESTED,
  SURFACE_STATUS_CONFIRMED,
  SURFACE_STATUS_REJECTED,
  VALID_SURFACE_TYPES,
  VALID_SURFACE_CONFIDENCE,
  VALID_CREATED_FROM,
} from './people/domain';
export type { PeopleRepository } from './people/repository';
export {
  SQLitePeopleRepository,
  computeExtractionFingerprint,
  setPeopleRepository,
  getPeopleRepository,
} from './people/repository';
export type { PersonResolver, ResolvedPerson } from './people/resolver';
export { RepositoryPersonResolver } from './people/resolver';
// Parity contract — runnable Jest suite that pins the behaviors any
// `PeopleRepository` implementation must honor to stay in lockstep
// with main Dina's Go `SQLitePersonStore`. New implementations
// (Go-import, future Rust/Swift ports) plug in their own factory
// and re-run the same checks.
export type { PersonStoreContractHarness } from './people/contract';
export { runPersonStoreContract } from './people/contract';
// `CoreRouter` is the server-side counterpart apps wire up to host the
// Core HTTP surface in-process (used by `InProcessTransport`). Exporting
// here keeps `apps/home-node-lite/*` from having to reach into
// `./server/router` subpaths.
export { CoreRouter } from './server/router';
export type { CoreRequest, CoreResponse, CoreHandler, RouteRegistration, AuthMode } from './server/router';
export type {
  HttpClient,
  HttpRequestInit,
  HttpResponse,
  CanonicalRequestSigner,
  HttpCoreTransportOptions,
} from './client/http-transport';
