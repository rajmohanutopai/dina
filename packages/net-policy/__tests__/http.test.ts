import {
  acceptsContentType,
  narrowHeaders,
  rawHeadersWithinLimits,
  RAW_HEADER_LIMITS,
  selectSignedHeaders,
  SIGNED_HEADER_LIMITS,
} from '../src/http';

const raw: [string, string][] = [
  ['content-type', 'application/json'],
  ['set-cookie', 'session=secret'],
  ['cache-control', 'max-age=300'],
  ['x-trace', 'a'],
  ['x-trace', 'b'],
  ['signature-input', 'sig1=("@status" "content-digest")'],
  ['date', 'Sun, 04 Oct 2026 10:00:00 GMT'],
];

describe('narrowHeaders', () => {
  it('keeps only the allow-list; cookies and others never pass', () => {
    expect(narrowHeaders(raw)).toEqual({
      'content-type': 'application/json',
      'cache-control': 'max-age=300',
      'signature-input': 'sig1=("@status" "content-digest")',
    });
  });
  it('combines repeated fields and drops a value over 4 KiB whole', () => {
    expect(
      narrowHeaders([
        ['www-authenticate', 'Bearer'],
        ['www-authenticate', 'DPoP'],
      ]),
    ).toEqual({
      'www-authenticate': 'Bearer, DPoP',
    });
    expect(narrowHeaders([['etag', 'x'.repeat(4097)]])).toEqual({});
  });
});

describe('selectSignedHeaders', () => {
  it('returns the covered fields as received, combining repeats', () => {
    expect(selectSignedHeaders(raw, ['Date', 'x-trace'])).toEqual({
      ok: true,
      headers: { date: 'Sun, 04 Oct 2026 10:00:00 GMT', 'x-trace': 'a, b' },
    });
  });
  it('fails on a missing covered field, too many, or too many bytes', () => {
    expect(selectSignedHeaders(raw, ['content-length'])).toEqual({
      ok: false,
      reason: 'missing',
      field: 'content-length',
    });
    const many = Array.from({ length: SIGNED_HEADER_LIMITS.maxFields + 1 }, (_, i) => `h${i}`);
    expect(selectSignedHeaders(raw, many)).toEqual({ ok: false, reason: 'too_many' });
    expect(
      selectSignedHeaders([['big', 'x'.repeat(SIGNED_HEADER_LIMITS.maxBytes)]], ['big']),
    ).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});

describe('limits and media types', () => {
  it('caps raw headers by count and bytes', () => {
    expect(rawHeadersWithinLimits(raw)).toBe(true);
    expect(
      rawHeadersWithinLimits(
        Array.from({ length: RAW_HEADER_LIMITS.maxFields + 1 }, () => ['a', 'b'] as const),
      ),
    ).toBe(false);
    expect(rawHeadersWithinLimits([['a', 'x'.repeat(RAW_HEADER_LIMITS.maxBytes)]])).toBe(false);
  });
  it.each([
    ['json', 'application/json; charset=utf-8', true],
    ['json', 'application/problem+json', true],
    ['json', 'text/event-stream', false],
    ['json-or-sse', 'text/event-stream', true],
    ['json', 'text/html', false],
    ['json', undefined, false],
    ['status', 'text/html', true],
  ] as const)('%s accepts %p: %s', (accept, ct, ok) => {
    expect(acceptsContentType(accept, ct)).toBe(ok);
  });
});
