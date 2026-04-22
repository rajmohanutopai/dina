/**
 * Task 6.11 — `com.dina.trust.resolve` xRPC client.
 *
 * AppView's trust endpoint returns the weighted trust picture for a
 * subject DID:
 *
 *   - **scores** — numeric aggregates (weighted, confidence,
 *     attestation counts).
 *   - **didProfile** — identity-level signals (overall score, vouch
 *     count, tombstone count).
 *   - **flags** — open flags with severity.
 *   - **graphContext** — shortest-path + trusted-attestor info.
 *   - **authenticity** — classifier assessment (human / AI /
 *     unknown) + confidence.
 *   - **context** — echo of the caller-supplied usage context
 *     (`"before-transaction"`, `"share-pii"`, …).
 *
 * This module is the typed client — it validates the response
 * shape + maps the xRPC output into the structure
 * `computeRecommendation` (AppView's recommendation algorithm)
 * consumes. The companion primitive `TrustScoreResolver` (task
 * 6.21) then caches the result + feeds it into `decideTrust`
 * (task 6.23).
 *
 * **Never throws on non-2xx** — AppView 404 / 5xx land in a
 * structured rejection (`{ok: false, reason}`) so callers can
 * switch on the kind + apply their own retry policy.
 *
 * **Pluggable fetcher**: Production wires to Core's signed HTTP
 * client (5.9); tests pass scripted stubs. The fetcher returns a
 * raw JSON body OR throws on network failure; this primitive
 * handles the rest.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6d task 6.11.
 */

export type TrustContext =
  | 'before-transaction'
  | 'share-pii'
  | 'autonomous-action'
  | 'read';

export interface TrustResolveRequest {
  did: string;
  context?: TrustContext | null;
}

/** Scores aggregate — null fields mean "no data available". */
export interface TrustScoresView {
  weightedScore: number | null;
  confidence: number | null;
  totalAttestations: number | null;
  positive: number | null;
  negative: number | null;
  verifiedAttestationCount: number | null;
}

export interface TrustDidProfileView {
  overallTrustScore: number | null;
  vouchCount: number | null;
  activeFlagCount: number | null;
  tombstoneCount: number | null;
}

export interface TrustFlag {
  flagType: string;
  severity: 'critical' | 'serious' | 'warning' | 'info';
}

export interface TrustGraphContext {
  /** Shortest path in hops (null when unknown). */
  shortestPath: number | null;
  trustedAttestors: string[];
}

export interface TrustAuthenticityView {
  predominantAssessment: string;
  confidence: number | null;
}

export interface TrustResolveResponse {
  did: string;
  scores: TrustScoresView | null;
  didProfile: TrustDidProfileView | null;
  flags: TrustFlag[];
  graphContext: TrustGraphContext | null;
  authenticity: TrustAuthenticityView | null;
  context: TrustContext | null;
}

export type TrustResolveOutcome =
  | { ok: true; response: TrustResolveResponse }
  | { ok: false; reason: 'invalid_did'; detail: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'malformed_response'; detail: string }
  | { ok: false; reason: 'network_error'; error: string }
  | { ok: false; reason: 'rejected_by_appview'; status: number; error: string };

/** DID regex from 6.6 — accepts did:plc + did:web. */
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:-]+)$/;

/**
 * Raw xRPC fetcher shape. Production wires to the signed-HTTP
 * client's `xrpc.query('com.dina.trust.resolve', ...)`. Throws on
 * network failure; returns `{body: null, status: 404}` for not-found.
 */
export interface XrpcFetchResult {
  body: Record<string, unknown> | null;
  status: number;
}

export type TrustResolveFetchFn = (
  input: TrustResolveRequest,
) => Promise<XrpcFetchResult>;

export interface TrustResolveClientOptions {
  fetchFn: TrustResolveFetchFn;
  onEvent?: (event: TrustResolveEvent) => void;
}

export type TrustResolveRejectionReason =
  | 'invalid_did'
  | 'not_found'
  | 'malformed_response'
  | 'network_error'
  | 'rejected_by_appview';

export type TrustResolveEvent =
  | { kind: 'resolved'; did: string; hasScores: boolean }
  | { kind: 'rejected'; did: string; reason: TrustResolveRejectionReason };

/**
 * Create the trust-resolve xRPC client. Returns a function
 * `(input) => Promise<TrustResolveOutcome>` that production can
 * inject anywhere a resolver is needed.
 */
