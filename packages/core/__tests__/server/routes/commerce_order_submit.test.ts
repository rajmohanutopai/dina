/**
 * §15.2 — the card and the send are two acts, and CORE holds what was approved.
 *
 * WHAT THIS SUITE EXISTS FOR. `verifyApprovalBinding` compares what is about to
 * execute against what was approved, and that comparison is worth having only
 * when the two sides come from different places. They did not: `POST
 * /v1/commerce/orders/submit` took the order, the context AND the approved
 * payload from one request body, rebuilt the payload from that body's order,
 * and compared the result to that body's payload. A caller that re-planned the
 * order simply rebuilt both halves and passed. Every attack the binding names
 * — a re-planned order, a mutated store row, a swapped install between the tap
 * and the send — was one of those callers.
 *
 * The route had no test of its own, which is why changing its contract broke
 * nothing. That absence is the finding as much as the defect was.
 *
 * These cases drive the ROUTES. The executor beneath them has its own suite and
 * was never the problem.
 */

import {
  approvalDigest,
  buildBuyerApprovalPayload,
  type ActingInstall,
  type BuyerApprovalContext,
} from '../../../src/commerce/approval_payload';
import { InMemoryAttributionBoundaryRepository } from '../../../src/commerce/attribution_boundary';
import {
  installBuyerAuthorityProvider,
  singleOwnerAuthority,
} from '../../../src/commerce/buyer_authority';
import {
  installBuyerOrderSender,
  type BuyerOrderSender,
} from '../../../src/commerce/buyer_executor';
import { InMemoryBuyerOrderRepository } from '../../../src/commerce/buyer_orders';
import { InMemoryBuyerQuoteRepository } from '../../../src/commerce/buyer_quotes';
import { InMemoryBuyerQuoteRequestRepository } from '../../../src/commerce/buyer_requests';
import {
  InMemoryOrderApprovalRepository,
  ORDER_APPROVAL_TTL_MS,
} from '../../../src/commerce/order_approvals';
import {
  InMemoryOrderDraftRepository,
  type OrderDraft,
} from '../../../src/commerce/order_draft_store';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import * as ceremony from '../../../src/pairing/ceremony';
import { setNodeDID } from '../../../src/pairing/ceremony';
import {
  getPluginInstallRepository,
  setPluginInstallRepository,
} from '../../../src/plugins/registry';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import {
  BUYER_DID,
  installActiveBuyerPack,
  installActiveSupplierPack,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
  type InstalledBuyerPack,
} from '../../commerce/helpers';

import type { PurchaseOrderProposal , ApprovalSourceBinding } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';

/** The real order, from the shared fixtures — a hand-built one never reaches
 *  the §15.2 binding at all, because the payload builder refuses it first. */
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST, { quote_id: 'q-submit' });
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);
const SUPPLIER = ORDER.supplier_did;
const PO = ORDER.purchase_order_id;

const T0 = Date.parse('2026-08-08T09:00:00.000Z');

/**
 * The acting install is MINTED PER TEST, from the real registry (DR-2).
 *
 * It used to be a module constant naming `install-buyer` and a capability the
 * buyer pack does not even hold — which passed, because the route bound
 * whatever the body claimed. Now the ids come from the install this node
 * actually wrote, so a fixture cannot describe a pack that is not there.
 */
let pack: InstalledBuyerPack;
let INSTALL: ActingInstall;
let CONTEXT: BuyerApprovalContext;

function buildContext(): BuyerApprovalContext {
  return {
    // THIS NODE. `prepare` now refuses a business DID that is not its own,
    // which is why the harness sets the node DID to match.
    actingBusinessDid: BUYER_DID,
    principal: {
      // The principal THIS NODE would record (NEW-3). The fixture used to name
      // `did:plc:sanchoowner` under a `procurement` domain — a principal the
      // node has never heard of, which passed because nothing checked.
      principalDid: BUYER_DID,
      authorityDomain: 'buyer.order_submission',
      policyRevision: null,
    },
    serviceUri: `at://${SUPPLIER}/com.dinakernel.service.profile/self`,
    displayedLabels: { l1: 'Oak dining chair' },
    productKeys: { l1: 'gtin:05012345678900' },
    linePrices: { l1: { currency: 'INR', minor_units: '500' } },
    charges: [],
    quoteRevision: 1,
    quoteExpiresAt: '2026-08-09T09:00:00.000Z',
    install: INSTALL,
  };
}

let buyerOrders: InMemoryBuyerOrderRepository;
let approvals: InMemoryOrderApprovalRepository;
let router: CoreRouter;
/** Every order the buyer sender was asked to put on the wire. */
let sent: PurchaseOrderProposal[];

function req(
  path: string,
  body: Record<string, unknown>,
  callerType: string | undefined,
): CoreRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

const owner = (path: string, body: Record<string, unknown>): CoreRequest =>
  req(path, body, 'owner');

