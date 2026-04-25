/**
 * D2D V1 message families — type validation and vault-item-type mapping.
 *
 * Nine message types defined by the V1 protocol:
 *   presence.signal       → never stored (ephemeral, online/typing indicator)
 *   coordination.request  → stored (meeting, scheduling)
 *   coordination.response → stored (reply to coordination)
 *   social.update         → stored as "relationship_note"
 *   safety.alert          → always passes (cannot be blocked by policy)
 *   trust.vouch.request   → stored (identity verification request)
 *   trust.vouch.response  → stored as "trust_attestation"
 *   service.query         → never stored (ephemeral, public-service query)
 *   service.response      → never stored (ephemeral, public-service response)
 *
 * Source: core/internal/domain/d2d.go, core/internal/domain/message.go
 */

// Message-type string constants — single source of truth is
// `@dina/protocol`; core re-exports under the legacy `MsgType*` naming
// convention for backwards compatibility with existing call-sites.
// Discovered during task 1.22 (protocol index audit): the string
// values used to be duplicated here and in protocol. Drift-free now.
export {
  MSG_TYPE_PRESENCE_SIGNAL as MsgTypePresenceSignal,
  MSG_TYPE_COORDINATION_REQUEST as MsgTypeCoordinationRequest,
  MSG_TYPE_COORDINATION_RESPONSE as MsgTypeCoordinationResponse,
  MSG_TYPE_SOCIAL_UPDATE as MsgTypeSocialUpdate,
  MSG_TYPE_SAFETY_ALERT as MsgTypeSafetyAlert,
  MSG_TYPE_TRUST_VOUCH_REQUEST as MsgTypeTrustVouchRequest,
  MSG_TYPE_TRUST_VOUCH_RESPONSE as MsgTypeTrustVouchResponse,
  MSG_TYPE_SERVICE_QUERY as MsgTypeServiceQuery,
  MSG_TYPE_SERVICE_RESPONSE as MsgTypeServiceResponse,
} from '@dina/protocol';
import {
  MSG_TYPE_PRESENCE_SIGNAL as MsgTypePresenceSignal,
  MSG_TYPE_COORDINATION_REQUEST as MsgTypeCoordinationRequest,
  MSG_TYPE_COORDINATION_RESPONSE as MsgTypeCoordinationResponse,
  MSG_TYPE_SOCIAL_UPDATE as MsgTypeSocialUpdate,
  MSG_TYPE_SAFETY_ALERT as MsgTypeSafetyAlert,
  MSG_TYPE_TRUST_VOUCH_REQUEST as MsgTypeTrustVouchRequest,
  MSG_TYPE_TRUST_VOUCH_RESPONSE as MsgTypeTrustVouchResponse,
  MSG_TYPE_SERVICE_QUERY as MsgTypeServiceQuery,
  MSG_TYPE_SERVICE_RESPONSE as MsgTypeServiceResponse,
} from '@dina/protocol';
import { D2D_SCENARIOS } from '@dina/protocol';
import type {
  D2DMessageType,
  EphemeralD2DType,
  StorableD2DType,
  D2DScenario,
} from '@dina/protocol';
import type { VaultItemType } from '../vault/validation';

// Re-export the protocol-owned scenario types so existing core consumers
// (and the test harness) keep working without changing their imports.
// The single source of truth lives in `@dina/protocol/constants` — every
// language port targets that table.
export { D2D_SCENARIOS };
export type { D2DScenario };

/**
 * All valid V1 message types.
 *
 * The array literal is typed `D2DMessageType[]` — adding a new V1 type
 * to `@dina/protocol` forces a compile-time decision about storage +
 * scenario routing here (TS will reject this list as incomplete the
 * moment the union grows but the array doesn't).
 *
 * The Set itself is `Set<string>` because the query side handles
 * untrusted wire input — `isValidV1Type(unknownString)` is the whole
 * point. Strict typing happens at the builder, not at lookup.
 */
const V1_TYPES_LIST: readonly D2DMessageType[] = [
  MsgTypePresenceSignal,
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypeSocialUpdate,
  MsgTypeSafetyAlert,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
];
const V1_TYPES = new Set<string>(V1_TYPES_LIST);

/**
 * Mapping from a *storable* D2D message type to a vault item type.
 *
 * Typed `Record<StorableD2DType, VaultItemType>` so the compiler enforces
 * both invariants that Bug #1 violated:
 *
 *   1. **Completeness** — every storable type must have an entry. Adding
 *      a new V1 type without listing it as ephemeral immediately fails
 *      the build until you register a vault mapping for it.
 *   2. **Validity** — every value must be a real vault item type. You
 *      cannot accidentally map to a string the vault validator rejects.
 *
 * The original Bug #1 (`coordination.request` had no entry → drain dropped
 * messages) is impossible under this typing. The latent twin (Bug #2:
 * `safety.alert` had no entry) was caught by the contract test we added,
 * and is now also caught at compile time here.
 *
 * `coordination.*` and `trust.vouch.request` are free-form chat-style
 * payloads → generic `message`. `safety.alert` is storable (bypasses
 * sharing-policy gates so a record is always retained); since the vault
 * validator has no dedicated `safety_alert` type, pin to `message` —
 * the original D2D type lives on in staging metadata for audit.
 */