export function createTrustResolveClient(
  opts: TrustResolveClientOptions,
): (input: TrustResolveRequest) => Promise<TrustResolveOutcome> {
  if (typeof opts?.fetchFn !== 'function') {
    throw new TypeError('createTrustResolveClient: fetchFn is required');
  }
  const fetchFn = opts.fetchFn;
  const onEvent = opts.onEvent;

  return async function resolve(
    input: TrustResolveRequest,
  ): Promise<TrustResolveOutcome> {
    if (typeof input?.did !== 'string' || !DID_RE.test(input.did)) {
      const didStr = String(input?.did ?? '');
      onEvent?.({ kind: 'rejected', did: didStr, reason: 'invalid_did' });
      return {
        ok: false,
        reason: 'invalid_did',
        detail: `did must match did:plc or did:web format`,
      };
    }

    let result: XrpcFetchResult;
    try {
      result = await fetchFn(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({ kind: 'rejected', did: input.did, reason: 'network_error' });
      return { ok: false, reason: 'network_error', error: msg };
    }

    if (result.status === 404 || result.body === null) {
      onEvent?.({ kind: 'rejected', did: input.did, reason: 'not_found' });
      return { ok: false, reason: 'not_found' };
    }
    if (result.status < 200 || result.status >= 300) {
      const msg = typeof (result.body as { error?: unknown })?.error === 'string'
        ? ((result.body as { error: string }).error)
        : `status ${result.status}`;
      onEvent?.({
        kind: 'rejected',
        did: input.did,
        reason: 'rejected_by_appview',
      });
      return {
        ok: false,
        reason: 'rejected_by_appview',
        status: result.status,
        error: msg,
      };
    }
    const parsed = parseResponse(result.body, input.did, input.context ?? null);
    if (!parsed.ok) {
      onEvent?.({
        kind: 'rejected',
        did: input.did,
        reason: 'malformed_response',
      });
      return parsed;
    }
    onEvent?.({
      kind: 'resolved',
      did: input.did,
      hasScores: parsed.response.scores !== null,
    });
    return { ok: true, response: parsed.response };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

type ParseOk = { ok: true; response: TrustResolveResponse };
type ParseFail = { ok: false; reason: 'malformed_response'; detail: string };

function parseResponse(
  body: Record<string, unknown>,
  requestedDid: string,
  requestedContext: TrustContext | null,
): ParseOk | ParseFail {
  const did = typeof body.did === 'string' ? body.did : '';
  if (did === '' || did !== requestedDid) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: `body.did "${did}" does not match requested "${requestedDid}"`,
    };
  }
  return {
    ok: true,
    response: {
      did,
      scores: parseScores(body.scores),
      didProfile: parseDidProfile(body.didProfile),
      flags: parseFlags(body.flags),
      graphContext: parseGraph(body.graphContext),
      authenticity: parseAuthenticity(body.authenticity),
      context: (body.context as TrustContext) ?? requestedContext,
    },
  };
}

function parseScores(v: unknown): TrustScoresView | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  return {
    weightedScore: numberOrNull(s.weightedScore),
    confidence: numberOrNull(s.confidence),
    totalAttestations: integerOrNull(s.totalAttestations),
    positive: integerOrNull(s.positive),
    negative: integerOrNull(s.negative),
    verifiedAttestationCount: integerOrNull(s.verifiedAttestationCount),
  };
}

function parseDidProfile(v: unknown): TrustDidProfileView | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return {
    overallTrustScore: numberOrNull(p.overallTrustScore),
    vouchCount: integerOrNull(p.vouchCount),
    activeFlagCount: integerOrNull(p.activeFlagCount),
    tombstoneCount: integerOrNull(p.tombstoneCount),
  };
}

const VALID_SEVERITIES: ReadonlySet<TrustFlag['severity']> = new Set([
  'critical',
  'serious',
  'warning',
  'info',
]);

function parseFlags(v: unknown): TrustFlag[] {
  if (!Array.isArray(v)) return [];
  const out: TrustFlag[] = [];
  for (const entry of v) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.flagType !== 'string' || e.flagType === '') continue;
    const severity = e.severity as TrustFlag['severity'];
    if (!VALID_SEVERITIES.has(severity)) continue;
    out.push({ flagType: e.flagType, severity });
  }
  return out;
}

function parseGraph(v: unknown): TrustGraphContext | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  const attestors = Array.isArray(g.trustedAttestors)
    ? g.trustedAttestors.filter((a): a is string => typeof a === 'string')
    : [];
  return {
    shortestPath: integerOrNull(g.shortestPath),
    trustedAttestors: attestors,
  };
}

function parseAuthenticity(v: unknown): TrustAuthenticityView | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const assessment = typeof a.predominantAssessment === 'string'
    ? a.predominantAssessment
    : '';
  if (assessment === '') return null;
  return {
    predominantAssessment: assessment,
    confidence: numberOrNull(a.confidence),
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function integerOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}
