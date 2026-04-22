/**
 * Canonical Brain↔`MockCoreClient` exemplar (task 1.35).
 *
 * Phase 1c shifts Brain off the legacy `BrainCoreClient` (which owns
 * its own HTTP stack) onto the transport-agnostic `CoreClient`
 * interface. Production Brain receives `HttpCoreTransport` on the
 * server build and `InProcessTransport` on the mobile build. Brain
 * *tests* receive `MockCoreClient` from `@dina/test-harness`.
 *
 * This file is the reference wiring the task 1.32 bulk-refactor will
 * copy into every migrated Brain subsystem test. It verifies three
 * invariants up-front, so regressions surface here before they
 * ripple across 30+ Brain test files:
 *
 *   1. Module graph — `@dina/test-harness/MockCoreClient` resolves
 *      cleanly from a Brain test (catches broken moduleNameMapper
 *      or accidental runtime-dep edge in test-harness).
 *   2. Structural typing — `MockCoreClient` satisfies `CoreClient`
 *      at compile time (catches interface drift in either package).
 *   3. Observable behaviour — a subject-under-test that *takes*
 *      `CoreClient` by parameter actually drives the mock: calls
 *      are recorded, canned responses flow through, `throwOn`
 *      injection fires.
 *
 * The `SubjectUnderTest` class below is intentionally test-local
 * — it models what a thin Brain-side helper looks like when
 * ported to the CoreClient interface, without creating a real
 * production module that 1.32 would duplicate or conflict with.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.35.
 */

import { MockCoreClient } from '@dina/test-harness';

import type { CoreClient } from '@dina/core';

/**
 * Thin test-local Brain helper. Demonstrates the shape the task
 * 1.32 refactor gives to every migrated Brain subsystem: a class
 * that takes `CoreClient` in the constructor, holds no transport
 * state of its own, and never imports `fetch` / `undici` / `ws`.
 *
 * Intentionally covers a mix of method categories so the exemplar
 * exercises signing, vault I/O, and notification in one place.
 */
class SubjectUnderTest {
  constructor(private readonly core: CoreClient) {}

  /** Probe Core liveness — returns the reported DID or `null` if unhealthy. */
  async probe(): Promise<string | null> {
    const h = await this.core.healthz();
    return h.status === 'ok' ? h.did : null;
  }

  /** Store a note + notify the user as engagement-priority. */
  async storeAndNotify(persona: string, note: string): Promise<{ itemId: string; notificationId: string }> {
    const stored = await this.core.vaultStore(persona, {
      type: 'note',
      content: { text: note },
    });
    const notified = await this.core.notify({
      priority: 'engagement',
      title: 'New note stored',
      body: note,
      meta: { itemId: stored.id },
    });
    return { itemId: stored.id, notificationId: notified.notificationId };
  }

  /** Query the vault, returning just the result count. */
  async countMatches(persona: string, q: string): Promise<number> {
    const r = await this.core.vaultQuery(persona, { q });
    return r.count;
  }
}

describe('Brain ↔ MockCoreClient exemplar (task 1.35)', () => {
  let core: MockCoreClient;
  let subject: SubjectUnderTest;

  beforeEach(() => {
    core = new MockCoreClient();
    subject = new SubjectUnderTest(core);
  });

  describe('module graph + structural typing', () => {
    it('MockCoreClient from @dina/test-harness satisfies CoreClient from @dina/core', () => {
      // This is a compile-time assertion (the type annotation IS the test).
      // If MockCoreClient ever drifts from the CoreClient interface, the
      // whole file fails to type-check before Jest ever runs.
      const asInterface: CoreClient = new MockCoreClient();
      expect(typeof asInterface.healthz).toBe('function');
      expect(typeof asInterface.vaultQuery).toBe('function');
      expect(typeof asInterface.notify).toBe('function');
      expect(typeof asInterface.memoryToC).toBe('function');
    });
  });

  describe('observable behaviour through the interface', () => {
    it('drives canned healthz response and records the call', async () => {
      core.healthResult = { status: 'ok', did: 'did:key:z6MkAlonso', version: '0.2.1-test' };

      const did = await subject.probe();

      expect(did).toBe('did:key:z6MkAlonso');
      expect(core.callCountOf('healthz')).toBe(1);
      expect(core.calls[0]).toEqual({ method: 'healthz', args: [] });
    });

    it('composes multiple CoreClient calls in order', async () => {
      core.vaultStoreResult = { id: 'vi-42', storedAt: '2026-04-21T10:00:00Z' };
      core.notifyResult = { accepted: true, notificationId: 'n-99', subscribers: 2 };

      const result = await subject.storeAndNotify('personal', 'bus 42 reaches castro in 12m');

      expect(result).toEqual({ itemId: 'vi-42', notificationId: 'n-99' });
      expect(core.calls.map((c) => c.method)).toEqual(['vaultStore', 'notify']);

      const [storeCall, notifyCall] = core.calls;
      if (storeCall === undefined || notifyCall === undefined) {
        throw new Error('expected vaultStore + notify calls to have been recorded');
      }
      // Assert the store got the typed persona + item shape (no stringly-typed leakage).
      const [, vaultItem] = storeCall.args as [string, { type: string; content: unknown }];
      expect(vaultItem.type).toBe('note');
      expect(vaultItem.content).toEqual({ text: 'bus 42 reaches castro in 12m' });
      // Assert the notify payload encoded the crosslink to the stored item.
      const [notifyPayload] = notifyCall.args as [{ priority: string; meta?: { itemId: string } }];
      expect(notifyPayload.priority).toBe('engagement');
      expect(notifyPayload.meta?.itemId).toBe('vi-42');
    });

    it('propagates CoreClient errors via throwOn injection', async () => {
      core.throwOn.vaultQuery = new Error('persona-locked');

      await expect(subject.countMatches('financial', 'invoice')).rejects.toThrow('persona-locked');

      // Call is still recorded — matches the dispatch contract documented
      // in test-harness/src/mocks/core_client.ts (log-before-throw).
      expect(core.calls).toEqual([{ method: 'vaultQuery', args: ['financial', { q: 'invoice' }] }]);
    });

    it('resets cleanly between tests', async () => {
      await subject.probe();
      core.throwOn.notify = new Error('boom');
      expect(core.calls.length).toBe(1);

      core.reset();

      expect(core.calls).toEqual([]);
      expect(core.throwOn).toEqual({});
      // A fresh probe after reset sees no leakage from the previous test.
      await subject.probe();
      expect(core.calls.length).toBe(1);
    });
  });

  describe('canonical pattern documentation', () => {
    it('the subject under test never imports fetch / ws / undici — proven by dep_hygiene.test.ts', () => {
      // This placeholder test exists so future readers find the pattern
      // explicitly spelled out. The actual enforcement lives in
      // packages/brain/__tests__/dep_hygiene.test.ts (task 1.33).
      // SubjectUnderTest here imports only `CoreClient` (type-only from
      // @dina/core). That's the entire Brain↔Core surface after 1.32.
      expect(true).toBe(true);
    });
  });
});
