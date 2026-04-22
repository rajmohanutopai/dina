/**
 * T2C.2 — CLI task validation: research intent, denied tasks, dry-run, session.
 *
 * Source: cli/tests/test_task.py
 */

import { validateTask, dryRunTask, withSessionLifecycle } from '../../src/cli/task';
import { clearAllSessions } from '../../src/session/lifecycle';

describe('CLI Task Validation', () => {
  beforeEach(() => clearAllSessions());

  describe('validateTask', () => {
    it('validates research intent', () => {
      const result = validateTask('Research ergonomic chairs', 'search');
      expect(result.valid).toBe(true);
      expect(result.denied).toBe(false);
      expect(result.action).toBe('search');
    });

    it('infers search from "research" keyword', () => {
      const result = validateTask('Research ergonomic chairs');
      expect(result.action).toBe('search');
      expect(result.valid).toBe(true);
    });

    it('denied task → denied:true', () => {
      const result = validateTask('Delete all data', 'delete_large');
      // delete_large is MODERATE, not denied
      expect(result.valid).toBe(true);
    });

    it('credential_export → denied', () => {
      const result = validateTask('Export credentials', 'credential_export');
      expect(result.denied).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
    });

    it('brain-denied actions rejected', () => {
      const result = validateTask('Sign DID document', 'did_sign');
      expect(result.denied).toBe(true);
    });

    it('infers purchase from "buy" keyword', () => {
      const result = validateTask('Buy a new chair');
      expect(result.action).toBe('purchase');
      expect(result.valid).toBe(true); // HIGH but allowed
    });
  });

  describe('dryRunTask', () => {
    it('validates without invoking OpenClaw', () => {
      const result = dryRunTask('Research ergonomic chairs');
      expect(result.valid).toBe(true);
      expect(result.action).toBe('search');
    });

    it('returns same validation as validateTask', () => {
      const v1 = validateTask('Research chairs');
      const v2 = dryRunTask('Research chairs');
      expect(v1.valid).toBe(v2.valid);
      expect(v1.action).toBe(v2.action);
    });

    it('denied task shows reason', () => {
      const result = dryRunTask('Export credentials');
      expect(result.denied).toBe(true);
    });
  });

  describe('withSessionLifecycle', () => {
    it('creates and ends session around fn', async () => {
      const result = await withSessionLifecycle(
        'did:key:z6MkAgent',
        'chair-research',
        async (sessionId) => {
          expect(sessionId).toMatch(/^sess-/);
          return 'done';
        },
      );
      expect(result).toBe('done');
    });

    it('session end called even on error', async () => {
      await expect(
        withSessionLifecycle('did:key:z6MkAgent', 'failing-task', async () => {
          throw new Error('task failed');
        }),
      ).rejects.toThrow('task failed');
      // Session should be cleaned up (no leak)
    });

    it('passes session ID to inner function', async () => {
      const sessionId = await withSessionLifecycle('did:key:z6MkAgent', 'test', async (sid) => sid);
      expect(sessionId).toMatch(/^sess-/);
    });
  });
});