const VAULT_TYPE_MAP: Record<StorableD2DType, VaultItemType> = {
  [MsgTypeSocialUpdate]: 'relationship_note',
  [MsgTypeTrustVouchResponse]: 'trust_attestation',
  [MsgTypeCoordinationRequest]: 'message',
  [MsgTypeCoordinationResponse]: 'message',
  [MsgTypeTrustVouchRequest]: 'message',
  [MsgTypeSafetyAlert]: 'message',
};

/**
 * Types that are never stored (ephemeral). The list is typed
 * `EphemeralD2DType[]` so it stays in lockstep with the union exported
 * by `@dina/protocol`. The runtime Set is `Set<string>` because the
 * query side accepts untrusted wire input.
 */
const EPHEMERAL_TYPES_LIST: readonly EphemeralD2DType[] = [
  MsgTypePresenceSignal,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
];
const EPHEMERAL_TYPES = new Set<string>(EPHEMERAL_TYPES_LIST);

/** Types that cannot be blocked by sharing policy (always delivered).
 *  Builder side typed `D2DMessageType[]` so the list can only contain
 *  real V1 types; query side stays `Set<string>` for wire input. */
const ALWAYS_PASS_TYPES_LIST: readonly D2DMessageType[] = [MsgTypeSafetyAlert];
const ALWAYS_PASS_TYPES = new Set<string>(ALWAYS_PASS_TYPES_LIST);

/**
 * Message type → scenario mapping for scenario-policy gating.
 * Used by egress/ingress gates to look up which scenario tier applies.
 *
 * Typed `Record<D2DMessageType, D2DScenario>` so the compiler enforces:
 *   - every V1 message type has a scenario (Go parity, no fall-through)
 *   - the value is a known scenario (typo guard)
 *
 * Source: Go domain/message.go MsgTypeToScenario()
 */
const TYPE_TO_SCENARIO: Record<D2DMessageType, D2DScenario> = {
  [MsgTypePresenceSignal]: 'presence',
  [MsgTypeCoordinationRequest]: 'coordination',
  [MsgTypeCoordinationResponse]: 'coordination',
  [MsgTypeSocialUpdate]: 'social',
  [MsgTypeSafetyAlert]: 'safety',
  [MsgTypeTrustVouchRequest]: 'trust',
  [MsgTypeTrustVouchResponse]: 'trust',
  [MsgTypeServiceQuery]: 'service',
  [MsgTypeServiceResponse]: 'service',
};

/** Maximum D2D message body size in bytes (256 KB). */
export const MAX_MESSAGE_BODY_SIZE = 256 * 1024;

/**
 * Maximum TTL (seconds) for `service.query` / `service.response` messages.
 * 300 seconds = 5 minutes. Caller-provided values outside (0, 300] are rejected.
 *
 * Source: Go domain/message.go `MaxServiceTTL = 300`.
 */
export const MAX_SERVICE_TTL = 300;

/**
 * Check if a message type string is a valid V1 family.
 */
export function isValidV1Type(messageType: string): boolean {
  return V1_TYPES.has(messageType);
}

/**
 * Map a D2D message type to a vault item type for storage.
 * Returns null for types that should not be stored (e.g., presence.signal).
 *
 * Accepts `string` because the input is untrusted wire data; the typed
 * `VAULT_TYPE_MAP` (Record<StorableD2DType, VaultItemType>) is the
 * authoritative contract — what's reachable through this function is
 * still bounded by what was registered there at compile time.
 */
export function mapToVaultItemType(messageType: string): VaultItemType | null {
  if (EPHEMERAL_TYPES.has(messageType)) {
    return null;
  }
  // Cast required because TS can't statically prove `messageType` is a
  // StorableD2DType here. The runtime guarantee is that callers must
  // first check `isValidV1Type` and `shouldStore`; if those passed and
  // we reach here with a value not in the map, returning `undefined`
  // surfaces the bug to the validator immediately.
  const mapped = (VAULT_TYPE_MAP as Record<string, VaultItemType>)[messageType];
  return mapped ?? null;
}

/**
 * Check if a message type should be stored in the vault.
 * presence.signal is the only type that should NOT be stored.
 */
export function shouldStore(messageType: string): boolean {
  return !EPHEMERAL_TYPES.has(messageType);
}

/**
 * Check if a message type always passes (cannot be blocked by policy).
 * Only safety.alert has this property.
 */
export function alwaysPasses(messageType: string): boolean {
  return ALWAYS_PASS_TYPES.has(messageType);
}

/**
 * Map a D2D message type to its scenario name for policy gating.
 * Returns empty string for unknown types (caller should reject).
 *
 * Source: Go domain/message.go MsgTypeToScenario()
 */
export function msgTypeToScenario(messageType: string): D2DScenario | '' {
  // Cast required because input is untrusted wire data; the typed
  // `TYPE_TO_SCENARIO` (Record<D2DMessageType, D2DScenario>) is the
  // authoritative contract — every V1 type has a real scenario, and
  // unknown types fall through to '' for the caller to reject.
  return (TYPE_TO_SCENARIO as Record<string, D2DScenario>)[messageType] ?? '';
}

/**
 * Validate a D2D message body size.
 * Returns null if valid, or an error message if too large.
 */
export function validateMessageBody(body: string | Uint8Array): string | null {
  const size =
    typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
  if (size > MAX_MESSAGE_BODY_SIZE) {
    return `message body exceeds maximum size of ${MAX_MESSAGE_BODY_SIZE} bytes (got ${size})`;
  }
  return null;
}
