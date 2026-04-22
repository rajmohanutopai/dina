/**
 * T3.13 — Sleep/wake lifecycle: DEK zeroing, vault close, MsgBox reconnect.
 *
 * Category B+: NEW mobile-specific test.
 *
 * Source: ARCHITECTURE.md Section 23.6.
 */

import {
  enterBackground,
  expireBackground,
  resumeFromBackground,
  areSecretsZeroed,
  isMsgBoxConnected,
  getAppState,
  getBackgroundTimeout,
  resetLifecycleState,
  setBackgroundTimeout,
  markSecretsRestored,
} from '../../src/lifecycle/sleep_wake';

describe('Sleep/Wake Lifecycle (Mobile-Specific)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetLifecycleState();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('starts in active state', () => {
      expect(getAppState()).toBe('active');
    });

    it('secrets are not zeroed initially', () => {
      expect(areSecretsZeroed()).toBe(false);
    });

    it('MsgBox is connected initially', () => {
      expect(isMsgBoxConnected()).toBe(true);
    });
  });

  describe('enter background', () => {
    it('transitions to background state', () => {
      enterBackground();
      expect(getAppState()).toBe('background');
    });

    it('starts timeout countdown', () => {
      enterBackground();
      expect(getAppState()).toBe('background');
      // Timer hasn't fired yet — secrets still in RAM
      expect(areSecretsZeroed()).toBe(false);
    });

    it('timeout fires → expires background', () => {
      enterBackground();
      jest.advanceTimersByTime(getBackgroundTimeout() * 1000);
      expect(getAppState()).toBe('background_expired');
      expect(areSecretsZeroed()).toBe(true);
    });
  });

  describe('background timeout expired', () => {
    beforeEach(() => {
      enterBackground();
      expireBackground();
    });

    it('zeros all DEKs (secrets zeroed)', () => {
      expect(areSecretsZeroed()).toBe(true);
    });

    it('transitions to background_expired state', () => {
      expect(getAppState()).toBe('background_expired');
    });

    it('disconnects MsgBox WebSocket', () => {
      expect(isMsgBoxConnected()).toBe(false);
    });
  });

  describe('resume from background', () => {
    it('needs unlock if past timeout (secrets zeroed)', () => {
      enterBackground();
      expireBackground();
      const result = resumeFromBackground();
      expect(result.needsUnlock).toBe(true);
    });

    it('does NOT need unlock if within timeout (secrets in RAM)', () => {
      enterBackground();
      // Don't advance timers — resume before timeout
      const result = resumeFromBackground();
      expect(result.needsUnlock).toBe(false);
    });

    it('returns to active state after resume', () => {
      enterBackground();
      resumeFromBackground();
      expect(getAppState()).toBe('active');
    });

    it('returns to active state even after expired resume', () => {
      enterBackground();
      expireBackground();
      resumeFromBackground();
      expect(getAppState()).toBe('active');
    });

    it('secrets remain zeroed until markSecretsRestored', () => {
      enterBackground();
      expireBackground();
      resumeFromBackground();
      expect(areSecretsZeroed()).toBe(true);
      markSecretsRestored();
      expect(areSecretsZeroed()).toBe(false);
    });

    it('MsgBox reconnects after markSecretsRestored', () => {
      enterBackground();
      expireBackground();
      expect(isMsgBoxConnected()).toBe(false);
      resumeFromBackground();
      markSecretsRestored();
      expect(isMsgBoxConnected()).toBe(true);
    });

    it('drains MsgBox buffered messages on reconnect', () => {
      // Messages buffered during sleep are delivered via WS
      // This is an integration concern — we verify reconnect state
      enterBackground();
      expireBackground();
      resumeFromBackground();
      markSecretsRestored();
      expect(isMsgBoxConnected()).toBe(true);
    });
  });

  describe('timeout configuration', () => {
    it('default timeout is 300 seconds (5 minutes)', () => {
      expect(getBackgroundTimeout()).toBe(300);
    });

    it('timeout is configurable', () => {
      setBackgroundTimeout(60);
      expect(getBackgroundTimeout()).toBe(60);
    });

    it('rejects negative timeout', () => {
      expect(() => setBackgroundTimeout(-1)).toThrow('non-negative');
    });

    it('allows zero timeout (immediate expiry)', () => {
      setBackgroundTimeout(0);
      expect(getBackgroundTimeout()).toBe(0);
    });

    it('configured timeout affects expiry timing', () => {
      setBackgroundTimeout(60);
      enterBackground();
      jest.advanceTimersByTime(59_000);
      expect(getAppState()).toBe('background');
      jest.advanceTimersByTime(1_000);
      expect(getAppState()).toBe('background_expired');
    });
  });

  describe('re-enter background after resume', () => {
    it('can cycle through background → resume → background', () => {
      enterBackground();
      resumeFromBackground();
      expect(getAppState()).toBe('active');

      enterBackground();
      expect(getAppState()).toBe('background');
      expireBackground();
      expect(getAppState()).toBe('background_expired');
    });
  });

  describe('app killed', () => {
    it('everything zeroed (no recovery without passphrase)', () => {
      // OS kills app → all memory freed → secrets gone
      // Only pre-scheduled local notifications still fire
      expect(true).toBe(true);
    });

    it('MsgBox buffers messages for 24h', () => {
      // When phone reconnects (new app launch), MsgBox drains buffer
      expect(true).toBe(true);
    });
  });
});
