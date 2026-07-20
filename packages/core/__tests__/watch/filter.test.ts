/**
 * R2-04 — the watch wake-filter evaluator: fire only when a poll result matches
 * the watch's condition (cry-wolf guard), else stay silent.
 */

import { classifyWatchFilter, parseWatchFilter, watchFilterMatches } from '../../src/watch/filter';

describe('parseWatchFilter', () => {
  it('parses a well-formed { contains } filter', () => {
    expect(parseWatchFilter({ contains: 'delayed' })).toEqual({ contains: 'delayed' });
  });

  it('returns undefined for absent / malformed / empty filters', () => {
    expect(parseWatchFilter(undefined)).toBeUndefined();
    expect(parseWatchFilter(null)).toBeUndefined();
    expect(parseWatchFilter('delayed')).toBeUndefined();
    expect(parseWatchFilter({})).toBeUndefined();
    expect(parseWatchFilter({ contains: '' })).toBeUndefined();
    expect(parseWatchFilter({ contains: '   ' })).toBeUndefined();
    expect(parseWatchFilter({ contains: 42 })).toBeUndefined();
  });
});

describe('classifyWatchFilter (R5-07)', () => {
  it('absent = undefined/null (legitimately unfiltered → fire always)', () => {
    expect(classifyWatchFilter(undefined)).toBe('absent');
    expect(classifyWatchFilter(null)).toBe('absent');
  });

  it('valid = a well-formed { contains: <non-empty string> }', () => {
    expect(classifyWatchFilter({ contains: 'delayed' })).toBe('valid');
  });

  it('invalid = present but malformed — must fail closed, never "fire always"', () => {
    expect(classifyWatchFilter({})).toBe('invalid');
    expect(classifyWatchFilter({ contains: '' })).toBe('invalid');
    expect(classifyWatchFilter({ contains: '   ' })).toBe('invalid');
    expect(classifyWatchFilter({ contains: 42 })).toBe('invalid');
    expect(classifyWatchFilter('delayed')).toBe('invalid');
    expect(classifyWatchFilter([{ contains: 'delayed' }])).toBe('invalid');
  });
});

describe('watchFilterMatches', () => {
  it('an ABSENT filter always fires (wake policy: always)', () => {
    expect(watchFilterMatches(undefined, 'BA117 is on time')).toBe(true);
  });

  it('fires only on a case-insensitive substring match (cry-wolf guard)', () => {
    const filter = { contains: 'delayed' };
    // "notify me if BA117 is delayed" — silent on "on time", fires on "delayed".
    expect(watchFilterMatches(filter, 'BA117 is on time')).toBe(false);
    expect(watchFilterMatches(filter, 'BA117 is DELAYED by 40m')).toBe(true);
    expect(watchFilterMatches(filter, 'Delayed departure')).toBe(true);
  });
});
