/**
 * DEF-6.2 (scanner composition + concrete scanners) — tests.
 */

import type { DinaMessage } from '@dina/test-harness';
import {
  composeScanners,
  createAllowListScanner,
  createBodySizeScanner,
} from '../../src/guardian/d2d_scanners';
import type { D2DBody, D2DScanner } from '../../src/guardian/d2d_dispatcher';

function raw(type: string): DinaMessage {
  return {
    id: 'm-1',
    type,
    from: 'did:plc:x',
    to: 'did:plc:y',
    created_time: 0,
    body: '',
  };
}

describe('composeScanners', () => {
  it('zero scanners → passthrough echoes body', () => {
    const s = composeScanners();
    const result = s('service.query', { a: 1 }, raw('service.query'));
    expect(result.body).toEqual({ a: 1 });
    expect(result.dropped).toBeUndefined();
  });

  it('single scanner → returned as-is (no wrapper)', () => {
    const inner: D2DScanner = () => ({ body: { scrubbed: true } });
    expect(composeScanners(inner)).toBe(inner);
  });

  it('runs scanners in order, threading the body forward', () => {
    const order: string[] = [];
    const a: D2DScanner = (_type, body) => {
      order.push('a');
      return { body: { ...(body as Record<string, unknown>), a: true } };
    };
    const b: D2DScanner = (_type, body) => {
      order.push('b');
      return { body: { ...(body as Record<string, unknown>), b: true } };
    };
    const s = composeScanners(a, b);
    const result = s('service.query', { start: 1 }, raw('service.query'));
    expect(order).toEqual(['a', 'b']);
    expect(result.body).toEqual({ start: 1, a: true, b: true });
  });

  it('first drop short-circuits the pipeline', () => {
    let bRan = false;
    const a: D2DScanner = (_t, body) => ({ body, dropped: true, reason: 'nope' });
    const b: D2DScanner = (_t, body) => {
      bRan = true;
      return { body };
    };
    const s = composeScanners(a, b);
    const result = s('service.query', { x: 1 }, raw('service.query'));
    expect(result.dropped).toBe(true);
    expect(result.reason).toBe('nope');
    expect(bRan).toBe(false);
  });

  it('a later scanner sees the body transformed by earlier scanners', () => {
    const seen: D2DBody[] = [];
    const a: D2DScanner = (_t, body) => ({
      body: { ...(body as Record<string, unknown>), stage: 'a' },
    });
    const b: D2DScanner = (_t, body) => {
      seen.push(body);
      return { body };
    };
    composeScanners(a, b)('service.query', { raw: true }, raw('service.query'));
    expect(seen[0]).toEqual({ raw: true, stage: 'a' });
  });
});

describe('createBodySizeScanner', () => {
  it('allows bodies at or below the limit', () => {
    const s = createBodySizeScanner(100);
    const result = s('service.query', { x: 'y' }, raw('service.query'));
    expect(result.dropped).toBeUndefined();
  });

  it('drops bodies exceeding the limit', () => {
    const s = createBodySizeScanner(10);
    const result = s('service.query', { x: 'a'.repeat(20) }, raw('service.query'));
    expect(result.dropped).toBe(true);
    expect(result.reason).toMatch(/exceeds max size/);
  });

  it('counts UTF-8 bytes (not characters)', () => {
    // {"x":"a"}  = 9 bytes  (1 ascii char = 1 byte + 8 wrapping)
    // {"x":"日"} = 11 bytes (1 CJK char  = 3 bytes + 8 wrapping)
    // At limit 10: ascii body passes (9 ≤ 10), CJK body drops (11 > 10).
    // If the scanner naively counted JS string length (1 char each),
    // both would pass → the test would not catch the bug.
    const s = createBodySizeScanner(10);
    expect(s('service.query', { x: 'a' }, raw('service.query')).dropped).toBeUndefined();
    expect(s('service.query', { x: '日' }, raw('service.query')).dropped).toBe(true);
  });

  it('rejects non-positive / non-finite limits at construction', () => {
    expect(() => createBodySizeScanner(0)).toThrow(/maxBytes/);
    expect(() => createBodySizeScanner(-1)).toThrow(/maxBytes/);
    expect(() => createBodySizeScanner(Number.NaN)).toThrow(/maxBytes/);
    expect(() => createBodySizeScanner(Number.POSITIVE_INFINITY)).toThrow(/maxBytes/);
  });

  it('does not mutate the body on allow', () => {
    const s = createBodySizeScanner(100);
    const body = { a: 1 };
    const result = s('service.query', body, raw('service.query'));
    expect(result.body).toBe(body);
  });
});

describe('createAllowListScanner', () => {
  it('allows message types on the list', () => {
    const s = createAllowListScanner({ allowed: ['service.query', 'service.response'] });
    expect(s('service.query', {}, raw('service.query')).dropped).toBeUndefined();
    expect(s('service.response', {}, raw('service.response')).dropped).toBeUndefined();
  });

  it('drops message types not on the list', () => {
    const s = createAllowListScanner({ allowed: ['service.query'] });
    const result = s('service.response', {}, raw('service.response'));
    expect(result.dropped).toBe(true);
    expect(result.reason).toMatch(/not on the allowlist/);
  });

  it('empty allowlist drops everything', () => {
    const s = createAllowListScanner({ allowed: [] });
    expect(s('anything', {}, raw('anything')).dropped).toBe(true);
  });
});

describe('composeScanners + concrete scanners', () => {
  it('allowlist + size guard in pipeline: allowlist rejects first', () => {
    const s = composeScanners(
      createAllowListScanner({ allowed: ['service.query'] }),
      createBodySizeScanner(1000),
    );
    const result = s('safety.alert', {}, raw('safety.alert'));
    expect(result.dropped).toBe(true);
    expect(result.reason).toMatch(/allowlist/);
  });

  it('allowlist passes → size guard still runs', () => {
    const s = composeScanners(
      createAllowListScanner({ allowed: ['service.query'] }),
      createBodySizeScanner(10),
    );
    const result = s('service.query', { x: 'a'.repeat(20) }, raw('service.query'));
    expect(result.dropped).toBe(true);
    expect(result.reason).toMatch(/exceeds max size/);
  });
});
