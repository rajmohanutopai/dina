/**
 * The extension-operation broker (§3.4, WS-3.4).
 *
 * A plugin runner is untrusted code out of process that must be able to ask
 * for effects only Dina can perform, without ever holding the authority to
 * perform them. These tests hold the four-step protocol — propose, permit,
 * execute, verify — and the crash boundaries between the steps.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { ExtensionOperationBroker } from '../../src/plugins/extension_broker';
import { ExtensionOperationRegistry } from '../../src/plugins/extension_ops';
import {
  HostOperationDispatcher,
  makeBoundedAppViewSearch,
} from '../../src/plugins/host_operations';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const INSTALL = 'pli_supplier';
const OP = 'commerce.appview_search';

/** A minimal structural validator: required keys, no extras. */
function validate(value: unknown, schema: unknown): string | null {
  const shape = schema as {
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  if (value === null || typeof value !== 'object') return 'must be an object';
  const record = value as Record<string, unknown>;
  for (const key of shape.required ?? []) {
    if (!(key in record)) return `missing required property "${key}"`;
  }
  if (shape.additionalProperties === false) {
    const allowed = new Set(Object.keys(shape.properties ?? {}));
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) return `unexpected property "${key}"`;
    }
  }
  return null;
}

const PARAMS_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};
const RESULT_SCHEMA = {
  type: 'object',
  properties: { hits: { type: 'number' } },
  required: ['hits'],
  additionalProperties: false,
};

