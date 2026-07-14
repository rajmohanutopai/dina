/**
 * Plugin wire contract — record types for the two-record release scheme
 * plus the manifest carried inside each release.
 *
 * Spec: docs/PLUGIN_ARCHITECTURE.md §3 (vocabulary), §5 (manifest + its
 * records). Three record types:
 *
 *   com.dinakernel.plugin.release   — immutable, one per version. Carries
 *                                     the complete manifest. rkey is
 *                                     CONTENT-DERIVED (release_rkey.ts):
 *                                     rkey == f(record CID), so in-place
 *                                     overwrite fails every verifier.
 *   com.dinakernel.plugin.identity  — mutable, stable rkey = plugin_id.
 *                                     Points at the current release. Five
 *                                     pointer invariants (verifier.ts).
 *   com.dinakernel.plugin.advisory  — publisher flags compromised or
 *                                     withdrawn releases.
 *
 * Identity is `(publisherDid, plugin_id)` — never the plugin_id string
 * alone, never a CID. The CID pins a version's CONTENT only (§5 rule 2).
 *
 * Pure types + frozen constants. Zero runtime deps.
 */

import type { ActionClass, PrivacyClass } from '../types/catalog';

// ---------------------------------------------------------------------------
// Record NSIDs
// ---------------------------------------------------------------------------

export const PLUGIN_NSIDS = Object.freeze({
  release: 'com.dinakernel.plugin.release',
  identity: 'com.dinakernel.plugin.identity',
  advisory: 'com.dinakernel.plugin.advisory',
} as const);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Execution mode — one per plugin, never mixed (§19 non-goals). */
export type PluginExecutionMode = 'interpreted' | 'runner';

/**
 * Runner-mode lanes a capability may serve (§9). Declared per capability
 * in the manifest (`kinds`), validated for legal combinations, rendered
 * at consent, and inside the approved-scope hash (§8.1) — Core authorizes
 * against a consented declaration, never an inferred one.
 */
export type PluginKind = 'tool' | 'provider' | 'ingest' | 'notify';

export const PLUGIN_KINDS: readonly PluginKind[] = Object.freeze([
  'tool',
  'provider',
  'ingest',
  'notify',
]);

/** Interaction shape (§3): asymmetric query vs symmetric stateful session. */
export type PluginInteraction = 'query' | 'session';

/**
 * Effect contract (§5, §9.1). `supported` is a DECLARATION that the
 * provider deduplicates on `idempotency_key` for at least Core's retry
 * window. It is the ONLY thing that permits post-claim automatic
 * re-dispatch — declared action class is never trusted for retry safety.
 */
export type PluginIdempotency = 'supported' | 'unsupported';

/** Advisory severity levels. */
export type PluginAdvisorySeverity = 'notice' | 'warning' | 'critical';

/**
 * The closed deterministic ops library (§10.2). Grows by protocol
 * revision only (`min_interpreter` gates) — never by manifest request.
 */
export const PLUGIN_OPS = Object.freeze([
  'commit',
  'verifyCommit',
  'sharedRng',
  'compare',
  'tally',
  'counter',
  'timeoutAssert',
  'verifyFact',
] as const);

export type PluginOp = (typeof PLUGIN_OPS)[number];

// ---------------------------------------------------------------------------
// Structural caps (§5 rule 4) — numbers tunable; the existence of hard
// caps is not. Schema bombs are a real vector.
// ---------------------------------------------------------------------------

