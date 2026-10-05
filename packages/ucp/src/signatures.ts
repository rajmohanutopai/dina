/**
 * RFC 9421 HTTP Message Signatures and RFC 9530 Content-Digest, as UCP
 * v2026-08-25 profiles them (signatures.md; overview "Signature
 * verification"):
 *
 *  - ES256 is the algorithm every verifier must support (signatures.md:95-101);
 *    ECDSA signatures are raw `r||s`, 64 bytes for P-256, never DER (:494-499).
 *  - Parameters: Dina signs with `keyid` only; no `alg` (the key's `kty`/`crv`
 *    decide it, :124-125) and no required `created` (:850-852). Label `sig1`.
 *    A verified `alg`, when a signer sends one, must name the key's algorithm
 *    (RFC 9421 §3.2 step 6.5).
 *  - Tags (overview :2370-2390): an untagged signature is UCP's default; a
 *    `web-bot-auth` one (the dual-audience shape) is verified the same way,
 *    plus `keyid` must equal the key's RFC 7638 thumbprint (:2424-2429) and its
 *    `signature-agent;key="<label>"` component is a Dictionary member selected
 *    per RFC 9421 §2.1.2; any other tag is skipped.
 *  - Request coverage: `@method @authority @path`, plus `@query` when there is
 *    a query, `ucp-agent` when the header is sent, `idempotency-key` when sent,
 *    `content-digest content-type` when there is a body (:424-490;
 *    overview :2430-2444).
 *  - Response coverage: `@status`, plus `content-digest content-type` when there
 *    is a body (:770-776); the digest is checked over the raw bytes (:778-782).
 *  - Content-Digest is `sha-256` over the exact body bytes, never re-serialized
 *    JSON (:413-422).
 *
 * Crypto is injected: the package stays pure (no Node, no WebCrypto).
 */

import { base64Encode, utf8Bytes } from '@dina/a2a';

import {
  dictGet,
  paramGet,
  parseDictionary,
  serializeDictionary,
  serializeItem,
  serializeMember,
  SfParseError,
  type SfDictionary,
  type SfInnerList,
  type SfItem,
  type SfParameters,
} from './sf';

export type Sha256Fn = (bytes: Uint8Array) => Uint8Array;
/** Sign the signature base with the key behind `keyid`; ES256 returns raw r||s (64 bytes). */
export type SignFn = (base: Uint8Array) => Uint8Array;

/** A request or response as the signer or verifier sees it. Header names lower-case. */
export interface HttpMessage {
  /** Requests only. */
  method?: string;
  /** Requests only: the absolute target URL. */
  url?: string;
  /** Responses only. */
  status?: number;
  /** Lower-case names; a repeated field's values already joined with ", ". */
  headers: Readonly<Record<string, string>>;
  /** The exact body bytes, when there is a body. */
  body?: Uint8Array;
}

export const SIGNATURE_LABEL = 'sig1';

export class SignatureBaseError extends Error {
  constructor(message: string) {
    super(`signature base: ${message}`);
    this.name = 'SignatureBaseError';
  }
}

// ------------------------------------------------------------ content-digest

/** RFC 9530: `sha-256=:<base64>:` over the exact bytes. */
export function contentDigest(body: Uint8Array, sha256: Sha256Fn): string {
  return serializeDictionary([
    ['sha-256', { kind: 'item', value: { type: 'bytes', value: sha256(body) }, params: [] }],
  ]);
}

/** Whether a Content-Digest header carries a `sha-256` member matching these bytes. */
export function contentDigestMatches(header: string, body: Uint8Array, sha256: Sha256Fn): boolean {
  let dict: SfDictionary;
  try {
    dict = parseDictionary(header);
  } catch {
    return false;
  }
  const member = dictGet(dict, 'sha-256');
  if (member === undefined || member.kind !== 'item' || member.value.type !== 'bytes') return false;
  return bytesEqual(member.value.value, sha256(body));
}

// ------------------------------------------------------------ components

/**
 * A covered component (RFC 9421 §2): a derived component (`@status`) or a
 * header field, with `key` when it selects one member of a Dictionary
 * structured field (§2.1.2), as WBA's `"signature-agent";key="sig1"` does.
 */
