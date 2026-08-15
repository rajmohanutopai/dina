/**
 * How a runner asks for a host operation (§3.4, WS-3.4).
 *
 * The spec forbids the obvious design in as many words: "there is no separate
 * in-process callback surface". A runner asks by COMPLETING its claim with a
 * typed proposal, so the request inherits the claim-token, idempotency and
 * lease discipline the task lane already enforces instead of getting a second
 * door with none of it.
 *
 * These pin the four rules that follow: the runner names an operation and
 * nothing identity-shaped; the capability comes from the pinned manifest AND
 * the consent record; the decision is the existing plugin action plane; and a
 * paused install cannot act on a claim it held while active.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  applyOwnerDecision,
  brokerHostOperation,
  consentedCapability,
  decideExtensionProposal,
  ExtensionOperationBroker,
  HOST_OPERATION_PROPOSAL_KIND,
  carriesHostOperationMarker,
  parseHostOperationRequest,
} from '../../src/plugins';
import { ExtensionOperationRegistry } from '../../src/plugins/extension_ops';
import { HostOperationDispatcher } from '../../src/plugins/host_operations';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { RegisteredExtensionOperation } from '../../src/plugins/extension_ops';
import type { PluginInstall } from '../../src/plugins/registry';

const CAP = 'com.chairmaker.catalog.search';
const OP = 'commerce.appview_search';
const PAY_OP = 'commerce.settle_invoice';

const OPEN: NodeSQLiteAdapter[] = [];
const DIRS: string[] = [];

afterEach(() => {
  for (const a of OPEN.splice(0)) a.close();
  for (const d of DIRS.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function install(overrides: Partial<PluginInstall> = {}): PluginInstall {
  return {
    installId: 'install-1',
    publisherDid: 'did:plc:chairmaker00000000',
    pluginId: 'com.chairmaker.pack',
    label: 'ChairMaker',
    status: 'active',
    executionMode: 'runner',
    currentCid: 'bafy-current',
    currentVersion: '1.0.0',
    manifest: {
      capabilities: [{ id: CAP, host_operations: [OP, PAY_OP] }],
    } as unknown as PluginInstall['manifest'],
    installScopeHash: 'scope',
    capabilityHashes: { [CAP]: 'cap-scope-hash' },
    behaviorHash: 'behaviour',
    presentationHash: 'presentation',
    trustAnchor: { kind: 'publisher' } as unknown as PluginInstall['trustAnchor'],
    configRevision: 1,
    ...overrides,
  } as PluginInstall;
}

function setup(options: { searchHits?: unknown[]; searchThrows?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xop-lane-'));
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
    operationName: OP,
    paramsSchema: { type: 'object' },
    resultSchema: { type: 'object' },
    adapterVersion: '1',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'read',
  });
  registry.register({
    operationName: PAY_OP,
    paramsSchema: { type: 'object' },
    resultSchema: { type: 'object' },
    adapterVersion: '1',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'payment',
  });

  const broker = new ExtensionOperationBroker({ db, now: () => 1_700_000_000_000, validate: () => null });
  const dispatcher = new HostOperationDispatcher({
    broker,
    resultSchemaFor: (name) => registry.get(name)?.resultSchema,
  });
  let executions = 0;
  dispatcher.register(OP, async () => {
    executions += 1;
    if (options.searchThrows === true) throw new Error('socket died');
    return { kind: 'completed', result: { hits: options.searchHits ?? ['chair'] } };
  });
  return { broker, dispatcher, registry, executions: () => executions };
}

const request = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: HOST_OPERATION_PROPOSAL_KIND,
    operation_name: OP,
    params: { query: 'chairs' },
    idempotency_key: 'k1',
    ...overrides,
  });

describe('parseHostOperationRequest', () => {
  it('recognises a typed proposal', () => {
    expect(parseHostOperationRequest(request())).toEqual({
      operationName: OP,
      params: { query: 'chairs' },
      idempotencyKey: 'k1',
    });
  });

  it('lets an ordinary completion through untouched', () => {
    // The common case. A recogniser that claimed ordinary results would take
    // every plugin completion into the broker.
    for (const body of ['{"ok":true}', 'not json', 'null', '"text"', '[]']) {
      expect(parseHostOperationRequest(body)).toBeNull();
      // ...and NOTHING here carries the marker, so the bridge is free to
      // answer the requester. That is the pairing the two functions make.
      expect(carriesHostOperationMarker(body)).toBe(false);
    }
  });

  it('REFUSES a runner that names its own install', () => {
    // Choosing whose authority to spend, through a payload. Refused rather
    // than ignored: silently dropping it leaves the runner believing it chose.
    expect(parseHostOperationRequest(request({ install_id: 'install-2' }))).toBeNull();
  });

  it('refuses a proposal missing its operation or idempotency key', () => {
    expect(parseHostOperationRequest(request({ operation_name: '' }))).toBeNull();
    expect(parseHostOperationRequest(request({ idempotency_key: '' }))).toBeNull();
    expect(parseHostOperationRequest(request({ operation_name: 42 }))).toBeNull();
  });
});

/**
 * `null` ANSWERED TWO QUESTIONS AT ONCE, and the caller could only hear one.
 *
 * The four cases above assert `toBeNull()` — and null is the exact value
 * `WorkflowService` reads as "ordinary completion, bridge it to the
 * requester". So every refusal above was, at the call site, a decision to
 * forward the runner's proposal parameters to the counterparty as a
 * successful `service.response`: a false answer, sent before any host
 * operation was authorised, and carrying the payload the refusal existed to
 * reject.
 *
 * The marker is now a question of its own, and these are the cases where the
 * two answers differ. A test asserting only `null` cannot see this.
 */
