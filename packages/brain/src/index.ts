export * from './pii/entity_vault';
export * from './pii/tier2_patterns';
export * from './trust/scorer';
export * from './trust/tier_classifier';
export * from './enrichment/l0_deterministic';
export * from './contact/matcher';
export * from './contact/attributor';
export * from './enrichment/event_extractor';
export * from './api/process';
export * from './auth/service_key';
export { BrainCoreClient, WorkflowConflictError, CoreHttpError } from './core_client/http';
export type {
  BrainCoreClientConfig,
  SendServiceQueryResult,
  SendServiceRespondResult,
  WorkflowTask as CoreWorkflowTask,
} from './core_client/http';
export { ApprovalReconciler } from './service/approval_reconciliation';
export { WorkflowEventConsumer } from './service/workflow_event_consumer';
export type {
  WorkflowEventDeliverer,
  WorkflowEventConsumerOptions,
  WorkflowEventConsumerCoreClient,
  WorkflowEventTickResult,
  ApprovalEventDispatcher,
  ApprovedExecutionPayload,
} from './service/workflow_event_consumer';
export type {
  ApprovalReconcilerOptions,
  ReconciliationTickResult,
} from './service/approval_reconciliation';
export { ServiceHandler, snapshotForCapability } from './service/service_handler';
export type {
  ServiceHandlerOptions,
  ServiceHandlerCoreClient,
  ApprovalNotifier,
  SchemaSnapshot,
} from './service/service_handler';
export { validateAgainstSchema } from './service/capabilities/schema_validator';
export * from './guardian/silence';
export * from './llm/router';
export * from './staging/processor';
export {
  runStagingDrainTick,
  type StagingDrainOptions,
  type StagingDrainTickResult,
  type StagingDrainCoreClient,
} from './staging/drain';
export { StagingDrainScheduler, type StagingDrainSchedulerOptions } from './staging/scheduler';
export * from './contact/alias';
export * from './scratchpad/lifecycle';
export * from './routing/task';
export * from './sync/engine';
export * from './embedding/generation';
export * from './mcp/delegation';
export { loadBrainConfig, validateBrainConfig } from './config/loading';
export type { BrainConfig } from './config/loading';
export * from './resilience/degradation';
export * from './crash/safety';
export * from './persona/registry';
export * from './vault_context/assembly';
export * from './pipeline/safety';
export * from './person/linking';
export * from './nudge/whisper';
export * from './guardian/action_risk';
// density exports `classifyTier` which collides with trust/tier_classifier
// — re-export explicitly so the unrelated function stays reachable as
// `densityClassifyTier` without clobbering the trust one.
export {
  analyzeDensity,
  computeEntityDensity,
  classifyTier as densityClassifyTier,
  buildDisclosure,
  applyDisclosure,
} from './guardian/density';
export type { DensityTier, EntityDensity, DensityAnalysis } from './guardian/density';
// anti_her_classify exports `classifyDeterministic` which collides with
// guardian/silence. Re-export the anti-her one under its own name.
export {
  registerAntiHerClassifier,
  resetAntiHerClassifier,
  preScreenMessage,
  classifyDeterministic as classifyAntiHerDeterministic,
  parseLLMResponse as parseAntiHerLLMResponse,
} from './guardian/anti_her_classify';
export type {
  AntiHerCategory,
  PreScreenResult,
  AntiHerLLMCallFn,
} from './guardian/anti_her_classify';
export * from './guardian/guard_scan';
export { CircuitBreaker, CircuitBreakerOpenError } from './core_client/circuit_breaker';
export * from './routing/classify_factory';
export * from './routing/gemini_classify';
export * from './routing/persona_selector';
export * from './enrichment/sponsored';
export * from './enrichment/sweep';
// enrichment/pipeline exports `enrichItem` which collides with
// staging/processor's `enrichItem`. Re-export the pipeline one under a
// disambiguated name.
export {
  registerEnrichmentLLM,
  resetEnrichmentPipeline,
  enrichItem as enrichItemViaPipeline,
} from './enrichment/pipeline';
export type { LLMCallFn, EnrichmentResult } from './enrichment/pipeline';
export * from './pipeline/chat_reasoning';
export * from './pipeline/reasoning_trace';
export * from './pipeline/reminder_planner';
// identity_extraction exports `parseLLMResponse` which collides with
// guardian/anti_her_classify's. Re-export under a disambiguated name.
export {
  registerIdentityExtractor,
  resetIdentityExtractor,
  extractIdentityLinks,
  extractDeterministic,
  parseLLMResponse as parseIdentityLLMResponse,
} from './pipeline/identity_extraction';
export type {
  RelationshipType,
  IdentityLink,
  IdentityExtractionResult,
  IdentityLLMCallFn,
} from './pipeline/identity_extraction';
export * from './pipeline/post_publish';
export * from './briefing/assembly';
export * from './briefing/providers';
export * from './service/capabilities/registry';
export type { CapabilityDef, Validator } from './service/capabilities/registry';
export * from './service/capabilities/eta_query';
export type {
  Location,
  EtaQueryParams,
  EtaQueryResult,
  EtaQueryStatus,
} from './service/capabilities/eta_query';
export { AppViewClient, AppViewError } from './appview_client/http';
export type {
  AppViewClientOptions,
  SearchServicesParams,
  ServiceProfile,
  IsDiscoverableResult,
} from './appview_client/http';
export { PDSPublisher, PDSPublisherError } from './pds/publisher';
export type { PDSPublisherOptions, PutRecordResult } from './pds/publisher';
export { PDSAccountClient, PDSAccountError } from './pds/account';
export type {
  PDSSession,
  PDSAccountOptions,
  CreateAccountParams,
  CreateSessionParams,
} from './pds/account';
export { ensureNodeIdentity } from './identity/node_identity';
export type { EnsureNodeIdentityParams, NodeIdentity } from './identity/node_identity';
export { ToolRegistry } from './reasoning/tool_registry';
export type { AgentTool, ToolExecutionOutcome } from './reasoning/tool_registry';
export {
  createGeocodeTool,
  createSearchProviderServicesTool,
  createQueryServiceTool,
} from './reasoning/bus_driver_tools';
export type {
  GeocodeToolOptions,
  GeocodeResult,
  SearchProviderServicesToolOptions,
  QueryServiceToolOptions,
} from './reasoning/bus_driver_tools';
export { runAgenticTurn } from './reasoning/agentic_loop';
export type { AgenticLoopOptions, AgenticLoopResult } from './reasoning/agentic_loop';
export { makeAgenticAskHandler, DEFAULT_ASK_SYSTEM_PROMPT } from './reasoning/ask_handler';
export type { AgenticAskHandlerOptions } from './reasoning/ask_handler';
export { setAskCommandHandler, resetAskCommandHandler } from './chat/orchestrator';
export type { AskCommandHandler } from './chat/orchestrator';
export {
  ServicePublisher,
  PublisherConfigError,
  PublisherIdentityMismatchError,
  SERVICE_PROFILE_COLLECTION,
  SERVICE_PROFILE_RKEY,
  buildRecord as buildServiceProfileRecord,
} from './service/service_publisher';
export type {
  ServicePublisherOptions,
  ServicePublisherConfig,
  PublishedCapabilitySchema,
} from './service/service_publisher';
export { ConfigSync, toPublisherConfig } from './service/config_sync';
export type { ConfigSyncOptions, ConfigChangeSource } from './service/config_sync';
export { formatServiceQueryResult } from './service/result_formatter';
export type { ServiceQueryEventDetails } from './service/result_formatter';
export { rankCandidates, pickTopCandidate, haversineKm } from './service/candidate_ranker';
export type {
  RankedCandidate,
  RankOptions,
  Location as RankerLocation,
} from './service/candidate_ranker';
export {
  ServiceQueryOrchestrator,
  ServiceOrchestratorError,
} from './service/service_query_orchestrator';
export type {
  IssueQueryRequest,
  IssueQueryResult,
  OrchestratorOptions,
  OrchestratorCoreClient,
  OrchestratorAppView,
} from './service/service_query_orchestrator';
export { wireServiceOrchestrator, errorToAck } from './service/service_wiring';
export type { ServiceWiringOptions, ServiceWiringDisposer } from './service/service_wiring';
export {
  D2DDispatcher,
  getDefaultDispatcher,
  resetDefaultDispatcher,
} from './guardian/d2d_dispatcher';
export {
  composeScanners,
  createBodySizeScanner,
  createAllowListScanner,
} from './guardian/d2d_scanners';
export type {
  D2DHandler,
  D2DScanner,
  D2DBody,
  ScanResult,
  DispatchResult,
} from './guardian/d2d_dispatcher';
export {
  setServiceCommandHandler,
  resetServiceCommandHandler,
  setServiceApproveCommandHandler,
  resetServiceApproveCommandHandler,
  setServiceDenyCommandHandler,
  resetServiceDenyCommandHandler,
} from './chat/orchestrator';
export type {
  ServiceCommandHandler,
  ServiceApproveCommandHandler,
  ServiceDenyCommandHandler,
} from './chat/orchestrator';
export { makeServiceApproveHandler, makeServiceDenyHandler } from './service/approve_command';
export type { ServiceApproveCoreClient, ServiceDenyCoreClient } from './service/approve_command';
