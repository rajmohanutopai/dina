/**
 * OPENAI_DOTS_INTEGRATION §6.4 — the agent's tender-draft lane: an agent says
 * what the café needs, Core fills the suppliers from its own trade history,
 * the owner opens the draft with the limits (a person present), and the agent
 * reads ranks and names only. Real SQLite stores throughout.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { isAuthorized } from '../../../src/auth/authz';
import {
  installBuyerAuthorityProvider,
  singleOwnerAuthority,
} from '../../../src/commerce/buyer_authority';
import { installBuyerOrderSender } from '../../../src/commerce/buyer_executor';
import { installCommerceServiceQueryDispatch } from '../../../src/commerce/buyer_sender';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
  OWNER_IN_PROCESS_PRINCIPAL,
} from '../../../src/commerce/owner_presence';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import {
  installSupplierDirectory,
  trustIsGood,
  type SupplierFinding,
} from '../../../src/commerce/supplier_directory';
import { TENDER_DRAFT_TYPE } from '../../../src/commerce/tender_drafts';
import { addContact, resetContactDirectory } from '../../../src/contacts/directory';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { setPeopleRepository, SQLitePeopleRepository } from '../../../src/people/repository';
import { setOwnerReviewIdentity } from '../../../src/review/owner_review';
import {
  InMemoryReviewPublishRepository,
  setReviewPublishRepository,
} from '../../../src/review/publish_job_repository';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { CORE_MINTED_PAYLOAD_TYPES } from '../../../src/server/routes/workflow';
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import {
  BUYER_DID,
  installActiveBuyerPack,
  makeProjection,
  makeSignedQuote,
  type InstalledBuyerPack,
} from '../../commerce/helpers';

import type { QuoteRequest } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER_A = 'did:plc:supplieraaaa';
const SUPPLIER_B = 'did:plc:supplierbbbb';
const STRANGER = 'did:plc:strangerxxxx';
const AGENT = 'did:key:z6MkDotAgent';
const OTHER_AGENT = 'did:key:z6MkOtherAgent';

let dir: string;
let adapter: NodeSQLiteAdapter;
let runtime: CommerceRuntime;
let router: CoreRouter;
let pack: InstalledBuyerPack;
let workflow: WorkflowService;
let sessions: SessionRegistry;
let session: string;
let sent: { toDid: string; body: Record<string, unknown> }[];

const owner = (
  method: 'GET' | 'POST',
  p: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): CoreRequest => ({
  method,
  path: p,
  query,
  headers: {},
  body,
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: 'owner',
  ownerCapability: OWNER_CAP,
});

const agent = (
  method: 'GET' | 'POST',
  p: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
  over: Partial<CoreRequest> = {},
): CoreRequest => ({
  method,
  path: p,
  query,
  headers: {},
  body,
  rawBody: new TextEncoder().encode(JSON.stringify(body)),
  params: {},
  // The signed-request stage is tested elsewhere; this sets what it resolves.
  trustedInProcess: true,
  callerType: 'agent',
  callerDID: AGENT,
  agentScope: 'coding',
  ...over,
});

/** The owner's ChatGPT dot: an agent with the `dot` scope (HOSTED_DINA §6.3). */
const dot = (
  method: 'GET' | 'POST',
  p: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): CoreRequest => agent(method, p, body, query, { agentScope: 'dot' });

const NEED = {
  lines: [{ text: 'butter croissants', quantity: { value: '200', unit_code: 'each' } }],
  required_by: '2036-01-09T07:00:00Z',
};

beforeEach(() => {
  setNodeDID(BUYER_DID);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-tender-drafts-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER_DID,
    currentEpoch: () => '1',
    now: () => Date.now(),
  });
  installCommerceRuntime(runtime);
  pack = installActiveBuyerPack(Date.now());
  sent = [];
  installCommerceServiceQueryDispatch(async (args) => {
    sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
    return { sent: true };
  });
  installBuyerAuthorityProvider(({ order, context, serviceRkey }) =>
    singleOwnerAuthority({ ownerDid: 'did:plc:testowner00000000', order, context, serviceRkey }),
  );
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  setWorkflowService(workflow);
  sessions = new SessionRegistry();
  setSessionRegistry(sessions);
  session = sessions.start({ agentDid: AGENT, hostSessionId: 'dot-task-1' }).sessionId;
  resetContactDirectory();
  setPeopleRepository(new SQLitePeopleRepository(adapter));
  addContact(SUPPLIER_A, "Rosa's Bakery");
  addContact(SUPPLIER_B, 'Blue Door Bakehouse');
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installSupplierDirectory(null);
  setOwnerReviewIdentity(null);
  setReviewPublishRepository(null);
  pack.dispose();
  installOwnerPresenceVerifier(null);
  clearOwnerPresence();
  installBuyerAuthorityProvider(null);
  installCommerceServiceQueryDispatch(null);
  setWorkflowService(null);
  setSessionRegistry(null);
  resetContactDirectory();
  setPeopleRepository(null);
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The café's trade history: an earlier tender to its two bakeries. */
async function pastTender(): Promise<void> {
  const res = await router.handle(
    owner('POST', '/v1/commerce/trade/tender', {
      suppliers: [
        { supplier_did: SUPPLIER_A, service_rkey: 'self' },
        { supplier_did: SUPPLIER_B, service_rkey: 'shop' },
      ],
      lines: [
        {
          line_id: 'l1',
          requirement: { text: 'sourdough loaves' },
          quantity: { value: '20', unit_code: 'each' },
        },
      ],
      projection: makeProjection(),
      currency: 'INR',
    }),
  );
  expect(res.status).toBe(200);
  sent = [];
}

