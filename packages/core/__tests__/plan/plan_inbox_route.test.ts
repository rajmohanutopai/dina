/**
 * DAILY_PLAN.md §4 — an agent's batch signed while the phone slept still
 * counts when the phone wakes, on the inbox route only. Drives the real
 * signed pipeline and router: sign at 07:00, deliver at 17:00.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  registerDevice,
  resetCallerTypeState,
  setDeviceRoleResolver,
  setDeviceScopeResolver,
} from '../../src/auth/caller_type';
import { signRequest } from '../../src/auth/canonical';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../src/auth/middleware';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { decideFeed } from '../../src/plan/intake';
import { PlanStore, setPlanStore } from '../../src/plan/store';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerPlanRoutes } from '../../src/server/routes/plan';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff));
const PUB = getPublicKey(SEED);
const AGENT = deriveDIDKey(PUB);
const T0 = Date.parse('2026-11-03T07:00:00Z');
const HOUR = 60 * 60 * 1000;

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;
let router: CoreRouter;

function signed(
  method: 'GET' | 'POST',
  p: string,
  bodyObj?: unknown,
  query: Record<string, string> = {},
): CoreRequest {
  const raw =
    bodyObj === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(bodyObj));
  const qs = new URLSearchParams(query).toString();
  const h = signRequest(method, p, qs, raw, SEED, AGENT);
  return {
    method,
    path: p,
    query,
    headers: {
      'x-did': h['X-DID'],
      'x-timestamp': h['X-Timestamp'],
      'x-nonce': h['X-Nonce'],
      'x-signature': h['X-Signature'],
    },
    body: bodyObj,
    rawBody: raw,
    params: {},
  };
}

function batch(id: string) {
  return {
    batch_id: id,
    persona: 'work',
    items: [
      {
        source: 'teams',
        source_ref: 'thread-1',
        title: 'Answer the release question',
        observed_at: T0,
      },
    ],
  };
}

function wire(scope: 'coding' | 'dot'): void {
  resetMiddlewareState();
  resetCallerTypeState();
  registerPublicKeyResolver((d) => (d === AGENT ? PUB : null));
  registerDevice(AGENT, 'office-claude');
  setDeviceRoleResolver(() => 'agent');
  setDeviceScopeResolver(() => scope);
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  dir = mkdtempSync(path.join(tmpdir(), 'plan-route-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new PlanStore(db);
  setPlanStore(store);
  router = new CoreRouter();
  registerPlanRoutes(router, { agentName: () => 'Office Claude' });
  wire('coding');
});

afterEach(() => {
  jest.useRealTimers();
  setPlanStore(null);
  resetMiddlewareState();
  resetCallerTypeState();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /v1/plan/inbox from a sleeping phone', () => {
  it('takes a batch signed 10 hours before the phone woke', async () => {
    const req = signed('POST', '/v1/plan/inbox', batch('b1'));
    jest.setSystemTime(T0 + 10 * HOUR);
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 0, held: 1, duplicate_batch: false });
    expect(store.listTasks({ origin: AGENT })[0]).toMatchObject({
      status: 'held',
      persona: 'work',
    });
  });

  it('refuses one signed 21 hours before', async () => {
    const req = signed('POST', '/v1/plan/inbox', batch('b1'));
    jest.setSystemTime(T0 + 21 * HOUR);
    expect((await router.handle(req)).status).toBe(401);
  });

  it('refuses a timestamp more than 5 minutes ahead', async () => {
    jest.setSystemTime(T0 + HOUR);
    const req = signed('POST', '/v1/plan/inbox', batch('b1'));
    jest.setSystemTime(T0);
    expect((await router.handle(req)).status).toBe(401);
  });

  it('keeps the 5-minute window on every other route', async () => {
    const req = signed('GET', '/v1/plan/status');
    jest.setSystemTime(T0 + 10 * HOUR);
    expect((await router.handle(req)).status).toBe(401);
  });

  it('a replayed request adds nothing', async () => {
    const req = signed('POST', '/v1/plan/inbox', batch('b1'));
    jest.setSystemTime(T0 + HOUR);
    await router.handle(req);
    // The app restarted, so the in-memory nonce cache is empty: the batch
    // id refuses the copy.
    wire('coding');
    jest.setSystemTime(T0 + 2 * HOUR);
    const again = await router.handle(req);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate_batch: true });
    expect(store.listTasks()).toHaveLength(1);
  });

  it('status shows the agent its own tasks once the owner allows them', async () => {
    await router.handle(signed('POST', '/v1/plan/inbox', batch('b1')));
    decideFeed(store, AGENT, 'work', true, Date.now());
    const [t] = store.listTasks();
    store.updateTask(t.id, { status: 'done' }, Date.now());
    const res = await router.handle(signed('GET', '/v1/plan/status', undefined, { since: '0' }));
    expect(res.status).toBe(200);
    expect((res.body as { tasks: unknown[] }).tasks).toEqual([
      expect.objectContaining({ source_ref: 'thread-1', status: 'done', persona: 'work' }),
    ]);
  });

  it('a ChatGPT dot cannot send tasks', async () => {
    wire('dot');
    const res = await router.handle(signed('POST', '/v1/plan/inbox', batch('b1')));
    expect(res.status).toBe(403);
    expect(store.listTasks()).toHaveLength(0);
  });
});
