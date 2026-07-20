export * from './crypto';
// Platform-safe fetch accessor — bind it to globalThis so the
// browser's WebIDL fetch (which checks `this === Window`) works when
// the reference is captured into a class field or module-level let.
export { defaultFetch } from './runtime/fetch';
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
// Key-rotation lifecycle helpers — gen-aware signing keys + history
// for verification of older messages. Exposed so integration tests
// (and future operator UI) can drive a rotation cycle and inspect
// the generation counter.
export {
  initializeRotation,
  rotateKey,
  getCurrentGeneration,
  getCurrentPublicKey,
  getAllVerificationKeys,
  getKeyHistory,
  signWithCurrentKey,
  verifyWithAnyKey,
  resetRotationState,
} from './identity/rotation';
export type { KeyGeneration } from './identity/rotation';
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
  maxPrefixChars,
  MAX_HANDLE_CHARS,
} from './identity/handle_picker';
export type {
  AvailabilityKind,
  AvailabilityResult,
  PickerOptions,
  PickHandleResult,
} from './identity/handle_picker';
// Generic PLC update composer — add/replace verificationMethods,
// services, rotationKeys, alsoKnownAs in one ceremony. Used by mobile
// onboarding (PDS-first flow → PDS mints DID → update adds
// `dina_signing` VM + `dina-messaging` service) and by the admin CLI.
export {
  buildUpdateOperation,
  updateDIDPLC,
  buildSigningKeyRotation,
  secp256k1ToDidKeyMultibase,
} from './identity/plc_update';
export type {
  PLCUpdateParams,
  PLCUpdateResult,
  SigningKeyRotationParams,
} from './identity/plc_update';
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
  ALLOWED_TRANSITIONS,
  canTransition,
  ACTIVE_STATUSES,
  OUTBOX_STATUSES,
  LIVE_STATUSES,
  MAX_PUBLISH_QUEUE,
  MAX_PUBLISH_ATTEMPTS,
  PUBLISH_CLAIM_LEASE_MS,
  publishBackoffMs,
} from './review/publish_job';
export type {
  PublishJob,
  PublishJobStatus,
  PublishErrorCode,
  ClassifiedError,
  NewPublishJob,
} from './review/publish_job';
export {
  SQLiteReviewPublishRepository,
  InMemoryReviewPublishRepository,
  setReviewPublishRepository,
  getReviewPublishRepository,
  subscribeReviewPublishRegistry,
  rowToPublishJob,
} from './review/publish_job_repository';
export type { ReviewPublishRepository } from './review/publish_job_repository';
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
// Interactive runs (INTERACTIVE_SERVICES_ARCHITECTURE.md §5/§12.5)
export {
  RunState,
  RunTransport,
  DrainCause,
  DrainStrength,
  MaxCountBasis,
  PriorityCeiling,
  OnStop,
  ErasureMode,
  RunValidationError,
  isRunTerminal,
  decideBarrier,
  strengthOfCause,
  terminalStateForCause,
  MAX_QUEUE_CAP,
  DEFAULT_QUEUE_CAP,
} from './run/domain';
export type { RunRecord, CreateRunParams, BarrierState, BarrierDecision } from './run/domain';
export {
  SQLiteRunRepository,
  InMemoryRunRepository,
  RunConflictError,
  setRunRepository,
  getRunRepository,
} from './run/repository';
export type { RunRepository, RunConfigPatch } from './run/repository';
export {
  RunService,
  RunNotFoundError,
  setRunService,
  getRunService,
} from './run/service';
export type { RunServiceOptions, RunCommandResult } from './run/service';
export {
  SQLiteErasureKeyStore,
  InMemoryErasureKeyStore,
  setErasureKeyStore,
  getErasureKeyStore,
  probeErasureMode,
} from './run/erasure_store';
export type { ErasureKeyStore } from './run/erasure_store';
export { PayloadStore } from './run/payload_store';
export type {
  PayloadRef,
  PayloadStoreOptions,
  PersonaCipher,
  PutPayloadInput,
  BlobState,
} from './run/payload_store';
export {
  SQLiteReservationRepository,
  InMemoryReservationRepository,
  OPEN_RESERVATION_STATES,
  setReservationRepository,
  getReservationRepository,
} from './run/reservation';
export type {
  ReservationRecord,
  ReservationRepository,
  ReservationState,
  CommitReservationInput,
} from './run/reservation';
export { AdmissionService } from './run/admission';
export type {
  AdmissionServiceOptions,
  AdmissionCounts,
  ReserveResult,
  ReserveRejection,
  CommitResult,
} from './run/admission';
export {
  SQLiteMessageRepository,
  InMemoryMessageRepository,
  MESSAGE_TERMINAL_STATES,
  ENQUEUED_UNDECIDED_STATES,
  FENCEABLE_STATES,
  isValidMessageTransition,
  isMessageTerminal,
  setMessageRepository,
  getMessageRepository,
} from './run/message';
export type {
  MessageRecord,
  MessageRepository,
  MessageState,
  MessageKind,
  MessageDecision,
  TierSource,
} from './run/message';
export { computeFinalTier, ceilingRank } from './run/delivery';
export type { PriorityTier, ComputeTierInput, ComputeTierResult } from './run/delivery';
export {
  SQLiteClassificationJobRepository,
  InMemoryClassificationJobRepository,
  RunClassifyService,
  setClassificationJobRepository,
  getClassificationJobRepository,
} from './run/classification';
export type {
  ClassificationJobRecord,
  ClassificationJobRepository,
  ClassificationJobState,
  ClassificationView,
  WorkerAcquireResult,
  RunClassifyServiceOptions,
} from './run/classification';
export { RunDispatchService, deriveDelegationId } from './run/dispatch';
export type {
  RunDispatchServiceOptions,
  RiskClass,
  RiskOutcome,
  ClaimOutcome,
} from './run/dispatch';
export {
  SQLiteCompletionReceiptRepository,
  InMemoryCompletionReceiptRepository,
  CompletionService,
  setCompletionReceiptRepository,
  getCompletionReceiptRepository,
} from './run/completion';
export type {
  CompletionReceiptRecord,
  CompletionReceiptRepository,
  CompletionStatus,
  ReceiptState,
  IngestCompletionInput,
  IngestOutcome,
  CompletionServiceOptions,
} from './run/completion';
export {
  LockedArrivalStore,
  InMemoryRunSpool,
  SQLiteRunSpool,
  NaclDeviceSealer,
} from './run/locked_arrival';
export type {
  RunSpool,
  DeviceSealer,
  SealedResponseRef,
  PublishOutcome,
  RecoverOutcome,
  LockedArrivalStoreOptions,
} from './run/locked_arrival';
export { HeldReplayService, parseSealedRef } from './run/held_replay';
export type { HeldReplayOptions, HeldReplayReport } from './run/held_replay';
export { fireHeldReplay, setHeldReplayHook } from './run/replay_registry';
export { RunTerminationService, RunSweeper } from './run/termination';
export type {
  RunTerminationServiceOptions,
  ForceTerminateResult,
  RunSweeperOptions,
  RunSweepReport,
} from './run/termination';
// Interactive-run active-engine driver (INTERACTIVE_SERVICES §7/§8/§11 — ISVC-10).
export { RunEngine } from './run/engine';
export type {
  RunEngineOptions,
  EmitQueryEffect,
  EmitDelegationEffect,
  PacerReport,
  DispatchReport,
  EngineTickReport,
} from './run/engine';
export { RunResponseIngest } from './run/ingest';
export type {
  RunResponseIngestOptions,
  VerifiedRunMessage,
  PullIngestOutcome,
} from './run/ingest';
// ISVC-10 — the composition that turns the drivers into a live loop (both boots).
export { wireRunPlane } from './run/plane';
export type { RunPlane, RunPlaneDeps } from './run/plane';
// ISVC-10 — the run-response trust boundary (§6.2): verify a provider's signed
// RunMessage before its content enters the lifecycle.
export { verifyRunMessage } from './run/verify';
export type {
  SignedRunMessageWire,
  ExpectedRunBinding,
  ResolveRuntimeKey,
  VerifyRunMessageResult,
} from './run/verify';
// ISVC-10 — the boot assembly that makes the pull loop run (both boots): egress
// effects + PersonaCipher + the run plane + the D2D receive hook.
export { wireRunPlaneNode } from './run/plane_node';
export type { RunPlaneNode, RunPlaneNodeDeps, SendD2D } from './run/plane_node';
// Push services (PUSH_SERVICES_ARCHITECTURE.md §6/§8/§9)
export {
  classifyPushTier,
  priorityToTier,
  overBudgetDisposition,
  cryWolfFloor,
  decidePushDelivery,
} from './push/delivery';
export type {
  PushTier,
  ClaimedPriority,
  ClassifyPushInput,
  PushEventKind,
  OverBudgetDisposition,
  PushPipelineInput,
  PushDeliveryDecision,
} from './push/delivery';
export {
  SQLitePushSubscriptionRepository,
  InMemoryPushSubscriptionRepository,
  setPushSubscriptionRepository,
  getPushSubscriptionRepository,
} from './push/subscription';
export type {
  PushSubscriptionRecord,
  PushSubscriptionRepository,
  PushCeiling,
  PushFulfilment,
} from './push/subscription';
export {
  SQLiteCommandReceiptRepository,
  InMemoryCommandReceiptRepository,
  setCommandReceiptRepository,
  getCommandReceiptRepository,
  setCommandTxRunner,
  recordOrReplayCommand,
  commandReceiptKey,
  hashRequest,
} from './run/command_receipt';
export type {
  CommandReceiptRecord,
  CommandReceiptRepository,
  RecordOrReplayInput,
  RecordOrReplayResult,
} from './run/command_receipt';
// Poll-mode watches (PSVC-0)
export {
  parseWatchPollPayload,
  serializeWatchPollPayload,
  MIN_POLL_INTERVAL_SEC,
} from './watch/payload';
export type { WatchPollPayload } from './watch/payload';
export { classifyWatchFilter, parseWatchFilter, watchFilterMatches } from './watch/filter';
export type { WatchFilter } from './watch/filter';
export { WatchService, setWatchService, getWatchService, watchIdempotencyKey } from './watch/service';
export type { WatchServiceOptions, CreatePollWatchInput } from './watch/service';
export { WatchPollSweeper } from './watch/poll_sweeper';
export type {
  WatchPollSweeperOptions,
  WatchPollSweepResult,
  WatchPollHandler,
} from './watch/poll_sweeper';
export {
  buildWatchPollHandler,
  watchPollToServiceQuery,
  newWatchQueryId,
} from './watch/poll_query';
export type { BuildWatchPollHandlerOptions } from './watch/poll_query';
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
// Session-scoped approvals (in-memory, process-lifetime). The persona_guard
// (in @dina/brain) consults `isVaultReadSessionApproved` before minting a
// fresh workflow task so a vault_read_request granted scope='session' on
// approve unlocks subsequent `dina ask` calls for the same (agent, persona)
// pair until DEFAULT_TTL_SEC (~30 min) elapses.
export {
  grantSessionApproval,
  grantVaultReadSessionApproval,
  isVaultReadSessionApproved,
  resetSessionApprovals,
} from './server/routes/intent';
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
  listServiceConfigs,
  setServiceConfig,
  setServiceConfigDurable,
  clearServiceConfig,
  hydrateServiceConfig,
  onServiceConfigChanged,
  isCapabilityConfigured,
  validateServiceConfig,
  resetServiceConfigState,
  DEFAULT_LISTING_RKEY,
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
export { checkSharingPolicy, filterByTier, getSharingTier, setSharingPolicy } from './gatekeeper/sharing';
export type { SharingTier, SharingDecision } from './gatekeeper/sharing';
// Pure-value constants (durations, sizes, multicodec prefixes,
// network defaults). Originally only the onboarding subset was
// re-exported; expanded explicitly for CA-29 (Brain → Core boundary)
// so Brain can drop deep imports of `core/src/constants`.
//
// `ARGON2ID_PARAMS` is intentionally NOT re-exported here — there are
// two distinct constants by that name (`./constants` and
// `./crypto/argon2id`) with different shapes. `./crypto` (already
// re-exported above) wins; consumers needing the constants-style
// `{memory, iterations, parallelism}` shape import directly from
// `@dina/core/src/constants` (package-internal only) or build the
// shape themselves.
export {
  MS_SECOND,
  MS_MINUTE,
  MS_HOUR,
  MS_DAY,
  MS_WEEK,
  ED25519_SEED_BYTES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  NACL_EPHEMERAL_KEY_BYTES,
  NACL_NONCE_BYTES,
  NACL_TAG_BYTES,
  RANDOM_ID_BYTES,
  RANDOM_NONCE_BYTES,
  BIP39_SEED_BYTES,
  ED25519_MULTICODEC,
  SECP256K1_MULTICODEC,
  HARDENED_OFFSET,
  DINA_FILE_MAGIC,
  DINA_FILE_VERSION,
  CORE_DEFAULT_PORT,
  BRAIN_DEFAULT_PORT,
  DEFAULT_CORE_URL,
  DEFAULT_BRAIN_URL,
  DEFAULT_PLC_DIRECTORY,
  DEFAULT_APPVIEW_URL,
  TIMESTAMP_WINDOW_S,
  REQUEST_TIMEOUT_MS,
  MAX_BODY_SIZE_BYTES,
  NONCE_WINDOW_MS,
  BIOMETRIC_MAX_FAILURES,
  HEALTH_CHECK_TIMEOUT_MS,
  UNHEALTHY_THRESHOLD,
  STAGING_LEASE_DURATION_S,
  STAGING_ITEM_TTL_S,
  STAGING_MAX_RETRIES,
  STAGING_CLAIM_DEFAULT,
  STAGING_CLAIM_MAX,
  VAULT_QUERY_DEFAULT_LIMIT,
  VAULT_QUERY_MAX_LIMIT,
  VAULT_BATCH_MAX,
  HYBRID_FTS_WEIGHT,
  HYBRID_SEMANTIC_WEIGHT,
  TRUST_RERANK_CAVEATED,
  TRUST_RERANK_TRUSTED,
  TRUST_RERANK_LOW_CONFIDENCE,
  DEFAULT_EMBEDDING_DIMENSIONS,
  HNSW_DEFAULT_M,
  HNSW_DEFAULT_EF_CONSTRUCTION,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_ALPHABET,
  PAIRING_SECRET_BYTES,
  PAIRING_CODE_TTL_S,
  PAIRING_MAX_PENDING,
  WS_HUB_BUFFER_SIZE,
  WS_HUB_BUFFER_TTL_MS,
  OUTBOX_MAX_BACKOFF_MS,
  OUTBOX_INITIAL_BACKOFF_MS,
  DID_CACHE_TTL_MS,
  QUARANTINE_TTL_MS,
  TRUST_CACHE_TTL_MS,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MNEMONIC_DISPLAY_TTL_MS,
  ONBOARDING_VERIFY_WORD_COUNT,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_MAX_LENGTH,
  SYSTEM_MESSAGE_HISTORY_MAX,
  MSGBOX_HANDSHAKE_PREFIX,
  MSGBOX_WS_SUFFIX,
  MSGBOX_FORWARD_SUFFIX,
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
} from './constants';

