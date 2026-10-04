/**
 * DID credentials for Lane 2 clients (design §5.1, M4): the wire both sides
 * share.
 *
 * Binding. The owner starts it: Core mints a single-use challenge for one
 * client and the one DID the owner names, and the owner hands it over out
 * of band. The holder of that DID's key signs `didBindingSigningInput` and
 * POSTs `{did, challenge, signature}` to the gateway's
 * `A2A_DID_BINDING_PATH`; the challenge is the authority, so no other
 * credential goes with it. Core checks it all and swaps the client's
 * credential to the DID; the client's principal never changes. The keys
 * that count: those a DID document names under `authentication`, or, in a
 * document with no such member (every `did:plc` document), its Ed25519
 * verification methods; only Ed25519 keys sign a Dina request.
 *
 * Per-request signing. A DID-bound client signs each request it sends the
 * gateway with `didRequestSigningInput`: a domain line, the DID of the node
 * it addresses, then Dina's canonical string over its own request
 * (`{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`);
 * sent as `X-DID`, `X-Timestamp` (RFC 3339), `X-Nonce` and `X-Signature`
 * (hex Ed25519). The gateway forwards the four values and the raw body;
 * Core rebuilds the text under its own DID, checks the signature against the
 * key bound at binding, the time window and the nonce, and binds the
 * operation to the signed body.
 */

import { A2A_INGRESS_PREFIX } from './ingress_routes';
import { isPlainObject } from './json';
import { parseStrictJson } from './strict_json';

/** The gateway's public binding door: a Dina extension, outside JSON-RPC. */
export const A2A_DID_BINDING_PATH = '/a2a/v1/did-binding';
/** Core's door for it; the gateway's alone. */
export const A2A_DID_COMPLETE_ROUTE = `${A2A_INGRESS_PREFIX}/did/complete`;

/** The headers a DID-signed request carries, lower-cased. */
export const DID_REQUEST_HEADERS = Object.freeze({
  did: 'x-did',
  timestamp: 'x-timestamp',
  nonce: 'x-nonce',
  signature: 'x-signature',
});

/**
 * How a DID-bound client signs its requests, as the Dina extension on the
 * card states it (design §7.6: the extension also describes §5.1's scheme).
 */
export const DINA_REQUEST_SIGNING = Object.freeze({
  headers: ['X-DID', 'X-Timestamp', 'X-Nonce', 'X-Signature'],
  canonical:
    'dina-a2a-request:v1\n{NODE_DID}\n{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}',
  audience: 'NODE_DID is the did this card’s Dina extension names: a request signed for one node verifies at no other',
  signature: 'Ed25519, lower-case hex',
  timestamp: 'RFC 3339 UTC, within five minutes',
  nonce: '16 to 128 characters of [A-Za-z0-9_-], never reused',
  keys: 'Ed25519 keys under authentication; in a document with none (did:plc), its Ed25519 verification methods',
  binding: A2A_DID_BINDING_PATH,
});

/** The domain every binding signature starts with, so it can be nothing else. */
export const DID_BINDING_DOMAIN = 'dina-a2a-did-binding:v1';

/** The domain every per-request signature starts with. */
export const DID_REQUEST_DOMAIN = 'dina-a2a-request:v1';

/**
 * What a DID-bound client signs for each request: the domain, the DID of the
 * node it addresses (the audience), then Dina's canonical request string
 * over its own request, one per line. The audience line is what keeps a
 * request where it was sent: one DID may be a client of many nodes, every
 * gateway serves the same paths and each node keeps its own spent nonces, so
 * without it whoever saw a request (the node it was sent to, a gateway, a
 * TLS terminator) could replay it to another node inside the time window.
 */
export function didRequestSigningInput(args: {
  nodeDid: string;
  method: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
  /** Lower-case hex SHA-256 of the raw body; this package has no crypto. */
  bodySha256Hex: string;
}): string {
  return [
    DID_REQUEST_DOMAIN,
    args.nodeDid,
    args.method,
    args.path,
    args.query,
    args.timestamp,
    args.nonce,
    args.bodySha256Hex,
  ].join('\n');
}

/**
 * What a client signs to bind its DID: the domain, this node's DID, the
 * client id, the DID being bound and the challenge, one per line. Each part
 * pins the signature to one binding: no other node, client, DID or
 * challenge accepts it.
 */
export function didBindingSigningInput(args: { nodeDid: string; clientId: string; did: string; challenge: string }): string {
  return [DID_BINDING_DOMAIN, args.nodeDid, args.clientId, args.did, args.challenge].join('\n');
}

export interface DidBindingRequest {
  did: string;
  challenge: string;
  /** Hex Ed25519 signature over `didBindingSigningInput`. */
  signature: string;
}

const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,480}$/;
const CHALLENGE_RE = /^dch_[A-Za-z0-9_-]{43}$/;
const SIGNATURE_RE = /^[0-9a-f]{128}$/;

/** The binding request, parsed strictly (exactly these three members, each well formed), or null. */
export function parseDidBindingRequest(text: string): DidBindingRequest | null {
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const v = parsed.value;
  if (Object.keys(v).sort().join(',') !== 'challenge,did,signature') return null;
  if (typeof v.did !== 'string' || !DID_RE.test(v.did)) return null;
  if (typeof v.challenge !== 'string' || !CHALLENGE_RE.test(v.challenge)) return null;
  if (typeof v.signature !== 'string' || !SIGNATURE_RE.test(v.signature)) return null;
  return { did: v.did, challenge: v.challenge, signature: v.signature };
}
