export {
  registerService,
  registerDevice,
  setDeviceRoleResolver,
  setDeviceScopeResolver,
  resetCallerTypeState,
} from './src/auth/caller_type';
export { revokeReasoningAuthorityForPrincipal } from './src/reasoning/authority_revocation';
export {
  hydrateDeviceRegistry,
  getDeviceByDID,
  revokeDeviceByDidDurable,
} from './src/devices/registry';
export {
  configureRateLimiter,
  registerPublicKeyResolver,
  resetMiddlewareState,
} from './src/auth/middleware';
export type { CoreClient, ServiceConfig } from './src/client/core-client';
export { InProcessTransport } from './src/client/in-process-transport';
export type { DinaMessage } from './src/d2d/envelope';
export {
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypeSafetyAlert,
  MsgTypeSocialUpdate,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
} from './src/d2d/families';
export { DIDResolver } from './src/d2d/resolver';
export { sendD2D } from './src/d2d/send';
export type { ServiceQueryBody, ServiceResponseBody } from './src/d2d/service_bodies';
export {
  onGrantRequestPending,
  resetGrantRequestPendingListeners,
} from './src/d2d/grant_request_events';
export type { GrantRequestPendingEvent } from './src/d2d/grant_request_events';
export {
  onServiceOfferReceived,
  resetServiceOfferReceivedListeners,
} from './src/d2d/service_offer_events';
export type { ServiceOfferReceivedEvent } from './src/d2d/service_offer_events';
export { getTopicRepository, listTopicRepositoryPersonas } from './src/memory/repository';
export { MemoryService, setMemoryService } from './src/memory/service';
export { getNodeDID, setNodeDID } from './src/pairing/ceremony';
export { bootstrapMsgBox } from './src/relay/msgbox_boot';
export type { MsgBoxBootConfig } from './src/relay/msgbox_boot';
export {
  disconnect as disconnectMsgBox,
  isAuthenticated as isMsgBoxAuthenticated,
  onAuthenticated as onMsgBoxAuthenticated,
} from './src/relay/msgbox_ws';
export type { WSFactory } from './src/relay/msgbox_ws';
export { createCoreRouter, setAskRouteHandler } from './src/server/core_server';
export {
  createConnectedBrainAgentFacades,
  prepareConnectedBrainContext,
  prepareOwnerReasoningContext,
  prepareServiceReasoningContext,
  persistConnectedBrainMemoryProposal,
} from './src/agent/connected_brain_facades';
export { createReasoningCommitBridge } from './src/reasoning/commit_bridge';
export { getSessionRegistry } from './src/session/registry';
export {
  createReasoningPolicySnapshotResolver,
  createServiceReasoningCommitter,
  createServiceReasoningSubmitter,
} from './src/reasoning/service_execution';
export { ReasoningBackendWorker } from './src/reasoning/backend_worker';
export type {
  ReasoningBackendExecutor,
  ReasoningBackendWorkerOptions,
  ReasoningExecutionProposal,
  ReasoningWorkerResult,
} from './src/reasoning/backend_worker';
export type { AskRouteHandler } from './src/server/core_server';
export { createInProcessDispatch } from './src/server/in_process_dispatch';
export { setD2DSender } from './src/server/routes/d2d_msg';
export { setServiceQuerySender } from './src/server/routes/service_query';
export { setServiceRespondSender } from './src/server/routes/service_respond';
export type { CoreRouter } from './src/server/router';
export {
  getServiceConfig,
  listServiceConfigs,
  hydrateServiceConfig,
  onServiceConfigChanged,
  resetServiceConfigState,
  setServiceConfig,
} from './src/service/service_config';
export {
  InMemoryServiceConfigRepository,
  SQLiteServiceConfigRepository,
  setServiceConfigRepository,
} from './src/service/service_config_repository';
export type { ServiceConfigRepository } from './src/service/service_config_repository';
export {
  InMemoryReviewPublishRepository,
  SQLiteReviewPublishRepository,
  setReviewPublishRepository,
  getReviewPublishRepository,
  subscribeReviewPublishRegistry,
} from './src/review/publish_job_repository';
export type { ReviewPublishRepository } from './src/review/publish_job_repository';
export { publishClaimedReview, runReviewPublishTick } from './src/review/publish_pipeline';
export type {
  PublishReceipt,
  ReviewRecordWriter,
  ReviewPublishErrorClassifier,
  PublishClaimedReviewDeps,
  PublishClaimedReviewResult,
  ReviewPublishTickDeps,
  ReviewPublishTickResult,
} from './src/review/publish_pipeline';
export type { DatabaseAdapter } from './src/storage/db_adapter';
export { setWSDeliverFn } from './src/transport/delivery';
export { BridgePendingSweeper } from './src/workflow/bridge_pending_sweeper';
export { LeaseExpirySweeper } from './src/workflow/lease_expiry_sweeper';
export { LocalDelegationRunner } from './src/workflow/local_delegation_runner';
export type { LocalCapabilityRunner } from './src/workflow/local_delegation_runner';
export { makeServiceResponseBridgeSender } from './src/workflow/response_bridge_sender';
export {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  setWorkflowRepository,
} from './src/workflow/repository';
export type { WorkflowRepository } from './src/workflow/repository';
export { WorkflowService, setWorkflowService, getWorkflowService } from './src/workflow/service';
export { TaskExpirySweeper } from './src/workflow/task_expiry_sweeper';