describe('extension-operation broker (§3.4)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let broker: ExtensionOperationBroker;
  let registry: ExtensionOperationRegistry;
  let now = 1_700_000_000_000;

  const consented = { id: 'com.acme.commerce.request_quote', host_operations: [OP] };

  beforeEach(() => {
    now = 1_700_000_000_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xop-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    registry = new ExtensionOperationRegistry();
    registry.register({
      operationName: OP,
      paramsSchema: PARAMS_SCHEMA,
      resultSchema: RESULT_SCHEMA,
      adapterVersion: '1',
      requiredFeature: 'commerce-host-ops-v1',
      actionClass: 'read',
    });
    broker = new ExtensionOperationBroker({ db: adapter, now: () => now, validate });
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function propose(overrides: Partial<Parameters<typeof broker.propose>[0]> = {}) {
    return broker.propose({
      installId: INSTALL,
      capability: consented,
      operationName: OP,
      params: { query: 'chairs' },
      idempotencyKey: 'idem-1',
      registry,
      ...overrides,
    });
  }

  it('records the proposal DURABLY before anything is permitted', () => {
    const result = propose();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a proposal');
    expect(result.value.state).toBe('proposed');
    // Readable from storage, not just returned: a crash here must leave a
    // row an operator can find, not an intention that evaporated.
    expect(broker.get(result.value.proposalId)?.state).toBe('proposed');
  });

  it('pins the schema digests AT PROPOSAL TIME', () => {
    const first = propose();
    if (!first.ok) throw new Error('expected a proposal');
    const pinned = first.value.resultSchemaDigest;

    // The adapter ships a new result schema. A proposal the owner already
    // saw must keep the contract it was decided under.
    const other = new ExtensionOperationRegistry();
    other.register({
      operationName: OP,
      paramsSchema: PARAMS_SCHEMA,
      resultSchema: { type: 'object', properties: { total: { type: 'number' } } },
      adapterVersion: '2',
      requiredFeature: 'commerce-host-ops-v1',
      actionClass: 'read',
    });
    expect(other.get(OP)?.resultSchemaDigest).not.toBe(pinned);
    expect(broker.get(first.value.proposalId)?.resultSchemaDigest).toBe(pinned);
  });

  it('denies an UNDECLARED operation before looking at params (§3.4)', () => {
    // The params of an operation the capability never declared are not input
    // this node should be parsing at all.
    const result = propose({
      capability: { id: consented.id, host_operations: ['commerce.something_else'] },
      params: { totally: 'malformed' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.refusal).toBe('operation_not_declared');
    // Nothing durable was written for a refused-at-the-gate proposal.
    expect(broker.listExecuting()).toEqual([]);
  });

  it('refuses params that do not fit the pinned schema, and records nothing', () => {
    const result = propose({ params: { query: 'chairs', smuggled: 'x' } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.refusal).toBe('params_rejected');
    // A recorded proposal is something the owner may be asked to permit. It
    // must never be possible to be asked about params nobody checked.
    expect(broker.get('xop:anything')).toBeNull();
  });

  it('a retry with the same key returns the SAME proposal, not a second effect', () => {
    const first = propose();
    const again = propose();
    if (!first.ok || !again.ok) throw new Error('both should succeed');
    expect(again.value.proposalId).toBe(first.value.proposalId);
    expect(again.value.createdAt).toBe(first.value.createdAt);
  });

  it('walks the whole protocol: propose, permit, execute, verify', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    const id = proposal.value.proposalId;

    expect(broker.permit(id)).toEqual({ ok: true, value: undefined });
    expect(broker.get(id)?.state).toBe('permitted');

    expect(broker.beginExecution(id)).toEqual({ ok: true, value: undefined });
    expect(broker.get(id)?.state).toBe('executing');

    expect(
      broker.settle(id, { kind: 'completed', result: { hits: 3 }, resultSchema: RESULT_SCHEMA }),
    ).toEqual({ ok: true, value: undefined });
    const done = broker.get(id);
    expect(done?.state).toBe('completed');
    expect(JSON.parse(done?.resultJson ?? 'null')).toEqual({ hits: 3 });
  });

  it('cannot execute what was never permitted', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    const outcome = broker.beginExecution(proposal.value.proposalId);
    expect(outcome).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(broker.get(proposal.value.proposalId)?.state).toBe('proposed');
  });

  it('a REFUSAL is recorded, not dropped', () => {
    // A silent drop leaves the runner retrying for ever and the owner with
    // no record of a decision they made.
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    expect(broker.refuseProposal(proposal.value.proposalId, 'owner declined')).toEqual({
      ok: true,
      value: undefined,
    });
    const row = broker.get(proposal.value.proposalId);
    expect(row?.state).toBe('refused');
    expect(row?.refusalReason).toBe('owner declined');
    // And it cannot be resurrected by permitting it afterwards.
    expect(broker.permit(proposal.value.proposalId)).toEqual({
      ok: false,
      refusal: 'not_proposed',
    });
  });

  it('a runner may withdraw before a decision, never after', () => {
    const first = propose();
    if (!first.ok) throw new Error('expected a proposal');
    expect(broker.cancel(first.value.proposalId)).toEqual({ ok: true, value: undefined });
    expect(broker.get(first.value.proposalId)?.state).toBe('cancelled');

    const second = propose({ idempotencyKey: 'idem-2' });
    if (!second.ok) throw new Error('expected a proposal');
    broker.permit(second.value.proposalId);
    broker.beginExecution(second.value.proposalId);
    // The effect may already have happened. It cannot be un-asked.
    expect(broker.cancel(second.value.proposalId)).toEqual({
      ok: false,
      refusal: 'not_proposed',
    });
  });

  it('a result that violates the pinned schema is FAILED, not forwarded', () => {
    // The runner asked for a typed operation; the caller is entitled to the
    // type. Passing drift through would hand the caller a shape it never
    // agreed to parse.
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    const id = proposal.value.proposalId;
    broker.permit(id);
    broker.beginExecution(id);

    const outcome = broker.settle(id, {
      kind: 'completed',
      result: { hits: 3, leaked: 'internal' },
      resultSchema: RESULT_SCHEMA,
    });
    expect(outcome).toEqual({
      ok: false,
      refusal: 'result_schema_violation',
      detail: 'unexpected property "leaked"',
    });
    const row = broker.get(id);
    expect(row?.state).toBe('failed');
    // The drifted payload itself never lands.
    expect(row?.resultJson).toBeNull();
  });

  it('outcome_unknown is a terminal state, distinct from failed', () => {
    // An effect that MAY have happened is a different fact from one that
    // certainly did not, and only the first forbids a retry.
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    const id = proposal.value.proposalId;
    broker.permit(id);
    broker.beginExecution(id);
    broker.settle(id, { kind: 'outcome_unknown', detail: 'transport died mid-send' });

    const row = broker.get(id);
    expect(row?.state).toBe('outcome_unknown');
    expect(row?.refusalReason).toBe('transport died mid-send');
    // Terminal: it cannot be settled again into a comfortable answer.
    expect(
      broker.settle(id, { kind: 'completed', result: { hits: 1 }, resultSchema: RESULT_SCHEMA }),
    ).toEqual({ ok: false, refusal: 'not_executing' });
  });

  it('a crash mid-effect leaves a DISCOVERABLE row, not a silent gap', () => {
    // The whole reason `executing` is written before the effect: the sweeper
    // can find what was in flight when the process died.
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    broker.permit(proposal.value.proposalId);
    broker.beginExecution(proposal.value.proposalId);

    expect(broker.listExecuting().map((p) => p.proposalId)).toEqual([
      proposal.value.proposalId,
    ]);
  });

  it('fails closed with no schema validator wired', () => {
    // Accepting unvalidated params into a durable, permittable record is how
    // an owner ends up approving something nobody checked.
    const unchecked = new ExtensionOperationBroker({ db: adapter, now: () => now });
    const result = unchecked.propose({
      installId: INSTALL,
      capability: consented,
      operationName: OP,
      params: { query: 'chairs' },
      idempotencyKey: 'idem-nc',
      registry,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.refusal).toBe('params_rejected');
  });
});

/**
 * Typed host operations (§3.4 FR-P9, WS-3.5).
 *
 * The broker records what a runner asked for; the dispatcher is what happens.
 * The rule under test is one sentence: the runner supplies the PARAMS, Dina
 * supplies the AUTHORITY.
 */
describe('host operation dispatcher (§3.4 FR-P9)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let broker: ExtensionOperationBroker;
  let registry: ExtensionOperationRegistry;
  let dispatcher: HostOperationDispatcher;
  const now = 1_700_000_000_000;
  const consented = { id: 'com.acme.commerce.request_quote', host_operations: [OP] };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xop-run-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    registry = new ExtensionOperationRegistry();
    registry.register({
      operationName: OP,
      paramsSchema: PARAMS_SCHEMA,
      resultSchema: RESULT_SCHEMA,
      adapterVersion: '1',
      requiredFeature: 'commerce-host-ops-v1',
      actionClass: 'read',
    });
    broker = new ExtensionOperationBroker({ db: adapter, now: () => now, validate });
    dispatcher = new HostOperationDispatcher({
      broker,
      resultSchemaFor: (name) => registry.get(name)?.resultSchema,
    });
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function permitted(key = 'idem-run'): string {
    const proposal = broker.propose({
      installId: INSTALL,
      capability: consented,
      operationName: OP,
      params: { query: 'chairs' },
      idempotencyKey: key,
      registry,
    });
    if (!proposal.ok) throw new Error('expected a proposal');
    broker.permit(proposal.value.proposalId);
    return proposal.value.proposalId;
  }

  it('an executor sees the params and NOTHING identity-shaped', async () => {
    // The whole point: a runner cannot smuggle authority through a payload,
    // because the context it reaches has no field for one.
    let seen: Record<string, unknown> | null = null;
    dispatcher.register(OP, async (ctx) => {
      seen = { ...ctx } as unknown as Record<string, unknown>;
      return { kind: 'completed', result: { hits: 1 } };
    });
    await dispatcher.run(permitted());

    expect(Object.keys(seen ?? {}).sort()).toEqual([
      'capabilityId',
      'installId',
      'operationName',
      'params',
      'proposalId',
    ]);
  });

  it('runs a permitted proposal to completion', async () => {
    dispatcher.register(OP, async () => ({ kind: 'completed', result: { hits: 2 } }));
    const id = permitted();
    expect(await dispatcher.run(id)).toEqual({ ok: true, state: 'completed' });
    expect(JSON.parse(broker.get(id)?.resultJson ?? 'null')).toEqual({ hits: 2 });
  });

  it('refuses to run a proposal that was never permitted', async () => {
    dispatcher.register(OP, async () => ({ kind: 'completed', result: { hits: 1 } }));
    const proposal = broker.propose({
      installId: INSTALL,
      capability: consented,
      operationName: OP,
      params: { query: 'chairs' },
      idempotencyKey: 'idem-unpermitted',
      registry,
    });
    if (!proposal.ok) throw new Error('expected a proposal');
    const outcome = await dispatcher.run(proposal.value.proposalId);
    expect(outcome).toMatchObject({ ok: false, refusal: 'not_permitted' });
    expect(broker.get(proposal.value.proposalId)?.state).toBe('proposed');
  });

  it('an operation this node does not ship is a refusal, not a crash', async () => {
    // A manifest may legitimately declare an operation a given node lacks.
    const outcome = await dispatcher.run(permitted());
    expect(outcome).toMatchObject({ ok: false, refusal: 'no_executor' });
    // And the proposal is untouched: nothing was attempted.
    expect(broker.get(permitted('idem-run'))?.state).toBe('permitted');
  });

  it('a THROWN executor settles as outcome_unknown, never failed', async () => {
    // A socket can die after the bytes left. Calling that `failed` invites a
    // retry that sends twice; `outcome_unknown` is terminal and forbids it.
    dispatcher.register(OP, async () => {
      throw new Error('socket closed mid-send');
    });
    const id = permitted();
    expect(await dispatcher.run(id)).toEqual({ ok: true, state: 'outcome_unknown' });
    const row = broker.get(id);
    expect(row?.state).toBe('outcome_unknown');
    expect(row?.refusalReason).toContain('socket closed mid-send');
  });

  it('an executor that CAN characterise its failure returns failed', async () => {
    dispatcher.register(OP, async () => ({ kind: 'failed', error: 'appview refused the query' }));
    const id = permitted();
    expect(await dispatcher.run(id)).toEqual({ ok: true, state: 'failed' });
    expect(broker.get(id)?.state).toBe('failed');
  });

  it('a result violating the PINNED schema lands as failed', async () => {
    dispatcher.register(OP, async () => ({ kind: 'completed', result: { hits: 1, extra: 'x' } }));
    const id = permitted();
    // Reports what actually landed, not what the executor hoped.
    expect(await dispatcher.run(id)).toEqual({ ok: true, state: 'failed' });
    expect(broker.get(id)?.state).toBe('failed');
    expect(broker.get(id)?.resultJson).toBeNull();
  });

  it('two executors cannot claim one operation', () => {
    dispatcher.register(OP, async () => ({ kind: 'completed', result: { hits: 1 } }));
    expect(() => dispatcher.register(OP, async () => ({ kind: 'failed', error: 'x' }))).toThrow(
      /already has an executor/,
    );
  });

  it('the bounded AppView search truncates in CORE, not at the caller', async () => {
    // "Bounded" is the security property. An unbounded search lets a runner
    // page the whole index through a channel approved for one lookup — and
    // the request carries no limit field at all, so it cannot be widened.
    const search = makeBoundedAppViewSearch({
      search: async () => Array.from({ length: 50 }, (_, i) => ({ id: i })),
      maxResults: 5,
    });
    const outcome = await search({
      proposalId: 'p',
      installId: INSTALL,
      capabilityId: consented.id,
      operationName: OP,
      params: { query: 'chairs' },
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('expected completion');
    const result = outcome.result as { hits: unknown[]; truncated: boolean };
    expect(result.hits).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});
