/**
 * The khata → rail hook (RESEARCHER_KERNEL §5.D): a buyer's PaymentNote that
 * names a UPI reference asks the active India pack's `upi-payment-status` rail
 * — through the gate, so the ask waits for the owner on the plugin lane — and
 * asks exactly once however many paths deliver the note. A note with no
 * reference, a cash note, a node without a pack, and a refused note ask
 * nothing. Nothing here writes a PaymentAck: the rail informs, the owner acks.
 *
 * Driven through the REAL entry point (`applyInboundTradeDocument`) with a
 * buyer-authored note from the commerce route, a real first-party install of
 * the pack, real grant/decision/install repositories and the in-memory
 * workflow store — so the wiring, not a hand-built call, is what passes.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pluginLane } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { queryAudit, resetAuditState } from '../../src/audit/service';
import { COUNTRY_PACK_IDS, type CountryPack } from '../../src/commerce/country_packs';
import {
  activeCountryPacks,
  askDeliveryFilingRail,
  askPaymentReminderRail,
  askPaymentStatusRail,
  paymentRailCheck,
} from '../../src/commerce/country_rails';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import { beginFirstPartyInstall } from '../../src/commerce/reference_install';
import {
  getCommerceRuntime,
  installCommerceRuntime,
  type CommerceMoneyAccess,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import {
  InMemoryCommerceSettingsRepository,
  type CommerceSettingsRepository,
} from '../../src/commerce/settings_store';
import { buildTradeInbox } from '../../src/commerce/trade_inbox';
import { applyInboundTradeDocument } from '../../src/commerce/trade_ingress';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';
import { InMemoryTradeSpoolRepository } from '../../src/commerce/trade_spool';
import {
  addContact,
  getContact,
  resetContactDirectory,
  setContactChannels,
  setPaperIdentity,
} from '../../src/contacts/directory';
import { setContactRepository, SQLiteContactRepository } from '../../src/contacts/repository';
import { setNodeDID } from '../../src/pairing/ceremony';
import { setPeopleRepository, SQLitePeopleRepository } from '../../src/people/repository';
import { SQLitePluginDecisionRepository, setPluginDecisionRepository } from '../../src/plugins/decisions';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import { readInvocationCardPolicy } from '../../src/plugins/invoke';
import { SQLitePluginInstallRepository, setPluginInstallRepository } from '../../src/plugins/registry';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { parsePluginEnvelope } from '../../src/workflow/plugin_envelope';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../src/workflow/service';

import { BUYER_DID, SUPPLIER_DID, moneyClosed, moneyOpen } from './helpers';

import type { WorkflowTask } from '../../src/workflow/domain';

const OWNER_CAP = 'test-owner-capability-secret';
const T0 = 1_800_000_000_000;
const RUNNER_DID = 'did:key:zrailsrunner';

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let workflowRepo: InMemoryWorkflowRepository;
let supplierDocs: InMemoryTradeDocumentRepository;

function owner(routePath: string, body: Record<string, unknown>): CoreRequest {
  return {
    method: 'POST',
    path: routePath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
  } as unknown as CoreRequest;
}

function nodeRuntime(
  nodeDid: string,
  money: () => CommerceMoneyAccess,
  tradeSpool: InMemoryTradeSpoolRepository = new InMemoryTradeSpoolRepository(),
  extras: { receipts?: InMemoryCommerceReceiptRepository; settings?: CommerceSettingsRepository } = {},
): CommerceRuntime {
  return {
    money,
    settings: extras.settings ?? new InMemoryCommerceSettingsRepository(),
    receipts: extras.receipts ?? new InMemoryCommerceReceiptRepository(),
    tradeSpool,
    nodeDid: () => nodeDid,
    now: () => T0,
    // The stores the §7 inbox reads beside the khata rows — empty here.
    orderDrafts: { list: () => [] },
    tenders: { listTenders: () => [] },
    pendingDecisions: { list: () => [] },
  } as unknown as CommerceRuntime;
}

/** The buyer authors a payment note through the route; the wire body is what the supplier receives. */
async function buyerAuthors(note: Record<string, unknown>): Promise<unknown> {
  setNodeDID(BUYER_DID);
  installCommerceRuntime(nodeRuntime(BUYER_DID, moneyOpen()));
  let captured: unknown = null;
  setD2DSender(async (_to, _type, body) => {
    captured = JSON.parse(JSON.stringify(body));
    return { messageId: 'm1', delivered: true, buffered: false, queued: false };
  });
  const router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  const res = await router.handle(owner('/v1/commerce/trade/payment-note', { supplier_did: SUPPLIER_DID, ...note }));
  if (res.status !== 200) throw new Error(`author: ${JSON.stringify(res.body)}`);
  installCommerceRuntime(null);
  setD2DSender(null);
  if (captured === null) throw new Error('nothing dispatched');
  return captured;
}

/** Activate a country pack on this node through the first-party door. */
function activatePack(pack: CountryPack, nowMs = T0): string {
  const begun = beginFirstPartyInstall({ pluginId: COUNTRY_PACK_IDS[pack], publisherDid: SUPPLIER_DID, nowMs });
  if (!begun.ok) throw new Error(JSON.stringify(begun));
  installs.bindPendingDevice(begun.installId, `${RUNNER_DID}-${pack}`, nowMs);
  installs.activate(begun.installId, `${RUNNER_DID}-${pack}`, nowMs);
  return begun.installId;
}