export const PLUGIN_CAPS = Object.freeze({
  /** Whole-manifest byte ceiling (canonical JSON bytes). */
  MAX_MANIFEST_BYTES: 256 * 1024,
  /** JSON Schema nesting ceiling for params/result/move/config schemas. */
  MAX_SCHEMA_DEPTH: 8,
  /** Machine: state count ceiling. */
  MAX_STATES: 64,
  /** Machine: move-type count ceiling. */
  MAX_MOVE_TYPES: 32,
  /** Machine: transitions per source state. */
  MAX_TRANSITIONS_PER_STATE: 16,
  /** Machine: ops per transition. */
  MAX_OPS_PER_TRANSITION: 32,
  /** Capabilities per manifest (not in spec table; see implementation notes). */
  MAX_CAPABILITIES: 32,
  /** intent_phrases per capability (spec: "capped + sanitized"). */
  MAX_INTENT_PHRASES: 8,
  /** Single intent phrase length. */
  MAX_PHRASE_LENGTH: 80,
  /** verify_budget ceiling per session (§21 open decision 4 — ceiling 8). */
  MAX_VERIFY_BUDGET: 8,
  /** data_scope.max_context_items ceiling (§11 point 4). */
  MAX_CONTEXT_ITEMS: 25,
  /** display_name / short_description length ceilings. */
  MAX_DISPLAY_NAME_LENGTH: 64,
  MAX_SHORT_DESCRIPTION_LENGTH: 400,
  /** network_domains entries per capability. */
  MAX_NETWORK_DOMAINS: 16,
  // --- Round-16 bounds (fail-closed anti-amplification / anti-spoof) ---
  /** #14: data_scope.categories / .personas entry count + per-entry length. */
  MAX_DATA_CATEGORIES: 32,
  MAX_DATA_PERSONAS: 32,
  MAX_DATA_SCOPE_ENTRY_LENGTH: 64,
  /** #15: required_features count + per-token length (owner-rendered). */
  MAX_REQUIRED_FEATURES: 32,
  MAX_REQUIRED_FEATURE_LENGTH: 64,
  /** #16: JSON-Schema property-name + annotation-string length (consent forms). */
  MAX_SCHEMA_PROP_NAME_LENGTH: 128,
  MAX_SCHEMA_ANNOTATION_LENGTH: 400,
  /** #17: validator diagnostic count ceiling (output-amplification guard). */
  MAX_DIAGNOSTICS: 200,
  /** #13: JSON-Schema enum member count (runtime deep-equal scan is O(n)). */
  MAX_ENUM_MEMBERS: 100,
  /** #10: interpreted machine timeout ceilings (seconds). Both stay below the
   *  int32-ms overflow threshold (~2.1M s ≈ 24.8 days) so language ports that
   *  convert to milliseconds don't overflow, while allowing legitimate async
   *  turn-based games (a per-move wait up to a week, a session up to two). */
  MAX_MOVE_SEC: 604_800, // 7 days
  MAX_SESSION_TTL_SEC: 1_209_600, // 14 days
  /** #18: icon blob-ref serialized-byte ceiling. */
  MAX_ICON_BYTES: 1024,
  // --- Round-17 (PLG-27) bounds (fail-closed anti-amplification / anti-spoof) ---
  /** #10: schema-problem collector budget. `collectSchemaProblems` walks the
   *  whole (byte-capped) schema; without a collector-level bound the joined
   *  diagnostic string is super-linear in a wide manifest even though the
   *  `err()` sink caps the diagnostic COUNT. Stop collecting past this. */
  MAX_SCHEMA_PROBLEMS: 200,
  /** #12: JSON-Schema collection cardinality — property-key count, required
   *  entry count, and `type`-array length. A 256 KB manifest otherwise packs
   *  thousands of entries that inflate consent rendering + every runtime
   *  validation. */
  MAX_SCHEMA_PROPERTIES: 128,
  MAX_REQUIRED_ENTRIES: 128,
  MAX_TYPE_MEMBERS: 7, // KNOWN_SCHEMA_TYPES has exactly 7 members
  /** #13: shared identifier length ceiling — machine state / move names and
   *  schema property names all use one `isValidIdentifier` contract. */
  MAX_IDENTIFIER_LENGTH: 128,
  // --- Round-18 (PLG-28) bounds ---
  /** #11: interpreted-machine `instructions` LLM-step length ceiling (multi-line
   *  text; feeds the §8.1 behavior hash + the future interpreter prompt). */
  MAX_INSTRUCTIONS_LENGTH: 4000,
} as const);

