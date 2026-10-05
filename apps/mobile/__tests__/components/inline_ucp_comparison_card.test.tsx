/**
 * A UCP search's comparison card (UCP plan §4.2 U1): what the owner reads
 * comes from Core (the shops' own titles, cleaned, prices, availability,
 * pages, and how each shop answered) and each shop's trust, which Core looks
 * up. Brain gives only the search id.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { addLifecycleMessage, getThread, resetThreads, type ChatMessage } from '@dina/brain/chat';

import { toDisplayType } from '../../src/chat/message_display';
import {
  CARD_PRODUCTS,
  InlineUcpComparisonCard,
  inCardOrder,
  priceText,
  readCardSpec,
  silentShops,
  trustWords,
} from '../../src/components/InlineUcpComparisonCard';
import { clearUcpCardCache } from '../../src/services/ucp_card_cache';

import type {
  MerchantTrust,
  OwnerSearchProduct,
  OwnerSearchView,
  OwnerUcpClient,
} from '@dina/core';

/** The search a test answers; the mock client adds Core's trust call and counts reads. */
let mockClient: { search: OwnerUcpClient['search'] } | null = null;
/** Core's trust answer for a search. */
let mockTrust: (searchId: string) => Promise<Map<string, MerchantTrust>> = async () => new Map();
let mockSearches = 0;
jest.mock('../../src/services/owner_ucp_client', () => ({
  getOwnerUcpClient: () =>
    mockClient === null
      ? null
      : {
          search: (id: string) => {
            mockSearches += 1;
            return (mockClient as { search: OwnerUcpClient['search'] }).search(id);
          },
          trust: (id: string) => mockTrust(id),
        },
}));

const A = 'https://a-shop.example';
const B = 'https://b-shop.example';

const product = (
  handle: string,
  merchant: string,
  title: string,
  extra: Partial<OwnerSearchProduct> = {},
  amount = '400',
): OwnerSearchProduct => ({
  handle,
  merchant,
  title,
  price_range: {
    min: { amount, currency: 'EUR' },
    max: { amount, currency: 'EUR' },
  },
  variants: [],
  ...extra,
});

const view = (
  products: OwnerSearchProduct[],
  merchants: OwnerSearchView['merchants'] = [
    { origin: A, state: 'ok', products: 1 },
    { origin: B, state: 'ok', products: 1 },
  ],
): OwnerSearchView => ({ search_id: 'ucp-search-1', created_at: 1, merchants, products });

function post(spec: Record<string, unknown>): ChatMessage {
  addLifecycleMessage('t', '', {
    kind: 'ucp_comparison',
    status: 'ready',
    searchId: 'ucp-search-1',
    cardSpec: spec,
  });
  const thread = getThread('t');
  return thread[thread.length - 1] as ChatMessage;
}

const SPEC = { kind: 'ucp_comparison', search_id: 'ucp-search-1' };
const rated = (recommendation: string, reviews: number): MerchantTrust => ({
  state: 'rated',
  recommendation,
  level: 'x',
  reviews,
});

beforeEach(() => {
  resetThreads();
  clearUcpCardCache();
  mockClient = null;
  mockTrust = async () => new Map();
  mockSearches = 0;
});

