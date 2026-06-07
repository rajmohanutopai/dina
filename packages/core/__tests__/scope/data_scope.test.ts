/**
 * DataScope runtime manager — unit tests (design doc Test Plan § "Data scope").
 */

import {
  USER_SCOPE,
  currentDataScope,
  setCurrentDataScope,
  isGuidedDemoScope,
  isValidDataScope,
  newGuidedDemoScope,
  runInDataScope,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
  type DataScope,
} from '../../src/scope/data_scope';

describe('DataScope runtime manager', () => {
  afterEach(() => {
    resetDataScope();
    resetGuidedDemoIdFactory();
  });

  it('defaults to the user scope', () => {
    expect(currentDataScope()).toBe('user');
    expect(USER_SCOPE).toBe('user');
  });

  it('newGuidedDemoScope has guided_demo:<id> shape and is unique', () => {
    resetGuidedDemoIdFactory();
    const a = newGuidedDemoScope();
    const b = newGuidedDemoScope();
    expect(a).toMatch(/^guided_demo:[A-Za-z0-9_-]+$/);
    expect(b).toMatch(/^guided_demo:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b); // distinct run ids
  });

  it('uses an injected id factory deterministically', () => {
    setGuidedDemoIdFactory(() => 'abc123');
    expect(newGuidedDemoScope()).toBe('guided_demo:abc123');
  });

  it('rejects a factory that produces an invalid run id', () => {
    setGuidedDemoIdFactory(() => 'bad:id'); // ':' is the scope delimiter
    expect(() => newGuidedDemoScope()).toThrow(/invalid run id/);
  });

  it('setCurrentDataScope changes the current scope', () => {
    setCurrentDataScope('guided_demo:run1');
    expect(currentDataScope()).toBe('guided_demo:run1');
    setCurrentDataScope('user');
    expect(currentDataScope()).toBe('user');
  });

  it('setCurrentDataScope rejects a malformed scope', () => {
    expect(() => setCurrentDataScope('nonsense' as DataScope)).toThrow(/invalid data scope/);
    expect(() => setCurrentDataScope('guided_demo:' as DataScope)).toThrow(/invalid data scope/);
    expect(() => setCurrentDataScope('guided_demo:a b' as DataScope)).toThrow(/invalid data scope/);
  });

  it('isGuidedDemoScope distinguishes demo from user', () => {
    expect(isGuidedDemoScope('user')).toBe(false);
    expect(isGuidedDemoScope('guided_demo:x')).toBe(true);
  });

  it('isValidDataScope accepts user + well-formed demo scopes only', () => {
    expect(isValidDataScope('user')).toBe(true);
    expect(isValidDataScope('guided_demo:abc-123_XYZ')).toBe(true);
    expect(isValidDataScope('guided_demo:')).toBe(false);
    expect(isValidDataScope('guided_demo:a:b')).toBe(false);
    expect(isValidDataScope('admin')).toBe(false);
    expect(isValidDataScope('')).toBe(false);
  });

  it('runInDataScope restores the prior scope after success', () => {
    setCurrentDataScope('guided_demo:outer');
    const result = runInDataScope('user', () => {
      expect(currentDataScope()).toBe('user');
      return 42;
    });
    expect(result).toBe(42);
    expect(currentDataScope()).toBe('guided_demo:outer');
  });

  it('runInDataScope restores the prior scope after a throw', () => {
    setCurrentDataScope('guided_demo:outer');
    expect(() =>
      runInDataScope('user', () => {
        expect(currentDataScope()).toBe('user');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(currentDataScope()).toBe('guided_demo:outer');
  });

  it('runInDataScope nests correctly', () => {
    expect(currentDataScope()).toBe('user');
    runInDataScope('guided_demo:a', () => {
      expect(currentDataScope()).toBe('guided_demo:a');
      runInDataScope('guided_demo:b', () => {
        expect(currentDataScope()).toBe('guided_demo:b');
      });
      expect(currentDataScope()).toBe('guided_demo:a');
    });
    expect(currentDataScope()).toBe('user');
  });

  it('resetDataScope returns to user', () => {
    setCurrentDataScope('guided_demo:x');
    resetDataScope();
    expect(currentDataScope()).toBe('user');
  });
});
