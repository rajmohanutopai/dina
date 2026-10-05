/**
 * A UCP search's comparison card, in chat (UCP plan §4.2 U1).
 *
 * A view keyed by the search: Brain gives only the search id. What the owner
 * reads comes from Core (`OwnerUcpClient.search`): each product's title in
 * the shop's own words, cleaned, its price, availability and page, and how
 * each shop answered; and each shop's PeerLens trust, which Core looks up
 * (never Brain). A search read once is kept for a few minutes, so a row the
 * chat list draws again does not ask again.
 * Products go best-trusted shop first, then cheapest first within a currency,
 * never by anything a shop says about itself. A product's page opens only on
 * a tap; one off the shop's own site is shown whole, and said so, first.
 */

import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';
import { bestFirst, formatMoney } from '@dina/core';

import { getOwnerUcpClient } from '../services/owner_ucp_client';
import { cachedUcpSearch, rememberUcpSearch } from '../services/ucp_card_cache';
import { colors, radius, spacing, textStyles } from '../theme';

import type { MerchantTrust, OwnerSearchProduct, OwnerSearchView } from '@dina/core';

/** Products the card shows; the rest are counted. */
export const CARD_PRODUCTS = 8;

/** Brain's card spec, read as untrusted: the search id alone. */
export function readCardSpec(raw: unknown): { searchId: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const id = (raw as Record<string, unknown>).search_id;
  return typeof id === 'string' && id !== '' ? { searchId: id } : null;
}

const TRUST_WORDS: Record<string, string> = {
  proceed: 'Trusted on PeerLens',
  caution: 'PeerLens: some caution',
  verify: 'PeerLens: not yet verified',
  avoid: 'PeerLens: people advise avoiding',
};

/** A shop's trust in words; while it is being looked up, nothing. */
export function trustWords(trust: MerchantTrust | undefined): string {
  if (trust === undefined) return '';
  if (trust.state === 'unavailable') return 'PeerLens could not be reached';
  if (trust.state === 'unrated') return 'No PeerLens reviews yet';
  const words = TRUST_WORDS[trust.recommendation] ?? 'PeerLens: unknown';
  // Advised against with no reviews (a shop removed or flagged): no count to give.
  if (trust.reviews === 0) return words;
  return `${words} · ${trust.reviews} review${trust.reviews === 1 ? '' : 's'}`;
}

const OUTCOME_WORDS: Record<string, string> = {
  unreachable: 'could not be reached',
  timed_out: 'took too long',
  unavailable: 'does not offer search',
  rate_limited: 'asked Dina to slow down',
  refused: 'refused the search',
  link_required: 'asks you to link your account (Settings, Linked accounts)',
  too_large: 'answered too much',
  profile_rejected: 'could not read Dina’s shopping profile',
};