describe('the comparison card', () => {
  it('orders products by the trust Core looked up, then by price; shows prices in decimals and stock', async () => {
    const asked: string[] = [];
    mockTrust = async (searchId) => {
      asked.push(searchId);
      return new Map([
        [A, { state: 'unrated' }],
        [B, rated('proceed', 12)],
      ]);
    };
    mockClient = {
      search: async () =>
        view([
          product(
            'p1',
            A,
            'Sencha',
            {
              variants: [
                { handle: 'v1.1', price: { amount: '250', currency: 'EUR' }, available: false },
              ],
            },
            '250',
          ),
          product('p2', B, 'Hojicha', { url: 'https://store.b-shop.example/p/2' }, '1999'),
          product(
            'p3',
            B,
            'Matcha',
            {
              variants: [
                { handle: 'v3.1', price: { amount: '900', currency: 'EUR' }, available: true },
              ],
            },
            '900',
          ),
        ]),
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() =>
      expect(screen.getByTestId('ucp-trust-p2').props.children).toBe(
        'Trusted on PeerLens · 12 reviews',
      ),
    );
    expect(asked).toEqual(['ucp-search-1']);
    expect(screen.getAllByTestId(/^ucp-product-/).map((n) => n.props.testID)).toEqual([
      'ucp-product-p3',
      'ucp-product-p2',
      'ucp-product-p1',
    ]);
    expect(screen.getByTestId('ucp-trust-p1').props.children).toBe('No PeerLens reviews yet');
    expect(screen.getByText('EUR 9.00 · In stock · b-shop.example')).toBeTruthy();
    expect(screen.getByText('EUR 19.99 · b-shop.example')).toBeTruthy();
    expect(screen.getByText('EUR 2.50 · Out of stock · a-shop.example')).toBeTruthy();
    expect(screen.getByText('Open at store.b-shop.example')).toBeTruthy();
    expect(screen.queryByTestId('ucp-open-p1')).toBeNull();
    expect(screen.queryByTestId('ucp-elsewhere-p2')).toBeNull();
  });

  it('shows the products before trust arrives, and says so when PeerLens could not be reached', async () => {
    let answer: (m: Map<string, MerchantTrust>) => void = () => undefined;
    mockTrust = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    mockClient = { search: async () => view([product('p1', A, 'Sencha')]) };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByTestId('ucp-product-p1'));
    expect(screen.getByTestId('ucp-trust-p1').props.children).toBe('');
    answer(new Map([[A, { state: 'unavailable' }]]));
    await waitFor(() =>
      expect(screen.getByTestId('ucp-trust-p1').props.children).toBe(
        'PeerLens could not be reached',
      ),
    );
  });

  it('a lookup that fails, or a shop Core gave no line for, reads as unavailable', async () => {
    mockTrust = async () => {
      throw new Error('down');
    };
    mockClient = {
      search: async () => view([product('p1', A, 'Sencha'), product('p2', B, 'Hojicha')]),
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() =>
      expect(screen.getByTestId('ucp-trust-p2').props.children).toBe(
        'PeerLens could not be reached',
      ),
    );
    expect(screen.getByTestId('ucp-trust-p1').props.children).toBe('PeerLens could not be reached');
  });

  it('drawn again (the chat list remounts its row), it reuses what it read: no second search or lookup', async () => {
    let lookups = 0;
    mockTrust = async () => {
      lookups += 1;
      return new Map([[A, rated('proceed', 2)]]);
    };
    mockClient = { search: async () => view([product('p1', A, 'Sencha')]) };
    const message = post(SPEC);
    const first = render(<InlineUcpComparisonCard message={message} />);
    await waitFor(() =>
      expect(first.getByTestId('ucp-trust-p1').props.children).toBe(
        'Trusted on PeerLens · 2 reviews',
      ),
    );
    first.unmount();
    const again = render(<InlineUcpComparisonCard message={message} />);
    expect(again.getByTestId('ucp-trust-p1').props.children).toBe(
      'Trusted on PeerLens · 2 reviews',
    );
    expect(mockSearches).toBe(1);
    expect(lookups).toBe(1);
  });

  it('a price past fifteen digits still draws (as given), and the card with it', async () => {
    mockClient = {
      search: async () => view([product('p1', A, 'Gold tea', {}, '1000000000000000')]),
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByTestId('ucp-product-p1'));
    // Read as given, said to be minor units: never a hundredfold price.
    expect(screen.getByText(/EUR 1000000000000000 \(minor units\)/)).toBeTruthy();
  });

  it('a page off the shop’s own site is shown whole and said so; it opens only on a tap', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    mockClient = {
      search: async () =>
        view([
          product('p2', B, 'Hojicha', {
            url: 'https://elsewhere.example/p/2',
            url_elsewhere: true,
          }),
        ]),
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByTestId('ucp-open-p2'));
    expect(screen.getByTestId('ucp-elsewhere-p2').props.children).toBe(
      "Not the shop's own site: https://elsewhere.example/p/2",
    );
    expect(screen.getByTestId('ucp-open-p2').props.accessibilityLabel).toMatch(
      /off the shop's own site/,
    );
    expect(open).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('ucp-open-p2'));
    expect(open).toHaveBeenCalledWith('https://elsewhere.example/p/2');
    open.mockRestore();
  });

  it('names the shops that gave nothing', async () => {
    mockClient = {
      search: async () =>
        view(
          [product('p1', A, 'Sencha')],
          [
            { origin: A, state: 'ok', products: 1 },
            { origin: B, state: 'timed_out', products: 0 },
            { origin: 'https://c-shop.example', state: 'malformed', products: 0 },
          ],
        ),
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByTestId('ucp-product-p1'));
    expect(screen.getAllByTestId('ucp-silent-shop').map((n) => n.props.children)).toEqual([
      'b-shop.example took too long',
      'c-shop.example gave an answer Dina could not use',
    ]);
  });

  it('says so when the results have expired, or cannot be loaded', async () => {
    mockClient = { search: async () => null };
    const { unmount } = render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByText(/expired/));
    unmount();
    mockClient = {
      search: async () => {
        throw new Error('down');
      },
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByText(/could not be loaded/));
  });

  it('shows at most eight products and counts the rest', async () => {
    mockClient = {
      search: async () =>
        view(Array.from({ length: 11 }, (_, i) => product(`p${i}`, A, `Tea ${i}`))),
    };
    render(<InlineUcpComparisonCard message={post(SPEC)} />);
    await waitFor(() => screen.getByText('3 more'));
    expect(screen.getAllByTestId(/^ucp-product-/)).toHaveLength(CARD_PRODUCTS);
  });
});

