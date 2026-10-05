import {
  dictGet,
  paramGet,
  parseDictionary,
  parseItem,
  serializeDictionary,
  SfParseError,
} from '../src/sf';

describe('RFC 8941 dictionaries', () => {
  it('parses UCP-Agent as a dictionary whose profile is an sf-string', () => {
    const dict = parseDictionary(
      'profile="https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/.well-known/ucp"',
    );
    const profile = dictGet(dict, 'profile');
    expect(profile).toEqual({
      kind: 'item',
      value: {
        type: 'string',
        value: 'https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/.well-known/ucp',
      },
      params: [],
    });
  });

  it('parses a Signature-Input inner list with parameters, keeping order', () => {
    const dict = parseDictionary(
      'sig1=("@method" "@authority" "@path" "ucp-agent" "idempotency-key" "content-digest" "content-type");keyid="platform-2026";created=1738617600',
    );
    const member = dictGet(dict, 'sig1');
    expect(member?.kind).toBe('inner-list');
    if (member?.kind !== 'inner-list') return;
    expect(member.items.map((i) => (i.value as { value: string }).value)).toEqual([
      '@method',
      '@authority',
      '@path',
      'ucp-agent',
      'idempotency-key',
      'content-digest',
      'content-type',
    ]);
    expect(paramGet(member.params, 'keyid')).toEqual({ type: 'string', value: 'platform-2026' });
    expect(paramGet(member.params, 'created')).toEqual({ type: 'integer', value: 1738617600 });
  });

  it('parses a byte sequence and a bare boolean member', () => {
    const dict = parseDictionary('sig1=:AQID:, flag');
    expect(dictGet(dict, 'sig1')).toEqual({
      kind: 'item',
      value: { type: 'bytes', value: new Uint8Array([1, 2, 3]) },
      params: [],
    });
    expect(dictGet(dict, 'flag')).toEqual({
      kind: 'item',
      value: { type: 'boolean', value: true },
      params: [],
    });
  });

  it('accepts a byte sequence without padding (RFC 8941 §4.2.7)', () => {
    const dict = parseDictionary('d=:AQI:');
    expect(dictGet(dict, 'd')).toEqual({
      kind: 'item',
      value: { type: 'bytes', value: new Uint8Array([1, 2]) },
      params: [],
    });
  });

  it('round-trips: what parses serializes back to the same text', () => {
    const text =
      'sig1=("@status" "content-digest");keyid="k";created=1, sig2=:AQID:, a=?0, b=tok/en, c=-12, d=1.5';
    expect(serializeDictionary(parseDictionary(text))).toBe(text);
  });

  it("keeps the last of duplicate keys, in the first one's place", () => {
    const dict = parseDictionary('a=1, b=2, a=3');
    expect(dict.map(([k]) => k)).toEqual(['a', 'b']);
    expect(dictGet(dict, 'a')).toEqual({
      kind: 'item',
      value: { type: 'integer', value: 3 },
      params: [],
    });
  });

  it.each([
    ['trailing comma', 'a=1,'],
    ['upper-case key', 'A=1'],
    ['unterminated string', 'a="x'],
    ['bad escape', 'a="\\n"'],
    ['non-ASCII in string', 'a="é"'],
    ['bad byte character', 'a=:a*b:'],
    ['unterminated inner list', 'a=("x" "y"'],
    ['bad boolean', 'a=?2'],
    ['integer too long', 'a=1234567890123456'],
    ['decimal fraction too long', 'a=1.2345'],
    ['junk after member', 'a=1 b'],
    ['too much padding', 'a=:AQID===:'],
    ['padding the length does not need', 'a=:AQIDBA==A:'],
    ['one stray character of base64', 'a=:A:'],
    ['padding in the middle', 'a=:AQ=D:'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseDictionary(text)).toThrow(SfParseError);
  });

  it('parses a single item with parameters', () => {
    expect(parseItem('"x";a=1')).toEqual({
      kind: 'item',
      value: { type: 'string', value: 'x' },
      params: [['a', { type: 'integer', value: 1 }]],
    });
  });

  it('refuses to serialize a string sf-string cannot carry', () => {
    expect(() =>
      serializeDictionary([
        ['a', { kind: 'item', value: { type: 'string', value: 'naïve' }, params: [] }],
      ]),
    ).toThrow(SfParseError);
  });

  it.each([
    // RFC 8941 §3.2 and §3.3 examples, parsed and serialized back exactly.
    ['en="Applepie", da=:w4ZibGV0w6ZydGU=:'],
    ['a=?0, b, c;foo=bar'],
    ['rating=1.5, feelings=(joy sadness)'],
    ['a=(1 2), b=3, c=4;aa=bb, d=(5 6);valid'],
  ])('round-trips the RFC example %p', (text) => {
    expect(serializeDictionary(parseDictionary(text))).toBe(text);
  });
});
