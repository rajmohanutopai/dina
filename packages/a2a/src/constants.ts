/**
 * Pinned A2A facts (docs/A2A_GATEWAY_ARCHITECTURE.md §2, A2A v1.0.1,
 * `specification/a2a.proto`, package `lf.a2a.v1`).
 */

/** Where a Dina gateway serves the JSON-RPC binding (the REST binding is under `A2A_REST_PATH`). */
export const A2A_RPC_PATH = '/a2a/v1';

/** The only protocol version Dina speaks; `Major.Minor`, never a patch (spec §3.6). */
export const A2A_PROTOCOL_VERSION = '1.0';

/**
 * The one `A2A-Version` grammar, for every door: `Major.Minor` with an
 * optional patch, digits in canonical form (no leading zeros), so `01.0`
 * and `1.00` are not versions.
 */
export const A2A_VERSION_GRAMMAR = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})(?:\.(0|[1-9][0-9]{0,5}))?$/;

/**
 * Whether a client's `A2A-Version` names the version Dina speaks. The value
 * is `Major.Minor`; a patch number should not be sent, and negotiation
 * matches `Major.Minor` only, so `1.0.1` reads as `1.0` (spec §3.6). An
 * empty value means 0.3, which Dina does not speak. Same grammar as
 * `checkRequestedVersion`.
 */
export function speaksA2AVersion(value: string): boolean {
  const m = A2A_VERSION_GRAMMAR.exec(value.trim());
  return m !== null && `${m[1] ?? ''}.${m[2] ?? ''}` === A2A_PROTOCOL_VERSION;
}

/** An empty `A2A-Version` means 0.3 (spec §3.6.2), which Dina does not speak. */
export const A2A_EMPTY_VERSION_MEANS = '0.3';

export const A2A_VERSION_HEADER = 'A2A-Version';
export const A2A_EXTENSIONS_HEADER = 'A2A-Extensions';

/** Where every A2A server serves its public card (spec §8.2). */
export const AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json';

/** `AgentInterface.protocolBinding` values Dina declares (spec §5.3). */
export const PROTOCOL_BINDING_JSONRPC = 'JSONRPC';
export const PROTOCOL_BINDING_HTTP_JSON = 'HTTP+JSON';

export const JSON_MEDIA_TYPE = 'application/json';

/**
 * The Dina extension (design §7.6). The version lives in the URI because
 * v1.0 extensions carry no version field; a breaking change mints a new URI.
 */
export const DINA_A2A_EXTENSION_URI = 'https://dinakernel.com/a2a/ext/v1';

/** Size caps (design §6.6, §7.2 step 3, §8.3). */
/**
 * The longest a `SendMessage` that did not ask to return at once waits for
 * its task to end or be interrupted (A2A `returnImmediately`, false by
 * default: "the operation MUST wait until the task reaches a terminal ...
 * or interrupted ... state"). A call runs for up to ten minutes and a
 * reviewed one waits on the owner for a day; no HTTP hop holds a request
 * that long. Past this, Core does not hand back an unfinished task as the
 * answer: it answers an error that names the task (reason
 * `wait_deadline_exceeded`), and the task goes on. The client reads the rest
 * with GetTask, a stream or its webhook, or sends the same message again
 * and waits again. The gateway's forward of `SendMessage` waits longer than
 * this.
 */
export const A2A_SEND_WAIT_MS = 10_000;

export const A2A_LIMITS = Object.freeze({
  /** A fetched or published Agent Card, in UTF-8 bytes. */
  maxCardBytes: 128 * 1024,
  /**
   * One skill's share of a card: its entry in `skills[]` and its contract in
   * the Dina extension, canonical UTF-8 bytes, measured in its largest form
   * (granted, full envelope). No one listing can fill the card alone.
   */
  maxSkillShareBytes: 16 * 1024,
  /** A remote result, or an inbound request body, in UTF-8 bytes. */
  maxPayloadBytes: 256 * 1024,
  /** Parts in one inbound message or one released result. */
  maxParts: 16,
  /** One released text part, in Unicode code points. */
  maxTextCodePoints: 65536,
  /** Nesting depth of any JSON value Dina will canonicalize or sanitize. */
  maxJsonDepth: 32,
});