export interface CoveredComponent {
  name: string;
  key?: string;
}

function asComponent(c: string | CoveredComponent): CoveredComponent {
  return typeof c === 'string' ? { name: c } : c;
}

function componentItem(c: CoveredComponent): SfItem {
  return {
    kind: 'item',
    value: { type: 'string', value: c.name },
    params: c.key !== undefined ? [['key', { type: 'string', value: c.key }]] : [],
  };
}

/** RFC 9421 §2.2: a derived component's value, or a header field's (§2.1, §2.1.2). */
export function componentValue(msg: HttpMessage, component: string | CoveredComponent): string {
  const { name: id, key } = asComponent(component);
  if (id.startsWith('@') && key !== undefined) {
    throw new SignatureBaseError(`a derived component takes no key: ${id}`);
  }
  switch (id) {
    case '@method':
      if (msg.method === undefined)
        throw new SignatureBaseError('@method on a message with no method');
      return msg.method.toUpperCase();
    case '@authority': {
      const url = requestUrl(msg);
      // §2.2.3: host, lower-cased, with the port only when not the default.
      return url.port === ''
        ? url.hostname.toLowerCase()
        : `${url.hostname.toLowerCase()}:${url.port}`;
    }
    case '@path': {
      const url = requestUrl(msg);
      return url.pathname === '' ? '/' : url.pathname;
    }
    case '@query': {
      // §2.2.7: the query with its leading "?", or "?" alone when empty.
      const url = requestUrl(msg);
      return url.search === '' ? '?' : url.search;
    }
    case '@status':
      if (msg.status === undefined) throw new SignatureBaseError('@status on a request');
      return String(msg.status).padStart(3, '0');
    default: {
      if (id.startsWith('@')) throw new SignatureBaseError(`unsupported derived component ${id}`);
      const value = msg.headers[id];
      if (value === undefined) throw new SignatureBaseError(`covered header "${id}" is missing`);
      // §2.1: leading and trailing whitespace removed, obsolete line folding joined.
      const field = value.replace(/\r?\n[ \t]+/g, ' ').trim();
      if (key === undefined) return field;
      // §2.1.2: the field parsed as a Dictionary, and the named member re-serialized.
      let dict: SfDictionary;
      try {
        dict = parseDictionary(field);
      } catch {
        throw new SignatureBaseError(`covered header "${id}" is not a Dictionary`);
      }
      const member = dictGet(dict, key);
      if (member === undefined) throw new SignatureBaseError(`"${id}" has no member "${key}"`);
      return serializeMember(member);
    }
  }
}

function requestUrl(msg: HttpMessage): URL {
  if (msg.url === undefined)
    throw new SignatureBaseError('request component on a message with no URL');
  return new URL(msg.url);
}

/** RFC 9421 §2.5: the signature base for covered components and their parameters. */
export function signatureBase(
  msg: HttpMessage,
  covered: readonly (string | CoveredComponent)[],
  params: SfParameters,
): string {
  const components = covered.map(asComponent);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of components) {
    const identifier = serializeItem(componentItem(c));
    if (seen.has(identifier)) throw new SignatureBaseError(`component ${identifier} covered twice`);
    seen.add(identifier);
    lines.push(`${identifier}: ${componentValue(msg, c)}`);
  }
  lines.push(`"@signature-params": ${signatureParamsValue(components, params)}`);
  return lines.join('\n');
}

function signatureParamsValue(
  components: readonly CoveredComponent[],
  params: SfParameters,
): string {
  const list: SfInnerList = { kind: 'inner-list', items: components.map(componentItem), params };
  return serializeMember(list);
}

// ------------------------------------------------------------ coverage rules

/** The components a UCP request signature must cover (signatures.md:424-490). */
export function requiredRequestComponents(msg: HttpMessage): string[] {
  const url = requestUrl(msg);
  const out = ['@method', '@authority', '@path'];
  if (url.search !== '') out.push('@query');
  if (msg.headers['ucp-agent'] !== undefined) out.push('ucp-agent');
  if (msg.headers['signature-agent'] !== undefined) out.push('signature-agent');
  if (msg.headers['idempotency-key'] !== undefined) out.push('idempotency-key');
  if (msg.body !== undefined && msg.body.length > 0) out.push('content-digest', 'content-type');
  return out;
}

