import {
  clearReasoningBackendPresence,
  isReasoningBackendPresent,
  markReasoningBackendPresent,
  resetReasoningBackendPresence,
} from '../../src/reasoning/backend_presence';

describe('reasoning backend runtime presence', () => {
  beforeEach(resetReasoningBackendPresence);
  afterEach(resetReasoningBackendPresence);

  it('is principal-bound and expires without a heartbeat', () => {
    markReasoningBackendPresent('brain', 'did:key:zBrain', 1_000);
    expect(isReasoningBackendPresent('brain', 'did:key:zBrain', 10_999)).toBe(true);
    expect(isReasoningBackendPresent('brain', 'did:key:zOther', 10_999)).toBe(false);
    expect(isReasoningBackendPresent('brain', 'did:key:zBrain', 11_001)).toBe(false);
  });

  it('does not let stale teardown clear a replacement principal', () => {
    markReasoningBackendPresent('brain', 'did:key:zOld', 1_000);
    markReasoningBackendPresent('brain', 'did:key:zNew', 2_000);
    clearReasoningBackendPresence('brain', 'did:key:zOld');
    expect(isReasoningBackendPresent('brain', 'did:key:zNew', 2_001)).toBe(true);
  });
});