/** Ask Core for a card, the way an owner's surface does. */
async function prepare(over: Record<string, unknown> = {}): Promise<string> {
  const resp = await router.handle(
    owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT, ...over }),
  );
  if (resp.status !== 200) {
    throw new Error(`prepare refused: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return (resp.body as { approval_id: string }).approval_id;
}

const submit = async (body: Record<string, unknown>) =>
  router.handle(owner('/v1/commerce/orders/submit', body));

/**
 * Edit a retained card AFTER it was written, from the harness.
 *
 * `put` is first-writer-wins on purpose, so there is no supported way to change
 * a retained row — and adding one to make this testable would add the very hole
 * the test checks for.
 */
function tamperWithRetainedApproval(approvalId: string): void {
  const inner = approvals as unknown as { held: Map<string, { context_json: string }> };
  const row = inner.held.get(approvalId);
  if (row === undefined) throw new Error('nothing retained to tamper with');
  row.context_json = JSON.stringify({
    ...CONTEXT,
    serviceUri: 'at://did:plc:someoneelse00000000/com.dinakernel.service.profile/self',
  });
}

beforeEach(() => {
  // The composition root's two jobs, which this harness stands in for: say who
  // this node is, and have the acting pack actually installed.
  setNodeDID(BUYER_DID);
  pack = installActiveBuyerPack(T0);
  INSTALL = {
    installId: pack.installId,
    capabilityId: pack.capabilityId,
    manifestCid: pack.manifestCid,
    installScopeHash: pack.installScopeHash,
    configRevision: pack.configRevision,
  };
  CONTEXT = buildContext();

  buyerOrders = new InMemoryBuyerOrderRepository();
  approvals = new InMemoryOrderApprovalRepository();
  installCommerceRuntime({
    receipts: new InMemoryCommerceReceiptRepository(),
    attributionBoundary: new InMemoryAttributionBoundaryRepository(),
    buyerOrders,
    // Empty quote stores mean "no quote held" — the documented §12.4 step-6
    // skip. Quote revalidation has its own suite.
    buyerQuotes: new InMemoryBuyerQuoteRepository(),
    buyerQuoteRequests: new InMemoryBuyerQuoteRequestRepository(),
    orderApprovals: approvals,
  } as unknown as CommerceRuntime);
  sent = [];
  const sender: BuyerOrderSender = async ({ order }) => {
    sent.push(order);
    return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
  };
  installBuyerOrderSender(sender);
  // §7.2/§7.3 (DR-1) — the composition root's job, which this harness stands in
  // for. Without it the routes fail closed, which is the intended posture and
  // is covered by its own case below.
  installBuyerAuthorityProvider(({ order, context, serviceRkey }) =>
    singleOwnerAuthority({ ownerDid: 'did:plc:testowner00000000', order, context, serviceRkey }),
  );
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  pack.dispose();
  jest.restoreAllMocks();
  installCommerceRuntime(null);
  installBuyerOrderSender(null);
  installBuyerAuthorityProvider(null);
});

describe('preparing a card', () => {
  it('mints the payload and hands back an id to send under', async () => {
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { approval_id: string; approved: { orderDigest: string } };
    expect(body.approval_id).toMatch(/^oap_[0-9a-f]{32}$/);
    // The payload travels so the surface can render exactly what is bound.
    expect(body.approved.orderDigest).toBe(ORDER.order_digest);
    expect(sent).toEqual([]);
  });

  it('refuses an order that does not describe itself', async () => {
    // Retaining a card over an unreadable order would be a pending decision
    // that can never be answered: the store cannot hydrate it back.
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: { ...ORDER, order_digest: 'f'.repeat(64) },
        context: CONTEXT,
      }),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('invalid_order');
  });

  it('refuses a context missing a §15.2 field, and names it', async () => {
    // A payload built with a label missing binds a CONSTANT and protects
    // nothing, so the builder refuses rather than filling in a blank.
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: ORDER,
        context: { ...CONTEXT, displayedLabels: {} },
      }),
    );
    expect(resp.status).toBe(400);
    const body = resp.body as { error: string; missing: string[] };
    expect(body.error).toBe('approval_incomplete');
    expect(body.missing).toContain('displayedLabels[l1]');
  });
});

describe('sending under a card', () => {
  it('sends the RETAINED order, not one the request supplied', async () => {
    const approvalId = await prepare();
    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.order_digest).toBe(ORDER.order_digest);
    expect(sent[0]?.idempotency_key).toBe(ORDER.idempotency_key);
  });

  it('IGNORES approval material in the request body', async () => {
    // THE C-03 REGRESSION, stated directly. The old route accepted all three
    // and checked them against each other. Supplying them now proves nothing
    // and sends nothing: without a card there is no approval.
    const built = buildBuyerApprovalPayload(ORDER, CONTEXT);
    if (!built.ok) throw new Error('fixture cannot build a payload');
    const resp = await submit({ order: ORDER, approved: built.payload, context: CONTEXT });

    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('approval_id is required');
    expect(sent).toEqual([]);
  });

  it('refuses a card this node never minted', async () => {
    const resp = await submit({ approval_id: 'oap_deadbeef' });
    expect(resp.status).toBe(404);
    expect((resp.body as { error: string }).error).toBe('unknown_approval');
    expect(sent).toEqual([]);
  });

  it('spends the card, so one approval cannot become two orders', async () => {
    const approvalId = await prepare();
    expect((await submit({ approval_id: approvalId })).status).toBe(200);

    const second = await submit({ approval_id: approvalId });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe('approval_already_used');
    expect(sent).toHaveLength(1);
  });

  it('leaves the card answerable when the send never happened', async () => {
    // A refusal must not burn a decision the owner would have to make again
    // from scratch. Here there is no sender at all.
    installBuyerOrderSender(null);
    const approvalId = await prepare();
    const refused = await submit({ approval_id: approvalId });
    expect(refused.status).toBe(503);

    const sender: BuyerOrderSender = async ({ order }) => {
      sent.push(order);
      return { kind: 'ambiguous', reason: 'sent' };
    };
    installBuyerOrderSender(sender);
    expect((await submit({ approval_id: approvalId })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('refuses a card older than its own lifetime', async () => {
    const approvalId = await prepare();
    const later = Date.now() + ORDER_APPROVAL_TTL_MS + 1;
    jest.spyOn(Date, 'now').mockReturnValue(later);

    const resp = await submit({ approval_id: approvalId });
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('approval_expired');
    expect(sent).toEqual([]);
  });

  it('refuses a card whose retained row no longer describes itself', async () => {
    // The binding failure still REACHABLE now that the caller cannot supply a
    // payload: a row edited after writing. The store rebuilds the payload from
    // the stored order and context on every read and compares it to the stored
    // digest, so a tampered row reads as ABSENT.
    const approvalId = await prepare();
    tamperWithRetainedApproval(approvalId);

    const resp = await submit({ approval_id: approvalId });
    expect(resp.status).toBe(404);
    expect((resp.body as { error: string }).error).toBe('unknown_approval');
    expect(sent).toEqual([]);
  });

  it('does not let a fresh card bypass the duplicate guard', async () => {
    // §12.7: a buyer never creates a second order for the same purchase. The
    // card authorises an act; it does not overrule the ledger.
    expect((await submit({ approval_id: await prepare() })).status).toBe(200);

    const again = await submit({ approval_id: await prepare() });
    expect(again.status).toBe(200);
    const body = again.body as { ok: boolean; refusal: string };
    expect(body.ok).toBe(false);
    expect(body.refusal).toBe('already_submitted');
    expect(sent).toHaveLength(1);
  });
});

describe('only the owner', () => {
  it.each([undefined, 'brain', 'agent', 'plugin', 'device', 'admin', 'service'])(
    'refuses caller type %s on both routes',
    async (callerType) => {
      const prepared = await router.handle(
        req('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }, callerType),
      );
      expect(prepared.status).toBe(403);

      const submitted = await router.handle(
        req('/v1/commerce/orders/submit', { approval_id: await prepare() }, callerType),
      );
      expect(submitted.status).toBe(403);
      expect(sent).toEqual([]);
    },
  );
});

/**
 * §7.2/§7.3 (DR-1) — the authority check is ON the money path, or it is not a
 * check.
 *
 * These cases exist because the previous shape passed every one of the suite's
 * other tests while evaluating nobody's authority at all. `submitApprovedOrder`
 * took `authority` optionally, neither route supplied it, and the evaluation
 * was skipped. So the assertions below are deliberately about the ROUTE
 * refusing, never about `evaluateStaffAuthority` returning the right verdict —
 * that function was always correct and always unreachable.
 */
describe('nobody commits this business without authority', () => {
  it('refuses to send when the node installed NO authority provider', async () => {
    const approvalId = await prepare();
    installBuyerAuthorityProvider(null);

    const resp = await submit({ approval_id: approvalId });

    // 503, not 403: the node cannot answer the question, which is different
    // from having answered it no. A misconfigured node must not buy.
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('authority_provider_unavailable');
    expect(sent).toEqual([]);
  });

  it('refuses when the provider holds no authority record for this order', async () => {
    // §7.3's DoD in one case: an owner with no grant record is not an owner.
    const approvalId = await prepare();
    installBuyerAuthorityProvider(() => null);

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('no_authority_record');
    expect(sent).toEqual([]);
  });

  it('refuses an order ABOVE the buyer’s spend ceiling', async () => {
    // The strongest evidence that evaluation runs: a grant that permits this
    // supplier, this category and this region, and refuses only on amount. If
    // the check were skipped the order would go out regardless.
    const approvalId = await prepare();
    installBuyerAuthorityProvider(({ order, context, serviceRkey }) => {
      const base = singleOwnerAuthority({
        ownerDid: 'did:plc:testowner00000000',
        order,
        context,
        serviceRkey,
      });
      return {
        ...base,
        grants: [
          {
            kind: 'buyer',
            principalDid: 'did:plc:testowner00000000',
            spendCeilingMinorUnits: '1',
            currency: order.approved_total.currency,
          },
        ],
      };
    });

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(409);
    expect((resp.body as { refusal: string }).refusal).toBe('not_authorized');
    expect(sent).toEqual([]);
  });

  it('sends when the SAME grant’s ceiling clears the total', async () => {
    // The other half of the ceiling case. Without it, a route that refused
    // everything would pass the test above.
    const approvalId = await prepare();
    installBuyerAuthorityProvider(({ order, context, serviceRkey }) => {
      const base = singleOwnerAuthority({
        ownerDid: 'did:plc:testowner00000000',
        order,
        context,
        serviceRkey,
      });
      return {
        ...base,
        grants: [
          {
            kind: 'buyer',
            principalDid: 'did:plc:testowner00000000',
            spendCeilingMinorUnits: '99999999',
            currency: order.approved_total.currency,
          },
        ],
      };
    });

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('leaves the card ANSWERABLE after an authority refusal', async () => {
    // A refusal is not a spent decision. The owner fixes the grant and taps
    // the same card again; being made to re-approve from scratch would push
    // them toward approving without reading.
    const approvalId = await prepare();
    installBuyerAuthorityProvider(() => null);
    expect((await submit({ approval_id: approvalId })).status).toBe(403);

    installBuyerAuthorityProvider(({ order, context, serviceRkey }) =>
      singleOwnerAuthority({ ownerDid: 'did:plc:testowner00000000', order, context, serviceRkey }),
    );
    const retried = await submit({ approval_id: approvalId });

    expect(retried.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

/**
 * §7.2 — branch authority, which was unsatisfiable rather than merely unwired.
 *
 * `covers` refuses a `location` grant outright when the request names no
 * region, and the executor built its `AuthorityRequest` with `regionValue:
 * null` hardcoded. So a business whose staff model is "this branch buys for
 * this state" could not buy at all — the grant existed, was tested in
 * isolation, and refused every real order.
 */
describe('branch authority reads the region off the ORDER', () => {
  const locationAuthority = (regionValues: string[]) => () =>
    installBuyerAuthorityProvider(({ order, context, serviceRkey }) => ({
      ...singleOwnerAuthority({
        ownerDid: 'did:plc:testowner00000000',
        order,
        context,
        serviceRkey,
      }),
      grants: [{ kind: 'location', principalDid: 'did:plc:testowner00000000', regionValues }],
    }));

  it('permits a branch whose region matches the delivery projection', async () => {
    const approvalId = await prepare();
    locationAuthority(['postal_area:682001'])();

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('refuses a branch authorized for somewhere else', async () => {
    const approvalId = await prepare();
    locationAuthority(['postal_area:110001'])();

    const resp = await submit({ approval_id: approvalId });

    expect((resp.body as { refusal: string }).refusal).toBe('not_authorized');
    expect(sent).toEqual([]);
  });

  it('does not match on the bare value without its scheme', async () => {
    // `scheme:value`, not `value`. A postal area and an admin area can carry
    // the same digits, and matching on digits alone would let a branch
    // authorized for one commit in the other.
    const approvalId = await prepare();
    locationAuthority(['682001'])();

    const resp = await submit({ approval_id: approvalId });

    expect((resp.body as { refusal: string }).refusal).toBe('not_authorized');
    expect(sent).toEqual([]);
  });
});

/**
 * §15.2 (DR-2) — the install facts are CORE'S, not the caller's.
 *
 * §15.2's last line asks the approval to bind "plugin install, capability,
 * manifest CID, scope hash, and config revision". This route took all five out
 * of the request body and retained them, so the binding it later checked was a
 * claim compared against itself. The same argument applies to the acting
 * business: the node knows which node it is.
 */
describe('the card binds what this node knows, not what the body claimed', () => {
  const prepareWith = async (context: unknown) =>
    router.handle(owner('/v1/commerce/orders/prepare', { order: ORDER, context }));

  it('refuses an acting business that is not this node', async () => {
    const resp = await prepareWith({ ...CONTEXT, actingBusinessDid: 'did:plc:someoneelse00' });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('acting_business_mismatch');
  });

  it('refuses an install this node does not have', async () => {
    const resp = await prepareWith({
      ...CONTEXT,
      install: { ...INSTALL, installId: 'install-that-never-existed' },
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('unknown_install');
  });

  it('refuses a capability the acting install does not hold', async () => {
    // `submit-order` belongs to the SUPPLIER pack. A buyer card naming it is
    // binding an authority the acting install was never granted.
    const resp = await prepareWith({
      ...CONTEXT,
      install: { ...INSTALL, capabilityId: 'com.dinakernel.commerce.submit-order' },
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('capability_not_held');
  });

  it('refuses a manifest CID that disagrees with the registry', async () => {
    // REFUSES rather than substituting the true value. The surface showed the
    // owner a manifest; if that is not what would run, the owner approved a
    // description of a different act.
    const resp = await prepareWith({
      ...CONTEXT,
      install: { ...INSTALL, manifestCid: 'bafyreisomethingelse' },
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('install_facts_disagree');
  });

  it('refuses a config revision that disagrees with the registry', async () => {
    // The revision is what makes "this config, at this moment" auditable. A
    // card bound to a revision the node never had proves nothing afterwards.
    const resp = await prepareWith({
      ...CONTEXT,
      install: { ...INSTALL, configRevision: '999' },
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('install_facts_disagree');
  });

  it('accepts a card that states no CID at all and fills it from the registry', async () => {
    // A surface that did not claim is not a surface that is wrong. The
    // retained card still binds the node's own values.
    const resp = await prepareWith({
      ...CONTEXT,
      install: { installId: INSTALL.installId, capabilityId: INSTALL.capabilityId },
    });

    expect(resp.status).toBe(200);
    const approvalId = (resp.body as { approval_id: string }).approval_id;
    const retained = approvals.get(approvalId);
    expect(retained?.context.install.manifestCid).toBe(INSTALL.manifestCid);
    expect(retained?.context.install.installScopeHash).toBe(INSTALL.installScopeHash);
    expect(retained?.context.install.configRevision).toBe(INSTALL.configRevision);
  });

  it('refuses once the acting install is no longer active', async () => {
    // A pack paused between the tap and the send must not be recorded as
    // having acted. Prepare is where that is caught, because the card is the
    // artifact an auditor reads afterwards.
    const repo = getPluginInstallRepository();
    repo?.pause(INSTALL.installId, Date.now(), 'manual');

    const resp = await prepareWith(CONTEXT);

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('install_not_active');
  });
});

describe('a node that does not know who it is', () => {
  it('refuses to prepare a card at all', async () => {
    // §15.2 binds the acting business, and a node before identity load cannot
    // name one. 503 rather than 403: the node is not saying no, it is saying
    // it cannot yet answer. `setNodeDID` refuses a non-DID by design, so the
    // pre-identity state is reachable here only by standing in for it.
    jest.spyOn(ceremony, 'getNodeDID').mockReturnValue(null);

    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );

    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('node_identity_unavailable');
  });
});

/**
 * §15.2 (DR-3) — the card and the authority check must mean the SAME listing.
 *
 * `service_rkey` used to arrive as its own body field, defaulting to `'self'`,
 * while the card bound `context.serviceUri`. Nothing compared them. On a
 * single-listing node they agreed by accident; §10's multi-listing model is
 * where that stops being true, and the rkey is what a listing-scoped grant is
 * evaluated against.
 */
describe('the listing is named once', () => {
  const prepareWith = async (over: Record<string, unknown>) =>
    router.handle(owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT, ...over }));

  it('takes the rkey OUT of the bound service URI', async () => {
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: ORDER,
        context: { ...CONTEXT, serviceUri: `at://${SUPPLIER}/com.dinakernel.service.profile/chairs` },
      }),
    );

    expect(resp.status).toBe(200);
    const approvalId = (resp.body as { approval_id: string }).approval_id;
    expect(approvals.get(approvalId)?.serviceRkey).toBe('chairs');
  });

  it('refuses a stated service_rkey that is not the one the URI names', async () => {
    const resp = await prepareWith({ service_rkey: 'somewhere-else' });

    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('service_rkey_disagrees');
  });

  it('accepts a stated rkey that agrees', async () => {
    const resp = await prepareWith({ service_rkey: 'self' });
    expect(resp.status).toBe(200);
  });

  it('refuses a service URI belonging to a different supplier', async () => {
    // A card showing a trusted supplier's listing over an order addressed
    // somewhere else is the whole reason this is checked.
    const resp = await prepareWith({
      context: {
        ...CONTEXT,
        serviceUri: 'at://did:plc:rivalwood77/com.dinakernel.service.profile/self',
      },
    });

    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('service_uri_supplier_mismatch');
  });

  it('refuses a service URI that is not an AT-URI at all', async () => {
    const resp = await prepareWith({
      context: { ...CONTEXT, serviceUri: 'https://chairmaker.example/listing' },
    });

    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('service_uri_malformed');
  });
});

