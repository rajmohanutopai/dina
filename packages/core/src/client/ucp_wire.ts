/**
 * The Brain-side wire of a UCP merchant search (UCP plan §3.11, §3.16):
 * request bodies and the parsers both transports share, so the HTTP and
 * in-process clients read Core's answers identically. Refusals are values,
 * never throws. The types live in `core-client.ts`.
 */

import type {
  UcpCartCall,
  UcpCheckoutCall,
  UcpShopResult,
  UcpFetchInput,
  UcpFetchResult,
  UcpSearchMerchant,
  UcpGuardVerdictInput,
  UcpGuardVerdictResult,
  UcpSearchInput,
  UcpSearchResult,
  UcpSearchReviewResult,
} from './core-client';

const record = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

const errorOf = (raw: unknown): string => {
  const e = record(raw).error;
  return typeof e === 'string' ? e : 'response_malformed';
};

export function ucpSearchBody(input: UcpSearchInput): Record<string, unknown> {
  return {
    release_session: input.releaseSession,
    query: input.query,
    ...(input.merchants !== undefined ? { merchants: [...input.merchants] } : {}),
    ...(input.reviewId !== undefined ? { review_id: input.reviewId } : {}),
  };
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : undefined;

export function parseUcpSearchResponse(status: number, raw: unknown): UcpSearchResult {
  const r = record(raw);
  if (status === 200 && typeof r.search_id === 'string' && Array.isArray(r.merchants)) {
    return {
      ok: true,
      searchId: r.search_id,
      merchants: r.merchants as UcpSearchMerchant[],
      provenance: r.provenance === 'quoted' ? 'quoted' : 'derived',
    };
  }
  const why = strings(r.why);
  // The owner's allowed shops, when Brain must choose among them (`choose_merchants`).
  const allowed = strings(r.allowed);
  return {
    ok: false,
    status,
    reason: errorOf(raw),
    ...(why !== undefined ? { why } : {}),
    ...(allowed !== undefined ? { allowed } : {}),
  };
}

export function ucpFetchBody(input: UcpFetchInput): Record<string, unknown> {
  return { release_session: input.releaseSession, products: [...input.products] };
}

export function parseUcpFetchResponse(status: number, raw: unknown): UcpFetchResult {
  const r = record(raw);
  if (status === 200 && typeof r.search_id === 'string' && Array.isArray(r.merchants)) {
    return {
      ok: true,
      searchId: r.search_id,
      merchants: r.merchants as UcpSearchMerchant[],
      missing: Array.isArray(r.missing)
        ? r.missing.filter((h): h is string => typeof h === 'string')
        : [],
    };
  }
  return { ok: false, status, reason: errorOf(raw) };
}

export function parseUcpSearchReviewResponse(status: number, raw: unknown): UcpSearchReviewResult {
  const r = record(raw);
  if (status === 201 && typeof r.review_id === 'string' && typeof r.expires_at === 'number') {
    return { ok: true, reviewId: r.review_id, expiresAt: r.expires_at };
  }
  // The owner's allowed shops, when Brain must choose among them (`choose_merchants`).
  const allowed = strings(r.allowed);
  return { ok: false, status, reason: errorOf(raw), ...(allowed !== undefined ? { allowed } : {}) };
}

export function ucpGuardVerdictBody(input: UcpGuardVerdictInput): Record<string, unknown> {
  return {
    job_id: input.jobId,
    claim_id: input.claimId,
    digest: input.digest,
    verdict: input.verdict,
    code: input.code,
  };
}

export function parseUcpGuardVerdictResponse(status: number, raw: unknown): UcpGuardVerdictResult {
  if (status !== 200) return { ok: false, status, reason: errorOf(raw) };
  const state = record(raw).state;
  return state === 'passed' || state === 'blocked'
    ? { ok: true, state }
    : { ok: false, status, reason: 'response_malformed' };
}

const lines = (ls: readonly { variant: string; quantity: number }[]) =>
  ls.map((l) => ({ variant: l.variant, quantity: l.quantity }));

export function ucpCartBody(input: UcpCartCall): Record<string, unknown> {
  return {
    release_session: input.releaseSession,
    op: input.op,
    ...('cartId' in input ? { cart_id: input.cartId } : {}),
    ...('lines' in input ? { lines: lines(input.lines) } : {}),
  };
}

export function ucpCheckoutBody(input: UcpCheckoutCall): Record<string, unknown> {
  return {
    release_session: input.releaseSession,
    op: input.op,
    ...('sessionId' in input ? { session_id: input.sessionId } : {}),
    ...('lines' in input ? { lines: lines(input.lines) } : {}),
    ...('discountCodes' in input && input.discountCodes !== undefined
      ? { discount_codes: [...input.discountCodes] }
      : {}),
    ...('choice' in input ? { choice: input.choice, rev: input.rev } : {}),
  };
}

/** A cart or checkout answer: its body on success, its refusal otherwise. */
export function parseUcpShopResponse(status: number, raw: unknown): UcpShopResult {
  if (status === 200 || status === 201) return { ok: true, status, body: record(raw) };
  const detail = record(raw).detail;
  return {
    ok: false,
    status,
    reason: errorOf(raw),
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}
