/**
 * The owner's card for an inbound call under review (design §7.3): Core's
 * words, the exact params with hidden characters spelled out, and a payload
 * a reader can parse back.
 */

import { isInvisibleCodePoint } from '@dina/a2a';

import {
  A2A_INBOUND_REVIEW_TYPE,
  inboundReviewDisplay,
  inboundReviewMirror,
  parseInboundReviewCard,
  visibleJson,
} from '../../src/a2a';

const FIELDS = {
  client_name: 'Acme agent',
  skill: 'eta_query@bus',
  action_class: 'read' as const,
  params: { route_id: '42' },
  service_name: 'Bus 42',
};
/** The words' inputs: the card's fields, and how the caller proved who it is. */
const DISPLAY = { ...FIELDS, proof: { kind: 'bearer' as const } };

function card(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: A2A_INBOUND_REVIEW_TYPE,
    operation_id: 'op-1',
    client_id: 'ac_1',
    ...FIELDS,
    post_hash: 'e'.repeat(64),
    display: inboundReviewDisplay(DISPLAY),
    ...over,
  });
}

describe('visible JSON', () => {
  it('spells out invisible, bidi and control characters, and keeps the rest', () => {
    const hidden = String.fromCharCode(0x202e, 0x200b, 0x7, 0xad, 0x2028);
    const text = visibleJson({ note: `pay${hidden}me`, plain: 'caf\u00e9' });
    const spelled = ['202e', '200b', '0007', '00ad', '2028'].map((h) => `\\u${h}`).join('');
    expect(text).toContain(`pay${spelled}me`);
    expect(text).toContain(String.fromCharCode(0x63, 0x61, 0x66, 0xe9));
    expect([...text].every((c) => c === '\n' || (c >= ' ' && c.charCodeAt(0) < 0x7f) || c.charCodeAt(0) === 0xe9)).toBe(true);
  });
});

// Cold audit C5-4: one invisible set, astral points included, decides what the owner is shown
it('spells out tag characters, variation selectors, fillers and every other invisible point, astral ones as surrogate pairs', () => {
  const hidden = String.fromCodePoint(0xe0041, 0xe0042, 0xfe0f, 0x3164, 0x115f, 0x034f, 0xe0100);
  const text = visibleJson({ note: `ok${hidden}go` });
  expect(text).toContain('ok\\udb40\\udc41\\udb40\\udc42\\ufe0f\\u3164\\u115f\\u034f\\udb40\\udd00go');
  // Nothing in the text is invisible any more: every point the shared set names was spelled out.
  expect([...text].filter((c) => isInvisibleCodePoint(c.codePointAt(0) ?? 0))).toEqual([]);
  // A visible astral character, an emoji, stays as it is.
  expect(visibleJson({ note: String.fromCodePoint(0x1f68c) })).toContain(String.fromCodePoint(0x1f68c));
});

it('the card with hidden params, as the phone mirror shows it, spells them out too', () => {
  const sneaky = { ...DISPLAY, params: { note: `book${String.fromCodePoint(0xe0049, 0xe0047, 0xe004e)}` } };
  const parsed = parseInboundReviewCard(card({ params: sneaky.params, display: inboundReviewDisplay(sneaky) }));
  const mirrored = parsed === null ? null : inboundReviewMirror(parsed);
  expect(mirrored?.detail).toContain('book\\udb40\\udc49\\udb40\\udc47\\udb40\\udc4e');
});

describe('words', () => {
  it('names the client, the skill, the listing and the effect', () => {
    const d = inboundReviewDisplay(DISPLAY);
    expect(d.title).toBe('Acme agent asks to use eta_query@bus');
    expect(d.detail).toContain('Through your listing “Bus 42”.');
    expect(d.detail).toContain('It asks for information.');
    expect(inboundReviewDisplay({ ...DISPLAY, action_class: 'booking' }).detail).toContain('a booking action');
    expect(inboundReviewDisplay({ ...DISPLAY, client_name: '' }).title).toBe('An outside agent asks to use eta_query@bus');
  });

  // Cold audit C4-5: a client that bound a DID has no token
  it('says how the caller proved who it is: the token, or the key of the DID it bound', () => {
    expect(inboundReviewDisplay(DISPLAY).detail).toContain('The agent proved only that it holds the token you gave it.');
    const did = inboundReviewDisplay({ ...DISPLAY, proof: { kind: 'did', did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' } }).detail;
    expect(did).toContain('The agent proved only that it holds the key of did:plc:ewvi7nxzyoun6zhxrhs64oiz, the DID it bound.');
    expect(did).not.toMatch(/token/);
  });
});

describe('parse and mirror', () => {
  it('parses a card Core wrote, and mirrors it', () => {
    const parsed = parseInboundReviewCard(card());
    expect(parsed?.post_hash).toBe('e'.repeat(64));
    expect(parsed === null ? null : inboundReviewMirror(parsed)).toEqual(inboundReviewDisplay(DISPLAY));
  });

  it.each([
    ['another type', { type: 'a2a_delegation_consent' }],
    ['a bad class', { action_class: 'payment' }],
    ['params that are not an object', { params: [1] }],
    ['a bad hash', { post_hash: 'nope' }],
    ['no display', { display: undefined }],
  ])('refuses %s', (_name, over) => {
    expect(parseInboundReviewCard(card(over))).toBeNull();
  });

  it('keeps a card too long for the phone off the mirror', () => {
    const big = { ...DISPLAY, params: { note: 'x'.repeat(5_000) } };
    const parsed = parseInboundReviewCard(card({ params: big.params, display: inboundReviewDisplay(big) }));
    expect(parsed).not.toBeNull();
    expect(parsed === null ? 'x' : inboundReviewMirror(parsed)).toBeNull();
  });
});
