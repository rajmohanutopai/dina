/**
 * The policy socket contract (UCP plan §3.3, §3.4): what a host's transport
 * (the Node socket on servers, the native module on the phone) is asked to do,
 * and what it must hand back.
 *
 * The socket resolves the name once, refuses if ANY answer is a special-use
 * address (`classifyAddress`), connects only to a vetted address with TLS
 * checked against the original name and at least `minTls`, follows no
 * redirect, sends `Accept-Encoding: identity`, enforces the byte and time caps,
 * and reports whether any request byte may have left (`sent`).
 *
 * It returns every response header field within a hard cap (`rawHeaders`).
 * Core narrows them at once (`narrowHeaders`, `selectSignedHeaders`): the rest
 * of Core sees only the allow-listed headers, and the signature verifier only
 * the fields the signature covers. Parsing `Signature-Input` stays in one place
 * (`@dina/ucp`), not in each socket.
 */

export type PolicyMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type PolicyTransportError =
  /** The name did not resolve. */
  | 'dns_failed'
  /** A resolved (or connected) address is special-use. */
  | 'address_blocked'
  | 'connect_failed'
  /** The handshake failed, the certificate did not match the name, or TLS was below `minTls`. */
  | 'tls_failed'
  | 'timeout'
  /** The body or the headers passed their cap. */
  | 'too_large'
  /** A 3xx other than a 304 answering `ifNoneMatch`: redirects are never followed. */
  | 'redirect_refused'
  /** The media type is not one `accept` allows, or the body is compressed. */
  | 'bad_content_type'
  | 'io_error';

export interface PolicySocketRequest {
  method: PolicyMethod;
  /** An https URL that already passed Core's URL check. */
  url: string;
  /** Request headers, lower-case names. Host, length and `accept-encoding` are the socket's. */
  headers: Readonly<Record<string, string>>;
  /** The exact body bytes; `Content-Digest` is computed over them. */
  body?: Uint8Array;
  /**
   * What the answer may be: `json` (application/json or a `+json` type),
   * `json-or-sse` (also text/event-stream, for MCP endpoints), `car`
   * (application/vnd.ipld.car: an AT Protocol repository proof, read by
   * AppView's listing reconciliation), or `status` (the status only; the
   * body is never read and comes back empty).
   */
  accept: 'json' | 'json-or-sse' | 'car' | 'status';
  minTls: 'TLSv1.2' | 'TLSv1.3';
  /** Read 401 and 403 bodies (within the cap) instead of discarding them. */
  readAuthErrorBodies: boolean;
  /** Sent as `If-None-Match`; a 304 is then a result, not a refused redirect. */
  ifNoneMatch?: string;
  maxResponseBytes: number;
  timeoutMs: number;
}

export type PolicySocketResult =
  | {
      ok: true;
      status: number;
      bodyBytes: Uint8Array;
      /** Every response header field, lower-case names, in order, within `RAW_HEADER_LIMITS`. */
      rawHeaders: readonly (readonly [string, string])[];
      connectedAddress: string;
    }
  | {
      ok: false;
      error: PolicyTransportError;
      /**
       * Whether any request byte may have reached the remote. False only when
       * the failure came before the TLS handshake finished, so a mutation that
       * failed with `sent: false` certainly did not run remotely.
       */
      sent: boolean;
    };

export type PolicySocket = (request: PolicySocketRequest) => Promise<PolicySocketResult>;

/** The socket's hard cap on response headers; over it the answer is `too_large`. */
export const RAW_HEADER_LIMITS = Object.freeze({ maxFields: 128, maxBytes: 64 * 1024 });

/** Headers the rest of Core may read (§3.3), each value cut at 4 KiB. */
export const ALLOWED_RESPONSE_HEADERS = [
  'retry-after',
  'cache-control',
  'etag',
  'last-modified',
  'content-type',
  'content-digest',
  'signature',
  'signature-input',
  'mcp-session-id',
  'www-authenticate',
  'ucp-agent',
  'webhook-id',
  'webhook-timestamp',
] as const;
export type AllowedResponseHeader = (typeof ALLOWED_RESPONSE_HEADERS)[number];
export const MAX_ALLOWED_HEADER_VALUE = 4 * 1024;

/** The fields handed to a signature verifier: at most 32, 16 KiB in all (§3.3). */
export const SIGNED_HEADER_LIMITS = Object.freeze({ maxFields: 32, maxBytes: 16 * 1024 });

