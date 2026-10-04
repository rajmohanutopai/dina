/**
 * The A2A card record (design §8.2–§8.3): what a node's publisher writes to
 * its repository and the directory indexes. These are the record's rules
 * that need no key and no registry, written once so the publisher and the
 * directory hold the same ones; the directory adds the card's signature, the
 * shared capability registry and the directory envelope.
 *
 * Two steps, in the order the directory checks them (the signature between
 * them): the record and its card text, then what the card says and the
 * record's convenience fields, which must agree with it.
 */

import { A2A_LIMITS, DINA_A2A_EXTENSION_URI } from './constants';
import { canonicalize } from './jcs';
import { isPlainObject, utf8Bytes, type JsonObject, type JsonValue } from './json';
import { parseStrictJson } from './strict_json';
import { validateAgentCardShape } from './validate';

/** The members a card record may carry: the card, its envelope, three convenience fields, and the PDS's `$type`. */
export const A2A_CARD_RECORD_MEMBERS: ReadonlySet<string> = new Set([
  '$type',
  'card',
  'directory_envelope',
  'endpoint',
  'protocol_version',
  'skills',
]);

export type CardRecordText =
  | { ok: true; record: JsonObject; card: JsonObject; cardText: string }
  | { ok: false; reason: string };

/**
 * The record's members, exactly the published shape, and its card string:
 * at most the card cap, the RFC 8785 form of the card it parses to (the
 * bytes its hash covers are the bytes the live card is served as), no
 * U+0000 anywhere, and a v1.0 card.
 */
export function readCardRecordText(record: unknown): CardRecordText {
  if (!isPlainObject(record)) return { ok: false, reason: 'record_not_object' };
  if (Object.keys(record).some((k) => !A2A_CARD_RECORD_MEMBERS.has(k))) return { ok: false, reason: 'record_members' };
  const cardText = record.card;
  if (typeof cardText !== 'string') return { ok: false, reason: 'card_not_string' };
  if (utf8Bytes(cardText).length > A2A_LIMITS.maxCardBytes) return { ok: false, reason: 'card_too_large' };
  const parsed = parseStrictJson(cardText);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { ok: false, reason: 'card_not_json' };
  const card = parsed.value;
  let canonical: string;
  try {
    canonical = canonicalize(card as JsonValue);
  } catch {
    return { ok: false, reason: 'card_not_canonical' };
  }
  if (canonical !== cardText) return { ok: false, reason: 'card_not_canonical' };
  // U+0000 has no place in a card, and the index's text columns cannot hold it.
  if (containsNul(card)) return { ok: false, reason: 'card_nul_character' };
  const shape = validateAgentCardShape(card);
  if (shape !== null) return { ok: false, reason: shape };
  // A plain object of parsed JSON: what `isPlainObject` checked is a JSON object.
  return { ok: true, record: record as JsonObject, card, cardText };
}

export type CardRecordFacts =
  | { ok: true; endpoint: string; protocolVersion: string; skillIds: string[] }
  | { ok: false; reason: string };

/**
 * What the card says, and the record's agreement with it: the Dina
 * extension names the repository's own DID; the card has a JSON-RPC
 * interface and skills; and the record's `endpoint`, `protocol_version` and
 * `skills` equal the card's. The card has passed `readCardRecordText`.
 */
export function readCardRecordFacts(card: JsonObject, record: JsonObject, repoDid: string): CardRecordFacts {
  const extensions = isPlainObject(card.capabilities) && Array.isArray(card.capabilities.extensions) ? card.capabilities.extensions : [];
  const dina = extensions.find((e) => isPlainObject(e) && e.uri === DINA_A2A_EXTENSION_URI);
  if (!isPlainObject(dina) || !isPlainObject(dina.params) || dina.params.did !== repoDid) return { ok: false, reason: 'extension_did' };
  const interfaces = card.supportedInterfaces as Record<string, unknown>[];
  const rpc = interfaces.find((i) => i.protocolBinding === 'JSONRPC');
  if (rpc === undefined) return { ok: false, reason: 'no_jsonrpc_interface' };
  const endpoint = rpc.url as string;
  const protocolVersion = rpc.protocolVersion as string;
  const ids = Array.isArray(card.skills) ? card.skills.map((s) => (isPlainObject(s) && typeof s.id === 'string' ? s.id : null)) : [];
  if (ids.length === 0 || ids.includes(null)) return { ok: false, reason: 'skills' };
  const skillIds = ids as string[];
  if (record.endpoint !== endpoint) return { ok: false, reason: 'sibling_endpoint' };
  if (record.protocol_version !== protocolVersion) return { ok: false, reason: 'sibling_protocol_version' };
  const listed = record.skills;
  if (!Array.isArray(listed) || listed.length !== skillIds.length || listed.some((s, i) => s !== skillIds[i])) {
    return { ok: false, reason: 'sibling_skills' };
  }
  return { ok: true, endpoint, protocolVersion, skillIds };
}

/** Whether any key or string in a parsed JSON value holds U+0000. */
function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    if (typeof v === 'string') {
      if (v.includes('\u0000')) return true;
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, inner] of Object.entries(v)) {
        if (k.includes('\u0000')) return true;
        stack.push(inner);
      }
    }
  }
  return false;
}