// Error classes thrown across the Core/Brain boundary. Kept narrow on
// purpose — only the discriminator-named errors that consumers may
// `instanceof`-check or rethrow.
export {
  DinaError,
  PersonaLockedError,
  AuthorizationError,
  ApprovalRequiredError,
  CoreUnreachableError,
  LLMError,
  ConfigError,
  PIIScrubError,
  CloudConsentError,
  MCPError,
  NotFoundError,
} from './errors';

// Vault item type validation — VAULT_ITEM_TYPES, isVaultItemType,
// SenderTrust, etc. Brain consumes these to validate staging output.
export * from './vault/validation';

// Chat message repository. Brain's chat thread reads and writes
// through the shared repository contract.
export {
  setChatMessageRepository,
  getChatMessageRepository,
  SQLiteChatMessageRepository,
  InMemoryChatMessageRepository,
} from './chat/repository';
export type { StoredChatMessage, ChatMessageRepository } from './chat/repository';

// Notification log repository. Brain's notification inbox is a thin
// wrapper around this.
export {
  setNotificationLogRepository,
  getNotificationLogRepository,
  InMemoryNotificationLogRepository,
  SqliteNotificationLogRepository,
  storedNotificationToWire,
  wireToStoredNotification,
} from './notifications/repository';
export type {
  NotificationKind,
  StoredNotificationItem,
  NotificationLogRepository,
  NotificationWireDTO,
} from './notifications/repository';

