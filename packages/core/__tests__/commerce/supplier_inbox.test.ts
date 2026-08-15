/**
 * WS-7.3 — the supplier inbox (§18.6).
 *
 * The inbox's job is to be the place a supplier looks when they wonder whether
 * anything needs them. So the tests are mostly about ORDER and about which
 * items appear at all: the item nobody built a screen for is the item nobody
 * sees, and the two candidates for that are exactly the ones that cost money.
 */

import {
  CATALOG_STALE_AFTER_MS,
  buildSupplierInbox,
  type InboxItemKind,
} from '../../src/commerce/supplier_inbox';

import type { SupplierSettings } from '../../src/commerce/commerce_settings';
import type { CommerceOrderRef } from '../../src/commerce/order_refs';

const NOW = Date.parse('2026-08-08T09:00:00.000Z');

function ref(overrides: Partial<CommerceOrderRef> = {}): CommerceOrderRef {
  return {
    buyerDid: 'did:plc:sancho',
    purchaseOrderId: 'po-1',
    idempotencyKey: 'idem-1',
    orderDigest: 'a'.repeat(64),
    quoteId: 'q-1',
    quoteDigest: 'b'.repeat(64),
    pinnedVersion: '1.0',
    servingManifestCid: '',
    servingInstallId: '',
    admittedEpoch: '1',
    reconciliationRequired: false,
    readoptedChainEvidence: false,
    state: 'reserved',
    effectPhase: 'pre_effect',
    acknowledgementJson: null,
    externalRef: null,
    decisionDeadlineAt: NOW + 60_000,
    createdAt: NOW - 1_000,
    decidedAt: null,
    ...overrides,
  };
}

function settings(overrides: Partial<SupplierSettings> = {}): SupplierSettings {
  return {
    actingBusinessDid: 'did:plc:chairmaker99',
    catalogSource: { kind: 'inline', lastHealthyAtIso: '2026-08-08T08:00:00.000Z' },
    publicRegions: [],
    publishIndicativePrice: true,
    quoteAccess: 'anyone',
    responsePolicy: {},
    customerPricingSource: null,
    orderAcceptance: 'review',
    listingState: 'live',
    connectors: [],
    ...overrides,
  };
}

function kinds(items: { kind: InboxItemKind }[]): InboxItemKind[] {
  return items.map((i) => i.kind);
}