/** The draft's suppliers as the agent reads them, by name alone. */
function supplierNames(body: Record<string, unknown>): { name: string | null }[] {
  return (body.suppliers as { name: string | null }[]).map((s) => ({ name: s.name }));
}

async function draft(
  body: Record<string, unknown> = NEED,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await router.handle(
    agent('POST', '/v1/commerce/agent/tender-drafts', { session_id: session, ...body }),
  );
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function status(draftId: string, sessionId = session, over: Partial<CoreRequest> = {}) {
  const res = await router.handle(
    agent(
      'GET',
      '/v1/commerce/agent/tender-drafts/status',
      {},
      { draft_id: draftId, session_id: sessionId },
      over,
    ),
  );
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function openDraft(
  draftId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await router.handle(
    owner('POST', '/v1/commerce/trade/tender-drafts/open', {
      draft_id: draftId,
      target_total: '200000',
      budget_ceiling: '260000',
      currency: 'INR',
      region: { scheme: 'postal_area', value: '682001' },
      ...extra,
    }),
  );
  return { status: res.status, body: res.body as Record<string, unknown> };
}

describe('authz: the agent lane is the only commerce door an agent has', () => {
  it('admits an agent to exactly the two draft routes on the owner’s side', () => {
    expect(isAuthorized('agent', 'POST', '/v1/commerce/agent/tender-drafts')).toBe(true);
    expect(isAuthorized('agent', 'GET', '/v1/commerce/agent/tender-drafts/status')).toBe(true);
    expect(isAuthorized('agent', 'POST', '/v1/commerce/agent/tender-drafts/status')).toBe(false);
    expect(isAuthorized('agent', 'POST', '/v1/commerce/agent/tender-drafts/x')).toBe(false);
    for (const p of [
      '/v1/commerce/trade/tender',
      '/v1/commerce/trade/tender-drafts/open',
      '/v1/commerce/trade/tender/ranking',
      '/v1/commerce/trade/tender/award',
      '/v1/commerce/trade/counter',
      '/v1/commerce/orders/submit',
      '/v1/commerce/buyer/quotes',
    ]) {
      expect(isAuthorized('agent', 'POST', p)).toBe(false);
      expect(isAuthorized('agent', 'GET', p)).toBe(false);
    }
  });

  it('opens the owner’s dot steps to an agent, each on its one method', () => {
    for (const [method, p] of [
      ['POST', '/v1/commerce/agent/tender-drafts/open'],
      ['POST', '/v1/commerce/agent/tender-drafts/award'],
      ['GET', '/v1/commerce/agent/suppliers/search'],
      ['POST', '/v1/commerce/agent/suppliers/review'],
    ] as const) {
      expect(isAuthorized('agent', method, p)).toBe(true);
      expect(isAuthorized('agent', method === 'GET' ? 'POST' : 'GET', p)).toBe(false);
    }
  });

  it('keeps the draft card Core-minted', () => {
    expect(CORE_MINTED_PAYLOAD_TYPES.has(TENDER_DRAFT_TYPE)).toBe(true);
  });
});

describe('drafting a tender', () => {
  it('fills the suppliers from the café trade history and raises one owner card', async () => {
    await pastTender();
    const res = await draft();
    expect(res.status).toBe(200);
    expect(res.body.draft_state).toBe('pending');
    expect(supplierNames(res.body)).toEqual([
      { name: "Rosa's Bakery" },
      { name: 'Blue Door Bakehouse' },
    ]);
    // Nothing left the node: a draft asks no supplier anything.
    expect(sent).toEqual([]);
    const card = workflow.store().getById(`tender-draft-${String(res.body.draft_id)}`);
    expect(card?.status).toBe('pending_approval');
    expect(JSON.parse(card?.payload ?? '{}').type).toBe(TENDER_DRAFT_TYPE);
  });

  it('never takes a supplier, a price or a limit from the agent', async () => {
    await pastTender();
    const res = await draft({
      ...NEED,
      suppliers: [{ supplier_did: STRANGER, service_rkey: 'self' }],
      target_total: '1',
      budget_ceiling: '999999999',
    });
    expect(res.status).toBe(200);
    const listed = await router.handle(owner('GET', '/v1/commerce/trade/tender-drafts'));
    const drafts = (listed.body as { drafts: { suppliers: { supplier_did: string }[] }[] }).drafts;
    expect(drafts[0]?.suppliers.map((s) => s.supplier_did)).toEqual([SUPPLIER_A, SUPPLIER_B]);
    expect(JSON.stringify(listed.body)).not.toContain('999999999');
  });

  it('refuses when the café has no trade history to draw suppliers from', async () => {
    const res = await draft();
    expect(res).toEqual({ status: 409, body: { error: 'no_known_suppliers' } });
  });

  it('skips a supplier the owner blocked', async () => {
    await pastTender();
    const stored = runtime.settings.readBuyer();
    const base = stored.ok
      ? stored.settings
      : {
          actingIdentityDid: BUYER_DID,
          locations: [],
          preferredSuppliers: [],
          allowedCategoryIds: [],
          quoteFanoutCeiling: 5,
          approvalPolicySummary: '',
          currency: 'INR',
          preferredUnitCodes: [],
          publishReviews: false,
        };
    expect(runtime.settings.writeBuyer({ ...base, blockedSuppliers: [SUPPLIER_B] })).toEqual({
      ok: true,
    });
    const res = await draft();
    expect(supplierNames(res.body)).toEqual([{ name: "Rosa's Bakery" }]);
  });

  it('checks the lines', async () => {
    await pastTender();
    expect((await draft({ lines: [] })).status).toBe(400);
    expect(
      (
        await draft({
          lines: [{ text: 'croissants', quantity: { value: '0', unit_code: 'each' } }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await draft({
          lines: [{ text: 'croissants', quantity: { value: '2', unit_code: 'bushel' } }],
        })
      ).status,
    ).toBe(400);
    expect((await draft({ ...NEED, required_by: 'friday' })).status).toBe(400);
  });

  it('caps the drafts one agent may have waiting', async () => {
    await pastTender();
    for (let i = 0; i < 5; i += 1) expect((await draft()).status).toBe(200);
    expect(await draft()).toEqual({ status: 409, body: { error: 'too_many_pending_drafts' } });
  });

  it('needs a live session of the agent’s own, and refuses runners and other callers', async () => {
    await pastTender();
    expect((await draft({ ...NEED, session_id: 'nope' })).status).toBe(401);
    const foreign = sessions.start({ agentDid: OTHER_AGENT, hostSessionId: 'x' }).sessionId;
    expect((await draft({ ...NEED, session_id: foreign })).status).toBe(401);
    const runner = await router.handle(
      agent(
        'POST',
        '/v1/commerce/agent/tender-drafts',
        { session_id: session, ...NEED },
        {},
        {
          agentScope: 'runner',
        },
      ),
    );
    expect(runner.status).toBe(403);
    const device = await router.handle(
      agent(
        'POST',
        '/v1/commerce/agent/tender-drafts',
        { session_id: session, ...NEED },
        {},
        {
          callerType: 'device',
        },
      ),
    );
    expect(device.status).toBe(403);
  });
});

describe('opening a draft', () => {
  it('needs a person present, then opens the tender with the owner’s limits', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    expect((await openDraft(id)).body.error).toBe('no_user_presence');
    expect(sent).toEqual([]);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const opened = await openDraft(id);
    expect(opened.status).toBe(200);
    expect(opened.body.negotiating).toBe(true);
    expect(sent.map((w) => w.toDid).sort()).toEqual([SUPPLIER_A, SUPPLIER_B]);
    const policy = runtime.buyerNegotiation.getTender(String(opened.body.tender_id));
    expect(policy?.targetTotalMinor).toBe('200000');
    expect(policy?.budgetCeilingMinor).toBe('260000');
    // The card is down and a second open is refused.
    expect(workflow.store().getById(`tender-draft-${id}`)?.status).toBe('cancelled');
    expect((await openDraft(id)).body.error).toBe('draft_not_pending');
  });

  it('refuses on a node that cannot check the passphrase', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    installOwnerPresenceVerifier(null);
    expect((await openDraft(id)).body.error).toBe('presence_unavailable');
    expect(sent).toEqual([]);
  });

  it('lets the owner leave a supplier out, never add one', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await openDraft(id, { suppliers: [SUPPLIER_A, STRANGER] })).status).toBe(400);
    const opened = await openDraft(id, { suppliers: [SUPPLIER_A] });
    expect(opened.status).toBe(200);
    expect(sent.map((w) => w.toDid)).toEqual([SUPPLIER_A]);
  });

  it('is owner-only, and a dismissed draft cannot be opened', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    const byAgent = await router.handle(
      agent('POST', '/v1/commerce/trade/tender-drafts/open', { draft_id: id, session_id: session }),
    );
    expect(byAgent.status).toBe(403);
    const dismissed = await router.handle(
      owner('POST', '/v1/commerce/trade/tender-drafts/dismiss', { draft_id: id }),
    );
    expect(dismissed.status).toBe(200);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await openDraft(id)).body.error).toBe('draft_not_pending');
    expect((await status(id)).body.draft_state).toBe('dismissed');
  });
});