/** The components a UCP response signature must cover (signatures.md:770-776). */
export function requiredResponseComponents(msg: HttpMessage): string[] {
  const out = ['@status'];
  if (msg.body !== undefined && msg.body.length > 0) out.push('content-digest', 'content-type');
  return out;
}

/**
 * The components Dina requires on an incoming order webhook (UCP plan S16 /
 * D7): method, authority, path and the body pair; a missing `ucp-agent` is
 * accepted, as the spec's own webhook example sends it (order/index.md:742-750).
 */
export function requiredWebhookComponents(msg: HttpMessage): string[] {
  const url = requestUrl(msg);
  const out = ['@method', '@authority', '@path'];
  if (url.search !== '') out.push('@query');
  if (msg.body !== undefined && msg.body.length > 0) out.push('content-digest', 'content-type');
  return out;
}

// ------------------------------------------------------------ signing

export interface SignRequestInput {
  method: string;
  url: string;
  /** Lower-case names. `content-type`, `ucp-agent`, `idempotency-key` as they will be sent. */
  headers: Record<string, string>;
  body?: Uint8Array;
  keyid: string;
  sign: SignFn;
  sha256: Sha256Fn;
}

/**
 * Sign a UCP request. Returns the headers to add: `content-digest` (when there
 * is a body), `signature-input` and `signature`. Every required component is
 * covered, in the order of `requiredRequestComponents`.
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  // Dina signs UCP's default shape only; a Signature-Agent header would need the
  // Web Bot Auth shape (tag, created/expires, `;key`), which Dina does not send.
  if (input.headers['signature-agent'] !== undefined) {
    throw new SignatureBaseError('Dina does not send Signature-Agent');
  }
  const added: Record<string, string> = {};
  const headers: Record<string, string> = { ...input.headers };
  if (input.body !== undefined && input.body.length > 0) {
    if (headers['content-type'] === undefined)
      throw new SignatureBaseError('a body needs a content-type');
    added['content-digest'] = contentDigest(input.body, input.sha256);
    headers['content-digest'] = added['content-digest'];
  }
  const msg: HttpMessage = {
    method: input.method,
    url: input.url,
    headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
  const covered = requiredRequestComponents(msg).map(asComponent);
  const params: SfParameters = [['keyid', { type: 'string', value: input.keyid }]];
  const base = signatureBase(msg, covered, params);
  const signature = input.sign(utf8Bytes(base));
  added['signature-input'] = `${SIGNATURE_LABEL}=${signatureParamsValue(covered, params)}`;
  added['signature'] = `${SIGNATURE_LABEL}=:${base64Encode(signature)}:`;
  return added;
}

// ------------------------------------------------------------ verifying

/** A key that can verify, from the signer's profile (`usableEs256Keys`). */
export interface VerificationKey {
  /** Verify `signature` (raw r||s for ES256) over `base`. */
  verify(base: Uint8Array, signature: Uint8Array): boolean;
  /** The JWK's RFC 7638 SHA-256 thumbprint, for the `web-bot-auth` keyid check. */
  thumbprint: string;
}

/** The usable key whose `kid` is `keyid`, or null. */
export type KeyLookup = (keyid: string) => VerificationKey | null;

/** The one algorithm the keys Dina accepts (P-256) use (RFC 9421 §3.3.4). */
export const ES256_ALGORITHM = 'ecdsa-p256-sha256';

export type VerifyFailure =
  | 'signature_missing'
  | 'signature_malformed'
  | 'tag_unsupported'
  | 'algorithm_unsupported'
  | 'coverage_insufficient'
  | 'digest_mismatch'
  | 'key_not_found'
  | 'signature_invalid';

export type VerifyOutcome =
  | { ok: true; label: string; keyid: string }
  | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  msg: HttpMessage;
  /** The components this message must have covered (request, response or webhook rule). */
  required: readonly string[];
  keyFor: KeyLookup;
  sha256: Sha256Fn;
}