describe('the card’s parts', () => {
  it('takes only the search id from Brain', () => {
    expect(readCardSpec(null)).toBeNull();
    expect(readCardSpec({ search_id: '' })).toBeNull();
    expect(readCardSpec({ search_id: 's', order: ['p9'], merchants: [{ origin: A }] })).toEqual({
      searchId: 's',
    });
  });

  it('a shop advised against goes below shops with no rating; prices in other currencies are not compared', () => {
    const v = view([
      product('p1', A, 'a', {}, '100'),
      product('p2', B, 'b', {}, '900'),
      product('p3', B, 'c', {
        price_range: {
          min: { amount: '50', currency: 'JPY' },
          max: { amount: '50', currency: 'JPY' },
        },
      }),
    ]);
    const trust = new Map<string, MerchantTrust>([[A, rated('avoid', 9)]]);
    expect(inCardOrder(v, trust).map((p) => p.handle)).toEqual(['p2', 'p3', 'p1']);
  });

  it('prices, trust and silent shops in words', () => {
    expect(
      priceText({
        min: { amount: '1999', currency: 'EUR' },
        max: { amount: '4550', currency: 'EUR' },
      }),
    ).toBe('EUR 19.99 – EUR 45.50');
    expect(
      priceText({
        min: { amount: '1200', currency: 'JPY' },
        max: { amount: '1200', currency: 'JPY' },
      }),
    ).toBe('JPY 1200');
    expect(trustWords(rated('avoid', 1))).toBe('PeerLens: people advise avoiding · 1 review');
    expect(trustWords(rated('odd', 2))).toBe('PeerLens: unknown · 2 reviews');
    // Advised against with no reviews: no count to give.
    expect(trustWords(rated('avoid', 0))).toBe('PeerLens: people advise avoiding');
    expect(trustWords(undefined)).toBe('');
    expect(silentShops(view([], [{ origin: A, state: 'unreachable', products: 0 }]))).toEqual([
      'a-shop.example could not be reached',
    ]);
  });

  it('a ucp_comparison message is shown as the card', () => {
    expect(toDisplayType(post(SPEC))).toBe('ucp-comparison');
  });
});
