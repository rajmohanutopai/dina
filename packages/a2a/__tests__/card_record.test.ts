/**
 * The card record's rules a publisher and the directory share (design
 * §8.2–§8.3; cold audit C4-9): the record and its card text, then what the
 * card says and the record's agreement with it. AppView's card check runs
 * these between its own (the signature, the registry, the envelope), so its
 * tests cover every refusal through them; these hold the rules here.
 */

import { A2A_CARD_COLLECTION, DINA_A2A_EXTENSION_URI, canonicalize, readCardRecordFacts, readCardRecordText, type JsonValue } from '../src';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const card = (over: Record<string, unknown> = {}) => ({
  name: 'Bus 42',
  description: 'Arrival times.',
  supportedInterfaces: [{ url: 'https://dina.example/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  version: '1.0.0',
  capabilities: { extensions: [{ uri: DINA_A2A_EXTENSION_URI, params: { did: DID } }] },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 'eta_query@self', name: 'ETA', description: 'When.', tags: ['transit'] }],
  ...over,
});
const record = (over: Record<string, unknown> = {}, c: Record<string, unknown> = card()) => ({
  $type: A2A_CARD_COLLECTION,
  card: canonicalize(c as JsonValue),
  directory_envelope: {},
  endpoint: 'https://dina.example/a2a/v1',
  protocol_version: '1.0',
  skills: ['eta_query@self'],
  ...over,
});

function facts(r: Record<string, unknown>, did = DID) {
  const text = readCardRecordText(r);
  if (!text.ok) return text;
  return readCardRecordFacts(text.card, text.record, did);
}

it('takes a record as a publisher writes it', () => {
  expect(facts(record())).toEqual({ ok: true, endpoint: 'https://dina.example/a2a/v1', protocolVersion: '1.0', skillIds: ['eta_query@self'] });
});

it.each([
  ['a member the record never has', record({ note: 'x' }), 'record_members'],
  ['a card string that is not the card’s canonical text', record({ card: JSON.stringify(card(), null, 2) }), 'card_not_canonical'],
  ['a card with U+0000', record({}, card({ description: 'a\u0000b' })), 'card_nul_character'],
])('refuses %s', (_name, r, reason) => {
  expect(readCardRecordText(r)).toEqual({ ok: false, reason });
});

it.each([
  ['an extension naming another DID', record(), 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', 'extension_did'],
  ['an endpoint the card does not give', record({ endpoint: 'https://elsewhere.example/a2a/v1' }), DID, 'sibling_endpoint'],
  ['skills the card does not list', record({ skills: ['eta_query@self', 'price_check@self'] }), DID, 'sibling_skills'],
])('refuses %s', (_name, r, did, reason) => {
  expect(facts(r, did)).toEqual({ ok: false, reason });
});