// Scratchpad service — checkpoint/resume/clear/sweep API the Brain
// scratchpad lifecycle uses.
export {
  SCRATCHPAD_STALE_MS,
  DELETE_SENTINEL_STEP,
  checkpoint,
  resume,
  clear as clearScratchpad,
  sweepStale as sweepStaleScratchpads,
  resetScratchpadService,
} from './scratchpad/service';

// Staging heartbeat — Brain's batch processor extends per-item leases
// to keep claims alive while it works.
export {
  startHeartbeat,
  stopHeartbeat,
  beatOnce,
  activeHeartbeatCount,
  stopAllHeartbeats,
} from './staging/heartbeat';
export type { Heartbeat } from './staging/heartbeat';

// HTTP retry primitives shared with the AppView client + future Brain
// HTTP retry sites.
export {
  NON_RETRYABLE_STATUSES,
  BASE_RETRY_DELAY_MS,
  computeRetryDelay,
  backoff as httpBackoff,
  isRetryableStatus,
  isNonRetryableStatus,
  parseResponseBody,
} from './transport/http_retry';

// Vault repository contract + concrete adapters. Tests use the
// in-memory adapter for fixture setup; production wires the SQLite
// adapter through the storage boundary.
export {
  setVaultRepository,
  getVaultRepository,
  resetVaultRepositories,
  SQLiteVaultRepository,
  InMemoryVaultRepository,
} from './vault/repository';
export type { VaultRepository } from './vault/repository';

