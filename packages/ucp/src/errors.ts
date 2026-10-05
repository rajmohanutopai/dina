/**
 * What kind of answer a merchant gave (overview :1835-2086; error_response.json;
 * checkout/rest.md:1316-1410):
 *
 *  - a transport error: REST 4xx/5xx with `{code, content, continue_url?}`, or an
 *    MCP JSON-RPC error whose `data` has the same shape. Keyed on `code`, never
 *    on the HTTP status alone (Shopify answers `profile_unreachable` with 422,
 *    the spec says 424; plan §3.6 step 7);
 *  - a business failure: HTTP 200 (or an MCP result) with `ucp.status: "error"`
 *    and `messages[]`, i.e. an `error_response`;
 *  - a resource (`ucp.status` absent or `success`).
 *
 * `version_unsupported` arrives in either shape (plan A4); both are read.
 */

import { isPlainObject, type JsonObject } from '@dina/a2a';

import { parseMessages, type MessagesParse } from './messages';
import { readHttpsUrl } from './resource';

export const TRANSPORT_ERROR_CODES = [
  'invalid_profile_url',
  'profile_unreachable',
  'profile_malformed',
  'version_unsupported',
  'capabilities_incompatible',
  'profile_not_trusted',
  'signature_missing',
  'signature_invalid',
  'key_not_found',
  'digest_mismatch',
  'algorithm_unsupported',
  'identity_required',
  'insufficient_scope',
] as const;

/**
 * Error codes the spec defines (its tables in the overview, signatures,
 * checkout and cart pages, and error_code.json's examples). A merchant may
 * send any string as a code; only these pass on to Brain, anything else
 * reads `other`, so a merchant's own words never ride in a code.
 */
const SPEC_ERROR_CODES: ReadonlySet<string> = new Set([
  ...TRANSPORT_ERROR_CODES,
  'not_found',
  'out_of_stock',
  'item_unavailable',
  'address_undeliverable',
  'payment_failed',
  'eligibility_invalid',
  'discount_code_expired',
  'discount_code_invalid',
  'discount_code_already_applied',
  'discount_code_combination_disallowed',
  'discount_code_user_not_logged_in',
  'discount_code_user_ineligible',
]);

/** A merchant's error code as Brain may read it: a code the spec defines, or `other`. */
export function specErrorCode(code: string): string {
  return SPEC_ERROR_CODES.has(code) ? code : 'other';
}

export type BusinessAnswer =
  | { kind: 'resource'; value: JsonObject; messages: MessagesParse }
  | { kind: 'error_response'; messages: MessagesParse; continueUrl?: string }
  | { kind: 'malformed'; reason: string };

/** Read an answer body that arrived as a success (HTTP 2xx, or an MCP result). */
export function readBusinessAnswer(value: unknown): BusinessAnswer {
  if (!isPlainObject(value)) return { kind: 'malformed', reason: 'not_object' };
  const ucp = value.ucp;
  if (!isPlainObject(ucp)) return { kind: 'malformed', reason: 'no_ucp' };
  const messages = parseMessages(value.messages);
  if (ucp.status === 'error') {
    if (messages.messages.length === 0 && messages.unreadable === 0)
      return { kind: 'malformed', reason: 'error_without_messages' };
    return {
      kind: 'error_response',
      messages,
      ...continueUrlOf(value),
    };
  }
  if (ucp.status !== undefined && ucp.status !== 'success')
    return { kind: 'malformed', reason: 'bad_status' };
  return { kind: 'resource', value: value as JsonObject, messages };
}

import type { BearerChallenge } from './identity_link';

export interface TransportError {
  /** The UCP code, lower-case; `unknown` when the body names none. */
  code: string;
  content?: string;
  continueUrl?: string;
  /** HTTP status (REST) or JSON-RPC code (MCP). */
  status: number;
  /** The HTTP status the answer came with, on either transport (an MCP error pairs one with its code). */
  httpStatus?: number;
  /** Seconds, from `Retry-After` or `error.data.retry_after`. */
  retryAfter?: number;
  /** A 401 or 403's Bearer challenge (RFC 6750 §3): what linking it asks for. */
  challenge?: BearerChallenge;
}

/** A REST non-2xx answer. */
export function readRestError(
  status: number,
  body: unknown,
  retryAfterHeader?: string,
): TransportError {
  const out: TransportError = { status, httpStatus: status, code: 'unknown' };
  if (isPlainObject(body)) fillFrom(out, body);
  // version_unsupported may also come as an error_response body (plan A4).
  if (out.code === 'unknown' && isPlainObject(body)) {
    const msgs = parseMessages(body.messages).messages;
    const first = msgs.find((m) => m.type === 'error');
    if (first !== undefined && first.type === 'error') out.code = first.code;
  }
  const retry = parseRetryAfter(retryAfterHeader);
  if (retry !== undefined) out.retryAfter = retry;
  return out;
}

/** An MCP JSON-RPC error. */
export function readMcpError(code: number, data: unknown): TransportError {
  const out: TransportError = { status: code, code: 'unknown' };
  if (isPlainObject(data)) {
    fillFrom(out, data);
    if (
      typeof data.retry_after === 'number' &&
      Number.isFinite(data.retry_after) &&
      data.retry_after >= 0
    )
      out.retryAfter = data.retry_after;
  }
  return out;
}

function fillFrom(out: TransportError, body: Record<string, unknown>): void {
  if (typeof body.code === 'string') out.code = body.code.toLowerCase();
  if (typeof body.content === 'string') out.content = body.content;
  const url = readHttpsUrl(body.continue_url);
  if (url !== null) out.continueUrl = url;
}

/** `Retry-After` as delay-seconds (an HTTP-date is not used by UCP examples and is ignored). */
export function parseRetryAfter(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const t = header.trim();
  return /^\d{1,7}$/.test(t) ? Number(t) : undefined;
}

/** A `continue_url` Dina may offer the person: https without userinfo, or nothing (§3.8 step 3). */
function continueUrlOf(value: Record<string, unknown>): { continueUrl?: string } {
  const url = readHttpsUrl(value.continue_url);
  return url !== null ? { continueUrl: url } : {};
}
