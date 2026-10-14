/**
 * SHELF_SPACE_NEGOTIATION on the phone — the four screens:
 *
 *   - Terms and rules: the store's private floors and category rules, saved
 *     behind a person-present check;
 *   - Shelf space: listing a slot (a public record with no price), finding
 *     one, and the brand's requests with their states;
 *   - Ask for a slot: the deep-link target — a listing address and nothing
 *     else — fetched, then sent with the brand's limits;
 *   - Slot agreement: settle a period, accept or dispute one, and end the deal.
 */

import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import { DEFAULT_TERM_POLICY, OwnerCommerceHttpError } from '@dina/core';

import ShelfAgreementScreen from '../../app/shelf-agreement';
import ShelfRequestScreen from '../../app/shelf-request';
import ShelfSpaceScreen from '../../app/shelf-space';
import ShelfTermsScreen from '../../app/shelf-terms';

const mockParams: { value: Record<string, string> } = { value: {} };
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => {
  const ReactLocal = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: () => null },
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams.value,
    useFocusEffect: (fn: () => void) => ReactLocal.useEffect(fn, [fn]),
  };
});

const mockClient = {
  termPolicy: jest.fn(),
  saveTermPolicy: jest.fn(),
  termListings: jest.fn(),
  publishTermListing: jest.fn(),
  withdrawTermListing: jest.fn(),
  termAgreements: jest.fn(),
  termAgreement: jest.fn(),
  termNegotiations: jest.fn(),
  startTermNegotiation: jest.fn(),
  issueTermSettlement: jest.fn(),
  acknowledgeTermSettlement: jest.fn(),
  terminateTermAgreement: jest.fn(),
  provePresence: jest.fn(),
};
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockClient,
}));

const mockFindSlots = jest.fn();
const mockFetchSlotListing = jest.fn();
jest.mock('../../src/services/shelf_space', () => ({
  ...jest.requireActual('../../src/services/shelf_space'),
  findSlots: (...args: unknown[]) => mockFindSlots(...args),
  fetchSlotListing: (...args: unknown[]) => mockFetchSlotListing(...args),
}));

const mockPackStatus = jest.fn();
const mockActivateSlotPack = jest.fn();
jest.mock('../../src/services/commerce_install', () => ({
  slotPackStatus: (...args: unknown[]) => mockPackStatus(...args),
  activateSlotPack: (...args: unknown[]) => mockActivateSlotPack(...args),
}));

const presence = (): OwnerCommerceHttpError =>
  new OwnerCommerceHttpError('403', 403, 'no_user_presence');