describe('carriesHostOperationMarker — refused proposals are still proposals', () => {
  const refused = [
    ['names its own install', request({ install_id: 'install-2' })],
    ['empty operation name', request({ operation_name: '' })],
    ['empty idempotency key', request({ idempotency_key: '' })],
    ['non-string operation name', request({ operation_name: 42 })],
    ['no operation name at all', JSON.stringify({ kind: 'host_operation_proposal' })],
  ] as const;

  it.each(refused)('%s: refused by the parser, still marked', (_label, body) => {
    expect(parseHostOperationRequest(body)).toBeNull();
    expect(carriesHostOperationMarker(body)).toBe(true);
  });

  it('a valid proposal is marked too', () => {
    expect(carriesHostOperationMarker(request())).toBe(true);
  });

  it('unparseable and non-object bodies are not marked', () => {
    for (const body of ['not json', 'null', '"text"', '[]', '42', '']) {
      expect(carriesHostOperationMarker(body)).toBe(false);
    }
  });
});

describe('consentedCapability', () => {
  it('needs BOTH the pinned manifest and a consented scope hash', () => {
    // The manifest says the capability exists in the release the owner
    // installed; the hash says the owner consented to THIS scope. A manifest
    // capability with no hash is one the owner declined or has not yet seen.
    expect(consentedCapability(install(), CAP)?.id).toBe(CAP);
    expect(consentedCapability(install({ capabilityHashes: {} }), CAP)).toBeNull();
    expect(consentedCapability(install(), 'com.other.capability')).toBeNull();
  });
});

