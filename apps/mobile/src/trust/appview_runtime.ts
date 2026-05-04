/**
 * Mobile-side AppView runtime.
 *
 * Resolves AppView through the shared TypeScript Home Node endpoint
 * policy and exposes typed fetchers for the `com.dina.trust.*` xRPC
 * surface the Trust screens consume.
 *
 * Why a focused fetcher rather than `TrustQueryClient` from
 * `@dina/core`: the screens need three endpoints the upstream client
 * doesn't surface yet — `subjectGet`, `getAttestations`, `networkFeed`
 * — and pulling them all through the same low-level fetch keeps the
 * mobile build dependency-free and lets the screens treat AppView as a
 * pure HTTP boundary. When `TrustQueryClient` adopts these endpoints
 * we can switch over without touching the screen-side hooks.
 *
 * URL precedence comes from `@dina/home-node`: mobile env overrides
 * may replace specific endpoints, otherwise endpoint mode selects the
 * hosted test or release fleet as one unit.
 */

import { resolveMobileHostedDinaEndpoints } from '@dina/home-node';

const DEFAULT_TIMEOUT_MS = 10_000;

function configuredURL(): string {
  return resolveMobileHostedDinaEndpoints().appViewBaseUrl;
}

const APPVIEW_URL = configuredURL();

export function getAppViewURL(): string {
  return APPVIEW_URL;
}

export class AppViewError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'AppViewError';
  }
}

async function getJSON<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${APPVIEW_URL}${path}${qs ? `?${qs}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AppViewError(
        `HTTP ${res.status} on ${path}${body ? `: ${body.slice(0, 200)}` : ''}`,
        res.status,
        path,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wire types — mirror AppView responses verbatim ───────────────────────

export interface SearchAttestationHit {
  uri: string;
  authorDid: string;
  /**
   * Author's display handle (`alsoKnownAs[0]` minus `at://`). `null`
   * when AppView hasn't backfilled it yet OR when the DID owner
   * never published one. Search result cards render this when
   * present; fall back via `displayName(handle, did)`.
   */
  authorHandle: string | null;
  cid: string;
  subjectId: string;
  subjectRefRaw: {
    type: 'did' | 'organization' | 'product' | 'content' | 'dataset' | 'place' | 'claim';
    did?: string;
    name?: string;
    uri?: string;
    domain?: string;
  };
  category: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  text: string | null;
  confidence?: 'certain' | 'high' | 'moderate' | 'speculative' | null;
  recordCreatedAt: string;
}

export interface SearchResponse {
  results: SearchAttestationHit[];
  totalEstimate: number | null;
}

export interface AttestationSummary {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
}

export interface ReviewerStats {
  totalAttestationsBy: number;
  corroborationRate: number;
  evidenceRate: number;
  helpfulRatio: number;
}