/** The supplier's node: money open, and (optionally) a country pack active. */
function supplierNode(pack: CountryPack | null): string | null {
  setNodeDID(SUPPLIER_DID);
  supplierDocs = new InMemoryTradeDocumentRepository();
  installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs })));
  return pack === null ? null : activatePack(pack);
}

function receive(body: unknown): ReturnType<typeof applyInboundTradeDocument> {
  return applyInboundTradeDocument({ senderDid: BUYER_DID, body, evidenceJson: '{}', nowMs: T0 });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'country-rails-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(adapter));
  workflowRepo = new InMemoryWorkflowRepository();
  setWorkflowService(new WorkflowService({ repository: workflowRepo, nowMsFn: () => T0 }));
});

afterEach(() => {
  installCommerceRuntime(null);
  setD2DSender(null);
  setWorkflowService(null);
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  resetAuditState();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const UPI_NOTE = { amount: { currency: 'INR', minor_units: '250000' }, method: 'upi', external_ref: '314159265358' };

describe('a UPI payment note asks the India pack whether it settled (§5.D)', () => {
  it('the ask waits for the owner on the plugin lane with the note’s own UTR and amount; nothing is acked', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');

    const outcome = receive(body);
    expect(outcome.outcome).toBe('applied');

    const tasks = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (task === undefined) throw new Error('unreachable');
    expect(task.status).toBe('pending_approval');
    const envelope = parsePluginEnvelope(task.payload);
    expect(envelope?.capability_id).toBe(`${COUNTRY_PACK_IDS.in}.upi-payment-status`);
    expect(envelope?.params).toEqual({ utr: '314159265358', expected_amount: UPI_NOTE.amount });
    expect(envelope?.authorization_kind).toBe('card');
    // Correlated to the note it is about, so the answer can be shown beside it.
    const noteDigest = (body as { document: { note_digest: string } }).document.note_digest;
    expect(task.correlation_id).toBe(noteDigest);
    expect(task.origin).toBe('system');
    // The khata holds the note and NO ack — the rail informs, the owner acks.
    expect(supplierDocs.listByCounterparty(BUYER_DID, 'payment_note')).toHaveLength(1);
    expect(supplierDocs.listByCounterparty(BUYER_DID, 'payment_ack')).toHaveLength(0);
  });

  it('asks exactly once: a re-delivered note is a duplicate and no second task appears', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(receive(body).outcome).toBe('applied');
    expect(receive(body).outcome).toBe('duplicate');
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(1);
    // The hook itself dedups too, should a path call it directly with the same note.
    const again = askPaymentStatusRail((body as { document: unknown }).document, T0 + 1);
    expect(again).toMatchObject({ asked: true, pack: 'in', mode: 'approval_required' });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(1);
  });

  it('a cash note, or a UPI note with no reference, asks nothing', async () => {
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    // A cash note may still quote a receipt number — no rail answers for cash.
    const cash = await buyerAuthors({ amount: UPI_NOTE.amount, method: 'cash', external_ref: 'receipt-88' });
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs })));
    expect(receive(cash).outcome).toBe('applied');
    expect(askPaymentStatusRail((cash as { document: unknown }).document, T0)).toEqual({ asked: false, reason: 'method_has_no_rail' });

    const bare = await buyerAuthors({ amount: UPI_NOTE.amount, method: 'upi' });
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs })));
    expect(receive(bare).outcome).toBe('applied');
    expect(askPaymentStatusRail((bare as { document: unknown }).document, T0)).toEqual({ asked: false, reason: 'no_reference' });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(0);
  });

  it('with no active pack the note still lands and nothing is asked', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    supplierNode(null);
    expect(receive(body).outcome).toBe('applied');
    expect(activeCountryPacks()).toEqual([]);
    expect(askPaymentStatusRail((body as { document: unknown }).document, T0)).toEqual({ asked: false, reason: 'no_active_pack' });
  });

  it('a refused note (wrong sender) asks nothing', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    const verdict = applyInboundTradeDocument({ senderDid: 'did:plc:stranger', body, evidenceJson: '{}', nowMs: T0 });
    expect(verdict.outcome).not.toBe('applied');
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(0);
  });

  it('the USA pack answers a bank transfer through its settlement rail; a UPI note has no US rail', async () => {
    const transfer = await buyerAuthors({ amount: { currency: 'USD', minor_units: '125000' }, method: 'transfer', external_ref: 'ach-7781' });
    const installId = supplierNode('us');
    if (installId === null) throw new Error('unreachable');
    expect(receive(transfer).outcome).toBe('applied');
    const [task] = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    expect(parsePluginEnvelope(task?.payload ?? '')?.capability_id).toBe(`${COUNTRY_PACK_IDS.us}.settlement-status`);
    expect(parsePluginEnvelope(task?.payload ?? '')?.params).toEqual({
      payment_ref: 'ach-7781',
      rail: 'ach',
      expected_amount: { currency: 'USD', minor_units: '125000' },
    });

    const upi = await buyerAuthors(UPI_NOTE);
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs })));
    expect(askPaymentStatusRail((upi as { document: unknown }).document, T0)).toEqual({ asked: false, reason: 'method_has_no_rail' });
  });

  it('a note that waited in the SPOOL while the money line was closed asks once when it replays — the same task as a live delivery would', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    // The line closes: the note is spooled, nothing is asked yet.
    const spool = new InMemoryTradeSpoolRepository();
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyClosed('pack_paused'), spool));
    expect(receive(body).outcome).toBe('spooled');
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(0);
    // The line reopens; the next delivery drains the spool first, then lands itself.
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs }), spool));
    expect(receive(body).outcome).toBe('duplicate');
    const tasks = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    expect(tasks).toHaveLength(1);
    expect(spool.oldest(10)).toEqual([]);
  });

  it('with BOTH packs active, the note’s method picks the rail — a transfer asks the USA pack even when India was installed first', async () => {
    const transfer = await buyerAuthors({ amount: { currency: 'USD', minor_units: '125000' }, method: 'transfer', external_ref: 'ach-9' });
    const inId = supplierNode('in');
    const usId = activatePack('us', T0 + 1_000);
    if (inId === null) throw new Error('unreachable');
    expect(activeCountryPacks().map((p) => p.pack)).toEqual(['in', 'us']);

    expect(receive(transfer).outcome).toBe('applied');
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(inId))).toHaveLength(0);
    const [usTask] = workflowRepo.listNonTerminalByRunner(pluginLane(usId));
    expect(parsePluginEnvelope(usTask?.payload ?? '')?.capability_id).toBe(`${COUNTRY_PACK_IDS.us}.settlement-status`);

    const upi = await buyerAuthors(UPI_NOTE);
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs })));
    expect(receive(upi).outcome).toBe('applied');
    const [inTask] = workflowRepo.listNonTerminalByRunner(pluginLane(inId));
    expect(parsePluginEnvelope(inTask?.payload ?? '')?.capability_id).toBe(`${COUNTRY_PACK_IDS.in}.upi-payment-status`);
  });

  it('a note replayed from the spool days later raises a card that lives from NOW, not from its arrival', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    const spool = new InMemoryTradeSpoolRepository();
    const arrival = T0;
    const replay = T0 + 3 * 24 * 3600 * 1000;
    // Closed line at arrival: spooled.
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime({ ...nodeRuntime(SUPPLIER_DID, moneyClosed('pack_paused'), spool), now: () => arrival } as never);
    expect(applyInboundTradeDocument({ senderDid: BUYER_DID, body, evidenceJson: '{}', nowMs: arrival }).outcome).toBe('spooled');
    // Three days later the line reopens and something drains the spool.
    installCommerceRuntime({ ...nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs }), spool), now: () => replay } as never);
    expect(applyInboundTradeDocument({ senderDid: BUYER_DID, body, evidenceJson: '{}', nowMs: replay }).outcome).toBe('duplicate');
    const [task] = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    expect(task?.status).toBe('pending_approval');
    // The card's 24 h start at the replay, so it is alive for the owner to see.
    expect(task?.expires_at).toBeGreaterThan(Math.floor(replay / 1000));
    expect(task?.expires_at).toBeLessThanOrEqual(Math.floor(replay / 1000) + 24 * 3600);
  });

  it('the hook clears egress: the card carries no out-of-scope or unclassified rider', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(receive(body).outcome).toBe('applied');
    const [task] = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    const policy = readInvocationCardPolicy(task ?? { policy: '' });
    expect(policy?.risk_level).toBe('HIGH');
    expect(policy?.reasons.join(' ')).not.toMatch(/out-of-scope|classified|also:/);
  });

  it('a registry that faults after the note is stored cannot turn an accepted note into a failed receive', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    const broken = new Proxy(installs, {
      get(target, prop, receiver) {
        if (prop === 'list') {
          return () => {
            throw new Error('SQLITE_BUSY');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    setPluginInstallRepository(broken);
    expect(receive(body).outcome).toBe('applied');
    expect(supplierDocs.listByCounterparty(BUYER_DID, 'payment_note')).toHaveLength(1);
    expect(askPaymentStatusRail((body as { document: unknown }).document, T0)).toEqual({ asked: false, reason: 'refused', detail: 'Error' });
    setPluginInstallRepository(installs);
  });

  it('an unreadable note is a typed reason, never a throw into the ingress', () => {
    expect(askPaymentStatusRail({ not: 'a note' }, T0)).toMatchObject({ asked: false, reason: 'unreadable' });
  });
});

describe('the rail’s answer comes back beside the khata note it is about (§5.D, metadata-shaped)', () => {
  /** A rail task correlated to a note digest, in a given state — the shape `askPaymentStatusRail` stages. */
  function seedRailTask(digest: string, status: WorkflowTask['status'], result?: string, id = `plgx_${status}`): void {
    workflowRepo.create({
      id,
      kind: 'delegation',
      status,
      priority: 'normal',
      description: 'plugin invocation com.dinakernel.country.in.upi-payment-status',
      payload: JSON.stringify({ type: 'plugin_invocation', install_id: 'pli', capability_id: 'com.dinakernel.country.in.upi-payment-status', params: {} }),
      result_summary: '',
      policy: '',
      correlation_id: digest,
      created_at: T0,
      updated_at: T0,
      ...(result !== undefined ? { result } : {}),
    });
  }

  it('the unacknowledged-payment row carries the live check: waiting → asked → answered with the schema’s enum, never text', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(receive(body).outcome).toBe('applied');
    const digest = (body as { document: { note_digest: string } }).document.note_digest;
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('unreachable');
    const row = () => buildTradeInbox(runtime, T0).items.find((i) => i.kind === 'unacknowledged_payment' && i.subject === digest);
    const [task] = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    if (task === undefined) throw new Error('no rail task');

    expect(row()?.railCheck).toEqual({ state: 'awaiting_owner', taskId: task.id });
    // The owner approves: the same task moves to queued (the workflow's own transition).
    expect(workflowRepo.transition(task.id, 'pending_approval' as never, 'queued' as never, T0 + 1)).toBe(true);
    expect(row()?.railCheck).toEqual({ state: 'asked', taskId: task.id });
    // The runner claims it (a plugin-lane task completes only under its claim
    // token, §9.1) and answers with a conforming result that also carries text.
    const claimed = workflowRepo.claimDelegationTask(`${RUNNER_DID}-in`, T0 + 1, 60_000, pluginLane(installId));
    expect(claimed?.id).toBe(task.id);
    expect(row()?.railCheck).toEqual({ state: 'asked', taskId: task.id });
    const completed = workflowRepo.completeWithDetails(
      task.id,
      `${RUNNER_DID}-in`,
      'settled',
      JSON.stringify({ status: 'settled', provider_ref: 'psp-1', memo: 'ANY TEXT THE RUNNER WROTE' }),
      '{}',
      T0 + 2,
      claimed?.claim_id,
    );
    expect(completed).not.toBe(0);
    const answered = row()?.railCheck;
    expect(answered).toEqual({ state: 'answered', answer: 'settled', taskId: task.id });
    // Only the enum reaches the row — nothing the runner wrote.
    expect(JSON.stringify(answered)).not.toContain('ANY TEXT');
    // The owner still has the note to acknowledge throughout: the rail informs.
    expect(row()?.kind).toBe('unacknowledged_payment');
    expect(supplierDocs.listByCounterparty(BUYER_DID, 'payment_ack')).toHaveLength(0);
  });

  it('maps every task state; a completed result outside the four values reads as unknown', () => {
    setNodeDID(SUPPLIER_DID);
    const cases: [WorkflowTask['status'], string | undefined, unknown][] = [
      ['pending_approval', undefined, { state: 'awaiting_owner' }],
      ['queued', undefined, { state: 'asked' }],
      ['running', undefined, { state: 'asked' }],
      ['completed', JSON.stringify({ status: 'pending' }), { state: 'answered', answer: 'pending' }],
      ['completed', JSON.stringify({ status: 'failed' }), { state: 'answered', answer: 'failed' }],
      ['completed', JSON.stringify({ status: 'probably' }), { state: 'answered', answer: 'unknown' }],
      ['completed', 'not json', { state: 'answered', answer: 'unknown' }],
      ['cancelled', undefined, { state: 'closed' }],
      ['failed', undefined, { state: 'closed' }],
      ['outcome_unknown', undefined, { state: 'closed' }],
    ];
    for (const [i, [status, result, expected]] of cases.entries()) {
      const digest = `d${i}`;
      seedRailTask(digest, status, result, `plgx_${i}`);
      expect(paymentRailCheck(digest)).toMatchObject({ ...(expected as object), taskId: `plgx_${i}` });
    }
    // A DIFFERENT rail correlated to the same note (a future filing hook) is not the payment check.
    workflowRepo.create({
      id: 'filing',
      kind: 'delegation',
      status: 'completed',
      priority: 'normal',
      description: 'plugin invocation com.dinakernel.country.in.eway-bill',
      payload: JSON.stringify({ type: 'plugin_invocation', install_id: 'pli', capability_id: 'com.dinakernel.country.in.eway-bill', params: {} }),
      result: JSON.stringify({ status: 'settled' }),
      result_summary: '',
      policy: '',
      correlation_id: 'dF',
      created_at: T0 + 5,
      updated_at: T0 + 5,
    });
    expect(paymentRailCheck('dF')).toBeNull();
    // A correlated task that is NOT a plugin invocation is not a rail check.
    workflowRepo.create({
      id: 'other',
      kind: 'approval',
      status: 'pending_approval',
      priority: 'normal',
      description: 'x',
      payload: JSON.stringify({ type: 'intent_validation' }),
      result_summary: '',
      policy: '',
      correlation_id: 'dX',
      created_at: T0,
      updated_at: T0,
    });
    expect(paymentRailCheck('dX')).toBeNull();
    expect(paymentRailCheck('no-such-digest')).toBeNull();
  });

  it('no rail was asked → no check on the row; the buyer’s own outbound note never carries one', async () => {
    const cash = await buyerAuthors({ amount: UPI_NOTE.amount, method: 'cash' });
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(receive(cash).outcome).toBe('applied');
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('unreachable');
    const rows = buildTradeInbox(runtime, T0).items.filter((i) => i.kind === 'unacknowledged_payment');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.railCheck).toBeUndefined();
  });

  it('the inbox ROUTE carries the check as snake_case `rail_check` — the shape the phone reads — and none on the buyer’s outbound note', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(receive(body).outcome).toBe('applied');
    const digest = (body as { document: { note_digest: string } }).document.note_digest;
    const [task] = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    if (task === undefined) throw new Error('no rail task');
    // Approve, claim, answer — the same three moves the live path makes.
    expect(workflowRepo.transition(task.id, 'pending_approval' as never, 'queued' as never, T0 + 1)).toBe(true);
    const claimed = workflowRepo.claimDelegationTask(`${RUNNER_DID}-in`, T0 + 1, 60_000, pluginLane(installId));
    workflowRepo.completeWithDetails(task.id, `${RUNNER_DID}-in`, 'settled', JSON.stringify({ status: 'settled' }), '{}', T0 + 2, claimed?.claim_id);

    const router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const res = await router.handle({ ...owner('/v1/commerce/trade/inbox', {}), method: 'GET', query: {} } as CoreRequest);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    const row = items.find((i) => i.kind === 'unacknowledged_payment' && i.subject === digest);
    expect(row).toEqual({
      kind: 'unacknowledged_payment',
      role: 'supplier',
      subject: digest,
      counterparty_did: BUYER_DID,
      created_at: T0,
      rail_check: { state: 'answered', task_id: task.id, answer: 'settled' },
    });
    // A pending check carries no `answer` key at all.
    const pendingNote = await buyerAuthors({ ...UPI_NOTE, external_ref: '999999999999' });
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs })));
    expect(receive(pendingNote).outcome).toBe('applied');
    const pendingDigest = (pendingNote as { document: { note_digest: string } }).document.note_digest;
    const again = await router.handle({ ...owner('/v1/commerce/trade/inbox', {}), method: 'GET', query: {} } as CoreRequest);
    const pendingRow = (again.body as { items: Record<string, unknown>[] }).items.find((i) => i.subject === pendingDigest);
    expect(pendingRow?.rail_check).toEqual({ state: 'awaiting_owner', task_id: expect.stringMatching(/^plgx_/) });
    expect('answer' in ((pendingRow?.rail_check ?? {}) as object)).toBe(false);
  });

  it('with no workflow store the row simply carries no check', async () => {
    const body = await buyerAuthors(UPI_NOTE);
    supplierNode('in');
    expect(receive(body).outcome).toBe('applied');
    setWorkflowService(null);
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('unreachable');
    const row = buildTradeInbox(runtime, T0).items.find((i) => i.kind === 'unacknowledged_payment');
    expect(row?.railCheck).toBeUndefined();
  });
});

