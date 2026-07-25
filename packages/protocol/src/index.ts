/**
 * `@dina/protocol` — Dina wire-format protocol.
 *
 * Public surface grows progressively across Phase 1b tasks 1.17–1.27.
 * Populated so far:
 *   - 1.17b (DID document types)     — `VerificationMethod`, `ServiceEndpoint`, `DIDDocument`
 *   - 1.17c (D2D envelope + bodies)  — `D2DPayload`, `ServiceQueryBody`, `ServiceResponseBody`, 9 MsgType* consts, `MAX_*` limits
 *   - 1.18   (canonical-sign pure)   — `buildCanonicalPayload(method, path, query, ts, nonce, bodyHash)`
 *   - 1.21   (wire constants)        — DID contexts, fragments, service-type literals, auth-frame strings, port defaults
 *
 * Remaining extraction tracked in `packages/protocol/INVENTORY.md`.
 */

// Types (one file per category — see INVENTORY.md for the full plan).
export type { VerificationMethod, ServiceEndpoint, DIDDocument } from './types/plc_document';
export type {
  D2DPayload,
  ServiceResponseStatus,
  ServiceQueryBody,
  ServiceResponseBody,
  ServiceOfferBody,
  ServiceGrantRequestBody,
  TalkMessageBody,
} from './types/d2d';
export type {
  AuthChallengeFrame,
  AuthResponseFrame,
  AuthSuccessFrame,
  AuthFrame,
} from './types/auth_frames';
export { buildAuthSignedPayload } from './types/auth_frames';
export type { CoreRPCRequest, CoreRPCResponse } from './types/core_rpc';
export type {
  ServiceResponsePolicy,
  ServiceCapabilityConfig,
  ServiceCapabilitySchemas,
  ServiceConfig,
  ServiceListingStatus,
  ServiceSurface,
  AccessPolicyHint,
  RateLimitHint,
  PricingHint,
  FreshnessHint,
} from './types/capability';
export { LOCAL_RUNNER_NAME } from './types/capability';
export {
  SERVICE_QUERY_EXECUTION_TYPE,
  buildServiceQueryExecutionPayload,
  parseServiceQueryExecutionPayload,
  parseServiceExecutionSchemaSnapshot,
} from './types/service_execution';
export type {
  ServiceQueryExecutionPayload,
  ServiceQueryExecutionPayloadInput,
  ServiceExecutionSchemaSnapshot,
} from './types/service_execution';
export type {
  CategoryLifecycle,
  CapabilityLifecycle,
  ActionClass,
  PrivacyClass,
  Discoverability,
  ApprovalPolicyHint,
  CatalogCategory,
  CapabilityDefinition,
  DeprecatedCapability,
  CapabilityCatalog,
} from './types/catalog';
export {
  parseCreditsConfig,
  parseClaimGrantRequest,
  parseClaimGrantResponse,
  parseClaimGrantRefusal,
  TERMINAL_REFUSALS,
  CREDITS_GET_CONFIG_NSID,
  CREDITS_CLAIM_GRANT_NSID,
} from './types/credits';
export type {
  CreditsPlatform,
  CreditsAttestation,
  CreditsConfig,
  ClaimGrantRequest,
  ClaimGrantResponse,
  ClaimGrantRefusal,
  ClaimRefusalCode,
} from './types/credits';

// Wire constants.
export {
  DID_V1_CONTEXT,
  MULTIKEY_CONTEXT,
  DINA_SIGNING_FRAGMENT,
  DINA_MESSAGING_FRAGMENT,
  SERVICE_TYPE_MSGBOX,
  AUTH_CHALLENGE,
  AUTH_RESPONSE,
  AUTH_SUCCESS,
  DEFAULT_CORE_PORT,
  DEFAULT_BRAIN_PORT,
  DEFAULT_MSGBOX_PORT,
  MSG_TYPE_PRESENCE_SIGNAL,
  MSG_TYPE_COORDINATION_REQUEST,
  MSG_TYPE_COORDINATION_RESPONSE,
  MSG_TYPE_SOCIAL_UPDATE,
  MSG_TYPE_TALK_MESSAGE_V1,
  MSG_TYPE_SAFETY_ALERT,
  MSG_TYPE_PEERLENS_VOUCH_REQUEST,
  MSG_TYPE_PEERLENS_VOUCH_RESPONSE,
  MSG_TYPE_SERVICE_QUERY,
  MSG_TYPE_SERVICE_RESPONSE,
  MSG_TYPE_SERVICE_OFFER,
  MSG_TYPE_SERVICE_GRANT_REQUEST,
  MAX_MESSAGE_BODY_SIZE,
  MAX_SERVICE_TTL,
  MAX_TALK_MESSAGE_BYTES,
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
  NOTIFY_PRIORITY_FIDUCIARY,
  NOTIFY_PRIORITY_SOLICITED,
  NOTIFY_PRIORITY_ENGAGEMENT,
  D2D_SCENARIOS,
} from './constants';
export type {
  DinaServiceType,
  D2DMessageType,
  EphemeralD2DType,
  StorableD2DType,
  D2DScenario,
  NotifyPriority,
} from './constants';