/** RFC 9110 §5.3: repeated fields combine into one value joined by ", ". */
function combined(raw: readonly (readonly [string, string])[], name: string): string | undefined {
  const values = raw.filter(([n]) => n === name).map(([, v]) => v.trim());
  return values.length === 0 ? undefined : values.join(', ');
}

/** The allow-listed headers; a value over 4 KiB is dropped, never cut mid-value. */
export function narrowHeaders(
  raw: readonly (readonly [string, string])[],
): Partial<Record<AllowedResponseHeader, string>> {
  const out: Partial<Record<AllowedResponseHeader, string>> = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const v = combined(raw, name);
    if (v !== undefined && utf8Length(v) <= MAX_ALLOWED_HEADER_VALUE) out[name] = v;
  }
  return out;
}

export type SignedHeaderSelection =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: 'missing' | 'too_many' | 'too_large'; field?: string };

/**
 * The header fields a signature covers, as received. A covered field that is
 * missing, or a set over `SIGNED_HEADER_LIMITS`, fails (the signature cannot be
 * checked, so it is not accepted).
 */
export function selectSignedHeaders(
  raw: readonly (readonly [string, string])[],
  coveredFields: readonly string[],
): SignedHeaderSelection {
  const names = [...new Set(coveredFields.map((n) => n.toLowerCase()))];
  if (names.length > SIGNED_HEADER_LIMITS.maxFields) return { ok: false, reason: 'too_many' };
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const name of names) {
    const v = combined(raw, name);
    if (v === undefined) return { ok: false, reason: 'missing', field: name };
    bytes += utf8Length(name) + utf8Length(v);
    if (bytes > SIGNED_HEADER_LIMITS.maxBytes) return { ok: false, reason: 'too_large' };
    headers[name] = v;
  }
  return { ok: true, headers };
}

/** Whether raw headers fit the socket's hard cap. */
export function rawHeadersWithinLimits(raw: readonly (readonly [string, string])[]): boolean {
  if (raw.length > RAW_HEADER_LIMITS.maxFields) return false;
  let bytes = 0;
  for (const [n, v] of raw) bytes += utf8Length(n) + utf8Length(v);
  return bytes <= RAW_HEADER_LIMITS.maxBytes;
}

/** Whether a response media type is one `accept` allows (parameters ignored). */
export function acceptsContentType(
  accept: PolicySocketRequest['accept'],
  contentType: string | undefined,
): boolean {
  if (accept === 'status') return true;
  const media = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (accept === 'car') return media === 'application/vnd.ipld.car';
  const json = media === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(media);
  return json || (accept === 'json-or-sse' && media === 'text/event-stream');
}

/** RFC 9110 §5.6.2 token characters. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** RFC 9110 §5.5 field-vchar, SP and HTAB only: no CR, LF, NUL or other control, nothing outside ASCII. */
const FIELD_VALUE = /^[\t\x20-\x7e]*$/;

/**
 * Whether request headers may go on the wire: a token name and a value of
 * visible ASCII, spaces and tabs. A value with CR or LF would inject headers;
 * one outside ASCII is refused by OkHttp and sent raw by others. Both sockets
 * check before resolving, so a refused request has certainly not left.
 */
export function requestHeadersAcceptable(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).every(
    ([name, value]) => TOKEN.test(name) && FIELD_VALUE.test(value),
  );
}

/** A request body only where the method carries one (a GET never does). */
export function bodyAllowed(request: Pick<PolicySocketRequest, 'method' | 'body'>): boolean {
  return request.body === undefined || request.method !== 'GET';
}

/** Caps and timeouts for UCP calls (§3.3). */
export const UCP_FETCH_LIMITS = Object.freeze({
  /** The spec's floor for a profile size cap (overview/index.md:2305-2310); 10 s is Dina's choice. */
  profile: { maxResponseBytes: 128 * 1024, timeoutMs: 10_000 },
  catalog: { maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 20_000 },
  checkout: { maxResponseBytes: 512 * 1024, timeoutMs: 20_000 },
  order: { maxResponseBytes: 512 * 1024, timeoutMs: 20_000 },
  /** A schema document (§3.6 step 4a). */
  schema: { maxResponseBytes: 256 * 1024, timeoutMs: 10_000 },
});

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