/**
 * Anti-Her ban (§5 rule 3): companionship / emotional-intimacy
 * capabilities are rejected at ingest AND at install — enforced twice.
 */
export const PLUGIN_BANNED_CATEGORIES: readonly string[] = Object.freeze([
  'companionship',
  'emotional_intimacy',
  'romantic',
  'virtual_friend',
]);

// ---------------------------------------------------------------------------
// Manifest shapes
// ---------------------------------------------------------------------------

/**
 * Optional runtime evidence (§12 evidence tiers): a runner manifest may
 * pin what it truthfully can. Evidence buys LEGIBILITY (pinned
 * self-hosted artifact vs signed vendor deployment vs opaque hosted
 * service) — never proof of hosted behavior.
 */
export interface PluginRuntimeArtifacts {
  readonly npm_integrity?: string;
  readonly image_digest?: string;
  readonly source_commit?: string;
  readonly provenance?: string;
}

/**
 * Manifest-authorized runtime issuer (§14). For hosted runners the
 * instance certificate is signed by THIS issuer, not the repo DID (a
 * community PDS holds the repo signing key, so the publisher's
 * application cannot sign with it). Inside the approved-scope hash:
 * rotating the issuer is a re-consent event.
 */
export interface PluginRuntimeIssuer {
  readonly did: string;
  /** Multibase-encoded public key the issuer signs instance certs with. */
  readonly key: string;
}

export interface PluginSelfHost {
  readonly npm?: string;
  readonly docker?: string;
}

export interface PluginRuntime {
  readonly hosted_endpoint?: string;
  readonly issuer?: PluginRuntimeIssuer;
  readonly self_host?: PluginSelfHost;
  readonly artifacts?: PluginRuntimeArtifacts;
}

export interface PluginExecution {
  readonly mode: PluginExecutionMode;
  readonly runtime?: PluginRuntime;
}

/** One transition in an interpreted-mode state machine (§5, §10.3). */
export interface PluginMachineTransition {
  readonly from: string;
  readonly move: string;
  readonly ops: readonly string[];
  readonly to: string;
}

/**
 * Interpreted-session state machine (§5). Transitions are total
 * functions at runtime; here we pin the declared shape. `timeouts` are
 * behavior-hash material (§8.1): pressure- and spam-relevant.
 */
export interface PluginMachine {
  readonly initial: string;
  readonly states: readonly string[];
  /** move type → JSON Schema for its body. */
  readonly moves: Readonly<Record<string, unknown>>;
  readonly transitions: readonly PluginMachineTransition[];
  readonly turn: 'alternate' | 'free';
  readonly timeouts: { readonly move_sec: number; readonly session_ttl_sec: number };
  readonly terminal: readonly string[];
}

export interface PluginEffects {
  readonly idempotency: PluginIdempotency;
}

export interface PluginDataScope {
  readonly categories: readonly string[];
  readonly personas?: readonly string[];
  readonly max_context_items?: number;
}

export interface PluginCapabilityDecl {
  /** Custom reverse-DNS id (or canonical catalog id). */
  readonly id: string;
  readonly display_name: string;
  readonly interaction: PluginInteraction;
  readonly action_class: ActionClass;
  readonly privacy_class: PrivacyClass;
  readonly params_schema?: unknown;
  readonly result_schema?: unknown;
  /** Card-spec hints for renders (validated untrusted at render time). */
  readonly card?: unknown;

  // interpreted + session only:
  readonly machine?: PluginMachine;
  readonly ops_used?: readonly string[];
  readonly verify_budget?: number;
  /** Optional LLM step text — isolated context only (§10.4). */
  readonly instructions?: string | null;