describe('what appears', () => {
  it('is clear when nothing needs the operator', () => {
    const inbox = buildSupplierInbox({ undecided: [], settings: settings(), nowMs: NOW });
    // Reported rather than left to `items.length === 0`: "nothing needs you"
    // and "the inbox could not be built" reach a screen as the same empty list,
    // and only one has earned the reassurance.
    expect(inbox).toEqual({ items: [], clear: true });
  });

  it('offers accept and reject, which the decide route now serves', () => {
    // THIS ASSERTION IS INVERTED FROM WHAT IT USED TO SAY, and the old one was
    // a test that encoded the implementation rather than the requirement. It
    // read `toEqual(['accept','reject','counter'])` and passed for as long as
    // those three strings sat in the projection — while NO route implemented
    // any of them. `/v1/commerce/orders/command` is buyer-side, and
    // `settleInboundOrderDecision`'s `approval` parameter has no production
    // caller at all.
    //
    // FR-P10's rule is that a command is authorized by the same projection
    // that offered it. A projection offering commands that do not exist breaks
    // it from the other end: the owner taps and nothing happens, on the one
    // screen whose entire purpose is telling them a customer is waiting.
    //
    // §18.6's requirement is NOT waived and is not weakened by this test — a
    // supplier who can only accept or reject will reject an order they would
    // gladly have fulfilled on other terms, and that is right. It is
    // OUTSTANDING, and it belongs to the §15.2b lane. The test that proves it
    // is an end-to-end one — card offered, owner counters, buyer receives a
    // counterproposal — not an equality check against three string literals,
    // which is what let the gap hide in the first place.
    const inbox = buildSupplierInbox({ undecided: [ref()], settings: null, nowMs: NOW });
    expect(inbox.items[0]?.actions).toEqual(['accept', 'reject']);
    // `counter` stays absent: §18.6 remains OUTSTANDING because a
    // counterproposal needs replacement terms this card cannot collect.
    expect(inbox.items[0]?.actions).not.toContain('counter');
    expect(inbox.items[0]?.kind).toBe('order_awaiting_decision');
    expect(inbox.clear).toBe(false);
  });

  it('treats a started effect as unresolved, not as waiting', () => {
    // §9.9's `effect_started` means the external boundary was crossed. This is
    // not "waiting for a decision" any more — it is money that may already
    // have moved, and deciding here could double the work.
    const inbox = buildSupplierInbox({
      undecided: [ref({ effectPhase: 'effect_started' })],
      settings: null,
      nowMs: NOW,
    });
    expect(kinds(inbox.items)).toEqual(['external_outcome_unresolved']);
    // NO ACTIONS, and this one used to claim `['reconcile']`. The only
    // reconcile command is buyer-side (`POST /v1/commerce/orders/command`
    // loads `runtime.buyerOrders`), so the supplier tapped it and nothing
    // happened — on the item that matters most, because an `effect_started`
    // order is excluded from the decision sweeper by design and therefore
    // never lapses on its own.
    //
    // The gap is recorded rather than papered over: the operator is still told
    // what happened and can probe the external evidence via
    // `GET /v1/commerce/idempotency`; the command that RECORDS the resolution
    // belongs with the §15.2b supplier decision lane.
    expect(inbox.items[0]?.actions).toEqual([]);
    expect(inbox.items[0]?.headline).toMatch(/may have gone through/);
  });

  it('names a failing connector without quoting anything it holds', () => {
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp', healthy: false, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
      nowMs: NOW,
    });
    expect(kinds(inbox.items)).toEqual(['connector_failing']);
    expect(inbox.items[0]?.subject).toBe('erp');
    expect(inbox.items[0]?.headline).toContain('not responding');
  });

  it('distinguishes an expired credential from an unreachable connector', () => {
    // Different fixes. Telling an operator "erp is failing" when the answer is
    // "renew the credential" sends them to the wrong place.
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp', healthy: true, credentialValid: false, lastCheckedAtIso: null },
        ],
      }),
      nowMs: NOW,
    });
    expect(inbox.items[0]?.headline).toContain('credential');
  });

  it('says nothing about a healthy connector', () => {
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [{ name: 'erp', healthy: true, credentialValid: true, lastCheckedAtIso: null }],
      }),
      nowMs: NOW,
    });
    expect(inbox.clear).toBe(true);
  });

  it('warns when the catalog has not been confirmed recently (§10.4)', () => {
    // The supplier's side of "do not present a snapshot as live price": buyers
    // may be seeing numbers nobody has stood behind lately.
    const stale = new Date(NOW - CATALOG_STALE_AFTER_MS - 1).toISOString();
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({ catalogSource: { kind: 'inline', lastHealthyAtIso: stale } }),
      nowMs: NOW,
    });
    expect(kinds(inbox.items)).toEqual(['catalog_stale']);
  });

  it('treats a never-confirmed catalog as stale', () => {
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({ catalogSource: { kind: 'feed', lastHealthyAtIso: null } }),
      nowMs: NOW,
    });
    expect(inbox.items[0]?.headline).toContain('never been confirmed');
  });

  it('mentions a closed listing without nagging about it', () => {
    // A closed listing is usually a decision. Ranking it above a failing
    // connector would make the inbox something people stop reading.
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        listingState: 'paused',
        connectors: [
          { name: 'erp', healthy: false, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
      nowMs: NOW,
    });
    expect(kinds(inbox.items)).toEqual(['connector_failing', 'listing_not_live']);
  });

  it('shows the orders even when there are no settings to read', () => {
    // An operator with a broken or absent settings row still needs to see what
    // is waiting on them.
    const inbox = buildSupplierInbox({ undecided: [ref()], settings: null, nowMs: NOW });
    expect(kinds(inbox.items)).toEqual(['order_awaiting_decision']);
  });
});

describe('what comes first', () => {
  it('puts an order past its deadline above everything else', () => {
    // Ordered by what it costs to ignore, not by recency. A stale catalog is a
    // slow leak; an order about to time out is a customer who ordered and heard
    // nothing — and sorting by arrival would bury the second on a busy day.
    const inbox = buildSupplierInbox({
      undecided: [
        ref({ purchaseOrderId: 'po-waiting' }),
        ref({ purchaseOrderId: 'po-late', decisionDeadlineAt: NOW - 1 }),
        ref({ purchaseOrderId: 'po-unresolved', effectPhase: 'effect_started' }),
      ],
      settings: settings({
        listingState: 'paused',
        catalogSource: { kind: 'inline', lastHealthyAtIso: null },
        connectors: [
          { name: 'erp', healthy: false, credentialValid: false, lastCheckedAtIso: null },
        ],
      }),
      nowMs: NOW,
    });
    expect(kinds(inbox.items)).toEqual([
      'order_awaiting_decision', // po-late, past its deadline
      'external_outcome_unresolved',
      'order_awaiting_decision', // po-waiting, time left
      'connector_failing',
      'listing_not_live',
      'catalog_stale',
    ]);
    expect(inbox.items[0]?.subject).toBe('po-late');
  });

  it('breaks ties deterministically, so two reads never disagree', () => {
    const inbox = buildSupplierInbox({
      undecided: [ref({ purchaseOrderId: 'po-b' }), ref({ purchaseOrderId: 'po-a' })],
      settings: null,
      nowMs: NOW,
    });
    expect(inbox.items.map((i) => i.subject)).toEqual(['po-a', 'po-b']);
  });
});