/** The covered components of one Signature-Input member, or null when one is outside RFC 9421 as Dina reads it. */
function coveredComponents(member: SfInnerList): CoveredComponent[] | null {
  const out: CoveredComponent[] = [];
  for (const item of member.items) {
    if (item.value.type !== 'string') return null;
    const name = item.value.value;
    if (item.params.length === 0) {
      out.push({ name });
      continue;
    }
    // Only §2.1.2's `key`, only on a header field (`;sf`, `;bs`, `;req`, `;tr` are not used by UCP).
    const [only] = item.params;
    if (
      item.params.length !== 1 ||
      only === undefined ||
      only[0] !== 'key' ||
      only[1].type !== 'string'
    ) {
      return null;
    }
    if (name.startsWith('@')) return null;
    out.push({ name, key: only[1].value });
  }
  return out;
}

/**
 * Verify a signed message (overview :2360-2473): each candidate signature is
 * checked in order — its shape and tag, its `alg` if any, coverage, the body
 * digest, the key by `keyid` (and for `web-bot-auth` the thumbprint), then the
 * signature itself — and the message is accepted only if one candidate passes
 * every step. Coverage and the digest come before the key lookup, so a forged
 * message never causes a profile refresh for an unknown key. When all fail,
 * the reason reported is the one that got furthest.
 */
export function verifyMessage(input: VerifyInput): VerifyOutcome {
  const inputHeader = input.msg.headers['signature-input'];
  const sigHeader = input.msg.headers['signature'];
  if (inputHeader === undefined || sigHeader === undefined)
    return { ok: false, reason: 'signature_missing' };
  let inputs: SfDictionary;
  let sigs: SfDictionary;
  try {
    inputs = parseDictionary(inputHeader);
    sigs = parseDictionary(sigHeader);
  } catch (err) {
    if (err instanceof SfParseError) return { ok: false, reason: 'signature_malformed' };
    throw err;
  }
  const rank: VerifyFailure[] = [
    'signature_malformed',
    'tag_unsupported',
    'algorithm_unsupported',
    'coverage_insufficient',
    'digest_mismatch',
    'key_not_found',
    'signature_invalid',
  ];
  let best: VerifyFailure = 'signature_malformed';
  const worse = (r: VerifyFailure): void => {
    if (rank.indexOf(r) > rank.indexOf(best)) best = r;
  };

  for (const [label, member] of inputs) {
    const sig = dictGet(sigs, label);
    if (
      member.kind !== 'inner-list' ||
      sig === undefined ||
      sig.kind !== 'item' ||
      sig.value.type !== 'bytes'
    ) {
      worse('signature_malformed');
      continue;
    }
    const covered = coveredComponents(member);
    const keyid = paramGet(member.params, 'keyid');
    const tag = paramGet(member.params, 'tag');
    const alg = paramGet(member.params, 'alg');
    if (
      covered === null ||
      keyid?.type !== 'string' ||
      (tag !== undefined && tag.type !== 'string')
    ) {
      worse('signature_malformed');
      continue;
    }
    const wba = tag !== undefined && tag.value === 'web-bot-auth';
    if (tag !== undefined && !wba) {
      worse('tag_unsupported');
      continue;
    }
    if (alg !== undefined && !(alg.type === 'string' && alg.value === ES256_ALGORITHM)) {
      worse('algorithm_unsupported');
      continue;
    }
    if (!input.required.every((id) => covered.some((c) => c.name === id))) {
      worse('coverage_insufficient');
      continue;
    }
    if (covered.some((c) => c.name === 'content-digest')) {
      const header = input.msg.headers['content-digest'];
      if (
        header === undefined ||
        !contentDigestMatches(header, input.msg.body ?? new Uint8Array(), input.sha256)
      ) {
        worse('digest_mismatch');
        continue;
      }
    }
    const key = input.keyFor(keyid.value);
    if (key === null) {
      worse('key_not_found');
      continue;
    }
    if (wba && keyid.value !== key.thumbprint) {
      worse('signature_invalid');
      continue;
    }
    let base: string;
    try {
      base = signatureBase(input.msg, covered, member.params);
    } catch {
      worse('coverage_insufficient');
      continue;
    }
    let good = false;
    try {
      good = key.verify(utf8Bytes(base), sig.value.value) === true;
    } catch {
      good = false;
    }
    if (good) return { ok: true, label, keyid: keyid.value };
    worse('signature_invalid');
  }
  return { ok: false, reason: best };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
