/**
 * Render tests for the Tender screen (NEGOTIATION_PLAN §4.5, §4.7). The screen
 * judges nothing: Core ranks, gates presence, applies a clerk's cap and
 * refuses an award while a counter is in flight. The tender is drawn as
 * Dina's tender card (HOSTED_DINA §6.4, `buildTenderCard`); these pin that
 * the card shows the offers as Core ranked them, that its Award and Send
 * buttons carry the right ids, that a clerk over the cap reads "waiting for
 * the owner", that a refusal reads in words, and that a lapsed presence
 * raises the sheet and retries.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import TenderScreen, { setTenderBackendForTest, type TenderBackend } from '../../app/tender';

let params: Record<string, string> = { tender_id: 'tnd-1' };
jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useLocalSearchParams: () => params,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    Stack: { Screen: () => null },
  };
});
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => null,
}));
jest.mock('../../src/services/staff_identity_store', () => ({
  loadStaffIdentity: async () => null,
}));
jest.mock('../../src/services/staff_transport_rn', () => ({ makeStaffWebSocket: () => null }));
const mockConfirm = jest.fn(async (_title: string, _message: string) => true);
jest.mock('../../src/services/confirm_decision', () => ({
  confirmDecision: (title: string, message: string) => mockConfirm(title, message),
}));
const mockNames = new Map<string, string | null>();
jest.mock('../../src/services/supplier_names', () => ({
  ...jest.requireActual<object>('../../src/services/supplier_names'),
  supplierNamesHere: async () => mockNames,
}));

const A = 'did:plc:supplieraaaa';
const B = 'did:plc:supplierbbbb';
const RANKING = {
  tender_id: 'tnd-1',
  state: 'ready' as const,
  target_total: '42000',
  budget_ceiling: '49000',
  currency: 'INR',
  ranked: [
    {
      supplier_did: B,
      quote_id: 'q-b',
      service_rkey: 'shop',
      total_minor: '48000',
      currency: 'INR',
      comparison_cost_minor: '48000',
      credit_days: 0,
      valid_until: '2036-01-01T00:00:00.000Z',
      revision: '3',
    },
  ],
  excluded: [{ supplier_did: A, reason: 'over_budget' as const }],
};

function backend(over: Partial<TenderBackend> = {}): TenderBackend & {
  awardTender: jest.Mock;
  sendHeldOrder: jest.Mock;
  provePresence: jest.Mock;
} {
  return {
    presence: 'passphrase',
    tenderRanking: jest.fn(async () => RANKING),
    awardTender: jest.fn(async () => ({
      kind: 'awarded' as const,
      approvalId: 'oap_1',
      supplierDid: B,
      replayed: false,
    })),
    sendHeldOrder: jest.fn(async () => ({
      kind: 'sent' as const,
      headline: 'Sent. Waiting for the supplier to confirm.',
      state: 'submitted_unconfirmed',
    })),
    provePresence: jest.fn(async () => ({ ok: true })),
    ...over,
  } as never;
}

beforeEach(() => {
  params = { tender_id: 'tnd-1' };
  mockNames.clear();
  mockConfirm.mockClear();
});
afterEach(() => setTenderBackendForTest(null));

const AWARD = (did: string, alt?: string): string =>
  `card-action-tender.award-${did}${alt !== undefined ? `-${alt}` : ''}`;
const SEND = (approvalId: string): string => `card-action-tender.send-${approvalId}`;
const HELD = (approvalId: string) => ({
  ...RANKING,
  state: 'awarded' as const,
  awarded_supplier_did: B,
  approval_id: approvalId,
  held_order: 'held' as const,
});
/** Core's ranking before the award, and the held order after it. */
function rankingAfterAward(b: { awardTender: jest.Mock }, approvalId: string): jest.Mock {
  return jest.fn(async () => (b.awardTender.mock.calls.length > 0 ? HELD(approvalId) : RANKING));
}