describe("the agent's status read", () => {
  /** Each asked supplier answers, as the response lane would store it. */
  function quotesArrive(unitBySupplier: Record<string, string>): void {
    for (const wire of sent.filter(
      (w) => w.body.capability === 'com.dinakernel.commerce.request_quote',
    )) {
      const request = wire.body.params as QuoteRequest;
      const line = request.lines[0];
      if (line === undefined) throw new Error('request has no line');
      const unit = unitBySupplier[wire.toDid] as string;
      const quote = makeSignedQuote(request, {
        quote_id: `q-${wire.toDid.slice(-4)}`,
        valid_until: '2036-01-01T00:00:00.000Z',
        lines: [
          {
            line_id: 'l1',
            requested_product: line.product,
            offered_product: line.product,
            quantity: { value: '200', unit_code: 'each' },
            price_basis: { value: '1', unit_code: 'each' },
            unit_price: { currency: 'INR', minor_units: unit },
            line_subtotal: { currency: 'INR', minor_units: String(Number(unit) * 200) },
            stock_status: 'available',
          },
        ],
        total: { currency: 'INR', minor_units: String(Number(unit) * 200) },
      });
      runtime.buyerQuotes.append({
        supplierDid: wire.toDid,
        quoteId: quote.quote_id,
        quote,
        acceptedAt: Date.now(),
      });
      runtime.tenders.setMemberQuote(request.request_id, quote.quote_id);
    }
  }

  it('shows ranks and names, never a price, a quote or the owner’s limits', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await openDraft(id)).status).toBe(200);
    quotesArrive({ [SUPPLIER_A]: '1150', [SUPPLIER_B]: '1090' });
    const res = await status(id);
    expect(res.status).toBe(200);
    const tender = res.body.tender as Record<string, unknown>;
    expect(tender.ranked).toEqual([
      { rank: 1, name: 'Blue Door Bakehouse' },
      { rank: 2, name: "Rosa's Bakery" },
    ]);
    expect(tender.supplier_answer).toBe('none');
    const text = JSON.stringify(res.body);
    for (const secret of [
      '1150',
      '1090',
      '230000',
      '218000',
      '200000',
      '260000',
      'q-aaaa',
      'q-bbbb',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('after the owner awards, says who won and that the order is held, still with no price', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const opened = await openDraft(id);
    quotesArrive({ [SUPPLIER_A]: '1150', [SUPPLIER_B]: '1090' });
    const awarded = await router.handle(
      owner('POST', '/v1/commerce/trade/tender/award', {
        tender_id: opened.body.tender_id,
        supplier_did: SUPPLIER_B,
      }),
    );
    expect(awarded.status).toBe(200);
    const tender = (await status(id)).body.tender as Record<string, unknown>;
    expect(tender.state).toBe('awarded');
    expect(tender.awarded_to).toBe('Blue Door Bakehouse');
    expect(tender.held_order).toBe('held');
    expect(tender.supplier_answer).toBe('none');
    expect(JSON.stringify(tender)).not.toContain('218000');
  });

  it('lets the owner’s dot open the draft, read the quotes and award; the order goes out', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    const orders: string[] = [];
    installBuyerOrderSender(async ({ order }) => {
      orders.push(order.supplier_did);
      return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
    });
    try {
      // No passphrase: the owner is in the chat.
      const opened = await router.handle(
        dot('POST', '/v1/commerce/agent/tender-drafts/open', {
          session_id: session,
          draft_id: id,
          target_total: '200000',
          budget_ceiling: '260000',
          currency: 'INR',
          region: { scheme: 'postal_area', value: '682001' },
        }),
      );
      expect(opened.status).toBe(200);
      expect(sent.map((w) => w.toDid).sort()).toEqual([SUPPLIER_A, SUPPLIER_B]);
      const policy = runtime.buyerNegotiation.getTender(
        String((opened.body as { tender_id: string }).tender_id),
      );
      expect(policy?.budgetCeilingMinor).toBe('260000');
      expect(workflow.store().getById(`tender-draft-${id}`)?.status).toBe('cancelled');

      quotesArrive({ [SUPPLIER_A]: '1150', [SUPPLIER_B]: '1090' });
      const read = await router.handle(
        dot(
          'GET',
          '/v1/commerce/agent/tender-drafts/status',
          {},
          { draft_id: id, session_id: session },
        ),
      );
      const body = read.body as Record<string, unknown>;
      expect((body.tender as { ranked: unknown[] }).ranked).toEqual([
        {
          rank: 1,
          name: 'Blue Door Bakehouse',
          total: { currency: 'INR', minor_units: '218000' },
          valid_until: '2036-01-01T00:00:00.000Z',
        },
        {
          rank: 2,
          name: "Rosa's Bakery",
          total: { currency: 'INR', minor_units: '230000' },
          valid_until: '2036-01-01T00:00:00.000Z',
        },
      ]);
      expect((body.suppliers as { supplier_did?: string }[]).map((s) => s.supplier_did)).toEqual([
        SUPPLIER_A,
        SUPPLIER_B,
      ]);
      // The ceiling the dot set is never read back.
      expect(JSON.stringify(body)).not.toContain('260000');

      const awarded = await router.handle(
        dot('POST', '/v1/commerce/agent/tender-drafts/award', {
          session_id: session,
          draft_id: id,
          rank: 2,
        }),
      );
      expect((awarded.body as { awarded_to: string }).awarded_to).toBe("Rosa's Bakery");
      expect(orders).toEqual([SUPPLIER_A]);
      const after = (await status(id)).body.tender as Record<string, unknown>;
      expect(after.state).toBe('awarded');
      expect(after.held_order).toBe('sent');
    } finally {
      installBuyerOrderSender(null);
    }
  });

  it('lets no other agent open or award, and reads another agent’s draft as absent to the dot', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    const limits = {
      session_id: session,
      draft_id: id,
      target_total: '200000',
      budget_ceiling: '260000',
    };
    // A coding agent drafts; the owner decides.
    for (const p of [
      '/v1/commerce/agent/tender-drafts/open',
      '/v1/commerce/agent/tender-drafts/award',
    ]) {
      const res = await router.handle(agent('POST', p, limits));
      expect(res).toEqual({ status: 403, body: { error: 'agent_scope_not_allowed' } });
    }
    const other = sessions.start({ agentDid: OTHER_AGENT, hostSessionId: 'z' }).sessionId;
    const foreign = await router.handle(
      agent(
        'POST',
        '/v1/commerce/agent/tender-drafts/open',
        { ...limits, session_id: other },
        {},
        { agentScope: 'dot', callerDID: OTHER_AGENT },
      ),
    );
    expect(foreign).toEqual({ status: 404, body: { error: 'no_such_draft' } });
    expect(sent).toEqual([]);
    const early = await router.handle(
      dot('POST', '/v1/commerce/agent/tender-drafts/award', { session_id: session, draft_id: id }),
    );
    expect(early).toEqual({ status: 409, body: { error: 'draft_not_opened' } });
  });

  it("reads another agent's draft as absent", async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    const other = sessions.start({ agentDid: OTHER_AGENT, hostSessionId: 'y' }).sessionId;
    const res = await status(id, other, { callerDID: OTHER_AGENT });
    expect(res).toEqual({ status: 404, body: { error: 'no_such_draft' } });
  });
});