describe('the broker outranks the declaration (§18.3, WS-9.3)', () => {
  it('a failed brokered call marks a connector broken even when settings say it works', () => {
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp.primary', healthy: true, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
      credentials: [
        {
          resource: 'erp.primary',
          installId: 'install-1',
          operations: ['read_catalog'],
          rotatedAtMs: 1_000,
          lastResult: 'failed',
          lastCheckedAtMs: 2_000,
        },
      ],
      nowMs: NOW,
    });
    const failing = inbox.items.filter((item) => item.kind === 'connector_failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]?.subject).toBe('erp.primary');
    // "Needs its credential renewed", not "is not responding": the broker
    // reached it and was refused.
    expect(failing[0]?.headline).toContain('credential');
  });

  it('does not mark a declared-broken connector working', () => {
    // The override runs ONE WAY. A settings row saying the credential is
    // invalid is the owner (or a health check) reporting a fault, and a
    // successful brokered call against some other operation is not evidence
    // against it.
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp.primary', healthy: true, credentialValid: false, lastCheckedAtIso: null },
        ],
      }),
      credentials: [
        {
          resource: 'erp.primary',
          installId: 'install-1',
          operations: ['read_catalog'],
          rotatedAtMs: 1_000,
          lastResult: 'ok',
          lastCheckedAtMs: 2_000,
        },
      ],
      nowMs: NOW,
    });
    expect(inbox.items.filter((item) => item.kind === 'connector_failing')).toHaveLength(1);
  });

  it('surfaces a failing credential that no connector row declares', () => {
    // The connector nobody remembered to list is exactly the one that would
    // otherwise fail in silence.
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({ connectors: [] }),
      credentials: [
        {
          resource: 'erp.forgotten',
          installId: 'install-1',
          operations: ['read_catalog'],
          rotatedAtMs: 1_000,
          lastResult: 'failed',
          lastCheckedAtMs: 2_000,
        },
      ],
      nowMs: NOW,
    });
    const failing = inbox.items.filter((item) => item.kind === 'connector_failing');
    expect(failing.map((item) => item.subject)).toEqual(['erp.forgotten']);
  });

  it('reports one row per connector, not one per source of truth', () => {
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp.primary', healthy: false, credentialValid: false, lastCheckedAtIso: null },
        ],
      }),
      credentials: [
        {
          resource: 'erp.primary',
          installId: 'install-1',
          operations: ['read_catalog'],
          rotatedAtMs: 1_000,
          lastResult: 'failed',
          lastCheckedAtMs: 2_000,
        },
      ],
      nowMs: NOW,
    });
    expect(inbox.items.filter((item) => item.kind === 'connector_failing')).toHaveLength(1);
  });

  it('says nothing about a credential that has never been used', () => {
    const inbox = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp.primary', healthy: true, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
      credentials: [
        {
          resource: 'erp.primary',
          installId: 'install-1',
          operations: ['read_catalog'],
          rotatedAtMs: 1_000,
          lastResult: 'never_used',
          lastCheckedAtMs: null,
        },
      ],
      nowMs: NOW,
    });
    expect(inbox.items.filter((item) => item.kind === 'connector_failing')).toEqual([]);
  });

  it('behaves exactly as before when no credentials are supplied', () => {
    const withArg = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp.primary', healthy: false, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
      credentials: [],
      nowMs: NOW,
    });
    const without = buildSupplierInbox({
      undecided: [],
      settings: settings({
        connectors: [
          { name: 'erp.primary', healthy: false, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
      nowMs: NOW,
    });
    expect(without).toEqual(withArg);
    expect(without.items.filter((item) => item.kind === 'connector_failing')).toHaveLength(1);
  });
});