describe('decideExtensionProposal', () => {
  const decide = (actionClass: string, extra: Record<string, unknown> = {}) =>
    decideExtensionProposal({
      operation: { operationName: 'x', actionClass } as unknown as RegisteredExtensionOperation,
      capability: { id: CAP } as never,
      capabilityKind: 'custom',
      publisherRing: 'verified',
      touchesSensitivePersona: false,
      touchesLockedPersona: false,
      // No standing grant and no history: the state a capability is in the
      // first time it asks, which is where the floors actually bite.
      priorInvocations: 0,
      hasStandingApproval: false,
      ...extra,
    });

  it('permits a CANONICAL read without asking, and refuses a payment at every ring', () => {
    // The same floors that govern every other plugin effect (§8). A second
    // policy here would give the owner two consent surfaces that disagree.
    const canonical = { capabilityKind: 'canonical' as const };
    expect(decide('read', canonical)).toEqual({ kind: 'permit' });
    expect(decide('quote', canonical)).toEqual({ kind: 'permit' });
    expect(decide('payment', canonical)).toMatchObject({ kind: 'refuse' });
  });

  it('cards a CUSTOM read, because a declared class is a label and not proof', () => {
    // §8 rule 5: a custom capability id never floors below MODERATE. So the
    // same operation is silent under a canonical capability and carded under
    // a custom one — which is the whole point of the distinction, and the
    // reason this suite asserts both rather than picking one.
    expect(decide('read')).toMatchObject({ kind: 'approval' });
    expect(decide('read', { hasStandingApproval: true })).toEqual({ kind: 'permit' });
  });

  it('never runs silent for an unverified publisher', () => {
    expect(
      decide('read', { capabilityKind: 'canonical', publisherRing: 'unverified' }),
    ).toMatchObject({ kind: 'approval' });
  });

  it('cards every invocation when the capability declares regulated data', () => {
    // A standing approval never silences `sensitive`/`regulated` — the
    // approval-every-time policy for regulated data.
    expect(
      decideExtensionProposal({
        operation: { operationName: 'x', actionClass: 'read' } as unknown as RegisteredExtensionOperation,
        capability: { id: CAP, privacy_class: 'regulated' } as never,
        capabilityKind: 'canonical',
        publisherRing: 'verified',
        touchesSensitivePersona: false,
        touchesLockedPersona: false,
        priorInvocations: 500,
        hasStandingApproval: true,
      }),
    ).toMatchObject({ kind: 'approval' });
  });

  it('sends a write or booking to the owner', () => {
    expect(decide('write')).toMatchObject({ kind: 'approval' });
    expect(decide('booking')).toMatchObject({ kind: 'approval' });
  });

  it('lets a standing grant permit a write once the first-N cards are spent', () => {
    // §3.4 says "approval OR standing-grant check", and this is the second
    // half. It is also why the first version of this suite was wrong: it set a
    // standing grant in the DEFAULTS and then expected a card, so it would
    // have failed the correct implementation.
    expect(decide('write', { hasStandingApproval: true, priorInvocations: 100 })).toEqual({
      kind: 'permit',
    });
    // The first N still card, standing grant or not.
    expect(decide('write', { hasStandingApproval: true, priorInvocations: 0 })).toMatchObject({
      kind: 'approval',
    });
    // A payment is never permitted, whatever grant exists.
    expect(decide('payment', { hasStandingApproval: true, priorInvocations: 100 })).toMatchObject({
      kind: 'refuse',
    });
  });

  it('fails safe on an action class the table does not know', () => {
    // `?? MODERATE` in the floor table: an operation whose class nobody has
    // classified must not run silent.
    expect(decide('teleport')).toMatchObject({ kind: 'approval' });
  });

  it('never permits anything touching a locked persona', () => {
    expect(decide('read', { touchesLockedPersona: true })).toMatchObject({ kind: 'refuse' });
  });
});