/**
 * §15.2 (NEW-1) — the binding compares LIVE state, or it compares nothing.
 *
 * After DR-2 the check had become self-consistent again by a different route:
 * the store rebuilds the payload from its own `order` + `context` on every
 * read, and the executor rebuilds it again from those same two values, so two
 * derivations of one row could not disagree. The defect had MOVED — from "the
 * caller supplies both halves" to "one row supplies both halves" — while
 * `buyer_executor.ts` still promised that "a swapped install between the tap
 * and the send is refused rather than dispatched".
 *
 * A card lives thirty minutes. These cases are what happens inside that window.
 */
describe('what changed between the tap and the send', () => {
  const repo = () => getPluginInstallRepository();

  it('refuses when the acting install was PAUSED after the card was minted', async () => {
    const approvalId = await prepare();
    repo()?.pause(INSTALL.installId, Date.now(), 'manual');

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(409);
    expect((resp.body as { refusal: string }).refusal).toBe('install_changed_since_approval');
    expect((resp.body as { error: string }).error).toContain('install_not_active');
    expect(sent).toEqual([]);
  });

  it('refuses when the install CONFIG was changed after the card was minted', async () => {
    // §15.2 binds the config revision so an auditor can say which
    // configuration placed the order. A card bound to revision 1 must not send
    // under revision 2, however small the change.
    const approvalId = await prepare();
    repo()?.bumpConfigRevision(INSTALL.installId, Date.now());

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toContain('install_facts_disagree');
    expect(sent).toEqual([]);
  });

  it('still sends when nothing changed, so the re-check is not simply refusing', async () => {
    const resp = await submit({ approval_id: await prepare() });

    expect(resp.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('leaves the card answerable, so fixing the install and tapping again works', async () => {
    // A world that changed is not a spent decision. Forcing a re-approval here
    // would push an owner toward approving without reading.
    const approvalId = await prepare();
    repo()?.pause(INSTALL.installId, Date.now(), 'manual');
    expect((await submit({ approval_id: approvalId })).status).toBe(409);

    repo()?.resume(INSTALL.installId, Date.now());
    const retried = await submit({ approval_id: approvalId });

    expect(retried.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

/**
 * §15.2 / §7.2 (NEW-3) — WHO approved is this node's to say, like the install.
 *
 * DR-2 fixed the acting business and the install and left the principal, which
 * §7.2 names in the same breath. `chainGaps` only checks the domain is
 * non-empty, and nothing compared the retained principal to the one
 * `singleOwnerAuthority` substitutes into the chain — so the card could record
 * a human approving under a domain nobody holds while the authority evaluation
 * quietly used the owner. The supplier half of the same file already did this
 * correctly.
 */
describe('the approving principal is recorded by this node', () => {
  const prepareWith = async (principal: unknown) =>
    router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: { ...CONTEXT, principal } }),
    );

  it('records the node owner and a Core-side domain, whatever the body said', async () => {
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );

    expect(resp.status).toBe(200);
    const retained = approvals.get((resp.body as { approval_id: string }).approval_id);
    expect(retained?.context.principal.principalDid).toBe(BUYER_DID);
    expect(retained?.context.principal.authorityDomain).toBe('buyer.order_submission');
  });

  it('refuses a body naming a different principal', async () => {
    const resp = await prepareWith({
      principalDid: 'did:plc:notthisowner1',
      authorityDomain: 'buyer.order_submission',
      policyRevision: null,
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('principal_mismatch');
  });

  it('refuses a body naming an authority domain this node does not use', async () => {
    const resp = await prepareWith({
      principalDid: BUYER_DID,
      authorityDomain: 'whatever.i.like',
      policyRevision: null,
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('principal_mismatch');
  });

  it('refuses a body claiming POLICY approved what a person tapped', async () => {
    // §15.2b: the two are different accountability stories and must never
    // share a digest. A human tapped this card, so the policy slot stays empty.
    const resp = await prepareWith({
      principalDid: BUYER_DID,
      authorityDomain: 'buyer.order_submission',
      policyRevision: 'policy-7',
    });

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('principal_mismatch');
  });
});

/**
 * §7.1 (NEW-5) — the acting install must be the BUYER pack.
 *
 * Both selectors come out of a request body, and `resolveActingInstall`
 * checked only that the install exists, is active, and holds the named
 * capability — so an owner surface could bind the SUPPLIER pack as the
 * plugin that placed a purchase order, and both the §15.2 record and the §7.2
 * chain would name it. WS-7.1 calls role separation "a SAFETY rule and not a
 * UX preference": a compromise of the supplier runner must not carry buyer
 * authority with it. `roleIsInstalled(…, 'buyer')` already expressed the rule
 * and had no production caller — the same defect class as the rest of this
 * round, one layer along.
 */
describe('role separation between the two commerce packs', () => {
  it('refuses a card that names the SUPPLIER install as the pack acting', async () => {
    const supplier = installActiveSupplierPack(T0);

    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: ORDER,
        context: {
          ...CONTEXT,
          install: {
            installId: supplier.installId,
            capabilityId: 'com.dinakernel.commerce.submit-order',
          },
        },
      }),
    );

    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('wrong_pack_role');
  });

  it('names both packs in the refusal, so an operator can see the confusion', async () => {
    const supplier = installActiveSupplierPack(T0);

    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: ORDER,
        context: {
          ...CONTEXT,
          install: {
            installId: supplier.installId,
            capabilityId: 'com.dinakernel.commerce.submit-order',
          },
        },
      }),
    );

    const detail = (resp.body as { detail: string }).detail;
    expect(detail).toContain('com.dinakernel.commerce.supplier');
    expect(detail).toContain('com.dinakernel.commerce.buyer');
  });

  it('still accepts the buyer install, so the check is not refusing everything', async () => {
    installActiveSupplierPack(T0);
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );
    expect(resp.status).toBe(200);
  });
});

/**
 * NEW-17 — a node that cannot answer says so, rather than saying no.
 *
 * Moving the recheck into the executor collapsed a distinction the route
 * helper it replaced was carrying: 503 for an unreadable install registry, 409
 * for everything else. Every outcome became `install_changed_since_approval`
 * at 409, so a node with no registry told a client "the install changed,
 * retry" — inviting a retry loop against a node that will refuse identically
 * for ever. Every other not-configured condition on these routes answers 503,
 * and `prepare` never stopped doing so.
 */
describe('a node that cannot read its own install registry', () => {
  it('answers 503 on submit, not 409', async () => {
    const approvalId = await prepare();
    setPluginInstallRepository(null);

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(503);
    expect((resp.body as { refusal: string }).refusal).toBe('install_registry_unavailable');
    expect(sent).toEqual([]);
  });

  it('still answers 409 when the world actually changed', async () => {
    // The distinction only earns its place if the ordinary case keeps 409.
    const approvalId = await prepare();
    getPluginInstallRepository()?.pause(INSTALL.installId, Date.now(), 'manual');

    const resp = await submit({ approval_id: approvalId });

    expect(resp.status).toBe(409);
    expect((resp.body as { refusal: string }).refusal).toBe('install_changed_since_approval');
  });
});

// ---------------------------------------------------------------------------
// §5.4 stage 4 (photo-commerce design): the conditional presence gate and
// the source-bound approval.
// ---------------------------------------------------------------------------



describe('the conditional presence gate on prepare (§5.4 stage 4)', () => {
  afterEach(() => {
    installOwnerPresenceVerifier(null);
    clearOwnerPresence();
  });

  it('the NAMED software-path test: owner capability alone cannot mint a commercial approval', async () => {
    // A presence-capable node: the verifier exists, nobody has proven
    // anything. A program holding only the boot-minted owner capability —
    // which is exactly what this harness's `owner()` requests are — must
    // not obtain an approval.
    installOwnerPresenceVerifier(async (p) => p === 'correct horse');
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('no_user_presence');
  });

  it('a live proof opens the gate; a convenience-mode node is unchanged', async () => {
    installOwnerPresenceVerifier(async (p) => p === 'correct horse');
    await proveOwnerPresence('correct horse', Date.now());
    const withProof = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );
    expect(withProof.status).toBe(200);

    // Convenience mode: no verifier, no secret only the owner knows —
    // behaviour unchanged, so convenience-mode ordering survives.
    installOwnerPresenceVerifier(null);
    clearOwnerPresence();
    const convenience = await router.handle(
      owner('/v1/commerce/orders/prepare', { order: ORDER, context: CONTEXT }),
    );
    expect(convenience.status).toBe(200);
  });
});