describe("the owner's supplier list (HOSTED_DINA §6)", () => {
  const add = (body: Record<string, unknown>) =>
    router.handle(owner('POST', '/v1/commerce/trade/suppliers', body));

  it('lets a new Dina with no orders or tenders draft against suppliers the owner added', async () => {
    expect((await draft()).body).toEqual({ error: 'no_known_suppliers' });
    expect((await add({ supplier_did: SUPPLIER_A, service_rkey: 'self', label: 'Rosa' })).status).toBe(200);

    const res = await draft();
    expect(res.status).toBe(200);
    expect(supplierNames(res.body)).toEqual([{ name: "Rosa's Bakery" }]);
    const listed = await router.handle(owner('GET', '/v1/commerce/trade/suppliers'));
    expect((listed.body as { suppliers: unknown[] }).suppliers).toEqual([
      expect.objectContaining({ supplier_did: SUPPLIER_A, service_rkey: 'self', label: 'Rosa' }),
    ]);
  });

  it('lists the owner’s suppliers before the trade history, once each, and never a blocked one', async () => {
    await pastTender();
    await add({ supplier_did: SUPPLIER_B, service_rkey: 'wholesale' });
    await add({ supplier_did: STRANGER, service_rkey: 'self' });
    const stored = runtime.settings.readBuyer();
    const base = stored.ok
      ? stored.settings
      : {
          actingIdentityDid: BUYER_DID,
          locations: [],
          preferredSuppliers: [],
          allowedCategoryIds: [],
          quoteFanoutCeiling: 5,
          approvalPolicySummary: '',
          currency: 'INR',
          preferredUnitCodes: [],
          publishReviews: false,
        };
    expect(runtime.settings.writeBuyer({ ...base, blockedSuppliers: [STRANGER] })).toEqual({
      ok: true,
    });
    const res = await draft();
    const id = String(res.body.draft_id);
    expect(runtime.tenderDrafts.get(id)?.suppliers).toEqual([
      { supplier_did: SUPPLIER_B, service_rkey: 'wholesale', source: 'known', selected: true },
      { supplier_did: SUPPLIER_A, service_rkey: 'self', source: 'known', selected: true },
    ]);
  });

  it('names a supplier by the owner’s label when no contact names it', async () => {
    resetContactDirectory();
    await add({ supplier_did: STRANGER, service_rkey: 'self', label: 'Corner Bakery' });
    const res = await draft();
    expect(supplierNames(res.body)).toEqual([{ name: 'Corner Bakery' }]);
  });

  it('checks what the owner typed, replaces an entry, and removes one', async () => {
    expect((await add({ supplier_did: 'rosa', service_rkey: 'self' })).status).toBe(400);
    expect((await add({ supplier_did: SUPPLIER_A, service_rkey: 'has space' })).status).toBe(400);
    expect((await add({ supplier_did: SUPPLIER_A, service_rkey: 'self', label: 'x'.repeat(81) })).status).toBe(400);
    await add({ supplier_did: SUPPLIER_A, service_rkey: 'self' });
    await add({ supplier_did: SUPPLIER_A, service_rkey: 'shop' });
    expect(runtime.ownerSuppliers.list()).toEqual([
      expect.objectContaining({ supplierDid: SUPPLIER_A, serviceRkey: 'shop' }),
    ]);
    const removed = await router.handle(
      owner('POST', '/v1/commerce/trade/suppliers/remove', { supplier_did: SUPPLIER_A }),
    );
    expect(removed.status).toBe(200);
    const again = await router.handle(
      owner('POST', '/v1/commerce/trade/suppliers/remove', { supplier_did: SUPPLIER_A }),
    );
    expect(again.status).toBe(404);
  });

  it('is the owner’s alone: no agent can read or write it', async () => {
    for (const [method, p] of [
      ['GET', '/v1/commerce/trade/suppliers'],
      ['POST', '/v1/commerce/trade/suppliers'],
      ['POST', '/v1/commerce/trade/suppliers/remove'],
    ] as const) {
      expect(isAuthorized('agent', method, p)).toBe(false);
      const res = await router.handle(
        agent(method, p, { supplier_did: SUPPLIER_A, service_rkey: 'self' }),
      );
      expect(res.status).toBe(403);
    }
    expect(runtime.ownerSuppliers.count()).toBe(0);
  });
});

