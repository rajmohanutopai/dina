/**
 * semver_compare tests.
 */

import {
  SemverParseError,
  compareSemver,
  isValidSemver,
  parseSemver,
  satisfiesAtLeast,
  satisfiesLessThan,
} from '../src/brain/semver_compare';

describe('parseSemver — basic', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['non-string', 42 as unknown as string],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => parseSemver(bad as string)).toThrow(SemverParseError);
  });

  it.each([
    ['missing patch', '1.2'],
    ['extra segment', '1.2.3.4'],
    ['alpha in number', '1.a.3'],
    ['leading zero major', '01.2.3'],
    ['leading zero minor', '1.02.3'],
    ['negative', '-1.2.3'],
    ['leading v', 'v1.2.3'],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => parseSemver(bad)).toThrow(SemverParseError);
  });

  it('parses core MAJOR.MINOR.PATCH', () => {
    const s = parseSemver('1.2.3');
    expect(s.major).toBe(1);
    expect(s.minor).toBe(2);
    expect(s.patch).toBe(3);
    expect(s.pre).toEqual([]);
    expect(s.build).toBeNull();
    expect(s.raw).toBe('1.2.3');
  });

  it('trims surrounding whitespace', () => {
    const s = parseSemver('  1.2.3  ');
    expect(s.raw).toBe('1.2.3');
  });

  it('parses pre-release identifiers', () => {
    const s = parseSemver('1.2.3-alpha.1');
    expect(s.pre).toEqual(['alpha', '1']);
  });

  it('parses build metadata', () => {
    const s = parseSemver('1.2.3+build.123');
    expect(s.build).toBe('build.123');
    expect(s.pre).toEqual([]);
  });

  it('parses pre-release + build together', () => {
    const s = parseSemver('1.2.3-rc.1+build.7');
    expect(s.pre).toEqual(['rc', '1']);
    expect(s.build).toBe('build.7');
  });

  it('rejects empty build metadata', () => {
    expect(() => parseSemver('1.2.3+')).toThrow(/build metadata/);
  });

  it.each([
    ['empty pre identifier', '1.2.3-'],
    ['leading zero pre numeric', '1.2.3-01'],
    ['bad char in pre', '1.2.3-al@pha'],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => parseSemver(bad)).toThrow(SemverParseError);
  });
});

describe('isValidSemver', () => {
  it.each([
    ['0.0.0', true],
    ['1.2.3', true],
    ['1.2.3-alpha', true],
    ['1.2.3-alpha.1', true],
    ['1.2.3+build', true],
    ['1.2.3-rc.1+build', true],
    ['v1.2.3', false],
    ['1.2', false],
    ['abc', false],
    ['', false],
  ] as const)('%s → %s', (version, expected) => {
    expect(isValidSemver(version)).toBe(expected);
  });
});

describe('compareSemver — core version', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '1.0.0', 1],
    ['1.2.0', '1.3.0', -1],
    ['1.3.0', '1.2.0', 1],
    ['1.2.3', '1.2.4', -1],
    ['1.2.4', '1.2.3', 1],
    ['10.0.0', '9.0.0', 1],
    ['1.10.0', '1.9.0', 1],
    ['1.0.10', '1.0.9', 1],
  ] as const)('%s vs %s → %d', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});

describe('compareSemver — pre-release precedence', () => {
  it('absence > presence: 1.0.0 > 1.0.0-rc.1', () => {
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });

  it.each([
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], // shorter is lower
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1], // numeric < alphanumeric
    ['1.0.0-alpha.beta', '1.0.0-beta', -1], // alpha < beta (string compare)
    ['1.0.0-beta.2', '1.0.0-beta.11', -1], // numeric compare, not string
    ['1.0.0-beta.11', '1.0.0-beta.2', 1],
    ['1.0.0-rc.1', '1.0.0-rc.1', 0],
  ] as const)('%s vs %s → %d (per spec §11)', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});

describe('compareSemver — build metadata ignored', () => {
  it('same version different build → 0', () => {
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareSemver('1.0.0+a', '1.0.0')).toBe(0);
  });

  it('build does not affect pre-release comparison', () => {
    expect(compareSemver('1.0.0-rc.1+a', '1.0.0-rc.2+b')).toBe(-1);
  });
});

describe('compareSemver — accepts pre-parsed input', () => {
  it('works with ParsedSemver objects directly', () => {
    const a = parseSemver('1.0.0');
    const b = parseSemver('2.0.0');
    expect(compareSemver(a, b)).toBe(-1);
  });

  it('mixed: string + parsed', () => {
    const b = parseSemver('1.0.0');
    expect(compareSemver('0.9.0', b)).toBe(-1);
    expect(compareSemver(b, '0.9.0')).toBe(1);
  });
});

describe('satisfiesAtLeast / satisfiesLessThan', () => {
  it('satisfiesAtLeast: v >= min', () => {
    expect(satisfiesAtLeast('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesAtLeast('1.1.0', '1.0.0')).toBe(true);
    expect(satisfiesAtLeast('0.9.0', '1.0.0')).toBe(false);
  });

  it('satisfiesLessThan: v < max', () => {
    expect(satisfiesLessThan('0.9.0', '1.0.0')).toBe(true);
    expect(satisfiesLessThan('1.0.0', '1.0.0')).toBe(false);
    expect(satisfiesLessThan('1.0.1', '1.0.0')).toBe(false);
  });

  it('pre-release handled correctly in range', () => {
    // 1.0.0-rc.1 < 1.0.0
    expect(satisfiesLessThan('1.0.0-rc.1', '1.0.0')).toBe(true);
    expect(satisfiesAtLeast('1.0.0-rc.1', '1.0.0')).toBe(false);
  });
});

describe('compareSemver — real-world sequences', () => {
  it('canonical sort produces monotonic order', () => {
    const versions = [
      '1.0.0',
      '2.0.0',
      '1.0.0-rc.2',
      '1.0.0-rc.1',
      '1.0.1',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta',
    ];
    const sorted = [...versions].sort((a, b) => compareSemver(a, b));
    expect(sorted).toEqual([
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta',
      '1.0.0-rc.1',
      '1.0.0-rc.2',
      '1.0.0',
      '1.0.1',
      '2.0.0',
    ]);
  });
});