describe('the SOURCE-BOUND approval (§5.4 stage 4)', () => {
  let orderDrafts: InMemoryOrderDraftRepository;

  function sourceDraft(overrides: Partial<OrderDraft> = {}): OrderDraft {
    return {
      draftId: 'odr-1',
      manifest: [{ artifact_id: 'img-1', content_hash: 'a'.repeat(64), page_index: 0 }],
      extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
      extractionDigest: 'a'.repeat(64),
      lines: [
        {
          lineId: 'line-1',
          text: '20 dining chairs',
          pageIndex: 0,
          fields: { quantity: '20' },
          provenance: { quantity: 'accepted' },
          resolution: {
            kind: 'resolved',
            product: { scheme: 'gtin', value: '05012345678900' },
            supplierDid: SUPPLIER,
            flaggedNewSupplier: false,
          },
          generation: 1,
          assignmentGeneration: 0,
          vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
          deferred: false,
          evidence: null,
          submittedIn: null,
        },
      ],
      requirements: [],
      conversations: [
        {
          conversationId: 'conv-1',
          supplierDid: SUPPLIER,
          state: 'quoted',
          lineIds: ['line-1'],
          snapshot: null,
          snapshotDigest: 'd'.repeat(64),
          requestDigest: 'c'.repeat(64),
          requestId: 'req-1',
          quoteDigest: 'e'.repeat(64),
          quoteId: null,
          quoteValidUntil: '2026-08-22T00:00:00.000Z',
          approvalId: null,
          purchaseOrderId: null,
          dispatchIntent: null,
          outcome: null,
        },
      ],
      ceremonyCounter: 1,
      abandoned: false,
      createdAtMs: T0,
      updatedAtMs: T0,
      ...overrides,
    };
  }

  function binding(overrides: Partial<ApprovalSourceBinding> = {}): ApprovalSourceBinding {
    return {
      origin: 'photo_order_draft',
      binding_version: 1,
      draft_id: 'odr-1',
      conversation_id: 'conv-1',
      assignment_generations: [{ line_id: 'line-1', generation: 0 }],
      requirement_generations: [],
      snapshot_digest: 'd'.repeat(64),
      ...overrides,
    };
  }

  beforeEach(() => {
    orderDrafts = new InMemoryOrderDraftRepository();
    orderDrafts.put(sourceDraft());
    installCommerceRuntime({
    receipts: new InMemoryCommerceReceiptRepository(),
    attributionBoundary: new InMemoryAttributionBoundaryRepository(),
      buyerOrders,
      buyerQuotes: new InMemoryBuyerQuoteRepository(),
      buyerQuoteRequests: new InMemoryBuyerQuoteRequestRepository(),
      orderApprovals: approvals,
      orderDrafts,
    } as unknown as CommerceRuntime);
  });

  async function prepareBound(source: ApprovalSourceBinding): Promise<string> {
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: ORDER,
        context: { ...CONTEXT, source },
      }),
    );
    if (resp.status !== 200) {
      throw new Error(`prepare refused: ${resp.status} ${JSON.stringify(resp.body)}`);
    }
    return (resp.body as { approval_id: string }).approval_id;
  }

  function bindApproval(conversationId: string, approvalId: string): void {
    const draft = orderDrafts.get('odr-1');
    if (draft === null) throw new Error('draft gone');
    const conversation = draft.conversations.find((c) => c.conversationId === conversationId);
    if (conversation !== undefined) conversation.approvalId = approvalId;
    orderDrafts.put(draft);
  }

  it('the binding travels INSIDE the integrity digest — stripped changes the digest', () => {
    const withSource = buildBuyerApprovalPayload(ORDER, { ...CONTEXT, source: binding() });
    const without = buildBuyerApprovalPayload(ORDER, CONTEXT);
    expect(withSource.ok && without.ok).toBe(true);
    if (!withSource.ok || !without.ok) return;
    expect(approvalDigest(withSource.payload)).not.toBe(approvalDigest(without.payload));
  });

  it('a CURRENT binding submits', async () => {
    const approvalId = await prepareBound(binding());
    bindApproval('conv-1', approvalId);
    const resp = await submit({ approval_id: approvalId });
    expect(resp.status).toBe(200);
    expect(sent.length).toBe(1);
  });

  it('a STALE assignment generation dies at submit — the enforcement, not the courtesy', async () => {
    const approvalId = await prepareBound(binding());
    bindApproval('conv-1', approvalId);
    // The line moved after the approval was minted — a competitor closed
    // it, a repair retired it; either way the generation is not the one
    // the approval was minted under.
    const draft = orderDrafts.get('odr-1');
    if (draft !== null) {
      draft.lines[0]!.assignmentGeneration = 1;
      orderDrafts.put(draft);
    }
    const resp = await submit({ approval_id: approvalId });
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('stale_source_binding');
    expect(sent.length).toBe(0);
  });

  it('the NAMED test: approvals on two competing conversations — submit one, the other refuses', async () => {
    // Both conversations carry line-1; both minted approvals before either
    // submitted — the reachable race the design records.
    const draft = orderDrafts.get('odr-1');
    if (draft !== null) {
      draft.conversations.push({
        ...draft.conversations[0]!,
        conversationId: 'conv-2',
        state: 'superseded', // terminal, so the one-live invariant holds
      });
      orderDrafts.put(draft);
    }
    const approvalA = await prepareBound(binding());
    const approvalB = await prepareBound(binding({ conversation_id: 'conv-2' }));
    bindApproval('conv-1', approvalA);
    bindApproval('conv-2', approvalB);

    const first = await submit({ approval_id: approvalA });
    expect(first.status).toBe(200);

    // Submitting A closes the competing assignment — the orchestrator's
    // duty, performed here as it will perform it: the shared line's
    // assignment retires.
    const after = orderDrafts.get('odr-1');
    if (after !== null) {
      after.lines[0]!.assignmentGeneration = 1;
      orderDrafts.put(after);
    }
    const second = await submit({ approval_id: approvalB });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe('stale_source_binding');
    expect(sent.length).toBe(1);
  });

  it('a binding to a VANISHED draft answers 404, never the unrestricted path', async () => {
    const approvalId = await prepareBound(binding());
    orderDrafts.delete('odr-1');
    const resp = await submit({ approval_id: approvalId });
    expect(resp.status).toBe(404);
    expect((resp.body as { error: string }).error).toBe('unknown_source_draft');
  });

  it('a PARTIAL binding is refused at the door — never stored', async () => {
    const partial = { origin: 'photo_order_draft', binding_version: 1, draft_id: 'odr-1' };
    const resp = await router.handle(
      owner('/v1/commerce/orders/prepare', {
        order: ORDER,
        context: { ...CONTEXT, source: partial },
      }),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('invalid_source_binding');
  });

  it('the DOWNGRADE never happens: a binding corrupted AFTER retention reads as no approval', async () => {
    // §2.1: a photo approval whose source fields were lost to corruption
    // must not hydrate as a legitimate legacy approval and take the
    // unrestricted path. The stored context is stripped of a source field
    // from the harness; hydration refuses the ROW whole.
    const approvalId = await prepareBound(binding());
    bindApproval('conv-1', approvalId);
    const inner = approvals as unknown as { held: Map<string, { context_json: string }> };
    const row = inner.held.get(approvalId);
    if (row !== undefined) {
      const context = JSON.parse(row.context_json) as { source: Record<string, unknown> };
      delete context.source.snapshot_digest;
      row.context_json = JSON.stringify(context);
    }
    const submitResp = await submit({ approval_id: approvalId });
    expect(submitResp.status).toBe(404);
    expect(sent.length).toBe(0);
  });
});
