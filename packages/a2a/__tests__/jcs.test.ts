import { runInNewContext } from 'node:vm';

import { JcsError, canonicalize, isPlainObject } from '../src';

describe('RFC 8785 canonicalization', () => {
  it('matches the RFC 8785 §3.2.4 example (literals, numbers, string escapes)', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts members by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
    ) as Record<string, unknown>;
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign",' +
        '"\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('sorts nested objects and keeps array order', () => {
    expect(canonicalize([56, { d: true, '10': null, '1': [] }])).toBe(
      '[56,{"1":[],"10":null,"d":true}]',
    );
  });

  it('writes -0 as 0 and integers without exponent noise', () => {
    expect(canonicalize([-0, 1e21, 1e-7, 0.000001, 9007199254740991])).toBe(
      '[0,1e+21,1e-7,0.000001,9007199254740991]',
    );
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['undefined', undefined],
    ['a function', () => 1],
    ['a bigint', 1n],
    ['a Date', new Date(0)],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', 'a\udc00'],
    ['an undefined array element', [1, undefined]],
    ['an undefined member', { a: undefined }],
    ['a lone surrogate key', { '\ud800': 1 }],
  ])('refuses %s', (_name, value) => {
    expect(() => canonicalize(value)).toThrow(JcsError);
  });

  it('refuses nesting deeper than the cap', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(/too deep/);
  });

  it('keeps well-formed astral characters', () => {
    expect(canonicalize({ a: '😀' })).toBe('{"a":"😀"}');
  });
});

describe('a plain object is judged by shape, not by realm', () => {
  // `structuredClone` under a test runner, or a vm context, makes objects
  // whose prototype is ANOTHER realm's root object prototype.
  const foreign = <T>(source: string): T => runInNewContext(source) as T;

  it('accepts a plain object from another realm, and a null-prototype object', () => {
    expect(isPlainObject(foreign('({ a: 1 })'))).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(canonicalize(foreign('({ b: 2, a: [1, { c: 3 }] })'))).toBe('{"a":[1,{"c":3}],"b":2}');
  });

  it('refuses class instances and objects built on another object, from any realm', () => {
    class Shape {
      x = 1;
    }
    for (const value of [new Date(0), new Map(), new Shape(), Object.create({ a: 1 }), foreign('new Date(0)'), foreign('new Map()')]) {
      expect(isPlainObject(value)).toBe(false);
    }
    expect(() => canonicalize({ when: new Date(0) })).toThrow(JcsError);
  });

  it('refuses an object built on a bare prototype, and a realm’s Object.prototype itself', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { inherited: 1 });
    expect(isPlainObject(Object.create(bare))).toBe(false);
    expect(isPlainObject(Object.prototype)).toBe(false);
    expect(isPlainObject(foreign('Object.prototype'))).toBe(false);
  });

  it('refuses arrays from another realm as objects', () => {
    expect(isPlainObject(foreign('[1, 2]'))).toBe(false);
  });
});
