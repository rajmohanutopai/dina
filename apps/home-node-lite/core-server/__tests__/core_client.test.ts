/**
 * Task 5.10 — CoreClient interface tests.
 *
 * Pins the surface + the NullCoreClient reference implementation. Any
 * concrete CoreClient (HTTP / in-process) must honour the outcome
 * shape these tests encode.
 */

import {
  NullCoreClient,
  type CoreClient,
  type CoreClientError,
  type CoreOutcome,
  type NullCoreCall,
  type PersonaDetail,
  type PiiScrubResult,
  type VaultItem,
} from '../src/brain/core_client';

describe('CoreClient outcome shape (task 5.10)', () => {
  it('CoreOutcome is a discriminated union on `ok`', () => {
    const ok: CoreOutcome<number> = { ok: true, value: 1 };
    const err: CoreOutcome<number> = {
      ok: false,
      error: { code: 'core_error', message: 'x' },
    };
    // Compile-time narrowing — runtime check the narrowing worked.
    expect(ok.ok ? ok.value : null).toBe(1);
    expect(!err.ok ? err.error.code : null).toBe('core_error');
  });

  it('CoreClientError code covers the documented set', () => {
    const codes: CoreClientError['code'][] = [
      'unauthorized',
      'persona_locked',
      'rate_limited',
      'not_found',
      'invalid_input',
      'core_error',
      'network_error',
    ];
    // This test will fail to compile if the union narrows.
    for (const c of codes) {
      const e: CoreClientError = { code: c, message: '' };
      expect(e.code).toBe(c);
    }
  });
});

describe('NullCoreClient — default responses (task 5.10)', () => {
  let client: NullCoreClient;

  beforeEach(() => {
    client = new NullCoreClient();
  });

  it('implements the CoreClient interface', () => {
    // Compile-time check — the assignment only succeeds when every
    // method is present.
    const asInterface: CoreClient = client;
    expect(asInterface).toBeDefined();
  });

  it('queryVault returns empty array ok-outcome', async () => {
    const r = await client.queryVault({ persona: 'general', query: 'anything' });
    expect(r).toEqual({ ok: true, value: [] });
  });

  it('storeVault returns supplied id when present', async () => {
    const r = await client.storeVault({
      persona: 'general',
      item: {
        id: 'caller-assigned-id',
        persona: 'general',
        type: 'email',
        source: 'gmail',
        summary: 's',
        timestamp: 1_700_000_000,
      },
    });
    expect(r).toEqual({ ok: true, value: { id: 'caller-assigned-id' } });
  });

  it('storeVault falls back to null-core-id when id absent or empty', async () => {
    const base: Omit<VaultItem, 'id'> = {
      persona: 'general',
      type: 'email',
      source: 'gmail',
      summary: 's',
      timestamp: 1,
    };
    const noId = await client.storeVault({ persona: 'general', item: { ...base } });
    expect(noId).toEqual({ ok: true, value: { id: 'null-core-id' } });
    const emptyId = await client.storeVault({
      persona: 'general',
      item: { ...base, id: '' },
    });
    expect(emptyId).toEqual({ ok: true, value: { id: 'null-core-id' } });
  });

  it('scrubPii returns input text unchanged with empty entity map', async () => {
    const r = await client.scrubPii({ text: 'hi ma@x.com', includeEntityMap: true });
    const expected: PiiScrubResult = {
      scrubbedText: 'hi ma@x.com',
      entityMap: {},
      counts: {},
    };
    expect(r).toEqual({ ok: true, value: expected });
  });

  it('notify returns ok with undefined value', async () => {
    const r = await client.notify({
      priority: 'fiduciary',
      message: 'test',
    });
    expect(r).toEqual({ ok: true, value: undefined });
  });

  it('listPersonas returns a copy of the default personas', async () => {
    const r = await client.listPersonas();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([
        { id: 'persona-general', name: 'general', tier: 'default', locked: false },
      ]);
      // Mutating the returned value doesn't corrupt the client's defaults.
      r.value[0]!.name = 'hacked';
      const again = await client.listPersonas();
      expect(again.ok && again.value[0]!.name).toBe('general');
    }
  });

  it('storeReminder returns a stable null id', async () => {
    const r = await client.storeReminder({
      type: '',
      message: 'pay bill',
      triggerAt: 1_700_000_000,
      persona: 'general',
      kind: 'bill',
    });
    expect(r).toEqual({ ok: true, value: { id: 'null-reminder-id' } });
  });

  it('writeScratchpad / readScratchpad no-op returns', async () => {
    const w = await client.writeScratchpad('task-1', 1, { k: 'v' });
    expect(w).toEqual({ ok: true, value: undefined });
    const r = await client.readScratchpad('task-1');
    expect(r).toEqual({ ok: true, value: null });
  });
});

describe('NullCoreClient — recordCalls (task 5.10)', () => {
  it('records nothing by default', async () => {
    const client = new NullCoreClient();
    await client.queryVault({ persona: 'general', query: 'q' });
    await client.notify({ priority: 'engagement', message: 'n' });
    expect(client.calls).toEqual([]);
  });

  it('records every call when enabled', async () => {
    const client = new NullCoreClient({ recordCalls: true });
    await client.queryVault({ persona: 'general', query: 'q' });
    await client.notify({ priority: 'engagement', message: 'n' });
    await client.listPersonas();

    expect(client.calls.length).toBe(3);
    const expected: NullCoreCall[] = [
      { method: 'queryVault', input: { persona: 'general', query: 'q' } },
      { method: 'notify', input: { priority: 'engagement', message: 'n' } },
      { method: 'listPersonas', input: undefined },
    ];
    expect(client.calls).toEqual(expected);
  });

  it('reset clears history but leaves the client usable', async () => {
    const client = new NullCoreClient({ recordCalls: true });
    await client.queryVault({ persona: 'general', query: 'q' });
    expect(client.calls.length).toBe(1);

    client.reset();
    expect(client.calls).toEqual([]);

    await client.listPersonas();
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.method).toBe('listPersonas');
  });

  it('calls getter returns an isolated view', async () => {
    const client = new NullCoreClient({ recordCalls: true });
    await client.queryVault({ persona: 'general', query: 'q' });
    const snapshot = client.calls;
    // Mutate the returned array via a loose cast — the internal
    // history must be unaffected so external consumers can never
    // corrupt it.
    (snapshot as unknown as NullCoreCall[]).push({
      method: 'notify',
      input: { forged: true },
    });
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.method).toBe('queryVault');
  });
});

describe('NullCoreClient — defaultPersonas override (task 5.10)', () => {
  it('honours a custom persona list', async () => {
    const custom: PersonaDetail[] = [
      { id: 'p-work', name: 'work', tier: 'standard', locked: false },
      { id: 'p-health', name: 'health', tier: 'sensitive', locked: true },
    ];
    const client = new NullCoreClient({ defaultPersonas: custom });
    const r = await client.listPersonas();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(custom);
  });

  it('returns an empty list when explicitly configured with []', async () => {
    const client = new NullCoreClient({ defaultPersonas: [] });
    const r = await client.listPersonas();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});