describe('the stored draft is re-checked on every read', () => {
  it('reads a draft whose stored row was changed as absent, to the owner and the agent', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    adapter.run(`UPDATE commerce_tender_drafts SET suppliers_json = ? WHERE draft_id = ?`, [
      JSON.stringify([{ supplier_did: 'not-a-did', service_rkey: 'self' }]),
      id,
    ]);
    expect(runtime.tenderDrafts.get(id)).toBeNull();
    expect(runtime.tenderDrafts.listPending(Date.now())).toEqual([]);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await openDraft(id)).body).toEqual({ error: 'no_such_draft' });
    expect((await status(id)).status).toBe(404);
  });
});

describe('opening a draft twice at once (code review round 1)', () => {
  it('lets one open send to the suppliers; the other, and a dismiss, are refused', async () => {
    await pastTender();
    const id = String((await draft()).body.draft_id);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const dismissDuring = (async () => {
      await Promise.resolve();
      return router.handle(owner('POST', '/v1/commerce/trade/tender-drafts/dismiss', { draft_id: id }));
    })();
    const [a, b, d] = await Promise.all([openDraft(id), openDraft(id), dismissDuring]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a.body, b.body]).toContainEqual({ error: 'draft_opening' });
    expect(d.status).toBe(409);
    // One tender's worth of quote requests: one per supplier.
    expect(sent.map((m) => m.toDid).sort()).toEqual([SUPPLIER_A, SUPPLIER_B]);
    expect(runtime.tenderDrafts.get(id)?.state).toBe('opened');
  });
});

