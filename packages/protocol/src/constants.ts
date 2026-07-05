/**
 * Wire-format string constants — fragments, service types, context URIs, port defaults.
 *
 * Every string here is part of the Dina on-the-wire contract. Changing
 * a value here is a protocol break; bump `@dina/protocol` major.
 *
 * Source: consolidated from various sites in `@dina/core` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.21.
 */

// ─── W3C DID document @context URIs ──────────────────────────────────────

/** W3C DID v1 context URI — required in every DIDDocument['@context']. */
export const DID_V1_CONTEXT = 'https://www.w3.org/ns/did/v1';

/** Multikey context URI — required when `verificationMethod.type === 'Multikey'`. */
export const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1';

// ─── DID document fragment conventions ───────────────────────────────────

/**
 * Signing-key verification-method fragment. Underscore form matches
 * AT Protocol PLC doc convention and is what Dina publishes + reads.
 * Historical note: pre-0.14 Dina builds wrote the hyphenated form
 * `#dina-signing`; readers accept both for backward compat.
 */
export const DINA_SIGNING_FRAGMENT = '#dina_signing';

/**
 * Messaging-service endpoint fragment. Same underscore convention.
 * Historical hyphenated form `#dina-messaging` still recognised by
 * `getMessagingService()` readers.
 */
export const DINA_MESSAGING_FRAGMENT = '#dina_messaging';

// ─── Dina service-endpoint type literals ─────────────────────────────────

/**
 * Service-endpoint `type` field value. MsgBox-relayed delivery is the
 * sole transport — every Home Node (mobile or server) sits behind a
 * NAT, relies on the relay for offline buffering, and reuses the
 * already-open authenticated WebSocket. The pre-0.16 `DinaDirectHTTPS`
 * literal was never produced by any identity-creation path and has
 * been removed from the wire format.
 */
export const SERVICE_TYPE_MSGBOX = 'DinaMsgBox';

/** The (currently single-valued) union of Dina service endpoint types. */
export type DinaServiceType = typeof SERVICE_TYPE_MSGBOX;

// ─── MsgBox auth frame type strings ──────────────────────────────────────

/** Sent by the MsgBox server on every new WebSocket connection. */
export const AUTH_CHALLENGE = 'auth_challenge';

/** Sent by the client in response to an auth_challenge. */
export const AUTH_RESPONSE = 'auth_response';

/**
 * Sent by the MsgBox server after successful challenge verification.
 * Introduced in 0.14 — strict behaviour per docs/designs/MSGBOX_TRANSPORT.md.
 */
export const AUTH_SUCCESS = 'auth_success';

// ─── Default port numbers ────────────────────────────────────────────────
// These are defaults, not fixed — env vars (DINA_CORE_PORT etc.) override.
// Kept here so `@dina/protocol` implementers know what to expect when no
// override is set.

/** Default HTTP port for the Dina Core service (dev + test). */
export const DEFAULT_CORE_PORT = 8100;

/** Default HTTP port for the Dina Brain service. */
export const DEFAULT_BRAIN_PORT = 8200;

/** Default port for the MsgBox relay. */
export const DEFAULT_MSGBOX_PORT = 7700;

// ─── D2D message-type strings ────────────────────────────────────────────
// Ten V1 message families. Wire values are locked — any change is a
// protocol break. Matches core/internal/domain/d2d.go.

export const MSG_TYPE_PRESENCE_SIGNAL = 'presence.signal' as const;
export const MSG_TYPE_COORDINATION_REQUEST = 'coordination.request' as const;
export const MSG_TYPE_COORDINATION_RESPONSE = 'coordination.response' as const;
export const MSG_TYPE_SOCIAL_UPDATE = 'social.update' as const;
export const MSG_TYPE_SAFETY_ALERT = 'safety.alert' as const;
export const MSG_TYPE_PEERLENS_VOUCH_REQUEST = 'peerlens.vouch.request' as const;
export const MSG_TYPE_PEERLENS_VOUCH_RESPONSE = 'peerlens.vouch.response' as const;
export const MSG_TYPE_SERVICE_QUERY = 'service.query' as const;
export const MSG_TYPE_SERVICE_RESPONSE = 'service.response' as const;
/**
 * `service.offer` — a provider proactively shares a `known_only` listing with
 * a specific contact over the direct D2D relationship (never published to PDS
 * or AppView). It carries the listing metadata (capability + schema +
 * service_uri) the contact's Dina needs to call the service later. Added in
 * protocol v1.1 (additive — see conformance.md §14).
 */
export const MSG_TYPE_SERVICE_OFFER = 'service.offer' as const;
/**
 * `service.grant_request` — a contact's REQUESTER-INITIATED preflight for a
 * relationship service (`surface:'talk'`, `known_only`). When a contact has no
 * grant yet, their Dina asks for one by naming a CAPABILITY (never a private
 * listing rkey, which the requester cannot know). The provider resolves the
 * capability to its matching `surface:'talk'` listing, applies the
 * closeness/default-offerable policy, and (on allow) replies with a
 * `service.offer` carrying the grant_id + service_uri. Ephemeral (never
 * vaulted). docs/CONTACT_SERVICES_ARCHITECTURE.md §5.2. Protocol v1.1 (additive).
 */