const STORE = 'did:plc:cornerstore000000000000000';
const URI = `at://${STORE}/com.dinakernel.commerce.termListing/slot-3`;
const LISTING = {
  protocol_version: '1.0',
  listing_id: 'slot-3',
  seller_did: STORE,
  pack: { plugin_id: 'com.dinakernel.slot', schema_major: 1 },
  resource_ref: 'slot-3',
  kind: 'shelf',
  region: { scheme: 'postal_area', value: '560034' },
  available: { from: '2027-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' },
  tags: ['beverages.juice', 'snacks'],
  published_at: '2026-12-01T00:00:00Z',
  listing_digest: 'a'.repeat(64),
};
const GENERAL = {
  tag: 'beverages.juice',
  currency: 'INR',
  period: 'monthly' as const,
  cash_handler: 'vendor' as const,
  start: '2027-02-01T00:00:00Z',
  end: '2099-08-01T00:00:00Z',
  exit_notice_days: 30,
};
const TERMS = [
  { name: 'fee' as const, value: '195000' },
  { name: 'share_bps' as const, value: '800' },
];
const POLICY = {
  ...DEFAULT_TERM_POLICY,
  enabled: true,
  resources: [
    {
      resource_ref: 'slot-3',
      currency: 'INR',
      asking: { fee: '250000', share_bps: '1000' },
      floors: { fee: { hard: '150000' }, share_bps: { hard: '500' } },
      available: { from: '2027-01-01T00:00:00Z', to: '2028-12-31T00:00:00Z' },
      conditions: {
        period: 'monthly' as const,
        cash_handler: 'vendor' as const,
        exit_notice_days: 30,
      },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.value = {};
  mockClient.termPolicy.mockResolvedValue({ policy: POLICY });
  mockClient.termListings.mockResolvedValue({ listings: [] });
  mockClient.termAgreements.mockResolvedValue({ agreements: [] });
  mockClient.termNegotiations.mockResolvedValue({ negotiations: [], ranked: [] });
  mockClient.provePresence.mockResolvedValue({ ok: true });
  mockPackStatus.mockResolvedValue({ state: 'active', installId: 'inst' });
});

describe('Terms and rules', () => {
  it('reads the stored policy as rupees and percentages, and saves it back after a person-present check', async () => {
    mockClient.saveTermPolicy
      .mockRejectedValueOnce(presence())
      .mockResolvedValueOnce({ ok: true, revision: 2 });
    const view = render(<ShelfTermsScreen />);
    await waitFor(() => expect(view.getByTestId('slot-0-asking-rent').props.value).toBe('2500.00'));
    fireEvent.changeText(view.getByTestId('slot-0-floor-rent'), '1600');
    // A Switch answers a value change, not a press.
    fireEvent(view.getByTestId('rule-beverages.juice'), 'valueChange', true);
    fireEvent.press(view.getByTestId('shelf-terms-save'));
    // Refused for presence: the sheet asks, then the same save runs again.
    await waitFor(() => expect(view.getByTestId('presence-sheet')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(mockClient.saveTermPolicy).toHaveBeenCalledTimes(2));
    const saved = mockClient.saveTermPolicy.mock.calls[1]?.[0] as typeof POLICY & {
      holding_rules: unknown[];
    };
    expect(saved.resources[0]?.floors.fee).toEqual({ hard: '160000' });
    expect(saved.holding_rules).toEqual([
      { tag: 'beverages.juice', premium_bps_per_count: 1500, max_count: 4 },
    ]);
  });

  it('records a brand placed outside Dina, naming its slot, and saves it with the policy', async () => {
    mockClient.saveTermPolicy.mockResolvedValue({ ok: true, revision: 2 });
    mockClient.provePresence.mockResolvedValue({ ok: true });
    const view = render(<ShelfTermsScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-terms-screen')).toBeTruthy());
    fireEvent.press(view.getByTestId('shelf-terms-add-holding'));
    fireEvent.press(view.getByTestId('holding-0-tag-beverages.juice'));
    fireEvent.press(view.getByTestId('holding-0-slot-slot-3'));
    fireEvent.changeText(view.getByTestId('holding-0-start'), '2027-01-01');
    fireEvent.changeText(view.getByTestId('holding-0-end'), '2027-12-01');
    fireEvent.press(view.getByTestId('shelf-terms-save'));
    await waitFor(() => expect(mockClient.saveTermPolicy).toHaveBeenCalled());
    const saved = mockClient.saveTermPolicy.mock.calls.at(-1)?.[0] as typeof POLICY;
    expect(saved.manual_holdings).toEqual([
      {
        holding_id: 'holding-1',
        tag: 'beverages.juice',
        resource_ref: 'slot-3',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      },
    ]);
  });

  it('a holding with its dates the wrong way round is caught before any presence prompt', async () => {
    const view = render(<ShelfTermsScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-terms-screen')).toBeTruthy());
    fireEvent.press(view.getByTestId('shelf-terms-add-holding'));
    fireEvent.press(view.getByTestId('holding-0-tag-snacks'));
    fireEvent.changeText(view.getByTestId('holding-0-start'), '2027-06-01');
    fireEvent.changeText(view.getByTestId('holding-0-end'), '2027-01-01');
    fireEvent.press(view.getByTestId('shelf-terms-save'));
    await waitFor(() => expect(view.getByTestId('shelf-terms-problem')).toBeTruthy());
    expect(view.getByTestId('shelf-terms-problem').props.children).toBe(
      'Holding 1: the end must come after the start.',
    );
    expect(mockClient.saveTermPolicy).not.toHaveBeenCalled();
  });

  it('a slot rented by the week says so, and the policy carries it', async () => {
    mockClient.saveTermPolicy.mockResolvedValue({ ok: true, revision: 2, withdrawn: [] });
    const view = render(<ShelfTermsScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-terms-screen')).toBeTruthy());
    fireEvent.press(view.getByTestId('slot-0-period-weekly'));
    expect(view.getByText('Rent you ask, a week')).toBeTruthy();
    fireEvent.press(view.getByTestId('shelf-terms-save'));
    await waitFor(() => expect(mockClient.saveTermPolicy).toHaveBeenCalled());
    const saved = mockClient.saveTermPolicy.mock.calls.at(-1)?.[0] as typeof POLICY;
    expect(saved.resources[0]?.conditions.period).toBe('weekly');
  });

  it('catches a typo beside the field, before any presence prompt', async () => {
    const view = render(<ShelfTermsScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-terms-screen')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('slot-0-auto-rent'), '100');
    fireEvent.press(view.getByTestId('shelf-terms-save'));
    await waitFor(() => expect(view.getByTestId('shelf-terms-problem')).toBeTruthy());
    expect(mockClient.saveTermPolicy).not.toHaveBeenCalled();
  });
});

describe('Shelf space', () => {
  it('publishes a listing with no money in it, behind presence', async () => {
    mockClient.publishTermListing.mockResolvedValue({ ok: true, listing: LISTING, uri: URI });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-space-screen')).toBeTruthy());
    fireEvent.press(view.getByTestId('shelf-publish-slot-slot-3'));
    fireEvent.press(view.getByTestId('shelf-publish-kind-chiller'));
    fireEvent.changeText(view.getByTestId('shelf-publish-postal'), '560034');
    fireEvent.press(view.getByTestId('shelf-publish-tag-beverages.juice'));
    fireEvent.press(view.getByTestId('shelf-publish'));
    await waitFor(() => expect(mockClient.publishTermListing).toHaveBeenCalledTimes(1));
    const sent = mockClient.publishTermListing.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toEqual({
      resource_ref: 'slot-3',
      kind: 'chiller',
      region: { scheme: 'postal_area', value: '560034' },
      tags: ['beverages.juice'],
    });
    expect(JSON.stringify(sent)).not.toMatch(/fee|share|minor/);
  });

  it('finds slots and opens a request on one', async () => {
    mockFindSlots.mockResolvedValue([{ uri: URI, cid: null, sellerDid: STORE, listing: LISTING }]);
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-space-screen')).toBeTruthy());
    fireEvent.press(view.getByTestId('shelf-find-tag-beverages.juice'));
    fireEvent.changeText(view.getByTestId('shelf-find-postal'), '560034');
    fireEvent.press(view.getByTestId('shelf-find'));
    await waitFor(() => expect(view.getByTestId('shelf-found-slot-3')).toBeTruthy());
    expect(mockFindSlots).toHaveBeenCalledWith({
      tag: 'beverages.juice',
      region_scheme: 'postal_area',
      region_value: '560034',
    });
    fireEvent.press(view.getByTestId('shelf-found-slot-3'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/shelf-request',
      params: { listing: URI },
    });
  });

  it('shows each request’s state in words, and why a closed one closed', async () => {
    mockClient.termNegotiations.mockResolvedValue({
      negotiations: [
        {
          requestId: 'r1',
          sellerDid: STORE,
          state: 'ready',
          closeReason: '',
          deadlineAt: '',
          head: { offerDigest: 'o', revision: 4, terms: TERMS, general: GENERAL, validUntil: '' },
          pendingCardId: 'c',
          proposalDelivery: null,
        },
        {
          requestId: 'r3',
          sellerDid: STORE,
          state: 'proposed',
          closeReason: '',
          deadlineAt: '',
          head: { offerDigest: 'o3', revision: 2, terms: TERMS, general: GENERAL, validUntil: '' },
          pendingCardId: null,
          proposalDelivery: 'waiting',
        },
        {
          requestId: 'r2',
          sellerDid: STORE,
          state: 'closed',
          closeReason: 'above_ceiling',
          deadlineAt: '',
          head: null,
          pendingCardId: null,
          proposalDelivery: null,
        },
      ],
      ranked: [],
    });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-negotiation-r1')).toBeTruthy());
    expect(view.getByText('Offer ready — your yes needed')).toBeTruthy();
    expect(
      within(view.getByTestId('shelf-negotiation-r1')).getByText(
        'INR 1950.00 a month + 8% of sales',
      ),
    ).toBeTruthy();
    expect(view.getByText('The best offer was above your limit')).toBeTruthy();
    // §5.3: the owner sees where the proposal their yes sent stands.
    expect(view.getByTestId('shelf-negotiation-r3-delivery').props.children).toEqual([
      'Your proposal: ',
      'Sent · waiting on the other side',
    ]);
    expect(view.queryByTestId('shelf-negotiation-r1-delivery')).toBeNull();
  });

  it('an agreement row says whose yes is awaited and where this side’s answer stands', async () => {
    const summary = {
      role: 'host' as const,
      counterpartyDid: 'did:plc:juicebrand',
      resourceRef: 'slot-3',
      general: GENERAL,
      terms: TERMS,
    };
    mockClient.termAgreements.mockResolvedValue({
      agreements: [
        {
          ...summary,
          proposalDigest: 'a'.repeat(64),
          state: 'proposed',
          endsAt: null,
          delivery: null,
        },
        {
          ...summary,
          proposalDigest: 'b'.repeat(64),
          state: 'accepted',
          endsAt: GENERAL.end,
          delivery: 'not_delivered',
        },
      ],
    });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() =>
      expect(view.getByText('Waiting for your yes in Notifications')).toBeTruthy(),
    );
    expect(view.queryByTestId(`shelf-agreement-${'a'.repeat(12)}-delivery`)).toBeNull();
    expect(view.getByTestId(`shelf-agreement-${'b'.repeat(12)}-delivery`).props.children).toEqual([
      'Your answer',
      ':',
      ' ',
      'Not delivered — the other side never answered',
    ]);
  });
});

describe('Shelf space — a listing whose public record still stands', () => {
  it('a record that may still stand in the directory: it says so and offers to remove it', async () => {
    mockClient.termListings.mockResolvedValue({
      listings: [{ listing: LISTING, state: 'withdrawn', recordPublic: true }],
    });
    mockClient.withdrawTermListing.mockResolvedValue({ ok: true, record_removed: true });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-unremoved-slot-3')).toBeTruthy());
    // It is not offered as a live listing, and the words hold whether it was
    // withdrawn or a first publish failed.
    expect(view.queryByTestId('shelf-listing-slot-3')).toBeNull();
    expect(view.getByText(/slot-3: a public record may still show/)).toBeTruthy();
    expect(view.getByText('Remove')).toBeTruthy();
    fireEvent.press(view.getByTestId('shelf-unremoved-slot-3-retry'));
    await waitFor(() => expect(mockClient.withdrawTermListing).toHaveBeenCalledWith('slot-3'));
  });

  it('a listing withdrawn and removed everywhere shows nothing', async () => {
    mockClient.termListings.mockResolvedValue({
      listings: [{ listing: LISTING, state: 'withdrawn', recordPublic: false }],
    });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-space-screen')).toBeTruthy());
    expect(view.queryByTestId('shelf-unremoved-slot-3')).toBeNull();
  });

  it('with the store’s half off, a listing still out there keeps its Withdraw', async () => {
    mockPackStatus.mockImplementation(async (side: string) =>
      side === 'seller' ? { state: 'absent' } : { state: 'active', installId: 'inst' },
    );
    mockClient.termListings.mockResolvedValue({
      listings: [{ listing: LISTING, state: 'published', recordPublic: true }],
    });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-turn-on-seller-card')).toBeTruthy());
    expect(view.getByTestId('shelf-withdraw-slot-3')).toBeTruthy();
  });

  it('with renting off, no slot can be listed', async () => {
    mockClient.termPolicy.mockResolvedValue({ policy: { ...POLICY, enabled: false } });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-space-screen')).toBeTruthy());
    expect(view.queryByTestId('shelf-publish')).toBeNull();
  });
});

describe('Shelf space — turning the Slot Pack on', () => {
  it('a side that is off shows its turn-on card instead of its tools, and the ceremony runs after a person-present check', async () => {
    let sellerOn = false;
    mockPackStatus.mockImplementation(async (side: string) =>
      side === 'seller' && !sellerOn ? { state: 'absent' } : { state: 'active', installId: 'inst' },
    );
    mockActivateSlotPack.mockRejectedValueOnce(presence()).mockImplementationOnce(async () => {
      sellerOn = true;
      return { ok: true, installId: 'inst-seller' };
    });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-turn-on-seller-card')).toBeTruthy());
    // The store's tools wait for the store's half; the brand's half is on.
    expect(view.queryByTestId('shelf-terms-open')).toBeNull();
    expect(view.getByTestId('shelf-find')).toBeTruthy();
    fireEvent.press(view.getByTestId('shelf-turn-on-seller'));
    await waitFor(() => expect(view.getByTestId('presence-sheet')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(view.getByTestId('shelf-terms-open')).toBeTruthy());
    expect(mockActivateSlotPack).toHaveBeenCalledTimes(2);
    expect(mockActivateSlotPack).toHaveBeenLastCalledWith('seller');
    expect(view.queryByTestId('shelf-turn-on-seller-card')).toBeNull();
  });

  it('a refused install says why, and the brand’s tools stay hidden', async () => {
    mockPackStatus.mockImplementation(async (side: string) =>
      side === 'buyer' ? { state: 'absent' } : { state: 'active', installId: 'inst' },
    );
    mockActivateSlotPack.mockResolvedValue({ ok: false, error: 'needs_newer_dina' });
    const view = render(<ShelfSpaceScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-turn-on-buyer')).toBeTruthy());
    expect(view.queryByTestId('shelf-find')).toBeNull();
    fireEvent.press(view.getByTestId('shelf-turn-on-buyer'));
    await waitFor(() => expect(view.getByTestId('shelf-space-error')).toBeTruthy());
    expect(view.getByTestId('shelf-space-error').props.children).toBe(
      'Dina could not do that (needs newer dina).',
    );
  });
});

describe('Ask for a slot', () => {
  it('a link that does not name a listing is refused before anything is fetched', async () => {
    mockParams.value = { listing: 'https://evil.example/slot' };
    const view = render(<ShelfRequestScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-request-problem')).toBeTruthy());
    expect(mockFetchSlotListing).not.toHaveBeenCalled();
  });

  it('fetches the listing and sends the request with the brand’s limits', async () => {
    mockParams.value = { listing: URI };
    mockFetchSlotListing.mockResolvedValue({
      uri: URI,
      cid: null,
      sellerDid: STORE,
      listing: LISTING,
    });
    mockClient.startTermNegotiation.mockResolvedValue({ ok: true, request_id: 'treq-1' });
    const view = render(<ShelfRequestScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-request-screen')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('shelf-request-end'), '2027-08-01');
    fireEvent.changeText(view.getByTestId('shelf-request-target-rent'), '1700');
    fireEvent.changeText(view.getByTestId('shelf-request-max-rent'), '2200');
    fireEvent.press(view.getByTestId('shelf-request-send'));
    await waitFor(() => expect(mockClient.startTermNegotiation).toHaveBeenCalledTimes(1));
    const sent = mockClient.startTermNegotiation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      listing: LISTING,
      listing_uri: URI,
      tag: 'beverages.juice',
      start: '2027-01-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
      policy: {
        targets: { fee: '170000', share_bps: '0' },
        ceilings: { fee: '220000', share_bps: '0' },
      },
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/shelf-space');
  });

  it('a brand that thinks in weeks asks in weeks', async () => {
    mockParams.value = { listing: URI };
    mockFetchSlotListing.mockResolvedValue({
      uri: URI,
      cid: null,
      sellerDid: STORE,
      listing: LISTING,
    });
    mockClient.startTermNegotiation.mockResolvedValue({ ok: true, request_id: 'treq-2' });
    const view = render(<ShelfRequestScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-request-screen')).toBeTruthy());
    fireEvent.press(view.getByTestId('shelf-request-period-weekly'));
    expect(view.getByText('Most rent you will pay, a week')).toBeTruthy();
    fireEvent.changeText(view.getByTestId('shelf-request-end'), '2027-08-01');
    fireEvent.changeText(view.getByTestId('shelf-request-target-rent'), '400');
    fireEvent.changeText(view.getByTestId('shelf-request-max-rent'), '500');
    fireEvent.press(view.getByTestId('shelf-request-send'));
    await waitFor(() => expect(mockClient.startTermNegotiation).toHaveBeenCalledTimes(1));
    expect(mockClient.startTermNegotiation.mock.calls[0]?.[0]).toMatchObject({
      policy: { period: 'weekly', targets: { fee: '40000' }, ceilings: { fee: '50000' } },
    });
  });

  it('a listing no longer indexed says so', async () => {
    mockParams.value = { listing: URI };
    mockFetchSlotListing.mockResolvedValue(null);
    const view = render(<ShelfRequestScreen />);
    await waitFor(() => expect(view.getByText('That slot is no longer listed.')).toBeTruthy());
  });
});

describe('Slot agreement', () => {
  const DIGEST = 'b'.repeat(64);
  function agreement(role: 'host' | 'vendor'): void {
    mockParams.value = { digest: DIGEST };
    mockClient.termAgreements.mockResolvedValue({
      agreements: [
        {
          proposalDigest: DIGEST,
          role,
          counterpartyDid: STORE,
          state: 'accepted',
          resourceRef: 'slot-3',
          general: GENERAL,
          terms: TERMS,
          endsAt: GENERAL.end,
        },
      ],
    });
    mockClient.termAgreement.mockResolvedValue({
      status: 'accepted',
      statement: {
        ok: true,
        direction: 'vendor_owes_host',
        owed_minor: '355000',
        gross_minor: '2000000',
        share_minor: '160000',
        fee_minor: '195000',
        settlement_count: 1,
      },
      unanswered: ['c'.repeat(64)],
      schedule: [
        {
          start: '2027-02-01T00:00:00.000Z',
          end: '2027-03-01T00:00:00.000Z',
          kind: 'regular',
          feeDueMinor: '195000',
          settlementDigest: 'c'.repeat(64),
        },
        {
          start: '2027-03-01T00:00:00.000Z',
          end: '2027-04-01T00:00:00.000Z',
          kind: 'regular',
          feeDueMinor: '195000',
          settlementDigest: null,
        },
      ],
    });
  }

  it('the brand (holding the takings) settles a period by typing its sales; Core derives the rest', async () => {
    agreement('vendor');
    mockClient.issueTermSettlement.mockResolvedValue({ ok: true });
    const view = render(<ShelfAgreementScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-agreement-statement')).toBeTruthy());
    expect(view.getByTestId('shelf-agreement-statement').props.children).toBe(
      'You owe INR 3550.00 for the periods accepted so far.',
    );
    fireEvent.changeText(view.getByTestId('period-2027-03-01-gross'), '18000');
    fireEvent.press(view.getByTestId('period-2027-03-01-settle'));
    await waitFor(() =>
      expect(mockClient.issueTermSettlement).toHaveBeenCalledWith(DIGEST, {
        period_start: '2027-03-01T00:00:00.000Z',
        period_end: '2027-04-01T00:00:00.000Z',
        gross_minor: '1800000',
      }),
    );
  });

  it('the store accepts or disputes the figures — and is told acceptance is not payment', async () => {
    agreement('host');
    mockClient.acknowledgeTermSettlement.mockResolvedValue({ ok: true });
    const view = render(<ShelfAgreementScreen />);
    await waitFor(() => expect(view.getByTestId('period-2027-02-01-accept')).toBeTruthy());
    expect(view.getByText(/does not mark it paid/)).toBeTruthy();
    expect(view.getByTestId('shelf-agreement-statement').props.children).toBe(
      'You are owed INR 3550.00 for the periods accepted so far.',
    );
    fireEvent.press(view.getByTestId('period-2027-02-01-dispute'));
    await waitFor(() =>
      expect(mockClient.acknowledgeTermSettlement).toHaveBeenCalledWith('c'.repeat(64), 'disputed'),
    );
  });

  it('after the store disputes a period, the brand sends corrected figures that replace the note', async () => {
    agreement('vendor');
    mockClient.termAgreement.mockResolvedValue({
      status: 'accepted',
      statement: { ok: false, error: 'nothing accepted yet' },
      unanswered: [],
      schedule: [
        {
          start: '2027-02-01T00:00:00.000Z',
          end: '2027-03-01T00:00:00.000Z',
          kind: 'regular',
          feeDueMinor: '195000',
          settlementDigest: 'd'.repeat(64),
          answer: 'disputed',
        },
      ],
    });
    mockClient.issueTermSettlement.mockResolvedValue({ ok: true });
    const view = render(<ShelfAgreementScreen />);
    await waitFor(() => expect(view.getByTestId('period-2027-02-01-disputed')).toBeTruthy());
    expect(view.getByText('The other side disputed these figures.')).toBeTruthy();
    expect(view.getByText('Send corrected figures')).toBeTruthy();
    fireEvent.changeText(view.getByTestId('period-2027-02-01-gross'), '17000');
    fireEvent.press(view.getByTestId('period-2027-02-01-settle'));
    await waitFor(() =>
      expect(mockClient.issueTermSettlement).toHaveBeenCalledWith(DIGEST, {
        period_start: '2027-02-01T00:00:00.000Z',
        period_end: '2027-03-01T00:00:00.000Z',
        gross_minor: '1700000',
        replaces_settlement_digest: 'd'.repeat(64),
      }),
    );
  });

  it('the store that disputed waits for the correction, with nothing to press', async () => {
    agreement('host');
    mockClient.termAgreement.mockResolvedValue({
      status: 'accepted',
      statement: { ok: false, error: 'nothing accepted yet' },
      unanswered: [],
      schedule: [
        {
          start: '2027-02-01T00:00:00.000Z',
          end: '2027-03-01T00:00:00.000Z',
          kind: 'regular',
          feeDueMinor: '195000',
          settlementDigest: 'd'.repeat(64),
          answer: 'disputed',
        },
      ],
    });
    const view = render(<ShelfAgreementScreen />);
    await waitFor(() =>
      expect(view.getByText('You disputed these figures; waiting for a correction.')).toBeTruthy(),
    );
    expect(view.queryByTestId('period-2027-02-01-settle')).toBeNull();
    expect(view.queryByTestId('period-2027-02-01-accept')).toBeNull();
  });

  it('Settle with the sales field left empty sends nothing and asks for the figure', async () => {
    agreement('vendor');
    const view = render(<ShelfAgreementScreen />);
    await waitFor(() => expect(view.getByTestId('period-2027-03-01-settle')).toBeTruthy());
    fireEvent.press(view.getByTestId('period-2027-03-01-settle'));
    await waitFor(() => expect(view.getByTestId('shelf-agreement-problem')).toBeTruthy());
    expect(view.getByTestId('shelf-agreement-problem').props.children).toBe(
      'Type the sales for this period (0 if there were none).',
    );
    expect(mockClient.issueTermSettlement).not.toHaveBeenCalled();
  });

  it('ending the agreement needs a person present', async () => {
    agreement('host');
    mockClient.terminateTermAgreement
      .mockRejectedValueOnce(presence())
      .mockResolvedValueOnce({ ok: true });
    const view = render(<ShelfAgreementScreen />);
    await waitFor(() => expect(view.getByTestId('shelf-agreement-end')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('shelf-agreement-end-on'), '2027-06-01');
    fireEvent.press(view.getByTestId('shelf-agreement-end'));
    await waitFor(() => expect(view.getByTestId('presence-sheet')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(mockClient.terminateTermAgreement).toHaveBeenCalledTimes(2));
    expect(mockClient.terminateTermAgreement).toHaveBeenLastCalledWith(
      DIGEST,
      '2027-06-01T00:00:00Z',
    );
  });
});