// Interactive-run subsystem (INTERACTIVE_SERVICES_ARCHITECTURE.md §5..§13) —
// the Tier-0 stores + services the app boot wires.
export { SQLiteRunRepository, setRunRepository } from './src/run/repository';
export { RunService, setRunService } from './src/run/service';
export { setRunDispatchService, getRunDispatchService } from './src/run/dispatch';
export { SQLiteErasureKeyStore, setErasureKeyStore } from './src/run/erasure_store';
export { SQLiteReservationRepository, setReservationRepository } from './src/run/reservation';
export { SQLiteMessageRepository, setMessageRepository } from './src/run/message';
export {
  SQLiteClassificationJobRepository,
  setClassificationJobRepository,
} from './src/run/classification';
export {
  SQLiteCompletionReceiptRepository,
  setCompletionReceiptRepository,
} from './src/run/completion';
export {
  SQLiteCommandReceiptRepository,
  setCommandReceiptRepository,
  setCommandTxRunner,
} from './src/run/command_receipt';
// ISVC-10 — compose the interactive-run drivers into a live loop (both boots).
export { wireRunPlane } from './src/run/plane';
export type { RunPlane, RunPlaneDeps } from './src/run/plane';
export type { EmitQueryEffect, EmitDelegationEffect } from './src/run/engine';
export type { VerifiedRunMessage, PullIngestOutcome } from './src/run/ingest';
export type { IngestCompletionInput } from './src/run/completion';
export type { PersonaCipher } from './src/run/payload_store';
// ISVC-10 — the run-response trust boundary + the persona-DEK cipher functions
// the boot adapts into a PersonaCipher for the payload store (§6.2/§13).
export { verifyRunMessage } from './src/run/verify';
export type {
  SignedRunMessageWire,
  ExpectedRunBinding,
  ResolveRuntimeKey,
  VerifyRunMessageResult,
} from './src/run/verify';
export { hasDEK, wrapWithPersonaDEK, unwrapWithPersonaDEK } from './src/persona/orchestrator';
// ISVC-10 — the boot assembly (egress + PersonaCipher + plane + receive hook).
export { wireRunPlaneNode } from './src/run/plane_node';
export type { RunPlaneNode, RunPlaneNodeDeps, SendD2D } from './src/run/plane_node';
export { InProcessOwnerRunClient } from './src/client/owner-run-client';
export type {
  OwnerReasoningSubmitRequest,
  OwnerReasoningSubmitResult,
  OwnerReasoningBackendView,
  OwnerReasoningBackendRegisterRequest,
  OwnerReasoningClient,
  OwnerRunClient,
} from './src/client/owner-run-client';
// Poll-mode watches (PSVC-0)
export { WatchService, setWatchService, getWatchService } from './src/watch/service';
export { WatchPollSweeper } from './src/watch/poll_sweeper';
export type { WatchPollHandler } from './src/watch/poll_sweeper';
export type { WatchPollPayload } from './src/watch/payload';
export { buildWatchPollHandler, newWatchQueryId } from './src/watch/poll_query';
// Commerce Pack Core stores (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §23)
export * from './src/commerce';
// §9.13 drain authorizations (rebind drain + lifecycle continuity)
export {
  SQLiteDrainAuthorizationRepository,
  InMemoryDrainAuthorizationRepository,
  setDrainAuthorizationRepository,
  getDrainAuthorizationRepository,
} from './src/plugins/drain_authorizations';
export type {
  DrainAuthorization,
  DrainAuthorizationKind,
  DrainAuthorizationRepository,
} from './src/plugins/drain_authorizations';

// Extension-operation registry (§3.4 commerce host-operations gate)
export {
  ExtensionOperationRegistry,
  checkHostOperationInvocation,
  setExtensionOperationRegistry,
  getExtensionOperationRegistry,
} from './src/plugins/extension_ops';
export type {
  ExtensionActionClass,
  ExtensionOperationDef,
  RegisteredExtensionOperation,
  HostOperationGateResult,
} from './src/plugins/extension_ops';
// §3.4 host-operation plane (WS-3.4/3.5): the durable proposal broker and the
// dispatcher that executes permitted proposals. Both boots compose it through
// `createPluginHostRuntime`.
export {
  ExtensionOperationBroker,
} from './src/plugins/extension_broker';
export type {
  ExtensionProposal,
  ExtensionProposalState,
  ConsentedCapability,
} from './src/plugins/extension_broker';
export {
  HostOperationDispatcher,
  makeBoundedAppViewSearch,
  createPluginHostRuntime,
  installPluginHostRuntime,
  getPluginHostRuntime,
} from './src/plugins/host_operations';
export type {
  PluginHostRuntime,
  HostOperationContext,
  HostOperationExecutor,
  HostOperationOutcome,
  DispatchResult,
} from './src/plugins/host_operations';