// Canonical signing helper (pure — no crypto backend).
export { buildCanonicalPayload } from './canonical_sign';

// OpenAPI-generated types (tasks 1.37 + 1.38). `paths` + `components`
// + `operations` are the canonical openapi-typescript export shapes;
// re-exported here with distinctive names so consumers can write:
//   import type { CoreAPIComponents } from '@dina/protocol';
//   type HealthResponse = CoreAPIComponents['schemas']['HealthResponse'];
// Regenerate via `npm run generate` at the workspace root.
//
// ⚠️ These `CoreAPI*` types are generated from `api/core-api.yaml`, which
// is the LEGACY / deprecated Go-stack spec (see its header banner) — NOT
// the live TS contract. They have NO production consumer; the only
// importers are this package's own conformance tests (`__tests__/codegen`,
// `__tests__/type_compat`), which assert the hand-written wire types still
// match the shared COMPONENT SCHEMAS (HealthResponse, VaultStoreResponse,
// …) the two stacks agree on. Route-level drift (e.g. `/v1/reminder` vs the
// TS `/v1/reminders`) lives in `CoreAPIPaths` and is intentionally NOT
// asserted against runtime — the authoritative TS routes are in
// `packages/core/src/server/routes/*`. So this is a legacy schema-
// conformance fixture, not a second source of runtime truth.
export type {
  paths as CoreAPIPaths,
  components as CoreAPIComponents,
  operations as CoreAPIOperations,
} from './gen/core-api';
export type {
  paths as BrainAPIPaths,
  components as BrainAPIComponents,
  operations as BrainAPIOperations,
} from './gen/brain-api';

// Pure envelope constructors (task 1.19). Callers inject random /
// base64 runtime bits; protocol does the deterministic assembly.
export { buildMessageJSON, buildRPCRequest } from './envelope_builder';
export type { BuildMessageJSONInput, BuildRPCRequestInput } from './envelope_builder';

// Validators (task 1.20). Structural ones are pure; signature verify
// takes a crypto callback so protocol stays zero-runtime-deps.
export {
  parseMessageJSON,
  validateServiceQueryBody,
  validateServiceResponseBody,
  validateServiceOfferBody,
  validateServiceGrantRequestBody,
  validateTalkMessageBody,
  validateFutureSkew,
  verifyMessageSignature,
  parseServiceListingUri,
  isValidServiceListingRkey,
  SERVICE_PROFILE_COLLECTION,
} from './validators';
export type {
  ParsedMessage,
  Ed25519VerifyFn,
  VerifyMessageSignatureInput,
} from './validators';

// PeerLens wire types (TN-PROTO-001). Pure type declarations
// for the `com.dinakernel.peerlens.*` AT Protocol record family — Lite, Brain
// and mobile all consume from here so the workspace has one
// definition. AppView's parallel `lexicon-types.ts` mirrors this
// file until cross-workspace publish is set up.
export type {
  SubjectType,
  SubjectRef,
  Sentiment,
  DimensionValue,
  DimensionRating,
  EvidenceItem,
  Confidence,
  Mention,
  CoSignature,
  RelatedAttestation,
  Attestation,
  VouchConfidence,
  Vouch,
  Endorsement,
  FlagSeverity,
  Flag,
  ReplyIntent,
  Reply,
  ReactionType,
  Reaction,
  ReportType,
  ReportRecord,
  Revocation,
  Delegation,
  Collection,
  Media,
  SubjectRecord,
  Amendment,
  VerificationResult,
  Verification,
  ReviewRequest,
  Comparison,
  SubjectClaimType,
  SubjectClaim,
  PeerlensPolicy,
  NotificationPrefs,
  PeerlensNsid,
} from './peerlens/types';
export { PEERLENS_NSIDS } from './peerlens/types';

// D2D cosig handshake (TN-PROTO-002). Wire types + pure state
// machine for the trust.cosig.{request,accept,reject} 3-message
// exchange. The machine is clock-pure: callers feed `tick` events
// carrying an ISO-8601 `now` so unit tests stay deterministic.
export type {
  CosigMessageType,
  CosigRequest,
  CosigAccept,
  CosigReject,
  CosigRejectReason,
  CosigMessage,
  CosigStatus,
  CosigState,
  CosigStatePending,
  CosigStateAccepted,
  CosigStateRejected,
  CosigStateExpired,
  CosigEvent,
} from './d2d/cosig';
export {
  COSIG_REQUEST_TYPE,
  COSIG_ACCEPT_TYPE,
  COSIG_REJECT_TYPE,
  cosigInitial,
  cosigStep,
  validateCosigRequest,
  validateCosigAccept,
  validateCosigReject,
} from './d2d/cosig';

