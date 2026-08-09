/**
 * The recovery sweep over proposals stuck mid-effect (§3.4, WS-3.4).
 *
 * `listExecuting()` was written for a sweeper that did not exist, so on a real
 * node a proposal whose process died mid-effect stayed `executing` for ever:
 * the runner never got an answer and the one row recording that an effect
 * MIGHT have happened sat in a table nobody read.
 *
 * The claim these pin is narrow and it is the whole point: the sweep SETTLES,
 * it never retries. An effect that may have crossed the wire cannot be run
 * again.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { ExtensionOperationBroker, ExtensionExecutionSweeper } from '../../src/plugins';
import { ExtensionOperationRegistry } from '../../src/plugins/extension_ops';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { ExtensionProposal } from '../../src/plugins';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const OPEN: NodeSQLiteAdapter[] = [];
const DIRS: string[] = [];

afterEach(() => {
  for (const a of OPEN.splice(0)) a.close();
  for (const d of DIRS.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(now: { ms: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xop-sweep-'));
  DIRS.push(dir);
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  OPEN.push(db);
  applyMigrations(db, IDENTITY_MIGRATIONS);
  const registry = new ExtensionOperationRegistry();
  registry.register({
    operationName: 'commerce.appview_search',
    paramsSchema: { type: 'object' },
    resultSchema: { type: 'object' },
    adapterVersion: '1',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'read',
  });
  const broker = new ExtensionOperationBroker({
    db,
    now: () => now.ms,
    validate: () => null,
  });
  return { db, registry, broker };
}

/** Drive one proposal to `executing`, which is what the sweep looks for. */
function executing(
  broker: ExtensionOperationBroker,
  registry: ExtensionOperationRegistry,
  key: string,
): string {
  const proposed = broker.propose({
    installId: 'install-1',
    capability: { id: 'cap.search', host_operations: ['commerce.appview_search'] },
    operationName: 'commerce.appview_search',
    params: { query: 'chairs' },
    idempotencyKey: key,
    registry,
  });
  if (!proposed.ok) throw new Error(`propose refused: ${proposed.refusal}`);
  broker.permit(proposed.value.proposalId);
  broker.beginExecution(proposed.value.proposalId);
  return proposed.value.proposalId;
}