describe('the tender screen', () => {
  it('shows the offers as Core ranked them, and why the others are out', async () => {
    setTenderBackendForTest(backend());
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    expect(view.getByText('Ready to award')).toBeTruthy();
    expect(view.getByText(/Best offer/)).toBeTruthy();
    expect(view.getAllByText('INR 480.00').length).toBeGreaterThan(0);
    expect(view.getByText(/revised 2×/)).toBeTruthy();
    expect(view.getByText('Not in the running'.toUpperCase())).toBeTruthy();
    expect(view.getByText('Over your budget')).toBeTruthy();
    // The owner sees the target and the ceiling.
    expect(view.getByText('INR 420.00')).toBeTruthy();
    expect(view.getByText('INR 490.00')).toBeTruthy();
  });

  it('Award holds the order for that supplier; Send sends that held order and says what Core said', async () => {
    const b = backend();
    b.tenderRanking = rankingAfterAward(b, 'oap_1');
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    fireEvent.press(view.getByTestId(AWARD(B)));
    await waitFor(() => expect(view.getByTestId(SEND('oap_1'))).toBeTruthy());
    expect(b.awardTender).toHaveBeenCalledWith({ tenderId: 'tnd-1', supplierDid: B });
    fireEvent.press(view.getByTestId(SEND('oap_1')));
    await waitFor(() =>
      expect(view.getByTestId('tender-notice').props.children).toBe(
        'Sent. Waiting for the supplier to confirm.',
      ),
    );
    expect(b.sendHeldOrder).toHaveBeenCalledWith('oap_1');
  });

  it('a partner run that holds the exit right says the buyer may cancel without charge (§15 step 12)', async () => {
    const partner = {
      ...RANKING.ranked[0],
      alternative_id: 'partner_00112233',
      partner_run: {
        offer_ends_at: '2026-08-08T09:00:00.000Z',
        fallback_total_minor: '48000',
        exit_if_run_fails: true as const,
      },
    };
    setTenderBackendForTest(backend({ tenderRanking: jest.fn(async () => ({ ...RANKING, ranked: [partner] })) }));
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByText(/partner's delivery run/)).toBeTruthy());
    expect(view.getByText(/cancel without charge/)).toBeTruthy();
  });

  it('one supplier in two versions: each its own row; a partner run says its end and its fallback', async () => {
    const own = RANKING.ranked[0];
    const partner = {
      ...own,
      total_minor: '44500',
      comparison_cost_minor: '44500',
      alternative_id: 'partner_00112233',
      estimated_delivery_at: '2026-08-18T09:00:00Z',
      partner_run: {
        offer_ends_at: '2026-08-08T09:00:00.000Z',
        fallback_total_minor: '48000',
        fallback_delivery_at: '2026-08-20T09:00:00Z',
      },
    };
    const b = backend({ tenderRanking: jest.fn(async () => ({ ...RANKING, ranked: [partner, own] })) });
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B, 'partner_00112233'))).toBeTruthy());
    expect(view.getByTestId(AWARD(B))).toBeTruthy();
    const run = view.getByText(/partner's delivery run/).props.children as string;
    expect(run).toMatch(/delivered 2026-08-18/);
    expect(run).toMatch(/2026-08-08 09:00/);
    expect(run).toMatch(/2026-08-20/);
    expect(run).toMatch(/480\.00/);
    // No exit right on this version: nothing says the buyer may cancel.
    expect(run).not.toMatch(/cancel/);
    fireEvent.press(view.getByTestId(AWARD(B, 'partner_00112233')));
    await waitFor(() =>
      expect(b.awardTender).toHaveBeenCalledWith({
        tenderId: 'tnd-1',
        supplierDid: B,
        alternativeId: 'partner_00112233',
      }),
    );
  });

  it('a clerk over the cap reads "waiting for the owner", and no order is held', async () => {
    params = { tender_id: 'tnd-1', as: 'staff' };
    setTenderBackendForTest(
      backend({
        presence: 'pin',
        awardTender: jest.fn(async () => ({ kind: 'pending_approval' as const, taskId: 'esc-1' })),
      }),
    );
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    fireEvent.press(view.getByTestId(AWARD(B)));
    await waitFor(() =>
      expect(String(view.getByTestId('tender-notice').props.children)).toMatch(
        /owner has to approve/,
      ),
    );
    expect(view.queryByText('Send order')).toBeNull();
  });

  it('a refusal reads in words: a counter still out means try again shortly', async () => {
    setTenderBackendForTest(
      backend({
        awardTender: jest.fn(async () => {
          throw Object.assign(new Error('refused'), { errorKey: 'counter_in_flight' });
        }),
      }),
    );
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    fireEvent.press(view.getByTestId(AWARD(B)));
    await waitFor(() =>
      expect(String(view.getByTestId('tender-notice').props.children)).toMatch(/still waiting/),
    );
  });

  it('a lapsed presence raises the sheet; the proof is sent and the award retried', async () => {
    let first = true;
    const b = backend({
      awardTender: jest.fn(async () => {
        if (first) {
          first = false;
          throw Object.assign(new Error('no presence'), { errorKey: 'no_user_presence' });
        }
        return { kind: 'awarded' as const, approvalId: 'oap_2', supplierDid: B, replayed: false };
      }),
    });
    b.tenderRanking = jest.fn(async () => (first ? RANKING : HELD('oap_2')));
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    fireEvent.press(view.getByTestId(AWARD(B)));
    await waitFor(() => expect(view.getByTestId('presence-passphrase')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(view.getByTestId(SEND('oap_2'))).toBeTruthy());
    expect(b.provePresence).toHaveBeenCalledWith('correct horse');
    expect(b.awardTender).toHaveBeenCalledTimes(2);
  });

  it('the retried award keeps the screen busy: a second tap sends nothing more', async () => {
    let first = true;
    let finish: (() => void) | null = null;
    const b = backend({
      awardTender: jest.fn(async () => {
        if (first) {
          first = false;
          throw Object.assign(new Error('no presence'), { errorKey: 'no_user_presence' });
        }
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { kind: 'awarded' as const, approvalId: 'oap_3', supplierDid: B, replayed: false };
      }),
    });
    let done = false;
    b.tenderRanking = jest.fn(async () => (done ? HELD('oap_3') : RANKING));
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    fireEvent.press(view.getByTestId(AWARD(B)));
    await waitFor(() => expect(view.getByTestId('presence-passphrase')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse ');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(b.awardTender).toHaveBeenCalledTimes(2));
    // The passphrase goes as typed, trailing space included.
    expect(b.provePresence).toHaveBeenCalledWith('correct horse ');
    // The retry is in flight: Award stays disabled, so a second tap cannot
    // send a second award. (The test renderer does not honour `disabled`, so
    // the prop is what is asserted.)
    await waitFor(() => expect(view.getByTestId(AWARD(B)).props.disabled).toBe(true));
    done = true;
    finish?.();
    await waitFor(() => expect(view.getByTestId(SEND('oap_3'))).toBeTruthy());
    expect(b.awardTender).toHaveBeenCalledTimes(2);
  });

  it('a browser not connected as the owner is told to connect, not shown a raw key', async () => {
    const b = backend({
      tenderRanking: jest.fn(async () => {
        throw Object.assign(new Error('401'), { errorKey: 'owner_device_not_connected' });
      }),
    });
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByText(/Connect this browser as the owner/)).toBeTruthy());
  });

  it('an awarded tender offers the send of its held order, and no further award', async () => {
    setTenderBackendForTest(backend({ tenderRanking: jest.fn(async () => HELD('oap_9')) }));
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(SEND('oap_9'))).toBeTruthy());
    expect(view.queryByTestId(AWARD(B))).toBeNull();
    expect(view.getByText('Awarded')).toBeTruthy();
    expect(view.getByText('Awarded · INR 480.00')).toBeTruthy();
  });

  it('once the held order has gone, the card says so and offers no Send', async () => {
    setTenderBackendForTest(
      backend({
        tenderRanking: jest.fn(async () => ({ ...HELD('oap_9'), held_order: 'sent' as const })),
      }),
    );
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByText('Order sent to the supplier.')).toBeTruthy());
    expect(view.queryByTestId(SEND('oap_9'))).toBeNull();
    expect(view.getByTestId('tender-open-orders')).toBeTruthy();
  });

  it('after Send the order is followed live until it is on its way', async () => {
    // Reported: after Send the screen ended at "The supplier has not
    // confirmed yet" and never moved, though the supplier had accepted.
    jest.useFakeTimers();
    const SENT = { ...HELD('oap_9'), held_order: 'sent' as const };
    const base = {
      purchaseOrderId: 'po-7',
      supplierDid: B,
      serviceRkey: 'shop',
      supplierName: null,
      total: null,
      submittedAt: null,
      detail: null,
      actions: [],
      nextPollAtMs: null,
      pollCount: 0,
      quoteId: 'q-b',
      lines: [],
      tenderId: 'tnd-1',
    };
    const none = { checkoutLink: null, payment: null, paymentRecorded: false, fulfilment: null };
    const placedOrders = jest
      .fn()
      .mockResolvedValueOnce({
        orders: [
          { ...base, state: 'accepted', headline: 'Accepted by the supplier.', progress: none },
        ],
        evidence: 'available',
      })
      .mockResolvedValue({
        orders: [
          {
            ...base,
            state: 'accepted',
            headline: 'On its way to you.',
            progress: {
              ...none,
              paymentRecorded: true,
              fulfilment: { state: 'handed_to_carrier' },
            },
          },
        ],
        evidence: 'available',
      });
    const ranking = jest.fn(async () => SENT);
    setTenderBackendForTest(backend({ tenderRanking: ranking, placedOrders }));
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByText('Accepted by the supplier.')).toBeTruthy());
    expect(view.getByText('Paid')).toBeTruthy();
    // Still moving, so the screen reads again…
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await waitFor(() => expect(view.getByText('On its way to you.')).toBeTruthy());
    // …and stops once the order is on its way.
    const calls = ranking.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(ranking.mock.calls.length).toBe(calls);
    expect(view.getByTestId('tender-open-orders')).toBeTruthy();
  });

  describe('while the owner watches', () => {
    const WAITING = {
      ...RANKING,
      state: 'negotiating' as const,
      ranked: [],
      excluded: [
        { supplier_did: A, reason: 'no_quote' as const },
        { supplier_did: B, reason: 'no_quote' as const },
      ],
    };

    afterEach(() => jest.useRealTimers());

    it('before anyone answers, says it is waiting for quotes, not asking for better prices', async () => {
      setTenderBackendForTest(backend({ tenderRanking: jest.fn(async () => WAITING) }));
      const view = render(<TenderScreen />);
      await waitFor(() =>
        expect(view.getByText('Waiting for the suppliers to quote')).toBeTruthy(),
      );
    });

    it('an offer that lands while the screen is open shows on the next refresh', async () => {
      jest.useFakeTimers();
      const ranking = jest.fn().mockResolvedValueOnce(WAITING).mockResolvedValue(RANKING);
      setTenderBackendForTest(backend({ tenderRanking: ranking }));
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText('No offer can be awarded yet.')).toBeTruthy());
      expect(view.queryByTestId(AWARD(B))).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
    });

    it('an awarded tender is final: no more refreshes', async () => {
      jest.useFakeTimers();
      const ranking = jest.fn(async () => ({
        ...RANKING,
        state: 'awarded' as const,
        awarded_supplier_did: B,
      }));
      setTenderBackendForTest(backend({ tenderRanking: ranking }));
      render(<TenderScreen />);
      await waitFor(() => expect(ranking).toHaveBeenCalledTimes(1));
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(ranking).toHaveBeenCalledTimes(1);
    });
  });

  describe('what each bakery offered, and whether to trust it', () => {
    const money = (minor: string) => ({ currency: 'INR', minor_units: minor });
    const STORY = {
      tender_id: 'tnd-1',
      suppliers: [
        {
          supplier_did: B,
          service_rkey: 'shop',
          quote_id: 'q-b',
          revisions: [
            { revision: '1', total: money('52000'), issued_at: '2026-09-30T07:00:00Z' },
            { revision: '3', total: money('48000'), issued_at: '2026-09-30T07:02:00Z' },
          ],
          counters: [],
          lines: [
            {
              line_id: 'l1',
              product: { scheme: 'manufacturer_sku', value: 'B342' },
              name: 'Floral Celebration Cake',
              quantity: { value: '1', unit_code: 'each' },
              unit_price: money('48000'),
              line_subtotal: money('48000'),
            },
          ],
        },
        {
          supplier_did: A,
          service_rkey: 'self',
          quote_id: 'q-a',
          revisions: [{ revision: '1', total: money('61000'), issued_at: '2026-09-30T07:00:00Z' }],
          counters: [],
          lines: [],
        },
      ],
    };

    it('an offer names the item in the supplier’s own signed words, with its PeerLens trust', async () => {
      const supplierTrust = jest.fn(async () => ({ score: 0.8, reviewCount: 7 }));
      setTenderBackendForTest(backend({ tenderStory: jest.fn(async () => STORY), supplierTrust }));
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText(/1 each · Floral Celebration Cake/)).toBeTruthy());
      await waitFor(() => expect(view.getByText(/Trust 0\.80 · 7 reviews/)).toBeTruthy());
    });

    it('an offer over budget shows its price beside why it is out', async () => {
      setTenderBackendForTest(backend({ tenderStory: jest.fn(async () => STORY) }));
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText('INR 610.00')).toBeTruthy());
      expect(view.getByText('Over your budget')).toBeTruthy();
    });

    it('awarding a supplier PeerLens rates poorly asks first; declining awards nothing', async () => {
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const supplierTrust = jest.fn(async () => ({ score: 0.15, reviewCount: 6 }));
      const b = backend({ tenderStory: jest.fn(async () => STORY), supplierTrust });
      setTenderBackendForTest(b);
      const view = render(<TenderScreen />);
      await waitFor(() => expect(supplierTrust).toHaveBeenCalled());
      await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());

      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(mockConfirm.mock.calls[0]?.[1]).toMatch(
        /poor reviews on PeerLens \(6 reviews\)\. Award anyway\?$/,
      );
      expect(b.awardTender).not.toHaveBeenCalled();

      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() =>
        expect(b.awardTender).toHaveBeenCalledWith({ tenderId: 'tnd-1', supplierDid: B }),
      );
    });

    it('Award tapped before trust has loaded still checks it first', async () => {
      // The trust lookup is slow; the award must not read "no answer yet" as "fine".
      let release: ((t: { score: number; reviewCount: number }) => void) | null = null;
      const supplierTrust = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue({ score: 0.15, reviewCount: 6 });
      const b = backend({ supplierTrust });
      setTenderBackendForTest(b);
      mockConfirm.mockResolvedValueOnce(false);
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(b.awardTender).not.toHaveBeenCalled();
      release?.({ score: 0.15, reviewCount: 6 });
    });

    it("the owner's own poor review asks first even when PeerLens trust is fine", async () => {
      const supplierTrust = jest.fn(async () => ({ score: 0.8, reviewCount: 7 }));
      const ownReviews = jest.fn(
        async () =>
          new Map([
            [
              B,
              {
                sentiment: 'negative' as const,
                text: 'Late twice',
                createdAt: '2026-09-01T00:00:00.000Z',
              },
            ],
          ]),
      );
      const b = backend({ tenderStory: jest.fn(async () => STORY), supplierTrust, ownReviews });
      setTenderBackendForTest(b);
      mockConfirm.mockResolvedValueOnce(false);
      const view = render(<TenderScreen />);
      await waitFor(() => expect(supplierTrust).toHaveBeenCalled());
      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(mockConfirm.mock.calls[0]?.[1]).toMatch(
        /^You rated .+ poorly on PeerLens\. Award anyway\?$/,
      );
      expect(b.awardTender).not.toHaveBeenCalled();
    });

    it('own reviews are read again for each award: a review written since counts', async () => {
      const supplierTrust = jest.fn(async () => ({ score: 0.8, reviewCount: 7 }));
      const negative = new Map([
        [B, { sentiment: 'negative' as const, text: null, createdAt: '2026-10-01T00:00:00.000Z' }],
      ]);
      const ownReviews = jest
        .fn(async () => negative)
        .mockRejectedValueOnce(new Error('AppView down'));
      const b = backend({ tenderStory: jest.fn(async () => STORY), supplierTrust, ownReviews });
      setTenderBackendForTest(b);
      mockConfirm.mockResolvedValue(false);
      const view = render(<TenderScreen />);
      await waitFor(() => expect(supplierTrust).toHaveBeenCalled());
      // The first lookup fails: only PeerLens applies, and it is fine.
      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() => expect(b.awardTender).toHaveBeenCalledTimes(1));
      expect(mockConfirm).not.toHaveBeenCalled();
      // The next award reads again and finds the owner's poor review.
      await waitFor(() => expect(view.getByTestId(AWARD(B)).props.disabled).toBe(false));
      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
      expect(ownReviews).toHaveBeenCalledTimes(2);
      expect(b.awardTender).toHaveBeenCalledTimes(1);
    });

    it('a well-reviewed supplier is awarded without a warning', async () => {
      const supplierTrust = jest.fn(async () => ({ score: 0.8, reviewCount: 7 }));
      const b = backend({ tenderStory: jest.fn(async () => STORY), supplierTrust });
      setTenderBackendForTest(b);
      const view = render(<TenderScreen />);
      await waitFor(() => expect(supplierTrust).toHaveBeenCalled());
      fireEvent.press(view.getByTestId(AWARD(B)));
      await waitFor(() => expect(b.awardTender).toHaveBeenCalled());
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('a supplier not asked shows what it listed from', async () => {
      const POOR = 'did:plc:crumbandcoo';
      setTenderBackendForTest(
        backend({
          tenderRanking: jest.fn(async () => ({
            ...RANKING,
            not_asked: [
              {
                supplier_did: POOR,
                service_rkey: 'bakery',
                reason: 'own_poor_review' as const,
                note: '',
                listed_from: { currency: 'USD', minor_units: '12900' },
              },
            ],
          })),
        }),
      );
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText('from USD 129.00')).toBeTruthy());
      expect(view.getByText('you rated them poorly on PeerLens')).toBeTruthy();
    });

    it('a story that cannot be read leaves the ranking as it was', async () => {
      setTenderBackendForTest(
        backend({ tenderStory: jest.fn(async () => Promise.reject(new Error('offline'))) }),
      );
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByTestId(AWARD(B))).toBeTruthy());
      expect(view.getByText(/Best offer/)).toBeTruthy();
    });
  });

  describe('suppliers by name', () => {
    // Reported: the offers read "did:plc:mfsy…7goi". Core's tender knows DIDs
    // only; the screen shows the name it resolves, and the DID only where no
    // name is known or two suppliers share one.
    it('an offer and an excluded row show the supplier’s name, not the DID', async () => {
      mockNames.set(B, 'Albert Timber');
      mockNames.set(A, 'Alonso Furniture');
      setTenderBackendForTest(backend());
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText('Best offer · Albert Timber')).toBeTruthy());
      expect(view.getByText('1. Albert Timber')).toBeTruthy();
      expect(view.getByText('Alonso Furniture')).toBeTruthy();
      expect(view.queryByText(/did:plc/)).toBeNull();
    });

    it('a supplier set aside for PeerLens is listed as not asked, by name, with the review', async () => {
      const POOR = 'did:plc:crumbandcoo';
      mockNames.set(B, 'Albert Timber');
      mockNames.set(A, 'Alonso Furniture');
      mockNames.set(POOR, 'Crumb & Co');
      setTenderBackendForTest(
        backend({
          tenderRanking: jest.fn(async () => ({
            ...RANKING,
            not_asked: [
              {
                supplier_did: POOR,
                service_rkey: 'bakery',
                reason: 'own_poor_review',
                note: 'Stale bread, delivered late',
              },
            ],
          })),
        }),
      );
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText('Crumb & Co')).toBeTruthy());
      expect(view.getByText('NOT ASKED')).toBeTruthy();
      expect(
        view.getByText('you rated them poorly on PeerLens · “Stale bread, delivered late”'),
      ).toBeTruthy();
      // Never an offer: no award button for it.
      expect(view.queryByTestId(AWARD(POOR))).toBeNull();
    });

    it('an older Core with no not-asked list shows no such section', async () => {
      setTenderBackendForTest(backend());
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText('Ready to award')).toBeTruthy());
      expect(view.queryByText('NOT ASKED')).toBeNull();
    });

    it('two suppliers with the same name keep their DIDs beside it', async () => {
      mockNames.set(B, 'ChairMaker Workshop');
      mockNames.set(A, 'ChairMaker Workshop');
      setTenderBackendForTest(backend());
      const view = render(<TenderScreen />);
      await waitFor(() =>
        expect(view.getByText('1. ChairMaker Workshop · did:plc:supplierbbbb')).toBeTruthy(),
      );
      expect(view.getByText('ChairMaker Workshop · did:plc:supplieraaaa')).toBeTruthy();
    });
  });
});