// PeerLens rating bands (TN-MOB-002). Canonical thresholds + display
// formatters for the `[0, 1]` real score. Mobile + home-node-lite
// trust decision both import from here so band semantics stay
// consistent across the UI surface.
export type { PeerlensBand } from './peerlens/score_bands';
export {
  BAND_HIGH,
  BAND_MODERATE,
  BAND_LOW,
  trustBandFor,
  trustScoreDisplay,
  trustScoreLabel,
} from './peerlens/score_bands';

// Shared identifier parser (TN-PROTO-003). Pure functions — used by
// mobile compose flows + AppView's subject enricher to detect and
// normalise external identifiers (DOI / arxiv / ISBN / EAN / UPC /
// ASIN / place_id) into a canonical form.
export type { IdentifierType, ParsedIdentifier } from './peerlens/identifier_parser';
export {
  parseIdentifier,
  parseDoi,
  parseArxiv,
  parseIsbn13,
  parseIsbn10,
  parseEan13,
  parseUpc,
  parseAsin,
  parsePlaceId,
} from './peerlens/identifier_parser';

// DID document `assertionMethod` resolution (TN-AUTH-001). Pure
// resolver — translates `assertionMethod` string-references and
// inline VMs into the underlying `VerificationMethod` objects so
// AppView's signature gate and the mobile verifier can look up the
// namespace key referenced by a record's `namespace` field.
export {
  resolveAssertionMethods,
  resolveAssertionMethod,
} from './identity/did_resolver';

// Trust-record commit signature verifier (TN-AUTH-002). Pure
// closed-default verifier — given a record's bytes + signature +
// the author's DID doc + the claimed namespace, checks whether the
// signature verifies under the matching `assertionMethod` key.
// Crypto + multibase decode are injected (zero-runtime-deps).
export { verifyRecordCommit } from './identity/verify_record';
export type {
  VerifyRecordCommitInput,
  MultikeyDecodeFn,
} from './identity/verify_record';

// PeerLens V1 score formula (TN-PROTO-004 / TN-PROTO-005).
// Pure, zero-dep, deterministic reference. AppView's wall-clock
// scorer is the call-site behaviour; this is the formula every
// implementation pins to via `conformance/vectors/trust_score_v1.json`.
export type {
  ScoreV1Sentiment,
  ScoreV1FlagSeverity,
  ScoreV1AttestationAbout,
  ScoreV1Input,
  ScoreV1Components,
  ScoreV1Output,
} from './peerlens/score_v1';
export {
  SCORE_V1_CONSTANTS,
  computeScoreV1,
  computeSentimentV1,
  computeVouchV1,
  computeReviewerV1,
  computeNetworkV1,
  computeConfidenceV1,
} from './peerlens/score_v1';

// Service capability registry — shared canonical vocabulary + resolver.
// Byte-identical to appview/src/shared/capability-registry.ts (drift gate).
// Core's D2D ingress (`isCapabilityConfigured`) imports
// `resolveCanonicalCapability` from here to canonicalize inbound queries.
export * from './services/capability-registry';

// Official service-capability CATALOG — the curated, AppView-served vocabulary
// providers choose from. Superset of the resolver registry above (a consistency
// test enforces that). See docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md.
export * from './services/capability-catalog';

// Provider service-listing validation (discoverability + category + capability
// kind), fail-closed + explainable. See docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md §5.1.
export * from './services/listing-validation';

// PeerLens review-dimension registry — shared canonical vocabulary +
// resolver. Byte-identical to appview/src/shared/dimension-registry.ts.
export * from './services/dimension-registry';

// Service-result display card — the safe, fixed-vocabulary declarative
// CardSpec the brain maps results into + the client renders. See
// docs/CARD_SPEC_DESIGN.md. NO images, NO provider-supplied URLs (map =
// structured coords, link = https + shown host).
export * from './services/card-spec';

// Plugin wire layer — the two-record release scheme (plugin.identity +
// plugin.release), manifest validation, the three digests
// (approved_scope_hash / behavior_hash / presentation_hash),
// content-derived release rkeys, and the repo-proof verifier contract.
// See docs/PLUGIN_ARCHITECTURE.md §5, §8.1.
export * from './plugins';

// Interactive-run signed projections + the classification-view shape + the
// flat `interactive_run` capability id + additive public NSIDs.
// See docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §6.2/§12.1/§12.4.
export * from './run/projections';

// Push-service protocol layer — the `push_notify` capability id, the `push.*`
// D2D family ids, the frozen subscribe/ack/event body shapes + validators, and
// the signed `push.event` projection. See docs/PUSH_SERVICES_ARCHITECTURE.md §7.
export * from './push/schemas';