describe('ExtensionExecutionSweeper', () => {
  it('leaves a proposal alone while it is still inside the deadline', () => {
    const now = { ms: T0 };
    const { broker, registry } = setup(now);
    const id = executing(broker, registry, 'k1');

    const sweeper = new ExtensionExecutionSweeper({
      broker: () => broker,
      now: () => now.ms,
      deadlineMs: 15 * MINUTE,
    });
    now.ms = T0 + 15 * MINUTE;
    expect(sweeper.runTick()).toEqual({ abandoned: [], waiting: 1, raced: [] });
    expect(broker.get(id)?.state).toBe('executing');
  });

  it('settles a proposal that outlived the deadline as outcome_unknown', () => {
    // NOT failed, and not retried. `failed` would invite a retry that sends
    // twice; the sweep's job is to turn an open question into the terminal
    // state that says it is one.
    const now = { ms: T0 };
    const { broker, registry } = setup(now);
    const id = executing(broker, registry, 'k1');

    const abandoned: ExtensionProposal[] = [];
    const sweeper = new ExtensionExecutionSweeper({
      broker: () => broker,
      now: () => now.ms,
      deadlineMs: 15 * MINUTE,
      onAbandoned: (p) => abandoned.push(p),
    });
    now.ms = T0 + 15 * MINUTE + 1;
    expect(sweeper.runTick()).toMatchObject({ abandoned: [id], waiting: 0, raced: [] });
    expect(broker.get(id)?.state).toBe('outcome_unknown');
    expect(abandoned.map((p) => p.proposalId)).toEqual([id]);
  });

  it('measures from the PERMIT, not from the proposal', () => {
    // A proposal that waited on an owner's approval for longer than the
    // deadline would otherwise be swept the instant it began executing.
    const now = { ms: T0 };
    const { broker, registry } = setup(now);
    const proposed = broker.propose({
      installId: 'install-1',
      capability: { id: 'cap.search', host_operations: ['commerce.appview_search'] },
      operationName: 'commerce.appview_search',
      params: { query: 'chairs' },
      idempotencyKey: 'slow-owner',
      registry,
    });
    if (!proposed.ok) throw new Error('propose refused');

    // The owner takes an hour to answer.
    now.ms = T0 + 60 * MINUTE;
    broker.permit(proposed.value.proposalId);
    broker.beginExecution(proposed.value.proposalId);

    const sweeper = new ExtensionExecutionSweeper({
      broker: () => broker,
      now: () => now.ms,
      deadlineMs: 15 * MINUTE,
    });
    expect(sweeper.runTick()).toMatchObject({ abandoned: [], waiting: 1 });
    expect(broker.get(proposed.value.proposalId)?.state).toBe('executing');
  });

  it('reports a race rather than counting it as abandoned', () => {
    // The broker's CAS refused because a real settler landed between the list
    // and the write. `raced` and `abandoned` mean opposite things to an
    // operator, so they are never merged.
    const now = { ms: T0 };
    const { broker, registry } = setup(now);
    const id = executing(broker, registry, 'k1');

    const sweeper = new ExtensionExecutionSweeper({
      broker: () => ({
        listExecuting: () => broker.listExecuting(),
        settle: (proposalId, outcome) => {
          // The real dispatcher settles first, then the sweep tries.
          broker.settle(proposalId, { kind: 'completed', result: {}, resultSchema: {} });
          return broker.settle(proposalId, outcome);
        },
      }),
      now: () => now.ms,
      deadlineMs: 1,
    });
    now.ms = T0 + MINUTE;
    expect(sweeper.runTick()).toMatchObject({ abandoned: [], raced: [id] });
    // The TRUE outcome survives; the sweep did not overwrite it.
    expect(broker.get(id)?.state).toBe('completed');
  });

  it('is quiet on a node with no host-operation plane', () => {
    const sweeper = new ExtensionExecutionSweeper({ broker: () => null });
    expect(sweeper.runTick()).toBeNull();
  });

  it('reports a throwing resolver or listing as an error rather than dying', () => {
    const errors: unknown[] = [];
    const throwing = new ExtensionExecutionSweeper({
      broker: () => {
        throw new Error('no runtime');
      },
      onError: (e) => errors.push(e),
    });
    expect(throwing.runTick()).toBeNull();

    const listThrows = new ExtensionExecutionSweeper({
      broker: () => ({
        listExecuting: () => {
          throw new Error('db closed');
        },
        settle: () => ({ ok: true, value: undefined }),
      }),
      onError: (e) => errors.push(e),
    });
    expect(listThrows.runTick()).toBeNull();
    expect(errors).toHaveLength(2);
  });

  it('does not let a throwing observer stop the rest of the sweep', () => {
    const now = { ms: T0 };
    const { broker, registry } = setup(now);
    const first = executing(broker, registry, 'k1');
    const second = executing(broker, registry, 'k2');

    const errors: unknown[] = [];
    const sweeper = new ExtensionExecutionSweeper({
      broker: () => broker,
      now: () => now.ms,
      deadlineMs: 1,
      onAbandoned: () => {
        throw new Error('logger exploded');
      },
      onError: (e) => errors.push(e),
    });
    now.ms = T0 + MINUTE;
    expect(sweeper.runTick()?.abandoned.sort()).toEqual([first, second].sort());
    expect(errors).toHaveLength(2);
  });

  it('refuses a non-positive interval or deadline rather than destroying the lane', () => {
    // A zero deadline settles every proposal the instant it begins executing,
    // which is the sweep destroying what it exists to protect.
    expect(() => new ExtensionExecutionSweeper({ broker: () => null, intervalMs: 0 })).toThrow(
      /intervalMs/,
    );
    expect(() => new ExtensionExecutionSweeper({ broker: () => null, deadlineMs: 0 })).toThrow(
      /deadlineMs/,
    );
  });

  it('starts once and stops once', () => {
    let started = 0;
    let cleared = 0;
    const sweeper = new ExtensionExecutionSweeper({
      broker: () => null,
      setInterval: () => {
        started += 1;
        return started;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });
    sweeper.start();
    sweeper.start();
    sweeper.stop();
    sweeper.stop();
    expect([started, cleared]).toEqual([1, 1]);
  });
});

describe('the broker settles under a CAS', () => {
  it('refuses a second settler instead of overwriting the first', () => {
    // Before this guard, `settle` read the state and then wrote without one,
    // so a swept `outcome_unknown` could overwrite a verified `completed` —
    // turning a fact into a question an operator then chases.
    const now = { ms: T0 };
    const { broker, registry } = setup(now);
    const id = executing(broker, registry, 'k1');

    expect(broker.settle(id, { kind: 'completed', result: { hits: [] }, resultSchema: {} })).toEqual(
      { ok: true, value: undefined },
    );
    expect(broker.settle(id, { kind: 'outcome_unknown', detail: 'swept' })).toMatchObject({
      ok: false,
      refusal: 'not_executing',
    });
    expect(broker.get(id)?.state).toBe('completed');
  });
});
