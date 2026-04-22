/**
 * MockCoreClient behavioral smoke — Brain tests depend on these
 * guarantees: (1) records every call, (2) returns configurable canned
 * data, (3) honors `throwOn` failure injection, (4) implements the
 * full `CoreClient` interface (compile-time assertion via implicit
 * variable annotation below).
 *
 * Task 1.34 — test lives in core because that's where jest runs; the
 * mock itself lives in `@dina/test-harness`.
 */

import { MockCoreClient } from '@dina/test-harness';
import type { CoreClient } from '../../src/client/core-client';

describe('MockCoreClient (task 1.34)', () => {
  // Compile-time assertion: any drift in CoreClient that MockCoreClient
  // doesn't cover will fail this assignment. (Runtime side-effect free.)
  it('satisfies the CoreClient interface at compile time', () => {
    const m: CoreClient = new MockCoreClient();
    expect(m).toBeInstanceOf(MockCoreClient);
  });

  it('records every method call with its args', async () => {
    const m = new MockCoreClient();
    await m.healthz();
    await m.vaultQuery('personal', { q: 'dentist' });
    await m.personaStatus('financial');

    expect(m.calls).toHaveLength(3);
    expect(m.calls[0]?.method).toBe('healthz');
    expect(m.calls[0]?.args).toEqual([]);
    expect(m.calls[1]?.method).toBe('vaultQuery');
    expect(m.calls[1]?.args).toEqual(['personal', { q: 'dentist' }]);
    expect(m.calls[2]?.method).toBe('personaStatus');
    expect(m.calls[2]?.args).toEqual(['financial']);

    expect(m.callCountOf('vaultQuery')).toBe(1);
    expect(m.callCountOf('notify')).toBe(0);
  });

  it('returns configurable canned responses', async () => {
    const m = new MockCoreClient();
    m.healthResult = { status: 'ok', did: 'did:key:configured', version: '42.0.0' };
    m.vaultListResult = {
      items: [{ id: 'one' }, { id: 'two' }],
      count: 2,
      total: 99,
    };

    const h = await m.healthz();
    expect(h.did).toBe('did:key:configured');
    expect(h.version).toBe('42.0.0');

    const l = await m.vaultList('personal');
    expect(l.total).toBe(99);
    expect(l.items).toHaveLength(2);
  });

  it('piiScrub passes input through by default (empty canned scrubbed)', async () => {
    // Default MockCoreClient.piiScrubResult.scrubbed is "" — the mock
    // echoes the input so downstream prompt-builders in Brain tests get
    // intelligible text without having to configure the mock.
    const m = new MockCoreClient();
    const r = await m.piiScrub('Hello Alice');
    expect(r.scrubbed).toBe('Hello Alice');
    expect(r.sessionId).toBe('mock-pii-session');
  });

  it('piiScrub honors a configured non-empty scrubbed string', async () => {
    const m = new MockCoreClient();
    m.piiScrubResult = {
      scrubbed: 'Hello {{ENTITY:0}}',
      sessionId: 'custom-session',
      entityCount: 1,
    };
    const r = await m.piiScrub('Hello Alice');
    expect(r.scrubbed).toBe('Hello {{ENTITY:0}}');
    expect(r.entityCount).toBe(1);
  });

  it('personaStatus respects per-persona overrides before falling back', async () => {
    const m = new MockCoreClient();
    m.personaStatusByName.financial = {
      persona: 'financial',
      tier: 'locked',
      open: false,
      dekFingerprint: null,
      openedAt: null,
    };
    m.personaStatusResult = {
      persona: 'PLACEHOLDER',
      tier: 'default',
      open: true,
      dekFingerprint: 'ab12cd34',
      openedAt: 1776700000,
    };

    const locked = await m.personaStatus('financial');
    expect(locked.tier).toBe('locked');
    expect(locked.open).toBe(false);

    // Fallback path: unmatched persona → default result, but with the
    // requested name spliced in (so tests don't see 'PLACEHOLDER').
    const standard = await m.personaStatus('work');
    expect(standard.tier).toBe('default');
    expect(standard.persona).toBe('work');
  });

  it('serviceQuery echoes queryId so callers can correlate without configuring per-test', async () => {
    const m = new MockCoreClient();
    const r = await m.serviceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-real-id',
      params: {},
      ttlSeconds: 60,
    });
    expect(r.taskId).toBe('mock-task-id');
    expect(r.queryId).toBe('q-real-id');
  });

  it('throwOn injects a method-specific exception; other methods keep working', async () => {
    const m = new MockCoreClient();
    m.throwOn = { vaultStore: new Error('simulated core outage') };

    await expect(
      m.vaultStore('personal', { type: 'note', content: {} }),
    ).rejects.toThrow(/simulated core outage/);

    // healthz unaffected.
    await expect(m.healthz()).resolves.toMatchObject({ status: 'ok' });

    // The throw-path still recorded the attempt.
    expect(m.callCountOf('vaultStore')).toBe(1);
  });

  it('serviceConfig defaults to null (matches the real transports on missing config)', async () => {
    const m = new MockCoreClient();
    await expect(m.serviceConfig()).resolves.toBeNull();

    m.serviceConfigResult = {
      isDiscoverable: true,
      name: 'Test Service',
      capabilities: {},
    };
    await expect(m.serviceConfig()).resolves.not.toBeNull();
  });

  it('reset() drops all recorded calls + clears throwOn + per-persona overrides', async () => {
    const m = new MockCoreClient();
    m.throwOn = { healthz: new Error('x') };
    m.personaStatusByName.financial = {
      persona: 'financial',
      tier: 'locked',
      open: false,
      dekFingerprint: null,
      openedAt: null,
    };
    try {
      await m.healthz();
    } catch {
      /* expected */
    }
    expect(m.calls).toHaveLength(1);

    m.reset();

    expect(m.calls).toHaveLength(0);
    expect(m.throwOn).toEqual({});
    expect(m.personaStatusByName).toEqual({});

    // After reset, healthz no longer throws.
    await expect(m.healthz()).resolves.toMatchObject({ status: 'ok' });
  });
});
