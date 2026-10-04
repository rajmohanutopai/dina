/**
 * The published lexicons agree with the constants the publisher and AppView
 * use: both records keyed `literal:self` under their collections, the
 * envelope's and fence's members, the card cap AppView enforces. And every
 * type they use is one Lexicon has (it has no float, for one: the
 * directory's queries, which return trust scores as JSON numbers, are
 * documented in the design, not published as lexicons).
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { A2A_CARD_COLLECTION, A2A_FENCE_COLLECTION, A2A_LIMITS, A2A_SELF_RKEY, FENCE_DOMAIN, MAX_ID_LENGTH } from '../src';

const DIR = path.join(__dirname, '..', 'lexicons', 'com', 'dinakernel', 'a2a');
interface Lexicon {
  id: string;
  defs: {
    main: {
      type: string;
      key?: string;
      record: { required: string[]; properties: Record<string, { maxLength?: number; const?: unknown; items?: { maxLength?: number } }> };
    };
  };
}
const read = (name: string) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as Lexicon;

it.each([
  ['card', A2A_CARD_COLLECTION],
  ['fence', A2A_FENCE_COLLECTION],
])('the %s record is %s, keyed literal:self', (name, nsid) => {
  const lex = read(name);
  expect(lex.id).toBe(nsid);
  expect(lex.defs.main.type).toBe('record');
  expect(lex.defs.main.key).toBe(`literal:${A2A_SELF_RKEY}`);
});

it('the card record names the members the publisher writes, and the 128 KB cap', () => {
  const record = read('card').defs.main.record;
  expect([...record.required].sort()).toEqual(['card', 'directory_envelope', 'endpoint', 'protocol_version', 'skills']);
  expect(record.properties.card?.maxLength).toBe(A2A_LIMITS.maxCardBytes);
  // A skill id is bounded as the card validator bounds it.
  expect((record.properties.skills as { items?: { maxLength?: number } } | undefined)?.items?.maxLength).toBe(MAX_ID_LENGTH);
});

it('the fence names exactly the signed members, and its domain', () => {
  const record = read('fence').defs.main.record;
  expect([...record.required].sort()).toEqual(['did', 'domain', 'publisher_epoch', 'publisher_instance', 'sig', 'v']);
  expect(record.properties.domain?.const).toBe(FENCE_DOMAIN);
});

/** Lexicon's closed list of types (atproto Lexicon spec). */
const LEXICON_TYPES = new Set([
  'null', 'boolean', 'integer', 'string', 'bytes', 'cid-link', 'blob', 'array', 'object', 'params',
  'token', 'ref', 'union', 'unknown', 'record', 'query', 'procedure', 'subscription', 'permission-set',
]);

function typesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) typesIn(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'type' && typeof v === 'string') out.push(v);
      else typesIn(v, out);
    }
  }
  return out;
}

it('the lexicons are exactly the two records, and use only types Lexicon has', () => {
  const files = readdirSync(DIR).sort();
  expect(files).toEqual(['card.json', 'fence.json']);
  for (const file of files) {
    const types = typesIn(JSON.parse(readFileSync(path.join(DIR, file), 'utf8')));
    expect(types.filter((t) => !LEXICON_TYPES.has(t))).toEqual([]);
  }
});
