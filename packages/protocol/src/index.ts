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
} from './types/capability';

// Wire constants.
export {
  DID_V1_CONTEXT,
  MULTIKEY_CONTEXT,
  DINA_SIGNING_FRAGMENT,
  DINA_MESSAGING_FRAGMENT,
  SERVICE_TYPE_MSGBOX,
  SERVICE_TYPE_DIRECT_HTTPS,
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
  MSG_TYPE_SAFETY_ALERT,
  MSG_TYPE_TRUST_VOUCH_REQUEST,
  MSG_TYPE_TRUST_VOUCH_RESPONSE,
  MSG_TYPE_SERVICE_QUERY,
  MSG_TYPE_SERVICE_RESPONSE,
  MAX_MESSAGE_BODY_SIZE,
  MAX_SERVICE_TTL,
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
// Regenerate via `npm run generate` at the workspace root. Hand-written
// types in `types/*.ts` are still the source of truth for Phase 1b; the
// generated types are additive until task 1.42 replaces the hand-written
// ones where the spec covers them.
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
  validateFutureSkew,
  verifyMessageSignature,
} from './validators';
export type {
  ParsedMessage,
  Ed25519VerifyFn,
  VerifyMessageSignatureInput,
} from './validators';

// Trust Network wire types (TN-PROTO-001). Pure type declarations
// for the `com.dina.trust.*` AT Protocol record family — Lite, Brain
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
  TrustPolicy,
  NotificationPrefs,
  TrustNsid,
} from './trust/types';
export { TRUST_NSIDS } from './trust/types';

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

// Trust-score bands (TN-MOB-002). Canonical thresholds + display
// formatters for the `[0, 1]` real score. Mobile + home-node-lite
// trust decision both import from here so band semantics stay
// consistent across the UI surface.
export type { TrustBand } from './trust/score_bands';
export {
  BAND_HIGH,
  BAND_MODERATE,
  BAND_LOW,
  trustBandFor,
  trustScoreDisplay,
  trustScoreLabel,
} from './trust/score_bands';

// Shared identifier parser (TN-PROTO-003). Pure functions — used by
// mobile compose flows + AppView's subject enricher to detect and
// normalise external identifiers (DOI / arxiv / ISBN / EAN / UPC /
// ASIN / place_id) into a canonical form.
export type { IdentifierType, ParsedIdentifier } from './trust/identifier_parser';
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
} from './trust/identifier_parser';

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

// Trust Network V1 score formula (TN-PROTO-004 / TN-PROTO-005).
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
} from './trust/score_v1';
export {
  SCORE_V1_CONSTANTS,
  computeScoreV1,
  computeSentimentV1,
  computeVouchV1,
  computeReviewerV1,
  computeNetworkV1,
  computeConfidenceV1,
} from './trust/score_v1';