  // runner mode only:
  readonly kinds?: readonly PluginKind[];
  readonly effects?: PluginEffects;
  readonly intent_phrases?: readonly string[];
  readonly data_scope?: PluginDataScope;
  /** Consent-card transparency, not a firewall (§17 honesty clause). */
  readonly network_domains?: readonly string[];
}

/**
 * The manifest — carried in full inside each `plugin.release` record.
 * `$type` is the release record type; the manifest IS the release body.
 */
export interface PluginManifest {
  readonly $type: typeof PLUGIN_NSIDS.release;
  /** Equals the identity record's rkey. Identity = (publisherDid, plugin_id). */
  readonly plugin_id: string;
  /** Semver label for humans; the CID is the real pin (§5). */
  readonly version: string;
  readonly display_name: string;
  readonly short_description?: string;
  /** Blob ref for the marketplace icon (opaque here; AppView validates). */
  readonly icon?: unknown;
  readonly homepage?: string;
  readonly source_url?: string;
  /** Interpreted: node refuses constructs it doesn't know. */
  readonly min_interpreter?: number;
  /** Runner: envelope/lifecycle contract version (§5, §14). */
  readonly min_plugin_protocol?: number;
  /**
   * Declarations only ADD — the installer derives the real requirement
   * set from manifest structure and unions this in (§14). Fail closed
   * on unknown features.
   */
  readonly required_features?: readonly string[];
  readonly execution: PluginExecution;
  readonly capabilities: readonly PluginCapabilityDecl[];
  /** Owner-facing settings form. NON-SECRET preferences only (§5 rule 6). */
  readonly config_schema?: unknown;
}

// ---------------------------------------------------------------------------
// Identity + advisory records
// ---------------------------------------------------------------------------

/**
 * Mutable pointer record, stable rkey = plugin_id. Shape frozen with the
 * lexicons (§5). Five pointer invariants — a pointer failing any is
 * treated as NO pointer at all (verifier.ts `checkIdentityPointer`).
 */
export interface PluginIdentityRecord {
  readonly $type: typeof PLUGIN_NSIDS.identity;
  readonly plugin_id: string;
  readonly current: {
    /** AT-URI of the current release record. */
    readonly uri: string;
    /** CID of the current release record. */
    readonly cid: string;
    /** MUST equal the release's own `version` (invariant 5). */
    readonly version: string;
  };
}

/**
 * Advisory record (§5, §14): publisher flags releases as compromised or
 * withdrawn. CIDs are unordered hashes, so the range is expressed over
 * semver WITH an explicit CID list, never over CIDs alone. Version
 * strings are labels — enforcement keys on `affected_cids`.
 */
export interface PluginAdvisory {
  readonly $type: typeof PLUGIN_NSIDS.advisory;
  readonly plugin_id: string;
  readonly version_range: string;
  readonly affected_cids: readonly string[];
  readonly severity: PluginAdvisorySeverity;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Reserved lane prefix (§3): keyed on the INSTALL, never the
// publisher-chosen id, so same-named plugins from different publishers
// cannot collide. Mirrors the `dina.local` reserved-lane precedent.
// ---------------------------------------------------------------------------

export const PLUGIN_LANE_PREFIX = 'plugin:';

/** Build the workflow lane for an install: `plugin:<install_id>`. */
export function pluginLane(installId: string): string {
  return `${PLUGIN_LANE_PREFIX}${installId}`;
}

/** True iff `runner` names a plugin lane. */
export function isPluginLane(runner: string): boolean {
  return runner.startsWith(PLUGIN_LANE_PREFIX) && runner.length > PLUGIN_LANE_PREFIX.length;
}

/** Extract the install id from a plugin lane, or null. */
export function installIdFromLane(runner: string): string | null {
  return isPluginLane(runner) ? runner.slice(PLUGIN_LANE_PREFIX.length) : null;
}
