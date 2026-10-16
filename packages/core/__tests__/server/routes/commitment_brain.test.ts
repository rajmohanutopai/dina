/**
 * COMMITMENT_KERNEL §15 step 5 — Brain's door to the value model.
 *
 *   R-01  Brain only: the owner's caller and agents are refused;
 *   R-02  the view carries the vocabulary and the entries Brain may read, never
 *         the Core form, and no values when the owner switched them off;
 *   R-03  a change needs the owner's newest turn, once; it raises one card;
 *   R-04  with values off, Brain drafts no values (never-rules still may be);
 *   R-05  Brain reading the card through the workflow routes learns only that
 *         one exists: no description, no entries.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2AReleaseLog, installA2AReleaseLog } from '../../../src/a2a';
import { cleanForProvenance } from '../../../src/a2a/provenance_text';
import { resetSpanProofs } from '../../../src/a2a/span_proof';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { installValueModelStore, ValueModelStore } from '../../../src/commitment/model_store';
import { installStrategyStore, StrategyStore } from '../../../src/commitment/strategy_store';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommitmentBrainRoutes } from '../../../src/server/routes/commitment_brain';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../../src/workflow/service';

const SESSION = 'chat:main';
const KIND = 'shelf_space.vendor';

describe('Brain’s door to the value model', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;
  let log: A2AReleaseLog;
  let router: CoreRouter;
  let store: ValueModelStore;
  let strategy: StrategyStore;
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'commitment-brain-'));
    db = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: 'ab'.repeat(32),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    // Each turn a moment after the last, as real turns are: two in one
    // millisecond would leave "the newest" undecided.
    let clock = Date.now();
    log = new A2AReleaseLog(db, () => (clock += 1_000), { chatLivesIn: 'brain' });
    installA2AReleaseLog(log);
    resetSpanProofs();
    store = new ValueModelStore(db, {
      db: () => null,
      isOpen: () => false,
      brainMayRead: () => false,
    });
    installValueModelStore(store);
    strategy = new StrategyStore(db);
    installStrategyStore(strategy);
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
    router = new CoreRouter();
    registerCommitmentBrainRoutes(router);
    registerWorkflowRoutes(router);
  });
  afterEach(() => {
    installA2AReleaseLog(null);
    installValueModelStore(null);
    installStrategyStore(null);
    setWorkflowService(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (
    method: 'GET' | 'POST',
    p: string,
    body: unknown,
    callerType: string | undefined = 'brain',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const req: CoreRequest = {
      method,
      path: p,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      ...(callerType !== undefined ? { callerType } : {}),
    } as CoreRequest;
    const res = await router.handle(req);
    return { status: res.status, body: res.body as Record<string, unknown> };
  };

  const said = (turnId: string, text: string) => {
    log.recordUtterance(SESSION, turnId, text);
    const clean = cleanForProvenance(text);
    return {
      release_session: SESSION,
      turn_id: turnId,
      turn_text: text,
      start: 0,
      end: clean.length,
    };
  };

  const run = (rupees: string) => ({
    action: 'put',
    entry: {
      body: {
        type: 'promise',
        part: 'stock_run',
        dimensions: { crates: '2', day: 'tue', every_days: '7' },
        rupees,
      },
    },
  });

  it('R-01: Brain only', async () => {
    expect((await call('GET', `/v1/commitment/brain/${KIND}`, undefined, 'owner')).status).toBe(
      403,
    );
    expect((await call('GET', `/v1/commitment/brain/${KIND}`, undefined, 'agent')).status).toBe(
      403,
    );
    expect((await call('GET', `/v1/commitment/brain/${KIND}`, undefined)).status).toBe(200);
  });

  it('R-02: the view carries no form, and no values when switched off', async () => {
    store.setForm(
      KIND,
      { walkAway: 987n, limits: {}, totals: { overall: 44_444n }, asking: {}, binding: 'card' },
      1,
    );
    store.putEntry(
      {
        id: 'run',
        kind: KIND,
        covers: ['stock_run'],
        body: {
          type: 'promise',
          part: 'stock_run',
          value: { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees: -300n },
        },
      },
      2,
    );
    store.putEntry(
      {
        id: 'n1',
        kind: KIND,
        covers: ['stock_run'],
        body: {
          type: 'never',
          label: 'no stock runs',
          all: [{ part: 'stock_run', present: true }],
        },
      },
      3,
    );
    const on = await call('GET', `/v1/commitment/brain/${KIND}`, undefined);
    expect(JSON.stringify(on.body)).not.toMatch(
      /987|44444|walkAway|limits|totals|asking|no stock runs/,
    );
    expect((on.body.entries as unknown[]).length).toBe(2);
    strategy.setSettings(KIND, { strategy: 'fixed', valuesOn: false }, 4);
    const off = await call('GET', `/v1/commitment/brain/${KIND}`, undefined);
    expect(off.body.values_on).toBe(false);
    expect(JSON.stringify(off.body.entries)).not.toContain('-300');
  });

  it('R-03: a change needs the owner’s newest turn, once', async () => {
    const proof = said('t1', 'a lorry run each tuesday costs me 300 rupees');
    const first = await call('POST', `/v1/commitment/brain/${KIND}/changes`, {
      changes: [run('-300')],
      proof,
    });
    expect(first.body.status).toBe('pending_owner');
    expect(first.body).not.toHaveProperty('description'); // the card's words stay with the owner
    const again = await call('POST', `/v1/commitment/brain/${KIND}/changes`, {
      changes: [run('-300')],
      proof,
    });
    expect(again.body).toMatchObject({ status: 'refused' });
    expect(again.body.reason).toBe('turn_already_used');
    const forged = await call('POST', `/v1/commitment/brain/${KIND}/changes`, {
      changes: [run('-1')],
      proof: { ...said('t2', 'hello'), turn_text: 'my lorry run costs nothing' },
    });
    expect(forged.body.reason).toBe('owner_turn_not_proven');
    expect(
      (await call('POST', `/v1/commitment/brain/${KIND}/changes`, { changes: [], proof })).status,
    ).toBe(400);
  });

  it('R-04: values off: no values drafted, never-rules still may be', async () => {
    strategy.setSettings(KIND, { strategy: 'fixed', valuesOn: false }, 1);
    const v = await call('POST', `/v1/commitment/brain/${KIND}/changes`, {
      changes: [run('-300')],
      proof: said('t1', 'a lorry run costs me 300'),
    });
    expect(v.body).toEqual({ status: 'refused', reason: 'values_off' });
    const n = await call('POST', `/v1/commitment/brain/${KIND}/changes`, {
      changes: [
        {
          action: 'put',
          entry: {
            body: {
              type: 'never',
              label: 'no stock runs',
              all: [{ part: 'stock_run', present: true }],
            },
          },
        },
      ],
      proof: said('t2', 'I never promise stock runs'),
    });
    expect(n.body).toMatchObject({ status: 'pending_owner' });
  });

  it('R-05: Brain reads that a card exists, nothing on it', async () => {
    const made = await call('POST', `/v1/commitment/brain/${KIND}/changes`, {
      changes: [run('-300')],
      proof: said('t1', 'a lorry run costs me 300 rupees'),
    });
    const id = String(made.body.task_id);
    const asBrain = await call('GET', `/v1/workflow/tasks/${id}`, undefined, 'brain');
    expect(asBrain.status).toBe(200);
    expect(JSON.stringify(asBrain.body)).not.toMatch(/300|stock_run|lorry/);
    expect(JSON.stringify(asBrain.body)).toContain('owner_only');
  });

  it('R-06: the seller\'s share is one setting: Brain may raise it first, then change it', async () => {
    const share = (option: string) => ({
      action: 'put',
      entry: { body: { type: 'choice', part: 'saving_share', option, rupees: '1' } },
    });
    const first = await call('POST', '/v1/commitment/brain/goods.seller/changes', {
      changes: [share('third')],
      proof: said('s1', 'pass on a third of what a cheaper day saves me'),
    });
    expect(first.body.status).toBe('pending_owner');
    store.putEntry(
      { id: 'saving_share', kind: 'goods.seller', covers: ['saving_share'], body: { type: 'choice', part: 'saving_share', option: 'third', rupees: 1n } },
      9,
    );
    const replaced = await call('POST', '/v1/commitment/brain/goods.seller/changes', {
      changes: [share('most')],
      proof: said('s2', 'actually pass on most of it'),
    });
    expect(replaced.body.status).toBe('pending_owner');
  });

  it('R-07: past deals through the one projection: numbers only with values on', async () => {
    installCommerceRuntime({
      terms: {
        agreements: () => [
          {
            proposalDigest: 'deal-1',
            role: 'vendor',
            counterpartyDid: 'did:plc:store',
            state: 'accepted',
            resourceRef: 'slot-3',
            general: { start: '2026-11-01T00:00:00Z', end: '2027-02-01T00:00:00Z', exit_notice_days: 30 },
            terms: [{ name: 'fee', value: '170000' }],
            promises: [],
            endsAt: '2027-02-01T00:00:00Z',
            delivery: null,
          },
          {
            proposalDigest: 'deal-0',
            role: 'host',
            counterpartyDid: 'did:plc:brand',
            state: 'rejected',
            resourceRef: 'slot-9',
            general: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', exit_notice_days: 60 },
            terms: [{ name: 'fee', value: '999999' }],
            promises: [],
            endsAt: null,
            delivery: null,
          },
        ],
      },
    } as unknown as CommerceRuntime);
    try {
      // The fixed style bargains (the default): Brain sees no figure, values on or not.
      const fixed = await call('GET', `/v1/commitment/brain/${KIND}`, undefined);
      expect(JSON.stringify(fixed.body.past_deals)).not.toMatch(/170000|999999|exit_notice/);
      strategy.setSettings(KIND, { strategy: 'brain', valuesOn: true }, 1);
      const on = await call('GET', `/v1/commitment/brain/${KIND}`, undefined);
      // Only the vendor's own deals for the vendor kind.
      expect(on.body.past_deals).toEqual([
        {
          state: 'accepted',
          counterparty_did: 'did:plc:store',
          start: '2026-11-01T00:00:00Z',
          end: '2027-02-01T00:00:00Z',
          terms: [{ name: 'fee', value: '170000' }],
          exit_notice_days: 30,
        },
      ]);
      strategy.setSettings(KIND, { strategy: 'brain', valuesOn: false }, 2);
      const off = await call('GET', `/v1/commitment/brain/${KIND}`, undefined);
      expect(off.body.past_deals).toEqual([
        { state: 'accepted', counterparty_did: 'did:plc:store', start: '2026-11-01T00:00:00Z', end: '2027-02-01T00:00:00Z' },
      ]);
      expect(JSON.stringify(off.body)).not.toMatch(/170000|999999/);
    } finally {
      installCommerceRuntime(null);
    }
  });
});