/** The shops that gave nothing, in words: "b-shop.example could not be reached". */
export function silentShops(view: OwnerSearchView): string[] {
  return view.merchants
    .filter((m) => m.state !== 'ok')
    .map(
      (m) => `${hostOf(m.origin)} ${OUTCOME_WORDS[m.state] ?? 'gave an answer Dina could not use'}`,
    );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** A product's price as people read it: `EUR 19.99`, or a range. */
export function priceText(p: OwnerSearchProduct['price_range']): string {
  const one = (m: { amount: string; currency: string }): string => {
    try {
      return formatMoney({ currency: m.currency, minor_units: m.amount });
    } catch {
      // Core shows no price past fifteen digits; should one arrive, the card still draws.
      return `${m.currency} ${m.amount} (minor units)`;
    }
  };
  const min = one(p.min);
  const max = one(p.max);
  return min === max ? min : `${min} – ${max}`;
}

/** Whether a product can be bought: any variant available, none, or unknown. */
function availability(p: OwnerSearchProduct): string {
  const said = p.variants.filter((v) => v.available !== undefined);
  if (said.length === 0) return '';
  return said.some((v) => v.available === true) ? 'In stock' : 'Out of stock';
}

/** The products in the card's order: best-trusted shop first, then cheapest. */
export function inCardOrder(
  view: OwnerSearchView,
  trust: ReadonlyMap<string, MerchantTrust>,
): OwnerSearchProduct[] {
  return bestFirst(
    view.products,
    (p) => p.merchant,
    (p) => p.price_range.min,
    (shop) => trust.get(shop),
  );
}

export function InlineUcpComparisonCard({
  message,
}: {
  message: ChatMessage;
}): React.ReactElement | null {
  const lc = readLifecycle(message);
  const spec = lc !== null && lc.kind === 'ucp_comparison' ? readCardSpec(lc.cardSpec) : null;
  const searchId = spec?.searchId ?? '';
  const start = searchId === '' ? null : cachedUcpSearch(searchId);
  const [view, setView] = useState<OwnerSearchView | null>(start?.view ?? null);
  const [trust, setTrust] = useState<ReadonlyMap<string, MerchantTrust>>(start?.trust ?? new Map());
  const [state, setState] = useState<'loading' | 'ready' | 'gone' | 'failed'>(
    start !== null ? 'ready' : 'loading',
  );

  useEffect(() => {
    if (searchId === '') return;
    let alive = true;
    const client = getOwnerUcpClient();
    if (client === null) {
      setState('failed');
      return;
    }
    const hit = cachedUcpSearch(searchId);
    if (hit !== null && hit.trust !== null) return;
    const read = hit !== null ? Promise.resolve(hit.view) : client.search(searchId);
    read
      .then((v) => {
        if (!alive) return;
        setView(v);
        setState(v === null ? 'gone' : 'ready');
        if (v === null) return;
        rememberUcpSearch(searchId, v, null);
        void client
          .trust(searchId)
          .catch(() => new Map<string, MerchantTrust>())
          .then((answered) => {
            // A shop Core gave no line for (or a lookup that failed) reads as unavailable.
            const t = new Map<string, MerchantTrust>(
              v.merchants.map((m) => [
                m.origin,
                answered.get(m.origin) ?? { state: 'unavailable' },
              ]),
            );
            rememberUcpSearch(searchId, v, t);
            if (alive) setTrust(t);
          });
      })
      .catch(() => {
        if (alive) setState('failed');
      });
    return () => {
      alive = false;
    };
  }, [searchId]);

  if (spec === null) return null;
  return (
    <View style={styles.card} testID={`ucp-comparison-${searchId}`}>
      <Text style={styles.title}>From the shops</Text>
      {state === 'loading' && <Text style={styles.meta}>Loading the results…</Text>}
      {state === 'gone' && (
        <Text style={styles.meta}>These results have expired (kept a day).</Text>
      )}
      {state === 'failed' && <Text style={styles.meta}>The results could not be loaded.</Text>}
      {state === 'ready' && view !== null && (
        <>
          {inCardOrder(view, trust)
            .slice(0, CARD_PRODUCTS)
            .map((p) => {
              const stock = availability(p);
              const page = p.url !== undefined ? hostOf(p.url) : '';
              return (
                <View key={p.handle} style={styles.product} testID={`ucp-product-${p.handle}`}>
                  <Text style={styles.line}>{p.title === '' ? 'Untitled product' : p.title}</Text>
                  <Text style={styles.meta}>
                    {[priceText(p.price_range), stock, hostOf(p.merchant)]
                      .filter((w) => w !== '')
                      .join(' · ')}
                  </Text>
                  <Text style={styles.trust} testID={`ucp-trust-${p.handle}`}>
                    {trustWords(trust.get(p.merchant))}
                  </Text>
                  {p.url !== undefined && page !== '' && (
                    <Pressable
                      testID={`ucp-open-${p.handle}`}
                      accessibilityRole="link"
                      accessibilityLabel={
                        p.url_elsewhere === true
                          ? `Open ${p.url}, a page off the shop's own site`
                          : `Open at ${page}`
                      }
                      onPress={() => {
                        void Linking.openURL(p.url as string).catch(() => undefined);
                      }}
                    >
                      {p.url_elsewhere === true && (
                        <Text style={styles.meta} testID={`ucp-elsewhere-${p.handle}`}>
                          {`Not the shop's own site: ${p.url}`}
                        </Text>
                      )}
                      <Text style={styles.link}>{`Open at ${page}`}</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          {view.products.length > CARD_PRODUCTS && (
            <Text style={styles.meta}>{`${view.products.length - CARD_PRODUCTS} more`}</Text>
          )}
          {view.products.length === 0 && <Text style={styles.meta}>No products came back.</Text>}
          {silentShops(view).map((line) => (
            <Text key={line} style={styles.meta} testID="ucp-silent-shop">
              {line}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: {
    ...textStyles.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
  },
  product: { gap: 2 },
  line: { ...textStyles.body, color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  trust: { ...textStyles.caption, color: colors.textPrimary },
  link: { ...textStyles.caption, color: colors.accent },
});