/**
 * §5.D — the FILING hook: the supplier authors a dispatch, and an active pack
 * has a filing to make. Every fact comes from the places the data model put
 * them (the node's own business settings, the buyer's contact, the bound
 * quote); when one is missing, the hook says which and asks nothing.
 */
describe('a dispatch asks the active pack for its filing (§5.D)', () => {
  const OWN_GSTIN = '27AAPFU0939F1ZV';
  const BUYER_GSTIN = '29AAGCB7383J1Z4';
  const VALUE = { currency: 'INR', minor_units: '50000' };
  const NOTE = {
    note_digest: 'bafy-note-1',
    purchase_order_id: 'po-1',
    lines: [{ line_id: 'l1', delivered_quantity: { value: '100', unit_code: 'each' } }],
  } as unknown as Parameters<typeof askDeliveryFilingRail>[0]['note'];

  let identityAdapter: NodeSQLiteAdapter;
  let identityDir: string;

  /** Wire the two paper identities this hook reads: ours and the buyer's. */
  function statePaperIdentities(
    opts: { own?: string | null; theirs?: string | null; addresses?: boolean } = {},
  ): CommerceSettingsRepository {
    const settings = new InMemoryCommerceSettingsRepository();
    if (opts.own !== null) {
      settings.writeBusiness({
        legalName: 'Utopai Furniture LLP',
        registrations: [{ scheme: 'gstin', value: opts.own ?? OWN_GSTIN }],
        ...(opts.addresses === true
          ? {
              address: {
                line1: '12 Nehru Road',
                city: 'Bengaluru',
                region: 'Karnataka',
                postalCode: '560001',
                country: 'IN',
              },
            }
          : {}),
      });
    }
    identityDir = mkdtempSync(path.join(tmpdir(), 'country-rails-identity-'));
    identityAdapter = new NodeSQLiteAdapter({
      path: path.join(identityDir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(identityAdapter, IDENTITY_MIGRATIONS);
    setPeopleRepository(new SQLitePeopleRepository(identityAdapter));
    setContactRepository(new SQLiteContactRepository(identityAdapter));
    resetContactDirectory();
    addContact(BUYER_DID, 'Buyer Traders', 'verified');
    if (opts.theirs !== null) {
      const findings = setPaperIdentity(BUYER_DID, {
        legalName: 'Buyer Traders Pvt Ltd',
        registrations: [{ scheme: 'gstin', value: opts.theirs ?? BUYER_GSTIN }],
        ...(opts.addresses === true
          ? {
              billingAddress: {
                line1: '4 Kalasipalya Road',
                city: 'Bengaluru',
                region: 'Karnataka',
                postalCode: '560002',
                country: 'IN',
              },
            }
          : {}),
      });
      expect(findings).toEqual([]);
    }
    return settings;
  }

  afterEach(() => {
    resetContactDirectory();
    setContactRepository(null);
    setPeopleRepository(null);
    identityAdapter?.close();
    if (identityDir !== undefined && identityDir !== '') rmSync(identityDir, { recursive: true, force: true });
    identityDir = '';
  });

  function supplierWithPack(pack: CountryPack, settings: CommerceSettingsRepository): string {
    setNodeDID(SUPPLIER_DID);
    supplierDocs = new InMemoryTradeDocumentRepository();
    installCommerceRuntime(
      nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs }), new InMemoryTradeSpoolRepository(), {
        settings,
      }),
    );
    const installId = activatePack(pack);
    if (installId === null) throw new Error('unreachable');
    return installId;
  }

  it('India: an e-way bill waits for the owner with BOTH GSTINs and the dispatch value', () => {
    const installId = supplierWithPack('in', statePaperIdentities());
    const outcome = askDeliveryFilingRail({
      note: NOTE,
      counterpartyDid: BUYER_DID,
      value: VALUE,
      creditDays: 30,
      askAtMs: T0,
    });
    expect(outcome).toMatchObject({ asked: true, pack: 'in', mode: 'approval_required' });
    const tasks = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    expect(tasks).toHaveLength(1);
    const envelope = parsePluginEnvelope(tasks[0].payload);
    expect(envelope?.capability_id).toBe(`${COUNTRY_PACK_IDS.in}.eway-bill`);
    expect(envelope?.params).toEqual({
      delivery_note_digest: 'bafy-note-1',
      consignor_gstin: OWN_GSTIN,
      consignee_gstin: BUYER_GSTIN,
      value: VALUE,
    });
    // A filing is a WRITE: it cards, and it is correlated to the note it is about.
    expect(envelope?.authorization_kind).toBe('card');
    expect(tasks[0].correlation_id).toBe('bafy-note-1');
    expect(tasks[0].origin).toBe('system');
  });

  /**
   * §11 — the CONTEXT that rides the same envelope. The params are the ask;
   * the context is what Dina chose to say about the two parties, projected
   * through its own templates from its own stores. Nothing here is passed in
   * by the hook: it names the counterparty and Core does the rest.
   */
  it('the envelope carries Dina’s OWN projection of both parties, flat and strings-only', () => {
    const installId = supplierWithPack('in', statePaperIdentities({ addresses: true }));
    askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 });
    const tasks = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    const context = parsePluginEnvelope(tasks[0].payload)?.context as
      | { category: string; fields: Record<string, string> }[]
      | undefined;
    if (context === undefined) throw new Error('no context projected');

    // An e-way bill is a WRITE, so the template admits the printed name and
    // the street beside the identifying fields.
    expect(context).toContainEqual({
      category: 'business_registry',
      fields: {
        role: 'self',
        legal_name: 'Utopai Furniture LLP',
        registration_scheme: 'gstin',
        registration_value: OWN_GSTIN,
      },
    });
    expect(context).toContainEqual({
      category: 'business_registry',
      fields: {
        role: 'counterparty',
        legal_name: 'Buyer Traders Pvt Ltd',
        registration_scheme: 'gstin',
        registration_value: BUYER_GSTIN,
      },
    });
    expect(context).toContainEqual({
      category: 'address',
      fields: {
        role: 'counterparty',
        line1: '4 Kalasipalya Road',
        city: 'Bengaluru',
        region: 'Karnataka',
        postal_code: '560002',
        country: 'IN',
      },
    });
    // Flat and strings all the way down: no vault row, no nested object, no
    // internal identifier reached the payload.
    for (const item of context) {
      for (const value of Object.values(item.fields)) expect(typeof value).toBe('string');
    }
    expect(JSON.stringify(context)).not.toContain(BUYER_DID);
    // `delivery` and `tax_filing` are consented but Dina keeps no store it
    // could project them from, so nothing stands in for them.
    expect(context.every((i) => i.category === 'business_registry' || i.category === 'address')).toBe(true);
  });

  it('the owner’s card says what the projection added, as counts and category names only', () => {
    const installId = supplierWithPack('in', statePaperIdentities({ addresses: true }));
    askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 });
    const task = workflowRepo.listNonTerminalByRunner(pluginLane(installId))[0];
    const policy = readInvocationCardPolicy(task);
    expect(policy?.context).toEqual({ categories: ['address', 'business_registry'], item_count: 4 });
    // Metadata, never content: the card facts name the categories and count
    // them, and carry not one character of what they describe.
    expect(JSON.stringify(policy)).not.toContain(OWN_GSTIN);
    expect(JSON.stringify(policy)).not.toContain('Nehru');
  });

  it('the audit log records the projection as metadata — categories, counts, a hash, no content', () => {
    supplierWithPack('in', statePaperIdentities({ addresses: true }));
    askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 });
    const entries = queryAudit({ action: 'plugin_context_projected' });
    expect(entries).toHaveLength(1);
    const detail = JSON.parse(entries[0].detail) as Record<string, unknown>;
    expect(detail).toMatchObject({
      template_version: 1,
      categories: ['address', 'business_registry'],
      item_count: 4,
      dropped_fields: 0,
      // Consented, but Dina keeps no store it could project them from.
      unsourced: ['delivery', 'tax_filing'],
    });
    expect(detail.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0].detail).not.toContain(OWN_GSTIN);
    expect(entries[0].detail).not.toContain('Nehru');
    expect(entries[0].detail).not.toContain('Utopai');
  });

  it('a filing whose counterparty has stated nothing carries only our own side', () => {
    const installId = supplierWithPack('in', statePaperIdentities({ theirs: null }));
    const outcome = askDeliveryFilingRail({
      note: NOTE,
      counterpartyDid: BUYER_DID,
      value: VALUE,
      creditDays: 30,
      askAtMs: T0,
    });
    // No consignee GSTIN, so the pack has nothing to file — and the hook says
    // which fact is missing rather than filing half a bill.
    expect(outcome).toMatchObject({ asked: false });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(0);
  });

  it('USA: an invoice carries the order’s net terms and the delivered total', () => {
    const installId = supplierWithPack('us', statePaperIdentities({ theirs: null }));
    const outcome = askDeliveryFilingRail({
      note: NOTE,
      counterpartyDid: BUYER_DID,
      value: VALUE,
      creditDays: 30,
      askAtMs: T0,
    });
    expect(outcome).toMatchObject({ asked: true, pack: 'us' });
    const envelope = parsePluginEnvelope(workflowRepo.listNonTerminalByRunner(pluginLane(installId))[0].payload);
    expect(envelope?.capability_id).toBe(`${COUNTRY_PACK_IDS.us}.invoice-terms`);
    expect(envelope?.params).toEqual({ delivery_note_digest: 'bafy-note-1', net_days: 30, total: VALUE });
  });

  it('asks exactly once per dispatch — a second call is the same task', () => {
    const installId = supplierWithPack('in', statePaperIdentities());
    expect(askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 }))
      .toMatchObject({ asked: true });
    expect(
      askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 + 5 }),
    ).toMatchObject({ asked: true });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(1);
  });

  it.each([
    ['no GSTIN of our own', { own: null }, 'no_own_registration'],
    ['no GSTIN on the buyer’s contact', { theirs: null }, 'no_counterparty_registration'],
  ])('India files nothing when there is %s, and says which', (_label, opts, reason) => {
    const installId = supplierWithPack('in', statePaperIdentities(opts as { own?: string | null; theirs?: string | null }));
    expect(
      askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 }),
    ).toMatchObject({ asked: false, reason });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(0);
  });

  it('files nothing when the dispatch has no value from a bound quote', () => {
    supplierWithPack('in', statePaperIdentities());
    expect(
      askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: null, creditDays: 30, askAtMs: T0 }),
    ).toMatchObject({ asked: false, reason: 'unpriceable' });
  });

  it.each([
    [null, 'the bound quote states no payment terms'],
    [21, "net 21 is not one of the pack's terms"],
  ])('USA files nothing on terms the pack does not carry (%s)', (creditDays, detail) => {
    supplierWithPack('us', statePaperIdentities({ theirs: null }));
    const outcome = askDeliveryFilingRail({
      note: NOTE,
      counterpartyDid: BUYER_DID,
      value: VALUE,
      creditDays: creditDays as number | null,
      askAtMs: T0,
    });
    expect(outcome).toMatchObject({ asked: false, reason: 'terms_not_supported' });
    if (outcome.asked) throw new Error('unreachable');
    expect(outcome.detail).toContain(detail);
  });

  it('with no pack installed there is nothing to file', () => {
    setNodeDID(SUPPLIER_DID);
    supplierDocs = new InMemoryTradeDocumentRepository();
    installCommerceRuntime(
      nodeRuntime(SUPPLIER_DID, moneyOpen({ tradeDocuments: supplierDocs }), new InMemoryTradeSpoolRepository(), {
        settings: statePaperIdentities(),
      }),
    );
    expect(
      askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 }),
    ).toEqual({ asked: false, reason: 'no_active_pack' });
  });

  it('with no workflow service there is nowhere to stage the ask', () => {
    supplierWithPack('in', statePaperIdentities());
    setWorkflowService(null);
    expect(
      askDeliveryFilingRail({ note: NOTE, counterpartyDid: BUYER_DID, value: VALUE, creditDays: 30, askAtMs: T0 }),
    ).toEqual({ asked: false, reason: 'no_workflow' });
  });

  it('a THROWN fault never escapes — a signed, sent note is not undone by a filing', () => {
    supplierWithPack('in', statePaperIdentities());
    // A store that faults mid-ask is the case the guard exists for: without it
    // the throw would leave the delivery-note route, which has already signed,
    // stored and dispatched the note.
    setWorkflowService({
      create: () => {
        throw new Error('workflow store unavailable');
      },
      getActiveByIdempotencyKey: () => null,
      getById: () => null,
    } as unknown as WorkflowService);
    const outcome = askDeliveryFilingRail({
      note: NOTE,
      counterpartyDid: BUYER_DID,
      value: VALUE,
      creditDays: 30,
      askAtMs: T0,
    });
    expect(outcome).toMatchObject({ asked: false, reason: 'refused' });
    if (outcome.asked) throw new Error('unreachable');
    // The fault is named by TYPE only — a message can carry the note's own
    // contents, and this outcome is logged.
    expect(outcome.detail).toMatch(/^[A-Za-z]*Error$/);
  });
});

