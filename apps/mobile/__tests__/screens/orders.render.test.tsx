/**
 * My Orders — the placed orders (iPhone buyer run 2026-09-29: an order sent
 * from Award → Send could never be seen on the phone again). The screen
 * judges nothing: Core lists the orders, names the headline and summarises
 * the evidence. These pin that each placed order shows its supplier, total,
 * Core's headline and one chip per reported fact; that a live https payment
 * link is offered as "Open payment link" and nothing else is; that the
 * empty state no longer says "No orders yet" once an order was placed; that
 * a node without commerce still shows its drafts; and that the list is read
 * again when the screen regains focus.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { OwnerCommerceHttpError } from '@dina/core';

import OrdersScreen from '../../app/orders';

import type { OrderDraftSummary, PlacedOrderDto } from '@dina/core';

/** Every focus effect the screen and its sections registered; a refocus runs them all. */
const mockFocusEffects = new Set<() => void>();
let mockFocus: (() => void) | null = null;
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    useFocusEffect: (effect: () => void) => {
      mockFocusEffects.add(effect);
      mockFocus = () => mockFocusEffects.forEach((e) => e());
      ReactLib.useEffect(effect, [effect]);
    },
    Stack: { Screen: () => null },
  };
});
/** Listing names by `did|rkey` — no AppView in tests. */
const mockListed = new Map<string, string>();
jest.mock('../../src/services/supplier_names', () => ({
  ...jest.requireActual<object>('../../src/services/supplier_names'),
  supplierNamesHere: async (refs: { supplierDid: string; serviceRkey?: string }[]) =>
    new Map(
      refs.map((r) => [
        r.supplierDid,
        mockListed.get(`${r.supplierDid}|${r.serviceRkey ?? 'self'}`) ?? null,
      ]),
    ),
}));
const mockCommerce = {
  orderDrafts: jest.fn(),
  placedOrders: jest.fn(),
  tenderStory: jest.fn(),
};
/** The supplier's catalogue item and PeerLens trust — no PDS or AppView in tests. */
const mockPublished = jest.fn();
jest.mock('../../src/services/offered_catalog', () => ({
  publishedItemFor: (...args: unknown[]) => mockPublished(...args),
  supplierTrustFor: async () => ({ score: 0.8, reviewCount: 3 }),
}));
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockCommerce,
}));
/** Shop (UCP) orders; none unless a test sets them. */
const mockUcp = { orders: jest.fn(), markOrderDone: jest.fn(), startLink: jest.fn() };
jest.mock('../../src/services/owner_ucp_client', () => ({
  getOwnerUcpClient: () => mockUcp,
}));
jest.mock('../../src/services/commerce_install', () => ({
  buyerInstallStatus: async () => ({ state: 'active' }),
  buyerInstallConsentSummary: () => ({ name: 'Commerce — Buyer', capabilities: [] }),
  activateBuyerInstall: async () => ({ ok: true }),
}));
jest.mock('../../src/services/photo_pipeline', () => ({ normalizePickedPages: jest.fn() }));
jest.mock('../../src/services/show_message', () => ({ showMessage: jest.fn() }));
jest.mock('../../src/services/confirm_decision', () => ({ confirmDecision: jest.fn() }));

const SUPPLIER = 'did:plc:valuecrumbbakery000';
const INR = (minor: string): { currency: string; minor_units: string } => ({
  currency: 'INR',
  minor_units: minor,
});

function placed(over: Partial<PlacedOrderDto> = {}): PlacedOrderDto {
  return {
    purchaseOrderId: 'po-1',
    supplierDid: SUPPLIER,
    serviceRkey: 'shop',
    supplierName: null,
    total: INR('48000'),
    submittedAt: '2026-09-29T08:00:00.000Z',
    state: 'submitted_unconfirmed',
    headline: 'Sent. Waiting for the supplier to confirm.',
    detail: null,
    actions: ['wait', 'reconcile_now'],
    nextPollAtMs: null,
    pollCount: 0,
    progress: { checkoutLink: null, payment: null, paymentRecorded: false, fulfilment: null },
    quoteId: '',
    lines: [],
    tenderId: null,
    ...over,
  };
}

const DRAFT: OrderDraftSummary = {
  draft_id: 'odr-1',
  state: 'open',
  lines: 3,
  conversations: 0,
  created_at_ms: 1,
  updated_at_ms: 1,
};