// Auth middleware — request authentication, public-key resolver
// registration, rate limiter configuration. Used by tests building
// real Core servers and by Brain consumers that need to verify
// inbound requests.
export {
  registerPublicKeyResolver,
  getNonceCache,
  getRateLimiter,
  configureRateLimiter,
  authenticateRequest,
  resetMiddlewareState,
} from './auth/middleware';
export type { AuthRequest, AuthResult } from './auth/middleware';

// D2D receive pipeline — the trust+verify+stage pipeline run by
// inbound D2D handlers. Tests exercise this directly to assert
// staging/quarantine actions for various sender trust levels.
export type { QuarantinedMessage } from './d2d/quarantine';
// `quarantineMessage` is exported for the debug-only test seed (§8 backstage
// precondition — stage "an unknown sender messaged you" without a stranger
// node); production quarantine goes through the receive pipeline.
export { quarantineMessage } from './d2d/quarantine';
export { receiveD2D } from './d2d/receive_pipeline';
export type {
  ReceivePipelineAction,
  ReceivePipelineResult,
  ReceivePipelineOptions,
} from './d2d/receive_pipeline';

// Contact Services — `ask_to_enable` grant-request event surface. Core decides
// reach (closeness); the owner's yes is surfaced + issued on the phone.
export {
  onGrantRequestPending,
  emitGrantRequestPending,
  resetGrantRequestPendingListeners,
} from './d2d/grant_request_events';
export type {
  GrantRequestPendingEvent,
  GrantRequestPendingListener,
} from './d2d/grant_request_events';

