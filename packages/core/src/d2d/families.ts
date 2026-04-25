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

/** All valid V1 message types. */
const V1_TYPES = new Set<string>([
  MsgTypePresenceSignal,
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypeSocialUpdate,
  MsgTypeSafetyAlert,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
]);

/**
 * Mapping from D2D message type to vault item type.
 * Types not in this map are stored with their original message type as the item type.
 * Ephemeral types (presence.signal, service.query, service.response) are never stored.
 *
 * `coordination.request` / `coordination.response` and `trust.vouch.request`
 * are free-form chat-style payloads between contacts; they map to the
 * generic `message` vault type, which is one of the allowed types in
 * `vault/validation.ts:VALID_VAULT_ITEM_TYPES`. Without these mappings the
 * default branch (`messageType` itself) flows into the vault validator and
 * is rejected — the staging row gets claimed, fails to store, and the
 * D2D-to-reminder pipeline silently halts at the drain.
 */
const VAULT_TYPE_MAP: Record<string, string> = {
  [MsgTypeSocialUpdate]: 'relationship_note',
  [MsgTypeTrustVouchResponse]: 'trust_attestation',
  [MsgTypeCoordinationRequest]: 'message',
  [MsgTypeCoordinationResponse]: 'message',
  [MsgTypeTrustVouchRequest]: 'message',
};

/** Types that are never stored (ephemeral). */
const EPHEMERAL_TYPES = new Set<string>([
  MsgTypePresenceSignal,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
]);

/** Types that cannot be blocked by sharing policy (always delivered). */
const ALWAYS_PASS_TYPES = new Set<string>([MsgTypeSafetyAlert]);

/**
 * Message type → scenario mapping for scenario-policy gating.
 * Used by egress/ingress gates to look up which scenario tier applies.
 *
 * Source: Go domain/message.go MsgTypeToScenario()
 */
const TYPE_TO_SCENARIO: Record<string, string> = {
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
 */
export function mapToVaultItemType(messageType: string): string | null {
  if (EPHEMERAL_TYPES.has(messageType)) {
    return null;
  }
  return VAULT_TYPE_MAP[messageType] ?? messageType;
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
export function msgTypeToScenario(messageType: string): string {
  return TYPE_TO_SCENARIO[messageType] ?? '';
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