export const MSG_TYPE_SERVICE_GRANT_REQUEST = 'service.grant_request' as const;

/** Union of all V1 D2D message type strings. */
export type D2DMessageType =
  | typeof MSG_TYPE_PRESENCE_SIGNAL
  | typeof MSG_TYPE_COORDINATION_REQUEST
  | typeof MSG_TYPE_COORDINATION_RESPONSE
  | typeof MSG_TYPE_SOCIAL_UPDATE
  | typeof MSG_TYPE_SAFETY_ALERT
  | typeof MSG_TYPE_PEERLENS_VOUCH_REQUEST
  | typeof MSG_TYPE_PEERLENS_VOUCH_RESPONSE
  | typeof MSG_TYPE_SERVICE_QUERY
  | typeof MSG_TYPE_SERVICE_RESPONSE
  | typeof MSG_TYPE_SERVICE_OFFER
  | typeof MSG_TYPE_SERVICE_GRANT_REQUEST;

/**
 * Types that the protocol guarantees are NEVER staged into the persona vault.
 * "Ephemeral" here means "not a vault message item" — it does NOT mean "no
 * effect": `service.query` mints a workflow task, and `service.offer` is
 * persisted as CONTACT metadata (identity.sqlite `contact_service_offers`),
 * not as vault content. Receivers MUST keep all of these out of vault staging.
 */
export type EphemeralD2DType =
  | typeof MSG_TYPE_PRESENCE_SIGNAL
  | typeof MSG_TYPE_SERVICE_QUERY
  | typeof MSG_TYPE_SERVICE_RESPONSE
  | typeof MSG_TYPE_SERVICE_OFFER
  | typeof MSG_TYPE_SERVICE_GRANT_REQUEST;

/**
 * Types that DO persist into the vault. Computed from `D2DMessageType`
 * minus `EphemeralD2DType` so adding a new V1 type forces a compile-time
 * decision — either list it as ephemeral, or register a vault mapping
 * for it. No silent fall-through.
 */
export type StorableD2DType = Exclude<D2DMessageType, EphemeralD2DType>;

// ─── D2D scenarios (sharing-policy buckets) ──────────────────────────────
//
// Every V1 message type belongs to exactly one scenario. Sharing policies
// are stored per-(contact, scenario) — adding a new scenario is a wire
// concern because partner Home Nodes must agree on what the user has
// granted. Each language port (Go: `domain/message.go`, Rust/Swift/...)
// must mirror this list and the message-type → scenario mapping.

/**
 * The full set of D2D scenario names. Frozen as a const tuple so
 * {@link D2DScenario} stays a strict literal union.
 */
export const D2D_SCENARIOS = [
  'presence',
  'coordination',
  'social',
  'safety',
  'trust',
  'service',
] as const;

/** Strict union type for D2D scenario names. */
export type D2DScenario = (typeof D2D_SCENARIOS)[number];

// ─── D2D size + TTL limits ───────────────────────────────────────────────

/** Maximum D2D message body size in bytes (256 KiB). Core enforces on ingress. */
export const MAX_MESSAGE_BODY_SIZE = 256 * 1024;

/** Maximum `ttl_seconds` on `service.query` (5 minutes). */
export const MAX_SERVICE_TTL = 300;

// ─── Core RPC envelope type strings ──────────────────────────────────────

/** Outer `type` field on a Core RPC request envelope. */
export const RPC_REQUEST_TYPE = 'core_rpc_request' as const;

/** Outer `type` field on a Core RPC response envelope. */
export const RPC_RESPONSE_TYPE = 'core_rpc_response' as const;

// ─── Notification priorities (Four Laws) ─────────────────────────────────
// The three-level priority stack comes from the README's Law 1 ("Silence
// First"). Wire values are locked — these strings cross the Core↔client
// WebSocket push envelope.

/** Interrupt — silence would cause harm. Runtime bypasses quiet hours. */
export const NOTIFY_PRIORITY_FIDUCIARY = 'fiduciary' as const;

/** Notify — the user asked for this. Runtime respects quiet hours. */
export const NOTIFY_PRIORITY_SOLICITED = 'solicited' as const;

/** Save for briefing — silence merely misses an opportunity. */
export const NOTIFY_PRIORITY_ENGAGEMENT = 'engagement' as const;

/** Discriminated union of notify-priority wire values. */
export type NotifyPriority =
  | typeof NOTIFY_PRIORITY_FIDUCIARY
  | typeof NOTIFY_PRIORITY_SOLICITED
  | typeof NOTIFY_PRIORITY_ENGAGEMENT;