// Contact Services — inbound `service.offer` surface. Lets the mobile boot
// auto-replay a first-run request the instant the grant lands (no double-ask).
export {
  onServiceOfferReceived,
  emitServiceOfferReceived,
  resetServiceOfferReceivedListeners,
} from './d2d/service_offer_events';
export type {
  ServiceOfferReceivedEvent,
  ServiceOfferReceivedListener,
} from './d2d/service_offer_events';

// Wrapped-seed binary format — portable encode/decode pair used by
// onboarding flows and seed-file fixtures. The Node-only file
// adapters (`writeWrappedSeed`/`readWrappedSeed`) live behind
// `@dina/core/node`.
export { serializeWrappedSeed, deserializeWrappedSeed } from './storage/seed_file';

// Unlock lifecycle — full-unlock entry point used by onboarding tests
// and the in-process boot path.
export { fullUnlock } from './lifecycle/unlock';
export type { UnlockInput, UnlockResult } from './lifecycle/unlock';

// Health diagnostics — runHealthCheck assembles the live HealthReport
// for `/v1/healthz`.
export { runHealthCheck } from './diagnostics/health';
export type { HealthReport } from './diagnostics/health';

// Staging service additional inbox helpers.
export { inboxSize, sweep as stagingSweep, sweep } from './staging/service';

// Staging repository contract + in-memory adapter for tests.
export {
  setStagingRepository,
  getStagingRepository,
  InMemoryStagingRepository,
} from './staging/repository';
export type { StagingRepository } from './staging/repository';

// Caller-type registry — service DID → caller type mapping used by
// auth middleware and tests that register synthetic services.
export {
  registerService,
  resetCallerTypeState,
} from './auth/caller_type';