describe('brokerHostOperation', () => {
  const permitAll = () => ({ kind: 'permit' as const });

  it('brokers a permitted read end to end and returns the verified result', async () => {
    const { broker, dispatcher, registry, executions } = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    });
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error('unreachable');
    expect(result.proposal.state).toBe('completed');
    expect(JSON.parse(result.proposal.resultJson ?? 'null')).toEqual({ hits: ['chair'] });
    expect(executions()).toBe(1);
  });

  it('parks a card decision without executing anything', async () => {
    const { broker, dispatcher, registry, executions } = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: () => ({ kind: 'approval', reason: 'the owner decides writes' }),
    });
    expect(result).toMatchObject({ kind: 'awaiting_owner' });
    if (result.kind !== 'awaiting_owner') throw new Error('unreachable');
    // Durable and still `proposed` — which is what makes the card answerable
    // later: there is a row to permit.
    expect(broker.get(result.proposal.proposalId)?.state).toBe('proposed');
    expect(executions()).toBe(0);
  });

  it('RECORDS a refusal rather than dropping it', async () => {
    // A silent drop leaves the runner retrying and the owner with no record of
    // a decision they made.
    const { broker, dispatcher, registry, executions } = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: () => ({ kind: 'refuse', reason: 'payment is blocked at every ring' }),
    });
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error('unreachable');
    expect(result.proposal.state).toBe('refused');
    expect(result.proposal.refusalReason).toContain('blocked at every ring');
    expect(executions()).toBe(0);
  });

  it('refuses a PAUSED install acting on a claim it held while active', async () => {
    // The claim guard gates claiming; this gates acting, and the window
    // between them is exactly a pause (§14).
    const { broker, dispatcher, registry, executions } = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install({ status: 'paused' }),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    });
    expect(result).toMatchObject({ kind: 'refused', refusal: 'install_not_active' });
    expect(executions()).toBe(0);
  });

  it('refuses a capability the owner never consented to', async () => {
    const { broker, dispatcher, registry } = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install({ capabilityHashes: {} }),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    });
    expect(result).toMatchObject({ kind: 'refused', refusal: 'capability_not_consented' });
  });

  it('refuses an operation the capability never declared, before validation', async () => {
    // §3.4's deny-before-validation, reached through the lane.
    const { broker, dispatcher, registry } = setup();
    const parsed = parseHostOperationRequest(request({ operation_name: 'commerce.wire_money' }));
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    });
    expect(result).toMatchObject({ kind: 'refused', refusal: 'proposal_refused' });
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.detail).toContain('operation_not_declared');
  });

  it('does not re-decide a retry of the same idempotency key', async () => {
    // A runner that lost the response must not be able to spend a second
    // permit for one asked-for effect.
    const { broker, dispatcher, registry, executions } = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');
    const args = {
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    };
    const first = await brokerHostOperation(args);
    const second = await brokerHostOperation(args);
    expect(first.kind).toBe('settled');
    expect(second.kind).toBe('settled');
    expect(executions()).toBe(1);
  });

  it('settles a throwing executor as outcome_unknown, never as a retryable failure', async () => {
    const { broker, dispatcher, registry } = setup({ searchThrows: true });
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    });
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error('unreachable');
    expect(result.proposal.state).toBe('outcome_unknown');
  });

  it('refuses when this node ships no executor for a declared operation', async () => {
    // A manifest may legitimately declare an operation a given node does not
    // ship; that is a refusal, not a crash.
    const { broker, dispatcher, registry } = setup();
    const parsed = parseHostOperationRequest(request({ operation_name: PAY_OP }));
    if (parsed === null) throw new Error('unreachable');

    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry,
      broker,
      dispatcher,
      decide: permitAll,
    });
    expect(result).toMatchObject({ kind: 'refused', refusal: 'dispatch_failed' });
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.detail).toContain('no_executor');
  });
});

describe('applyOwnerDecision', () => {
  async function parked() {
    const ctx = setup();
    const parsed = parseHostOperationRequest(request());
    if (parsed === null) throw new Error('unreachable');
    const result = await brokerHostOperation({
      install: install(),
      capabilityId: CAP,
      request: parsed,
      registry: ctx.registry,
      broker: ctx.broker,
      dispatcher: ctx.dispatcher,
      decide: () => ({ kind: 'approval', reason: 'owner decides' }),
    });
    if (result.kind !== 'awaiting_owner') throw new Error('expected a parked proposal');
    return { ...ctx, proposalId: result.proposal.proposalId };
  }

  it('runs the effect when the owner approves', async () => {
    const { broker, dispatcher, proposalId, executions } = await parked();
    const result = await applyOwnerDecision({ proposalId, approved: true, broker, dispatcher });
    expect(result.kind).toBe('settled');
    expect(broker.get(proposalId)?.state).toBe('completed');
    expect(executions()).toBe(1);
  });

  it('records the refusal when the owner declines, and runs nothing', async () => {
    const { broker, dispatcher, proposalId, executions } = await parked();
    const result = await applyOwnerDecision({
      proposalId,
      approved: false,
      reason: 'not this supplier',
      broker,
      dispatcher,
    });
    expect(result.kind).toBe('settled');
    expect(broker.get(proposalId)?.state).toBe('refused');
    expect(broker.get(proposalId)?.refusalReason).toBe('not this supplier');
    expect(executions()).toBe(0);
  });

  it('a double tap on the card runs the effect once', async () => {
    // The permit CAS is what stops it: only the first transition out of
    // `proposed` lands.
    const { broker, dispatcher, proposalId, executions } = await parked();
    const first = await applyOwnerDecision({ proposalId, approved: true, broker, dispatcher });
    const second = await applyOwnerDecision({ proposalId, approved: true, broker, dispatcher });
    expect(first.kind).toBe('settled');
    expect(second).toMatchObject({ kind: 'refused' });
    expect(executions()).toBe(1);
  });

  it('refuses an unknown proposal rather than inventing one', async () => {
    const { broker, dispatcher } = setup();
    const result = await applyOwnerDecision({
      proposalId: 'xop:nope',
      approved: true,
      broker,
      dispatcher,
    });
    expect(result).toMatchObject({ kind: 'refused', detail: 'no such proposal' });
  });
});