let openURL: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockFocus = null;
  mockFocusEffects.clear();
  mockUcp.orders.mockResolvedValue([]);
  mockUcp.markOrderDone.mockResolvedValue(null);
  mockCommerce.orderDrafts.mockResolvedValue({ drafts: [] });
  mockCommerce.placedOrders.mockResolvedValue({ orders: [], evidence: 'available' });
  mockCommerce.tenderStory.mockRejectedValue(new Error('no tender in this test'));
  mockPublished.mockResolvedValue(null);
  mockPush.mockReset();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  mockListed.clear();
});

afterEach(() => {
  openURL.mockRestore();
});

describe('placed orders on My Orders', () => {
  it('an order from a tender reads like its catalogue, says what happens next, folds its bargaining and links back', async () => {
    // Reported: after Send the order was one line of text, with no item, no
    // next step and no way back to the offers.
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [
        placed({
          state: 'accepted',
          headline: 'Accepted by the supplier.',
          quoteId: 'q-1',
          tenderId: 'tnd-7',
          lines: [
            {
              lineId: 'l1',
              product: { scheme: 'manufacturer_sku', value: 'VALUE-FLORAL20' },
              quantity: { value: '1', unit_code: 'each' },
              name: 'Floral Celebration Cake — 20 servings',
            },
          ],
        }),
      ],
      evidence: 'available',
    });
    mockPublished.mockResolvedValue({
      name: 'Floral Celebration Cake — 20 servings',
      images: ['https://images.example.test/floral.jpg'],
    });
    mockCommerce.tenderStory.mockResolvedValue({
      tender_id: 'tnd-7',
      suppliers: [
        {
          supplier_did: SUPPLIER,
          service_rkey: 'shop',
          quote_id: 'q-1',
          revisions: [
            { revision: '1', total: INR('17500'), issued_at: '' },
            { revision: '2', total: INR('17000'), issued_at: '' },
          ],
          counters: [
            { round: 1, target_total: INR('15000'), state: 'revised', sent_at: 1, answered_at: 2 },
          ],
          lines: [],
        },
      ],
    });
    const view = render(<OrdersScreen />);
    await waitFor(() => expect(view.getByTestId('placed-order-item-po-1-photo')).toBeTruthy());
    expect(mockPublished).toHaveBeenCalledWith(SUPPLIER, {
      scheme: 'manufacturer_sku',
      value: 'VALUE-FLORAL20',
    });
    expect(view.getByTestId('placed-order-item-po-1-name').props.children).toBe(
      'Floral Celebration Cake — 20 servings',
    );
    expect(view.getByTestId('placed-order-item-po-1-trust').props.children).toBe(
      'Well trusted · 3 reviews',
    );
    expect(view.getByTestId('placed-order-progress-po-1-next').props.children).toMatch(
      /^Next: .+ sends a payment link\.$/,
    );
    await waitFor(() =>
      expect(view.getByTestId('placed-order-bargaining-po-1-summary').props.children).toBe(
        'Bargaining · 1 round · INR 175.00 → INR 170.00 · saved INR 5.00',
      ),
    );
    expect(mockCommerce.tenderStory).toHaveBeenCalledWith('tnd-7');
    fireEvent.press(view.getByTestId('placed-order-tender-po-1'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/tender', params: { tender_id: 'tnd-7' } });
  });

  it('reads again every 10 s while an order is still moving, so a payment link shows as it lands', async () => {
    // Reported: Create checkout in Jiffy, and the open My Orders screen still
    // said "sends a payment link" until it was left and reopened.
    jest.useFakeTimers();
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [placed({ state: 'accepted', headline: 'Accepted by the supplier.' })],
      evidence: 'available',
    });
    const view = render(<OrdersScreen />);
    await waitFor(() => expect(mockCommerce.placedOrders).toHaveBeenCalledTimes(1));
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [
        placed({
          state: 'accepted',
          headline: 'Accepted by the supplier.',
          progress: {
            checkoutLink: { url: 'https://pay.example.test/c/1', expired: false },
            payment: null,
            paymentRecorded: false,
            fulfilment: null,
          } as never,
        }),
      ],
      evidence: 'available',
    });
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await waitFor(() =>
      expect(view.getByTestId('placed-order-progress-po-1-next').props.children).toBe(
        'Next: pay with the payment link.',
      ),
    );
    jest.useRealTimers();
  });

  it('a list with nothing still moving is not read again on a timer', async () => {
    jest.useFakeTimers();
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [placed({ state: 'rejected', headline: 'The supplier rejected the order.' })],
      evidence: 'available',
    });
    render(<OrdersScreen />);
    await waitFor(() => expect(mockCommerce.placedOrders).toHaveBeenCalledTimes(1));
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(mockCommerce.placedOrders).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('an order from no tender offers no tender link and no bargaining', async () => {
    mockCommerce.placedOrders.mockResolvedValue({ orders: [placed()], evidence: 'available' });
    const view = render(<OrdersScreen />);
    await waitFor(() => expect(view.getByTestId('placed-order-po-1')).toBeTruthy());
    expect(view.queryByTestId('placed-order-tender-po-1')).toBeNull();
    expect(view.queryByTestId('placed-order-bargaining-po-1-toggle')).toBeNull();
    expect(view.queryByTestId('placed-order-item-po-1')).toBeNull();
    expect(view.getByTestId('placed-order-progress-po-1-next').props.children).toMatch(
      /^Waiting for .+ to confirm the order\.$/,
    );
  });

  it('nothing placed and no drafts reads as the empty state', async () => {
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('orders-empty')).toBeTruthy());
    expect(screen.queryByTestId('orders-placed-title')).toBeNull();
  });

  it('a sent order is listed with its supplier, total and Core’s headline — and "No orders yet" is gone', async () => {
    mockCommerce.placedOrders.mockResolvedValue({ orders: [placed()], evidence: 'available' });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('placed-order-po-1')).toBeTruthy());
    expect(screen.getByTestId('orders-placed-title')).toBeTruthy();
    expect(screen.getByTestId('placed-order-supplier-po-1').props.children).toBe(
      'did:plc:valu…y000',
    );
    expect(screen.getByTestId('placed-order-total-po-1').props.children).toBe('INR 480.00');
    expect(screen.getByTestId('placed-order-headline-po-1').props.children).toBe(
      'Sent. Waiting for the supplier to confirm.',
    );
    expect(screen.getByTestId('placed-order-chip-po-1-Sent')).toBeTruthy();
    expect(screen.queryByTestId('orders-empty')).toBeNull();
    expect(screen.queryByTestId('placed-order-pay-po-1')).toBeNull();
  });

  it('names the supplier from its listing, the same way the Tender screen does', async () => {
    mockListed.set(`${SUPPLIER}|shop`, 'ValueCrumb Bakery');
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [placed({ supplierDid: SUPPLIER, serviceRkey: 'shop' })],
      evidence: 'available',
    });
    const screen = render(<OrdersScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('placed-order-supplier-po-1').props.children).toBe(
        'ValueCrumb Bakery',
      ),
    );
  });

  it('prefers the owner contact name from Core over the listing', async () => {
    mockListed.set(`${SUPPLIER}|shop`, 'ValueCrumb Bakery');
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [placed({ supplierName: 'Val (my baker)' })],
      evidence: 'available',
    });
    const screen = render(<OrdersScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('placed-order-supplier-po-1').props.children).toBe(
        'Val (my baker)',
      ),
    );
  });

  it('an accepted order with a live https link offers "Open payment link", which opens exactly that URL', async () => {
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [
        placed({
          supplierName: 'ValueCrumb Bakery',
          state: 'accepted',
          headline: 'Accepted by the supplier.',
          progress: {
            checkoutLink: {
              url: 'https://pay.example.com/cs_1',
              amount: INR('48000'),
              provider: 'clover',
              expiresAt: '2036-01-01T00:00:00.000Z',
              expired: false,
            },
            payment: null,
            paymentRecorded: false,
            fulfilment: null,
          },
        }),
      ],
      evidence: 'available',
    });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('placed-order-pay-po-1')).toBeTruthy());
    expect(screen.getByTestId('placed-order-supplier-po-1').props.children).toBe(
      'ValueCrumb Bakery',
    );
    expect(screen.getByTestId('placed-order-chip-po-1-Accepted')).toBeTruthy();
    expect(screen.getByTestId('placed-order-chip-po-1-Payment link received')).toBeTruthy();
    fireEvent.press(screen.getByTestId('placed-order-pay-po-1'));
    expect(openURL).toHaveBeenCalledWith('https://pay.example.com/cs_1');
  });

  it('paid and on the way: one chip per fact, and no payment link once paid', async () => {
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [
        placed({
          state: 'accepted',
          headline: 'Accepted by the supplier.',
          progress: {
            checkoutLink: {
              url: 'https://pay.example.com/cs_1',
              amount: INR('48000'),
              provider: 'clover',
              expiresAt: null,
              expired: false,
            },
            payment: { state: 'captured', amount: INR('48000'), provider: 'clover' },
            paymentRecorded: true,
            fulfilment: {
              state: 'handed_to_carrier',
              provider: 'clover',
              reportedAt: '2026-09-29T09:00:00.000Z',
            },
          },
        }),
      ],
      evidence: 'available',
    });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('placed-order-po-1')).toBeTruthy());
    for (const chip of ['Accepted', 'Payment captured', 'Recorded as paid', 'On the way']) {
      expect(screen.getByTestId(`placed-order-chip-po-1-${chip}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('placed-order-chip-po-1-Payment link received')).toBeNull();
    expect(screen.queryByTestId('placed-order-pay-po-1')).toBeNull();
  });

  it('an expired link, or one that is not https, is never offered', async () => {
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [
        placed({
          purchaseOrderId: 'po-expired',
          state: 'accepted',
          progress: {
            checkoutLink: {
              url: 'https://pay.example.com/old',
              amount: INR('48000'),
              provider: 'clover',
              expiresAt: '2026-09-01T00:00:00.000Z',
              expired: true,
            },
            payment: null,
            paymentRecorded: false,
            fulfilment: { state: 'production_started', provider: 'clover', reportedAt: 'x' },
          },
        }),
        placed({
          purchaseOrderId: 'po-http',
          state: 'accepted',
          progress: {
            checkoutLink: {
              url: 'http://pay.example.com/plain',
              amount: INR('48000'),
              provider: 'clover',
              expiresAt: null,
              expired: false,
            },
            payment: null,
            paymentRecorded: false,
            fulfilment: null,
          },
        }),
      ],
      evidence: 'available',
    });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('placed-order-po-http')).toBeTruthy());
    expect(screen.getByTestId('placed-order-chip-po-expired-Payment link expired')).toBeTruthy();
    expect(screen.getByTestId('placed-order-chip-po-expired-In production')).toBeTruthy();
    expect(screen.queryByTestId('placed-order-pay-po-expired')).toBeNull();
    expect(screen.queryByTestId('placed-order-pay-po-http')).toBeNull();
  });

  it('placed orders and drafts show together, each under its own heading', async () => {
    mockCommerce.placedOrders.mockResolvedValue({ orders: [placed()], evidence: 'available' });
    mockCommerce.orderDrafts.mockResolvedValue({ drafts: [DRAFT] });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('order-draft-odr-1')).toBeTruthy());
    expect(screen.getByTestId('placed-order-po-1')).toBeTruthy();
    expect(screen.getByTestId('orders-drafts-title')).toBeTruthy();
    expect(screen.queryByTestId('orders-empty')).toBeNull();
  });

  it('a node without commerce still shows its drafts, with no error', async () => {
    mockCommerce.placedOrders.mockRejectedValue(
      new OwnerCommerceHttpError('unavailable', 503, 'commerce_unavailable'),
    );
    mockCommerce.orderDrafts.mockResolvedValue({ drafts: [DRAFT] });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('order-draft-odr-1')).toBeTruthy());
    expect(screen.queryByTestId('orders-placed-error')).toBeNull();
    expect(screen.queryByTestId('orders-error')).toBeNull();
  });

  it('a placed-orders failure is said in words and does not hide the drafts', async () => {
    mockCommerce.placedOrders.mockRejectedValue(
      new OwnerCommerceHttpError('boom', 500, 'internal_error'),
    );
    mockCommerce.orderDrafts.mockResolvedValue({ drafts: [DRAFT] });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('orders-placed-error')).toBeTruthy());
    expect(screen.getByTestId('order-draft-odr-1')).toBeTruthy();
    expect(String(screen.getByTestId('orders-placed-error').props.children)).not.toMatch(
      /OwnerCommerceClient/,
    );
  });

  it('reads the list again when the screen regains focus', async () => {
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(mockCommerce.placedOrders).toHaveBeenCalledTimes(1));
    mockCommerce.placedOrders.mockResolvedValue({
      orders: [placed({ state: 'accepted', headline: 'Accepted by the supplier.' })],
      evidence: 'available',
    });
    await act(async () => {
      mockFocus?.();
    });
    await waitFor(() =>
      expect(screen.getByTestId('placed-order-headline-po-1').props.children).toBe(
        'Accepted by the supplier.',
      ),
    );
    expect(mockCommerce.placedOrders).toHaveBeenCalledTimes(2);
  });
});

describe('shop orders on My Orders (UCP plan §3.14)', () => {
  const shopOrder = (over: Record<string, unknown> = {}) => ({
    merchant_origin: 'https://tea.example',
    merchant_host: 'tea.example',
    order_id: 'ord_1',
    state: 'open',
    close_reason: null,
    shared: true,
    headline: 'Shipped',
    summary: {
      currency: 'EUR',
      total: '1800',
      lines: [
        { title: 'Sencha 100 g', quantity: '2', status: 'processing' },
        { title: 'Earl Grey', quantity: '1', status: 'processing' },
      ],
      latest_event: { type: 'shipped', occurred_at: 1 },
      adjustments: [],
      settled: false,
    },
    notes: ['A refund: completed'],
    permalink_url: 'https://tea.example/orders/ord_1',
    link_scopes: null,
    created_at: 1,
    last_change_at: 1,
    closed_at: null,
    ...over,
  });

  it('an order the shop shares only with a linked account offers the link, asking for the scopes its challenge named', async () => {
    mockUcp.orders.mockResolvedValue([
      shopOrder({
        headline: 'Link your account at tea.example to follow this order',
        link_scopes: ['dev.ucp.shopping.order:read'],
      }),
    ]);
    mockUcp.startLink.mockResolvedValueOnce({
      started: true,
      opens: 'here',
      url: 'https://tea.example/auth/authorize?state=s',
      scopes: ['dev.ucp.shopping.order:read'],
      expires_at: 9,
    });
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('shop-orders-ord_1-link')).toBeTruthy());
    await act(async () => fireEvent.press(screen.getByTestId('shop-orders-ord_1-link')));
    expect(mockUcp.startLink).toHaveBeenCalledWith('https://tea.example', [
      'dev.ucp.shopping.order:read',
    ]);
    expect(openURL).toHaveBeenCalledWith('https://tea.example/auth/authorize?state=s');
    mockUcp.startLink.mockResolvedValueOnce({ started: false, reason: 'not_offered' });
    await act(async () => fireEvent.press(screen.getByTestId('shop-orders-ord_1-link')));
    expect(screen.getByTestId('shop-orders-error')).toHaveTextContent(
      'tea.example does not offer account linking.',
    );
  });

  it('an order not waiting for a link offers none', async () => {
    mockUcp.orders.mockResolvedValue([shopOrder()]);
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('shop-orders-ord_1')).toBeTruthy());
    expect(screen.queryByTestId('shop-orders-ord_1-link')).toBeNull();
  });

  it('shows the shop, total, Core’s headline and lines, and opens the shop’s order page; no empty state', async () => {
    mockUcp.orders.mockResolvedValue([shopOrder()]);
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('shop-orders-ord_1')).toBeTruthy());
    expect(screen.getByTestId('shop-orders-ord_1-headline').props.children).toBe('Shipped');
    expect(screen.getByText('EUR 18.00')).toBeTruthy();
    expect(screen.getByText('2 × Sencha 100 g · and 1 more')).toBeTruthy();
    // Refunds and disputes wait here quietly, in Core's words.
    expect(screen.getByText('A refund: completed')).toBeTruthy();
    expect(screen.queryByTestId('orders-empty')).toBeNull();
    expect(screen.queryByTestId('shop-orders-ord_1-done')).toBeNull();
    fireEvent.press(screen.getByTestId('shop-orders-ord_1-open'));
    expect(openURL).toHaveBeenCalledWith('https://tea.example/orders/ord_1');
  });

  it('an order the shop only sends updates for says so, and can be marked done', async () => {
    mockUcp.orders.mockResolvedValue([
      shopOrder({
        state: 'not_shared',
        shared: false,
        summary: { ...shopOrder().summary, as_sent: true },
      }),
    ]);
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('shop-orders-ord_1-as-sent')).toBeTruthy());
    mockUcp.orders.mockResolvedValue([shopOrder({ state: 'closed', close_reason: 'owner' })]);
    await act(async () => {
      fireEvent.press(screen.getByTestId('shop-orders-ord_1-done'));
    });
    expect(mockUcp.markOrderDone).toHaveBeenCalledWith('https://tea.example', 'ord_1');
    await waitFor(() => expect(screen.queryByTestId('shop-orders-ord_1-done')).toBeNull());
  });

  it('a node without shop orders shows no section, and the empty state as before', async () => {
    mockUcp.orders.mockResolvedValue(null);
    const screen = render(<OrdersScreen />);
    await waitFor(() => expect(screen.getByTestId('orders-empty')).toBeTruthy());
    expect(screen.queryByTestId('shop-orders')).toBeNull();
  });
});
