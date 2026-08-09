/**
 * The credential broker (§8.3, FR-P4 — WS-9.3).
 *
 * The property under test is a NEGATIVE one: no caller can obtain a
 * credential. That cannot be proved by calling every method and checking the
 * return values, because the danger is the method somebody adds next. So the
 * behavioural tests here cover the refusals, and `boundary.test.ts` asserts
 * over the source that no exported function returns material and nothing logs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CredentialBroker,
  paramsCarryCredential,
  redeemLease,
  type BrokeredExecutor,
  type CredentialLease,
} from '../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../src/commerce/credential_store';

const SECRET = 'sk-live-0123456789abcdefghijklmno';

function storeWith(overrides?: { operations?: string[]; installId?: string }): {
  store: InMemoryCredentialStore;
} {
  const store = new InMemoryCredentialStore();
  store.rotate({
    resource: 'erp.primary',
    installId: overrides?.installId ?? 'install-1',
    operations: overrides?.operations ?? ['submit_purchase_order'],
    material: SECRET,
    nowMs: 1_000,
  });
  return { store };
}

function brokerWith(
  store: InMemoryCredentialStore,
  executors: Record<string, BrokeredExecutor>,
  now = 2_000,
): CredentialBroker {
  return new CredentialBroker({ store, executors: () => executors, now: () => now });
}

describe('credential broker — a typed operation, never a secret', () => {
  it('performs the operation and hands the executor the material', async () => {
    const { store } = storeWith();
    let seen: string | null = null;
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async ({ secret, params }) => {
        seen = secret;
        return { ok: true, result: { echoed: params } };
      },
    });

    const result = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: { po: 'PO-1' },
    });

    expect(result).toEqual({ ok: true, result: { echoed: { po: 'PO-1' } } });
    // The EXECUTOR sees it, because the executor is the thing that makes the
    // call. Nothing the caller receives carries it.
    expect(seen).toBe(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('has no method that returns a credential', () => {
    const { store } = storeWith();
    const broker = brokerWith(store, {});
    // Every own and inherited method name, checked against the shapes a read
    // API would take. A future `getSecret` fails here on the commit that adds
    // it rather than on the incident that uses it.
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(broker) as object),
      ...Object.getOwnPropertyNames(broker),
    ];
    expect(
      names.filter((name) => /^(get|read|reveal|fetch|export)\w*(Secret|Credential)/i.test(name)),
    ).toEqual([]);
    // And the one read it DOES offer carries no material.
    expect(JSON.stringify(broker.statuses())).not.toContain(SECRET);
  });

  it('refuses an install the credential does not belong to', async () => {
    const { store } = storeWith({ installId: 'install-1' });
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => ({ ok: true, result: 'ran' }),
    });
    const result = await broker.perform({
      installId: 'install-2',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(result).toEqual({
      ok: false,
      refusal: 'install_not_permitted',
      error: expect.stringContaining('install-2'),
    });
  });

  it('refuses an operation the credential was not granted', async () => {
    const { store } = storeWith({ operations: ['read_catalog'] });
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => ({ ok: true, result: 'ran' }),
    });
    const result = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('operation_not_declared');
  });

  it('never opens the store for a refused call', async () => {
    const { store } = storeWith({ installId: 'install-1' });
    const opened: string[] = [];
    const watched = {
      ...store,
      useSecret: async <T>(resource: string, fn: (secret: string) => Promise<T>): Promise<T> => {
        opened.push(resource);
        return store.useSecret(resource, fn);
      },
      describe: (resource: string) => store.describe(resource),
      list: () => store.list(),
      recordResult: (resource: string, ok: boolean, nowMs: number) => {
        store.recordResult(resource, ok, nowMs);
      },
    };
    const broker = new CredentialBroker({
      store: watched,
      executors: () => ({
        'erp.primary:submit_purchase_order': async () => ({ ok: true, result: 'ran' }),
      }),
    });
    await broker.perform({
      installId: 'install-2',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(opened).toEqual([]);
  });

  it('refuses when the caller put a credential in the params', async () => {
    const { store } = storeWith();
    let ran = false;
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => {
        ran = true;
        return { ok: true, result: 'ran' };
      },
    });
    const result = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: { note: 'use ghp_abcdefghijklmnopqrstuvwxyz01' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('params_carry_credential');
    // REFUSED, not stripped: the caller's bug is still there.
    expect(ran).toBe(false);
  });

  it('separates "you may not" from "this build cannot"', async () => {
    const { store } = storeWith();
    const broker = brokerWith(store, {});
    const result = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(result.ok).toBe(false);
    // An owner sent to the settings screen by `operation_not_declared` would
    // find nothing wrong there: the grant is fine and the wiring is not.
    if (!result.ok) expect(result.refusal).toBe('no_executor');
  });

  it('a forgotten credential stops working on the next call, not the next boot', async () => {
    const { store } = storeWith();
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => ({ ok: true, result: 'ran' }),
    });
    const before = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(before.ok).toBe(true);

    store.forget('erp.primary');
    const after = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.refusal).toBe('no_such_resource');
  });

  it('reads its executors per call, so a connector added later is reachable', async () => {
    const { store } = storeWith();
    const table: Record<string, BrokeredExecutor> = {};
    const broker = new CredentialBroker({ store, executors: () => table });

    const before = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(before.ok).toBe(false);

    table['erp.primary:submit_purchase_order'] = async () => ({ ok: true, result: 'ran' });
    const after = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(after).toEqual({ ok: true, result: 'ran' });
  });
});

describe('credential status is derived, never declared (§18.3)', () => {
  it('records a success and a failure against the resource', async () => {
    const { store } = storeWith();
    expect(store.describe('erp.primary')?.lastResult).toBe('never_used');

    const ok = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => ({ ok: true, result: 'ran' }),
    });
    await ok.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(store.describe('erp.primary')).toMatchObject({
      lastResult: 'ok',
      lastCheckedAtMs: 2_000,
    });

    const bad = brokerWith(
      store,
      { 'erp.primary:submit_purchase_order': async () => ({ ok: false, error: 'HTTP 401' }) },
      3_000,
    );
    const result = await bad.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('operation_failed');
    expect(store.describe('erp.primary')).toMatchObject({
      lastResult: 'failed',
      lastCheckedAtMs: 3_000,
    });
  });

  it('a thrown executor is a failure, not a crash', async () => {
    const { store } = storeWith();
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => {
        throw new Error('socket hang up');
      },
    });
    const result = await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(result).toEqual({
      ok: false,
      refusal: 'operation_failed',
      error: 'socket hang up',
    });
    // Recorded as FAILED, which is the reading that makes an owner look.
    expect(store.describe('erp.primary')?.lastResult).toBe('failed');
  });

  it('rotation resets the verdict rather than carrying it forward', async () => {
    const { store } = storeWith();
    const broker = brokerWith(store, {
      'erp.primary:submit_purchase_order': async () => ({ ok: true, result: 'ran' }),
    });
    await broker.perform({
      installId: 'install-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
      params: {},
    });
    expect(store.describe('erp.primary')?.lastResult).toBe('ok');

    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['submit_purchase_order'],
      material: 'sk-live-brand-new-material-000000',
      nowMs: 9_000,
    });
    // The old `ok` was about the old material. Keeping it would tell an owner
    // their new credential works before anything has used it.
    expect(store.describe('erp.primary')).toMatchObject({
      lastResult: 'never_used',
      lastCheckedAtMs: null,
      rotatedAtMs: 9_000,
    });
  });
});

describe('params carrying credentials', () => {
  it('catches a well-named field and a badly-named value alike', () => {
    expect(paramsCarryCredential({ api_key: 'anything' })).toBe(true);
    expect(paramsCarryCredential({ note: 'AKIAIOSFODNN7EXAMPLE' })).toBe(true);
    expect(paramsCarryCredential({ nested: [{ passphrase: 'x' }] })).toBe(true);
    expect(
      paramsCarryCredential({
        pem: '-----BEGIN RSA PRIVATE KEY-----\nMII...',
      }),
    ).toBe(true);
  });

  it('lets ordinary operation input through', () => {
    expect(paramsCarryCredential({ po: 'PO-1', lines: [{ sku: 'CHAIR-1', qty: '2' }] })).toBe(
      false,
    );
    expect(paramsCarryCredential('a plain note')).toBe(false);
    expect(paramsCarryCredential(null)).toBe(false);
  });
});

describe('the lease fallback (§8.3)', () => {
  const lease: CredentialLease = {
    tenantId: 'tenant-1',
    installId: 'install-1',
    resource: 'erp.primary',
    operation: 'submit_purchase_order',
    expiresAtMs: 10_000,
    consentId: 'consent-1',
  };
  const request = {
    tenantId: 'tenant-1',
    installId: 'install-1',
    resource: 'erp.primary',
    operation: 'submit_purchase_order',
    params: {},
  };

  it('redeems only when every binding matches', () => {
    expect(redeemLease({ lease, request, nowMs: 5_000 })).toEqual({ ok: true });
  });

  it('refuses on each of the four scope bindings, one at a time', () => {
    const cases: [keyof typeof request, string][] = [
      ['tenantId', 'tenant'],
      ['installId', 'install'],
      ['resource', 'resource'],
      ['operation', 'operation'],
    ];
    for (const [field, named] of cases) {
      const verdict = redeemLease({
        lease,
        request: { ...request, [field]: 'something-else' },
        nowMs: 5_000,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.refusal).toBe('lease_scope_mismatch');
        expect(verdict.error).toContain(named);
      }
    }
  });

  it('refuses an expired lease', () => {
    const verdict = redeemLease({ lease, request, nowMs: 10_000 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe('lease_expired');
  });

  it('refuses a lease nobody consented to', () => {
    const verdict = redeemLease({
      lease: { ...lease, consentId: '' },
      request,
      nowMs: 5_000,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('consent');
  });
});

describe('the source itself (§8.3 — a rule review cannot hold alone)', () => {
  const SOURCES = ['credential_broker.ts', 'credential_store.ts'].map((name) =>
    path.join(__dirname, '..', '..', 'src', 'commerce', name),
  );

  /** Strip comments, so prose ABOUT logging is not read as logging. */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('never logs', () => {
    for (const file of SOURCES) {
      const body = code(fs.readFileSync(file, 'utf8'));
      expect(body).not.toMatch(/\bconsole\.\w+\s*\(/);
    }
  });

  it('the broker never reads or declares a material field', () => {
    // The STORE owns the column and the rotation input names it. The broker is
    // what every caller talks to, and it must not touch the value at all: a
    // `.material` read or a `material:` field there is a broker one edit away
    // from returning it. The word may still appear in a refusal message, which
    // is why the check is on the two shapes that HANDLE a value rather than on
    // the word.
    const broker = code(fs.readFileSync(SOURCES[0] ?? '', 'utf8'));
    expect(broker).not.toMatch(/\.material\b/);
    expect(broker).not.toMatch(/\bmaterial\s*[:,]/);
  });
});