export interface TrustProfile {
  did: string;
  /**
   * Display handle from PLC `alsoKnownAs[0]`. `null` when AppView
   * hasn't backfilled it yet OR the DID has no published handle.
   * Render via `displayName(handle, did)` for the consistent
   * fallback.
   */
  handle: string | null;
  overallTrustScore: number | null;
  attestationSummary: AttestationSummary;
  vouchCount: number;
  endorsementCount: number;
  reviewerStats: ReviewerStats;
  activeDomains: string[];
  lastActive: string | null;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────

export async function searchAttestations(q: string, limit = 25): Promise<SearchResponse> {
  return getJSON<SearchResponse>('/xrpc/com.dina.trust.search', {
    q,
    limit: String(limit),
  });
}

/**
 * Fetch attestations authored by `authorDid` — the "reviews I (or
 * they) wrote" surface used by the reviewer profile screen.
 *
 * Reuses the same `com.dina.trust.search` xRPC: `q` is optional on
 * that endpoint, and supplying `authorDid` alone returns every
 * (non-revoked) attestation by the author. Sort defaults to `recent`
 * because there's no FTS query to rank against — the natural
 * ordering for an "I wrote" list is reverse chronological anyway.
 */
export async function searchAttestationsByAuthor(
  authorDid: string,
  limit = 25,
): Promise<SearchResponse> {
  return getJSON<SearchResponse>('/xrpc/com.dina.trust.search', {
    authorDid,
    sort: 'recent',
    limit: String(limit),
  });
}

export async function getProfile(did: string): Promise<TrustProfile | null> {
  // AppView returns 200 OK + literal `null` body for DIDs without a
  // `did_profiles` row — caller must handle null (no profile yet).
  return getJSON<TrustProfile | null>('/xrpc/com.dina.trust.getProfile', { did });
}

// ─── Subject detail wire types ────────────────────────────────────────────

export type SubjectTrustBand = 'high' | 'moderate' | 'low' | 'very-low' | 'unrated';

export interface SubjectGetReviewer {
  did: string;
  /**
   * Reviewer's display handle from the PLC document
   * (`alsoKnownAs[0]` minus `at://`). `null` when the AppView
   * hasn't backfilled it yet OR when the DID owner never published
   * one. Mobile clients render this when present and fall back to a
   * truncated DID when null — see `truncateDid` in the runners.
   */
  handle: string | null;
  trustScore: number | null;
  trustBand: SubjectTrustBand;
  attestation: {
    uri: string;
    text: string | null;
    sentiment: 'positive' | 'neutral' | 'negative';
    createdAt: string;
  };
}

export interface SubjectGetResponse {
  subject: {
    type: string;
    did?: string;
    name?: string;
    identifiers?: unknown[];
  } | null;
  score: number | null;
  band: SubjectTrustBand;
  reviewCount: number;
  reviewers: {
    /**
     * The viewer's own attestations on this subject, when they
     * reviewed it themselves. Optional for backwards compatibility
     * with older AppView builds that didn't surface this group —
     * defaults to `[]` on the consumer side.
     */
    self?: SubjectGetReviewer[];
    contacts: SubjectGetReviewer[];
    extended: SubjectGetReviewer[];
    strangers: SubjectGetReviewer[];
  };
}

export async function subjectGet(
  subjectId: string,
  viewerDid: string,
): Promise<SubjectGetResponse> {
  return getJSON<SubjectGetResponse>('/xrpc/com.dina.trust.subjectGet', {
    subjectId,
    viewerDid,
  });
}

// ─── Network feed wire types ──────────────────────────────────────────────

/**
 * Wire shape of `com.dina.trust.networkFeed` rows. The server returns
 * the raw `attestations` table row with snake_case → camelCase via
 * Drizzle, so most fields land here unchanged. We only consume the
 * subset the trust feed surface needs (subject + author + headline);
 * the rest is kept loose to avoid maintaining a duplicate of the
 * schema's JSON columns.
 */
export interface NetworkFeedAttestation {
  uri: string;
  authorDid: string;
  /**
   * Author's display handle (`alsoKnownAs[0]` minus `at://`). `null`
   * when the AppView hasn't backfilled it yet OR when the DID owner
   * never published one. Mobile renders this when present, falling
   * back to a truncated DID via `displayName(handle, did)`.
   */
  authorHandle: string | null;
  subjectId: string | null;
  subjectRefRaw: {
    type: 'did' | 'organization' | 'product' | 'content' | 'dataset' | 'place' | 'claim';
    did?: string;
    name?: string;
    uri?: string;
    domain?: string;
    identifier?: string;
  };
  category: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  text: string | null;
  recordCreatedAt: string;
  isRevoked: boolean;
}

export interface NetworkFeedResponse {
  attestations: NetworkFeedAttestation[];
  cursor?: string;
}

export async function networkFeed(
  viewerDid: string,
  limit = 25,
  cursor?: string,
): Promise<NetworkFeedResponse> {
  const params: Record<string, string> = {
    viewerDid,
    limit: String(limit),
  };
  if (cursor !== undefined && cursor.length > 0) params.cursor = cursor;
  return getJSON<NetworkFeedResponse>('/xrpc/com.dina.trust.networkFeed', params);
}

// ─── Test-mode write endpoints ────────────────────────────────────────────
//
// These talk to the AppView's `com.dina.test.*` test-inject surface.
// Production publish flows through the user's PDS + Jetstream; the
// test endpoints are a DEV-only shortcut that lets the mobile UI write
// to AppView without standing up real PDS auth. Gated server-side on
// `DINA_TEST_INJECT=1` + bearer-token match (see appview's
// test-inject.ts) — production deploys leave the env vars unset and
// the endpoints return 404.
//
// The auth token is bundled at build time via
// `EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN`. This is intentional: the token
// is a TEST-MODE secret, not a user secret. It exists so a probe of
// the endpoint can't enumerate it; it's not meant to protect end-user
// data. When real PDS publish lands, this whole path retires.

export interface SubjectRefBody {
  type: 'product' | 'place' | 'organization' | 'content' | 'did' | 'dataset' | 'claim';
  did?: string;
  uri?: string;
  name?: string;
  identifier?: string;
}

export interface InjectAttestationRequest {
  authorDid: string;
  rkey: string;
  cid: string;
  record: {
    subject: SubjectRefBody;
    category: string;
    sentiment: 'positive' | 'neutral' | 'negative';
    confidence?: 'certain' | 'high' | 'moderate' | 'speculative';
    text?: string;
    domain?: string;
    tags?: string[];
    createdAt: string;
    // ── V2 wire fields (TN-V2-MOBILE-WIRE) — every field optional; ──
    // mobile populates them from the compose form's V2 inputs and
    // omits empty ones so AppView's empty-array → NULL collapse stays
    // a cheap server-side pass. Mirror of the V2 fields in
    // `appview/src/shared/types/lexicon-types.ts` Attestation.
    useCases?: string[];
    lastUsedMs?: number;
    reviewerExperience?: 'novice' | 'intermediate' | 'expert';
    recommendFor?: string[];
    notRecommendFor?: string[];
    alternatives?: SubjectRefBody[];
    compliance?: string[];
    accessibility?: string[];
    compat?: string[];
    price?: { low_e7: number; high_e7: number; currency: string; lastSeenMs: number };
    availability?: { regions?: string[]; shipsTo?: string[]; soldAt?: string[] };
    schedule?: { leadDays?: number; seasonal?: number[] };
  };
}

export interface InjectAttestationResponse {
  uri: string;
  cid: string;
}

export interface DeleteAttestationResponse {
  revocationUri: string;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const url = `${APPVIEW_URL}${path}`;
  const token = process.env.EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(typeof token === 'string' && token.length > 0
          ? { Authorization: `Bearer ${token}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppViewError(
        `HTTP ${res.status} on ${path}${text ? `: ${text.slice(0, 200)}` : ''}`,
        res.status,
        path,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function injectAttestation(
  body: InjectAttestationRequest,
): Promise<InjectAttestationResponse> {
  return postJSON<InjectAttestationResponse>(
    '/xrpc/com.dina.test.injectAttestation',
    body,
  );
}

export async function deleteAttestation(
  authorDid: string,
  uri: string,
): Promise<DeleteAttestationResponse> {
  return postJSON<DeleteAttestationResponse>(
    '/xrpc/com.dina.test.deleteAttestation',
    { authorDid, uri },
  );
}

export function isTestPublishConfigured(): boolean {
  const token = process.env.EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN;
  return typeof token === 'string' && token.length > 0;
}
