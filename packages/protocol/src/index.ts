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
} from './constants';
export type { DinaServiceType, D2DMessageType, NotifyPriority } from './constants';

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