// LRU dedup set — staging pipeline uses this to drop duplicate
// inbound items by `(source, itemId)`.
export {
  isDuplicate,
  markSeen,
  resetDedupState,
} from './sync/dedup';
export {
  addContact,
  addContactIfNotExists,
  addAlias,
  deleteContact,
  findByAlias,
  findByPreferredFor,
  getContact,
  getContactsByTrust,
  getTrustLevel,
  hydrateContactDirectory,
  rebuildContactProjections,
  establishContact,
  removeContact,
  mergeContactPersons,
  isContact,
  listContacts,
  removeAlias,
  resetContactDirectory,
  resolveByName,
  updateContact,
} from './contacts/directory';
export type { Relationship, DataResponsibility } from './contacts/directory';
export { closeness } from './contacts/closeness';
export type { Closeness } from './contacts/closeness';
export {
  closePersona,
  createPersona,
  deletePersona,
  getPersona,
  getPersonaTier,
  hydratePersonas,
  isPersonaOpen,
  listPersonas,
  openBootPersonas,
  openPersona,
  personaExists,
  resetPersonaState,
  setPersonaDescription,
  validatePersonaName,
} from './persona/service';
export type { PersonaState } from './persona/service';
// Provider-derived DEK registration (ISVC-10/R5-01): the DB providers derive
// the SQLCipher key themselves, and must register it here so the run plane's
// persona-open predicate (`hasDEK`) and payload cipher (`wrapWithPersonaDEK`)
// see the vault as open.
export { hasDEK, registerPersonaDEK, releasePersonaDEK } from './persona/orchestrator';
export {
  SQLitePersonaRepository,
  getPersonaRepository,
  setPersonaRepository,
} from './persona/repository';
export type { PersonaRepository, StoredPersona } from './persona/repository';
export { DATA_CATEGORIES } from './persona/names';
export type { DataCategory } from './persona/names';
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
// Staging service: prefixed names (`stagingX`) are the canonical
// public surface — production code should use those. Bare names are
// re-exported alongside for tests that exercised the staging service
// through deep imports before CA-29; they alias the same source
// functions, so importing either form yields the same module
// instance (no Metro split-singleton risk). `getItem` is intentionally
// only available as `stagingGetItem` because the bare name collides
// with `vault/crud.getItem`.
export {
  ingest,
  ingest as stagingIngest,
  claim,
  claim as stagingClaim,
  resolve as stagingResolve,
  resolveMulti as stagingResolveMulti,
  fail as stagingFail,
  extendLease,
  extendLease as stagingExtendLease,
  getItem as stagingGetItem,
  drainForPersona,
  drainForPersona as stagingDrainForPersona,
  listByStatus,
  listByStatus as stagingListByStatus,
  resetStagingState,
} from './staging/service';
// `resolve` is a notorious name (Promise.resolve, jest's
// expect.resolves, fs.resolve, path.resolve) — keep it isolated to
// `stagingResolve`. Same for `fail` (jest's `fail()`).
export type { StagingItem } from './staging/service';
export * from './peerlens/levels';
export type { TrustLevel, TrustRing } from './peerlens/levels';
export * from './peerlens/source_trust';
export type {
  SenderTrust,
  Confidence,
  RetrievalPolicy,
  SourceTrustResult,
} from './peerlens/source_trust';
export * from './audit/hash_chain';
export type { AuditEntry as AuditHashEntry } from './audit/hash_chain';
export * from './export/archive';
export type {
  ArchiveHeaderV1,
  ArchiveManifest,
  ArchivePayloadV1,
  ArchivePersonaV1,
  ArchiveDataSource,
  ArchivePersonaSource,
  ImportArchiveOptions,
} from './export/archive';
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
export * from './transport/outbox_repository';
export type {
  D2DOutboxRepository,
  D2DOutboxRow,
  D2DOutboxState,
  D2DOutboxInsert,
} from './transport/outbox_repository';
export * from './transport/retry';
export type {
  OutboxRedeliverFn,
  RedeliverOutcome,
  DrainResult,
  DrainerHandle,
} from './transport/retry';
// issues.txt §2 — durable agent persona grants + deterministic access gate.
export * from './agent/grant_repository';
export type {
  AgentGrantRepository,
  AgentPersonaGrant,
  AgentPersonaGrantInsert,
  GrantMode,
} from './agent/grant_repository';
export * from './agent/access';
export type {
  AgentAccessDecision,
  RequireAgentPersonaAccessParams,
  AgentPersonaAccessApprovalPayload,
} from './agent/access';
export * from './transport/delivery';
export type { DeliveryResult } from './transport/delivery';
export * from './transport/adversarial';
export * from './ws/framing';
export type { WSMessageType, WSMessage } from './ws/framing';
export * from './onboarding/portable';
export type { OnboardingResult } from './onboarding/portable';
export * from './peerlens/pds_publish';
export type { Attestation, SignedAttestation } from './peerlens/pds_publish';
export * from './approval/pending_reason';
export type { PendingReasonRecord } from './approval/pending_reason';
export {
  ApprovalManager,
  getApprovalManager,
  resetApprovalManager,
} from './approval/manager';
export type {
  ApprovalRequest,
  ApprovalRequestListener,
} from './approval/manager';
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
  wakeRelay,
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
export * from './peerlens/network_search';
export * from './peerlens/cache';
export type { TrustScore } from './peerlens/cache';
export { PeerlensQueryClient } from './peerlens/query_client';
export type {
  PeerlensProfile,
  AttestationSummary,
  ReviewerStats,
  QueryConfig,
  QueryError,
  QueryResult,
  AttestationSearchParams,
  AttestationSearchHit,
  SearchResult,
} from './peerlens/query_client';
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
  VaultQueryItem,
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
  ServiceListing,
  ServiceOfferView,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  MemoryToCOptions,
  MemoryToCResult,
  TocEntry,
  StagingIngestRequest,
  StagingIngestResult,
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
  ActionPolicyEntry,
  ActionPolicyResult,
  RiskLevel,
  PersonaListEntry,
  Reminder,
  RecurringFrequency,
  ReminderCreateInput,
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
export { HttpCoreTransport, CoreHttpError } from './client/http-transport';
// NOTE: no owner-client singleton getter/setter is exported (R2-08) — the
// instance is held at the app edge so Brain cannot acquire an owner-stamping
// dispatcher. Only the class (which needs the raw router to construct) is public.
export { InProcessOwnerRunClient, OwnerRunHttpError } from './client/owner-run-client';
export type {
  OwnerRunClient,
  RunStartRequest,
  RunStartResult,
  RunUpdateRequest,
  RunDecideRequest,
} from './client/owner-run-client';
export { registerWatchRoutes } from './server/routes/watch';
export { watchTaskToListItem } from './watch/list';
export type { WatchListItem } from './watch/list';
export { runToListItem } from './run/list';
export type { RunListItem } from './run/list';
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
  PersonIdentity,
  IdentityType,
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
export { createCoreRouter, HEALTHZ_PATH } from './server/core_server';
export type { CoreRouterOptions } from './server/core_server';
export type {
  HttpClient,
  HttpRequestInit,
  HttpResponse,
  CanonicalRequestSigner,
  HttpCoreTransportOptions,
} from './client/http-transport';
export { FEATURE_NAMES, type FeatureKey, type FeatureName } from './feature-names';
export {
  USER_SCOPE,
  currentDataScope,
  setCurrentDataScope,
  isGuidedDemoScope,
  isValidDataScope,
  newGuidedDemoScope,
  runInDataScope,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
  type DataScope,
} from './scope/data_scope';
export {
  ACTIVE_DEMO_KEY,
  getActiveDemo,
  setActiveDemo,
  updateActiveDemoStep,
  clearActiveDemo,
  hasActiveDemo,
  type ActiveDemoState,
} from './scope/active_demo';
export {
  deleteDataScope,
  registerScopedCleanup,
  clearScopedCleanups,
  registeredCleanupTables,
  type DeleteDataScopeResult,
  type ScopedCleanup,
} from './scope/cleanup';
export {
  DATA_SCOPE_COLUMN,
  scopedInsertFields,
  scopedWhere,
  scopedParams,
  scopedTableDeleter,
} from './scope/repository';
export {
  wireIdentityScopeCleanups,
  wirePersonaScopeCleanups,
  tearDownDataScope,
} from './scope/cleanup_wiring';
export {
  DEMO_FIRST_STEP,
  startGuidedDemo,
  startEmpty,
  pendingGuidedDemo,
  resumeGuidedDemo,
  markGuidedDemoStep,
  endGuidedDemo,
  hasSeenGuidedDemoEntry,
  markGuidedDemoEntrySeen,
} from './scope/guided_demo';

// Plugin substrate (docs/PLUGIN_ARCHITECTURE.md): dynamic registry,
// grants (constraints + per-execution consumption), decision log.
export * from './plugins';