/**
 * §5.D / TRADE_FIRST §4.5 — the OWNER asks for a matured payment. Nothing here
 * watches a clock: the hook exists because the owner tapped an overdue row.
 * The message is the pack's own template plus the khata document it is about,
 * so a runner is never handed free text.
 */
describe('an owner-initiated reminder asks the active pack (§5.D)', () => {
  const SUBJECT = 'bafy-order-1';
  const DUE_AT = '2026-09-01T00:00:00.000Z';
  const AMOUNT = { currency: 'INR', minor_units: '50000' };
  let identityAdapter: NodeSQLiteAdapter;
  let identityDir = '';

  function counterpartyWithChannels(channels: { phone?: string; email?: string }): void {
    identityDir = mkdtempSync(path.join(tmpdir(), 'country-rails-reminder-'));
    identityAdapter = new NodeSQLiteAdapter({
      path: path.join(identityDir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(identityAdapter, IDENTITY_MIGRATIONS);
    setPeopleRepository(new SQLitePeopleRepository(identityAdapter));
    setContactRepository(new SQLiteContactRepository(identityAdapter));
    resetContactDirectory();
    addContact(BUYER_DID, 'Buyer Traders', 'verified');
    if (channels.phone !== undefined || channels.email !== undefined) {
      expect(setContactChannels(BUYER_DID, channels)).toEqual([]);
    }
  }

  afterEach(() => {
    resetContactDirectory();
    setContactRepository(null);
    setPeopleRepository(null);
    identityAdapter?.close();
    if (identityDir !== '') rmSync(identityDir, { recursive: true, force: true });
    identityDir = '';
  });

  function ask(atMs = T0): ReturnType<typeof askPaymentReminderRail> {
    return askPaymentReminderRail({
      counterpartyDid: BUYER_DID,
      subjectDigest: SUBJECT,
      dueAt: DUE_AT,
      amount: AMOUNT,
      askAtMs: atMs,
    });
  }

  it('India: a WhatsApp reminder to the number on their contact, naming the document and the due', () => {
    counterpartyWithChannels({ phone: '+91 98450 12345' });
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(ask()).toMatchObject({ asked: true, pack: 'in', mode: 'approval_required' });
    const tasks = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    expect(tasks).toHaveLength(1);
    const envelope = parsePluginEnvelope(tasks[0].payload);
    expect(envelope?.capability_id).toBe(`${COUNTRY_PACK_IDS.in}.whatsapp-reminder`);
    expect(envelope?.params).toEqual({
      to: '+919845012345',
      template: 'payment_due',
      subject_digest: SUBJECT,
      due_at: DUE_AT,
      amount: AMOUNT,
    });
    // A message leaving the node cards — the owner reads the target first.
    expect(envelope?.authorization_kind).toBe('card');
    expect(tasks[0].correlation_id).toBe(SUBJECT);
  });

  /**
   * §11 — a reminder's context says WHO, never a second copy of the number.
   * The number the runner dials is in the params, where the owner reads it on
   * the card before it goes; a copy in the context would be a second thing to
   * leak and a second thing to keep in step.
   */
  it('the context names the counterparty and which channel exists, never the channel itself', () => {
    counterpartyWithChannels({ phone: '+91 98450 12345', email: 'ap@buyer.example' });
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(ask()).toMatchObject({ asked: true, pack: 'in' });
    const envelope = parsePluginEnvelope(workflowRepo.listNonTerminalByRunner(pluginLane(installId))[0].payload);
    const context = envelope?.context as { category: string; fields: Record<string, string> }[];
    expect(context).toEqual([
      {
        category: 'contact',
        fields: {
          role: 'counterparty',
          display_name: 'Buyer Traders',
          channel_kind: 'both',
          trust_level: 'verified',
          // When the contact was made, as a BUCKET. The rig writes the row on
          // the real clock and asks at a fixed T0 well after it, so the honest
          // answer here is "older" — and the instant itself never travels.
          known_since_class: 'older',
        },
      },
    ]);
    const asJson = JSON.stringify(context);
    expect(asJson).not.toContain(String(getContact(BUYER_DID)?.createdAt));
    expect(asJson).not.toContain('9845012345');
    expect(asJson).not.toContain('ap@buyer.example');
  });

  it('USA: an SMS notice where the counterparty has a number', () => {
    counterpartyWithChannels({ phone: '+14155550123' });
    const installId = supplierNode('us');
    if (installId === null) throw new Error('unreachable');
    expect(ask()).toMatchObject({ asked: true, pack: 'us' });
    const envelope = parsePluginEnvelope(workflowRepo.listNonTerminalByRunner(pluginLane(installId))[0].payload);
    expect(envelope?.capability_id).toBe(`${COUNTRY_PACK_IDS.us}.notice`);
    expect(envelope?.params).toMatchObject({ to: '+14155550123', channel: 'sms', template: 'payment_due' });
  });

  it('USA: an e-mail notice where there is no number', () => {
    counterpartyWithChannels({ email: 'ap@buyer.example' });
    const installId = supplierNode('us');
    if (installId === null) throw new Error('unreachable');
    expect(ask()).toMatchObject({ asked: true, pack: 'us' });
    const envelope = parsePluginEnvelope(workflowRepo.listNonTerminalByRunner(pluginLane(installId))[0].payload);
    expect(envelope?.params).toMatchObject({ to: 'ap@buyer.example', channel: 'email' });
  });

  it('with no channel stated, nothing is sent and the owner is told which is missing', () => {
    counterpartyWithChannels({});
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    const outcome = ask();
    expect(outcome).toMatchObject({ asked: false, reason: 'no_channel' });
    if (outcome.asked) throw new Error('unreachable');
    expect(outcome.detail).toContain('phone');
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(0);
  });

  it('two taps on the same row in one day are ONE message; a later day is a new decision', () => {
    counterpartyWithChannels({ phone: '+919845012345' });
    const installId = supplierNode('in');
    if (installId === null) throw new Error('unreachable');
    expect(ask(T0)).toMatchObject({ asked: true });
    expect(ask(T0 + 60_000)).toMatchObject({ asked: true });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(1);
    const nextDay = Date.parse('2026-09-03T09:00:00.000Z');
    expect(ask(nextDay)).toMatchObject({ asked: true });
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(2);
  });

  it('with no pack installed, nothing is asked', () => {
    counterpartyWithChannels({ phone: '+919845012345' });
    supplierNode(null);
    expect(ask()).toEqual({ asked: false, reason: 'no_active_pack' });
  });

  it('with no workflow service there is nowhere to stage the ask', () => {
    counterpartyWithChannels({ phone: '+919845012345' });
    supplierNode('in');
    setWorkflowService(null);
    expect(ask()).toEqual({ asked: false, reason: 'no_workflow' });
  });

  it('a THROWN fault never escapes the hook — the owner sees a refusal, not a crash', () => {
    counterpartyWithChannels({ phone: '+919845012345' });
    supplierNode('in');
    setWorkflowService({
      create: () => {
        throw new Error('workflow store unavailable');
      },
      getActiveByIdempotencyKey: () => null,
      getById: () => null,
    } as unknown as WorkflowService);
    const outcome = ask();
    expect(outcome).toMatchObject({ asked: false, reason: 'refused' });
    if (outcome.asked) throw new Error('unreachable');
    expect(outcome.detail).toMatch(/^[A-Za-z]*Error$/);
  });
});