// ── HOSTED_DINA §6.1–§6.2: suppliers found on the network, and the owner's verdict ──

const NET_GOOD = 'did:plc:netgoodbakery';
const NET_NEW = 'did:plc:netnewbakery';

function finding(
  did: string,
  name: string,
  score: number | null,
  reviews: number,
): SupplierFinding {
  return {
    supplierDid: did,
    serviceRkey: 'self',
    name,
    items: [
      {
        product: 'manufacturer_sku:CROI',
        indicativePrice: { currency: 'INR', minorUnits: '4500' },
      },
    ],
    trust: { score, reviews },
  };
}

function setBuyer(extra: Record<string, unknown> = {}): void {
  const stored = runtime.settings.readBuyer();
  const base = stored.ok
    ? stored.settings
    : {
        actingIdentityDid: BUYER_DID,
        locations: [],
        preferredSuppliers: [],
        blockedSuppliers: [],
        allowedCategoryIds: [],
        quoteFanoutCeiling: 5,
        approvalPolicySummary: '',
        currency: 'INR',
        preferredUnitCodes: [],
        publishReviews: false,
      };
  expect(
    runtime.settings.writeBuyer({
      ...base,
      locations: [{ scheme: 'postal_area', value: '560001' }],
      ...extra,
    } as never),
  ).toEqual({ ok: true });
}

