/**
 * Render tests for the Tender screen (NEGOTIATION_PLAN §4.5, §4.7). The screen
 * judges nothing: Core ranks, gates presence, applies a clerk's cap and
 * refuses an award while a counter is in flight. These pin that the offers
 * render as Core ranked them, that Award then Send carry the right ids, that
 * a clerk over the cap reads "waiting for the owner", that a refusal reads in
 * words, and that a lapsed presence raises the sheet and retries.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import TenderScreen, { setTenderBackendForTest, type TenderBackend } from '../../app/tender';

let params: Record<string, string> = { tender_id: 'tnd-1' };
jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useLocalSearchParams: () => params,
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
});
afterEach(() => setTenderBackendForTest(null));

describe('the tender screen', () => {
  it('shows the offers as Core ranked them, and why the others are out', async () => {
    setTenderBackendForTest(backend());
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(`tender-offer-${B}`)).toBeTruthy());
    expect(view.getByTestId('tender-state').props.children).toBe('Ready to award');
    expect(view.getByTestId(`tender-total-${B}`).props.children).toBe('INR 480.00');
    expect(view.getByText(/Best offer/)).toBeTruthy();
    expect(view.getByTestId(`tender-excluded-${A}`)).toBeTruthy();
    expect(view.getByText(/Over your budget/)).toBeTruthy();
  });

  it('Award holds the order for that supplier; Send sends that held order and says what Core said', async () => {
    const b = backend();
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(`tender-award-${B}`)).toBeTruthy());
    fireEvent.press(view.getByTestId(`tender-award-${B}`));
    await waitFor(() => expect(view.getByTestId('tender-send')).toBeTruthy());
    expect(b.awardTender).toHaveBeenCalledWith({ tenderId: 'tnd-1', supplierDid: B });
    fireEvent.press(view.getByTestId('tender-send'));
    await waitFor(() =>
      expect(view.getByTestId('tender-notice').props.children).toBe(
        'Sent. Waiting for the supplier to confirm.',
      ),
    );
    expect(b.sendHeldOrder).toHaveBeenCalledWith('oap_1');
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
    await waitFor(() => expect(view.getByTestId(`tender-award-${B}`)).toBeTruthy());
    fireEvent.press(view.getByTestId(`tender-award-${B}`));
    await waitFor(() =>
      expect(String(view.getByTestId('tender-notice').props.children)).toMatch(
        /owner has to approve/,
      ),
    );
    expect(view.queryByTestId('tender-send')).toBeNull();
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
    await waitFor(() => expect(view.getByTestId(`tender-award-${B}`)).toBeTruthy());
    fireEvent.press(view.getByTestId(`tender-award-${B}`));
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
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(`tender-award-${B}`)).toBeTruthy());
    fireEvent.press(view.getByTestId(`tender-award-${B}`));
    await waitFor(() => expect(view.getByTestId('presence-passphrase')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(view.getByTestId('tender-send')).toBeTruthy());
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
    setTenderBackendForTest(b);
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId(`tender-award-${B}`)).toBeTruthy());
    fireEvent.press(view.getByTestId(`tender-award-${B}`));
    await waitFor(() => expect(view.getByTestId('presence-passphrase')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse ');
    fireEvent.press(view.getByTestId('presence-submit'));
    await waitFor(() => expect(b.awardTender).toHaveBeenCalledTimes(2));
    // The passphrase goes as typed, trailing space included.
    expect(b.provePresence).toHaveBeenCalledWith('correct horse ');
    // The retry is in flight: Award stays disabled and the spinner shows, so
    // a second tap cannot send a second award. (The test renderer's Pressable
    // does not honour `disabled`, so the prop is what is asserted.)
    expect(view.getByTestId(`tender-award-${B}`).props.disabled).toBe(true);
    finish?.();
    await waitFor(() => expect(view.getByTestId('tender-send')).toBeTruthy());
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
    setTenderBackendForTest(
      backend({
        tenderRanking: jest.fn(async () => ({
          ...RANKING,
          state: 'awarded' as const,
          awarded_supplier_did: B,
          approval_id: 'oap_9',
          held_order: 'held' as const,
        })),
      }),
    );
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId('tender-send')).toBeTruthy());
    expect(view.queryByTestId(`tender-award-${B}`)).toBeNull();
    expect(view.getByTestId('tender-state').props.children).toBe('Awarded');
    expect(view.getAllByText('Awarded', { exact: true })).toHaveLength(2); // the state and the winner's tag
  });

  it('once the held order has gone, the screen says so and offers no Send', async () => {
    setTenderBackendForTest(
      backend({
        tenderRanking: jest.fn(async () => ({
          ...RANKING,
          state: 'awarded' as const,
          awarded_supplier_did: B,
          approval_id: 'oap_9',
          held_order: 'sent' as const,
        })),
      }),
    );
    const view = render(<TenderScreen />);
    await waitFor(() => expect(view.getByTestId('tender-sent')).toBeTruthy());
    expect(view.queryByTestId('tender-send')).toBeNull();
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
        expect(view.getByTestId('tender-state').props.children).toBe(
          'Waiting for the suppliers to quote',
        ),
      );
    });

    it('an offer that lands while the screen is open shows on the next refresh', async () => {
      jest.useFakeTimers();
      const ranking = jest.fn().mockResolvedValueOnce(WAITING).mockResolvedValue(RANKING);
      setTenderBackendForTest(backend({ tenderRanking: ranking }));
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByTestId(`tender-excluded-${B}`)).toBeTruthy());
      expect(view.queryByTestId(`tender-offer-${B}`)).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await waitFor(() => expect(view.getByTestId(`tender-offer-${B}`)).toBeTruthy());
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

  describe('suppliers by name', () => {
    // Reported: the offers read "did:plc:mfsy…7goi". Core's tender knows DIDs
    // only; the screen shows the name it resolves, and the DID only where no
    // name is known or two suppliers share one.
    it('an offer and an excluded row show the supplier’s name, not the DID', async () => {
      mockNames.set(B, 'Albert Timber');
      mockNames.set(A, 'Alonso Furniture');
      setTenderBackendForTest(backend());
      const view = render(<TenderScreen />);
      await waitFor(() => expect(view.getByText(/Albert Timber/)).toBeTruthy());
      expect(view.getByText(/Best offer · Albert Timber/)).toBeTruthy();
      expect(view.getByText(/Alonso Furniture — Over your budget/)).toBeTruthy();
      expect(view.queryByText(/did:plc/)).toBeNull();
    });

    it('two suppliers with the same name keep their DIDs beside it', async () => {
      mockNames.set(B, 'ChairMaker Workshop');
      mockNames.set(A, 'ChairMaker Workshop');
      setTenderBackendForTest(backend());
      const view = render(<TenderScreen />);
      await waitFor(() =>
        expect(view.getByText(/ChairMaker Workshop · did:plc:supplierbbbb/)).toBeTruthy(),
      );
      expect(
        view.getByText(/ChairMaker Workshop · did:plc:supplieraaaa — Over your budget/),
      ).toBeTruthy();
    });
  });
});