describe('network suppliers in an agent’s draft (HOSTED_DINA §6.1)', () => {
  let searches: { text: string; region?: string }[];
  let findings: SupplierFinding[];
  beforeEach(() => {
    searches = [];
    findings = [finding(NET_GOOD, 'Good Bakes', 0.9, 4), finding(NET_NEW, 'New Bakes', null, 0)];
    installSupplierDirectory({
      findSuppliers: async (q) => {
        searches.push({ text: q.text, ...(q.region !== undefined ? { region: q.region } : {}) });
        return findings;
      },
    });
    setBuyer();
  });

  it('offers a new Dina network finds: ticked when trust is good, unticked when not', async () => {
    const res = await draft();
    expect(res.status).toBe(200);
    expect(searches).toEqual([{ text: 'butter croissants', region: 'postal_area:560001' }]);
    const stored = runtime.tenderDrafts.get(String(res.body.draft_id));
    expect(stored?.suppliers).toEqual([
      {
        supplier_did: NET_GOOD,
        service_rkey: 'self',
        source: 'network',
        selected: true,
        name: 'Good Bakes',
        trust: { score: 0.9, reviews: 4 },
      },
      {
        supplier_did: NET_NEW,
        service_rkey: 'self',
        source: 'network',
        selected: false,
        name: 'New Bakes',
        trust: { score: null, reviews: 0 },
      },
    ]);
    // The agent reads names only.
    expect(supplierNames(res.body)).toEqual([{ name: 'Good Bakes' }, { name: 'New Bakes' }]);
    // The owner's card says where they came from.
    const card = workflow.store().getById(`tender-draft-${String(res.body.draft_id)}`);
    expect(card?.description).toContain('2 found on the network');
  });

  it('searches where the owner’s dot says the goods go, in its currency; another agent’s say is ignored', async () => {
    const where = { scheme: 'postal_area', value: '94103' };
    const res = await router.handle(
      dot('POST', '/v1/commerce/agent/tender-drafts', {
        session_id: session,
        ...NEED,
        region: where,
        currency: 'USD',
      }),
    );
    expect(res.status).toBe(200);
    expect(searches).toEqual([{ text: 'butter croissants', region: 'postal_area:94103' }]);
    const stored = runtime.tenderDrafts.get(String((res.body as { draft_id: string }).draft_id));
    expect(stored?.region).toEqual(where);
    expect(stored?.currency).toBe('USD');

    const coded = await draft({ ...NEED, region: where, currency: 'USD' });
    expect(searches[1]).toEqual({ text: 'butter croissants', region: 'postal_area:560001' });
    expect(runtime.tenderDrafts.get(String(coded.body.draft_id))?.currency).toBe('INR');

    const bad = await router.handle(
      dot('POST', '/v1/commerce/agent/tender-drafts', {
        session_id: session,
        ...NEED,
        region: { scheme: 'planet', value: 'mars' },
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('opens to the ticked suppliers only, unless the owner ticks others', async () => {
    const id = String((await draft()).body.draft_id);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await openDraft(id)).status).toBe(200);
    expect(sent.map((m) => m.toDid)).toEqual([NET_GOOD]);

    sent = [];
    const second = String((await draft()).body.draft_id);
    expect((await openDraft(second, { suppliers: [NET_NEW] })).status).toBe(200);
    expect(sent.map((m) => m.toDid)).toEqual([NET_NEW]);
  });

  it('never offers a supplier already offered, a blocked one, or the café itself', async () => {
    await router.handle(
      owner('POST', '/v1/commerce/trade/suppliers', {
        supplier_did: NET_GOOD,
        service_rkey: 'shop',
      }),
    );
    setBuyer({ blockedSuppliers: [NET_NEW] });
    findings = [...findings, finding(BUYER_DID, 'Myself', 1, 9)];
    const id = String((await draft()).body.draft_id);
    expect(runtime.tenderDrafts.get(id)?.suppliers).toEqual([
      { supplier_did: NET_GOOD, service_rkey: 'shop', source: 'known', selected: true },
    ]);
  });

  it('ticks no more than one tender asks, best trust first', async () => {
    findings = Array.from({ length: 7 }, (_, i) =>
      finding(`did:plc:bake${String(i)}xxxx`, `Bake ${String(i)}`, 0.6 + i * 0.05, 3),
    );
    const id = String((await draft()).body.draft_id);
    const offered = runtime.tenderDrafts.get(id)?.suppliers ?? [];
    expect(offered).toHaveLength(7);
    expect(offered.filter((s) => s.selected).map((s) => s.name)).toEqual([
      'Bake 6',
      'Bake 5',
      'Bake 4',
      'Bake 3',
      'Bake 2',
    ]);
  });

  it('drops a malformed AppView entry instead of storing a draft that cannot be read back', async () => {
    findings = [
      { ...finding('not-a-did', 'Bad', 0.9, 4) },
      { ...finding('did:plc:badrkeyyyyy', 'Bad rkey', 0.9, 4), serviceRkey: 'has space' },
      finding(NET_GOOD, 'x'.repeat(300), 0.9, 4),
    ];
    const id = String((await draft()).body.draft_id);
    const stored = runtime.tenderDrafts.get(id);
    expect(stored?.suppliers.map((s) => s.supplier_did)).toEqual([NET_GOOD]);
    expect(stored?.suppliers[0]?.name).toHaveLength(120);
  });

  it('never asks a supplier the owner blocked after the draft was made', async () => {
    const id = String((await draft()).body.draft_id);
    setBuyer({ blockedSuppliers: [NET_GOOD] });
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await openDraft(id, { suppliers: [NET_GOOD, NET_NEW] })).body).toEqual({
      error: 'supplier_blocked',
    });
    // With the draft's own ticks, the blocked one is dropped; none left is a refusal.
    expect((await openDraft(id)).body).toEqual({ error: 'no_unblocked_suppliers' });
    expect(sent).toEqual([]);
    expect((await openDraft(id, { suppliers: [NET_NEW] })).status).toBe(200);
    expect(sent.map((m) => m.toDid)).toEqual([NET_NEW]);
  });

  it('a failing directory leaves the café’s own suppliers, or no draft at all', async () => {
    installSupplierDirectory({
      findSuppliers: async () => {
        throw new Error('appview down');
      },
    });
    expect((await draft()).body).toEqual({ error: 'no_known_suppliers' });
    await pastTender();
    const res = await draft();
    expect(res.status).toBe(200);
    expect(supplierNames(res.body)).toEqual([
      { name: "Rosa's Bakery" },
      { name: 'Blue Door Bakehouse' },
    ]);
  });
});

describe('the owner finds suppliers and gives a verdict (HOSTED_DINA §6.1–§6.2)', () => {
  let reviews: InMemoryReviewPublishRepository;
  beforeEach(() => {
    installSupplierDirectory({
      findSuppliers: async () => [
        finding(NET_GOOD, 'Good Bakes', 0.9, 4),
        finding(NET_NEW, 'New Bakes', null, 0),
      ],
    });
    reviews = new InMemoryReviewPublishRepository();
    setReviewPublishRepository(reviews);
    setOwnerReviewIdentity(BUYER_DID);
    setBuyer();
  });

  const search = (query: Record<string, string>) =>
    router.handle(owner('GET', '/v1/commerce/trade/suppliers/search', {}, query));
  const verdict = (body: Record<string, unknown>) =>
    router.handle(owner('POST', '/v1/commerce/trade/suppliers/review', body));

  it('searches the network with trust, and marks who is listed or blocked', async () => {
    await router.handle(
      owner('POST', '/v1/commerce/trade/suppliers', {
        supplier_did: NET_GOOD,
        service_rkey: 'self',
      }),
    );
    const res = await search({ q: 'croissants' });
    expect(res.status).toBe(200);
    const body = res.body as { region: string; suppliers: Record<string, unknown>[] };
    expect(body.region).toBe('postal_area:560001');
    expect(body.suppliers).toEqual([
      expect.objectContaining({
        supplier_did: NET_GOOD,
        name: 'Good Bakes',
        listed: true,
        blocked: false,
        trust: { score: 0.9, reviews: 4, good: true },
      }),
      expect.objectContaining({
        supplier_did: NET_NEW,
        listed: false,
        trust: { score: null, reviews: 0, good: false },
      }),
    ]);
    expect((await search({ q: '' })).status).toBe(400);
    expect((await search({ q: 'x', region: 'not a region!' })).status).toBe(400);
  });

  it('“I trust this supplier” needs a person present, then publishes a review and lists it', async () => {
    const body = {
      supplier_did: NET_NEW,
      service_rkey: 'self',
      label: 'New Bakes',
      verdict: 'trust',
      note: 'Lovely croissants',
    };
    const refused = await verdict(body);
    expect(refused.status).toBe(403);
    expect(reviews.listForOwner(BUYER_DID)).toEqual([]);

    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const res = await verdict(body);
    expect(res.status).toBe(200);
    expect(runtime.ownerSuppliers.list()).toEqual([
      expect.objectContaining({ supplierDid: NET_NEW, serviceRkey: 'self', label: 'New Bakes' }),
    ]);
    const [job] = reviews.listForOwner(BUYER_DID);
    const record = JSON.parse(job?.recordJSON ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      subject: { type: 'did', did: NET_NEW, name: 'New Bakes' },
      category: 'supplier',
      sentiment: 'positive',
      text: 'Lovely croissants',
    });
    expect(record.isAgentGenerated).toBeUndefined();
    expect(job?.rkey).toMatch(/^owner-[0-9a-f]{24}$/);
  });

  it('“Not for me” publishes a negative review, unlists and blocks; trusting again lifts the block', async () => {
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    await verdict({ supplier_did: NET_GOOD, service_rkey: 'self', verdict: 'trust' });
    const res = await verdict({
      supplier_did: NET_GOOD,
      service_rkey: 'self',
      verdict: 'distrust',
    });
    expect(res.status).toBe(200);
    expect(runtime.ownerSuppliers.list()).toEqual([]);
    const buyer = runtime.settings.readBuyer();
    expect(buyer.ok && buyer.settings.blockedSuppliers).toEqual([NET_GOOD]);
    expect(
      reviews
        .listForOwner(BUYER_DID)
        .map((j) => (JSON.parse(j.recordJSON) as { sentiment: string }).sentiment)
        // Both queued in the same millisecond: the queue's order between them is not fixed.
        .sort(),
    ).toEqual(['negative', 'positive']);

    await verdict({ supplier_did: NET_GOOD, service_rkey: 'self', verdict: 'trust' });
    const after = runtime.settings.readBuyer();
    expect(after.ok && after.settings.blockedSuppliers).toEqual([]);
  });

  it('changes nothing when this Dina cannot publish reviews, and refuses itself', async () => {
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    setOwnerReviewIdentity(null);
    const res = await verdict({ supplier_did: NET_GOOD, service_rkey: 'self', verdict: 'trust' });
    expect([res.status, (res.body as { error: string }).error]).toEqual([
      503,
      'reviews_unavailable',
    ]);
    expect(runtime.ownerSuppliers.list()).toEqual([]);
    setOwnerReviewIdentity(BUYER_DID);
    expect(
      (await verdict({ supplier_did: BUYER_DID, service_rkey: 'self', verdict: 'trust' })).status,
    ).toBe(400);
    expect(
      (await verdict({ supplier_did: NET_GOOD, service_rkey: 'self', verdict: 'maybe' })).status,
    ).toBe(400);
  });

  it('lets the owner’s dot search and carry the owner’s verdict, with no passphrase', async () => {
    const found = await router.handle(
      dot(
        'GET',
        '/v1/commerce/agent/suppliers/search',
        {},
        { session_id: session, q: 'croissants' },
      ),
    );
    expect(found.status).toBe(200);
    expect(
      (found.body as { suppliers: { supplier_did: string }[] }).suppliers.map(
        (s) => s.supplier_did,
      ),
    ).toEqual([NET_GOOD, NET_NEW]);
    const res = await router.handle(
      dot('POST', '/v1/commerce/agent/suppliers/review', {
        session_id: session,
        supplier_did: NET_NEW,
        service_rkey: 'self',
        label: 'New Bakes',
        verdict: 'trust',
      }),
    );
    expect(res.status).toBe(200);
    expect(runtime.ownerSuppliers.list()).toEqual([
      expect.objectContaining({ supplierDid: NET_NEW, label: 'New Bakes' }),
    ]);
    expect(reviews.listForOwner(BUYER_DID)).toHaveLength(1);
  });

  it('refuses both to any agent but the owner’s dot', async () => {
    const searched = await router.handle(
      agent(
        'GET',
        '/v1/commerce/agent/suppliers/search',
        {},
        { session_id: session, q: 'croissants' },
      ),
    );
    expect(searched).toEqual({ status: 403, body: { error: 'agent_scope_not_allowed' } });
    const reviewed = await router.handle(
      agent('POST', '/v1/commerce/agent/suppliers/review', {
        session_id: session,
        supplier_did: NET_NEW,
        service_rkey: 'self',
        verdict: 'trust',
      }),
    );
    expect(reviewed).toEqual({ status: 403, body: { error: 'agent_scope_not_allowed' } });
    expect(reviews.listForOwner(BUYER_DID)).toEqual([]);
  });

  it('is the owner’s alone: no agent may search or review', () => {
    for (const p of [
      '/v1/commerce/trade/suppliers/search',
      '/v1/commerce/trade/suppliers/review',
    ]) {
      expect(isAuthorized('agent', 'GET', p)).toBe(false);
      expect(isAuthorized('agent', 'POST', p)).toBe(false);
      expect(isAuthorized('owner', 'POST', p)).toBe(true);
    }
  });
});

describe('good trust (HOSTED_DINA §6.1)', () => {
  it('needs two reviews and a score of at least 0.2: a young network’s two positive reviews pass', () => {
    // Kumar Bakes on the test network, 2026-10-24: two positive reviews from new Dinas.
    expect(trustIsGood({ score: 0.24, reviews: 2 })).toBe(true);
    expect(trustIsGood({ score: 0.19, reviews: 5 })).toBe(false);
    expect(trustIsGood({ score: 0.9, reviews: 1 })).toBe(false);
    expect(trustIsGood({ score: null, reviews: 0 })).toBe(false);
  });
});
