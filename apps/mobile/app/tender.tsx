/**
 * Tender (NEGOTIATION_PLAN §4.5, §4.7) — the ranked offers of one tender, an
 * Award button on each, and Send once the order is held. One screen for the
 * owner (in-process client) and a clerk (`as=staff`, the sealed relay).
 *
 * Every gate is Core's: presence, the clerk's grant and cap, a counter still
 * in flight, a tender already awarded. The screen carries the taps and says
 * what Core answered — including "waiting for the owner" when a clerk's award
 * or send is over the cap, which is a normal outcome, not an error.
 */

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyAmount, StaffCoreClient, staffTransportFor } from '@dina/core';

import { BargainingTimeline } from '../src/components/BargainingTimeline';
import {
  OfferedItemCard,
  type OfferedItem,
  type SupplierTrust,
} from '../src/components/OfferedItemCard';
import { OrderProgress, orderStepsReached } from '../src/components/OrderProgress';
import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { confirmDecision } from '../src/services/confirm_decision';
import {
  publishedItemFor,
  supplierTrustFor,
  type OfferedProduct,
} from '../src/services/offered_catalog';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { CONNECT_OWNER_DEVICE_MESSAGE, errorKeyOf } from '../src/services/owner_errors';
import { loadStaffIdentity } from '../src/services/staff_identity_store';
import { makeStaffWebSocket } from '../src/services/staff_transport_rn';
import { ownerDidHere } from '../src/services/supplier_finder';
import { shortDid, supplierLabels, supplierNamesHere } from '../src/services/supplier_names';
import {
  loadOwnSupplierReviews,
  setAsideFor,
  type OwnReview,
} from '../src/services/supplier_trust';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type {
  CatalogItem,
  OrderSendOutcome,
  PlacedOrderDto,
  PlacedOrdersAnswer,
  TenderAwardOutcome,
  TenderExclusionReason,
  TenderNotAskedView,
  TenderRankingView,
  TenderStorySupplierView,
  TenderStoryView,
} from '@dina/core';

/** What the screen needs from either client. */
export interface TenderBackend {
  presence: 'passphrase' | 'pin';
  tenderRanking(tenderId: string): Promise<TenderRankingView>;
  /** How each supplier got here; absent where the client cannot read it. */
  tenderStory?(tenderId: string): Promise<TenderStoryView>;
  /** The supplier's published catalogue item for an offered product (photo, description). */
  offeredItem?(supplierDid: string, product: OfferedProduct): Promise<CatalogItem | null>;
  /** The supplier's PeerLens trust, shown beside what it offered. */
  supplierTrust?(supplierDid: string): Promise<SupplierTrust | null>;
  /** The owner's placed orders, to follow this tender's order once it is sent. */
  placedOrders?(): Promise<PlacedOrdersAnswer>;
  /**
   * The owner's own PeerLens reviews of suppliers, by supplier DID — the
   * first thing Ask for quotes sets a supplier aside by. Absent for a clerk:
   * the owner's reviews are not theirs to read, so only PeerLens applies.
   */
  ownReviews?(): Promise<ReadonlyMap<string, OwnReview>>;
  awardTender(args: { tenderId: string; supplierDid?: string }): Promise<TenderAwardOutcome>;
  sendHeldOrder(approvalId: string): Promise<OrderSendOutcome>;
  provePresence(secret: string): Promise<unknown>;
}

let backendOverride: TenderBackend | null = null;
/** Tests install a backend; the app never calls this. */
export function setTenderBackendForTest(backend: TenderBackend | null): void {
  backendOverride = backend;
}

/** How often an open tender re-reads its ranking while the screen is in front. */
const REFRESH_MS = 10_000;

/**
 * What the supplier offered, as its catalogue shows it: the quote's first line
 * named in the supplier's own signed words, with the catalogue's photo and
 * description when its published catalogue lists the product.
 */
export function offeredItem(
  story: TenderStorySupplierView | undefined,
  published: CatalogItem | null | undefined,
): OfferedItem | null {
  const line = story?.lines[0];
  if (story === undefined || line === undefined) return null;
  const more = story.lines.length > 1 ? ` · and ${String(story.lines.length - 1)} more` : '';
  return {
    name: line.name ?? published?.name ?? line.product.value,
    description: published?.description ?? null,
    quantityText: `${line.quantity.value} ${line.quantity.unit_code}${more}`,
    imageUrl: published?.images?.[0] ?? null,
  };
}

const STATE_LABEL: Record<TenderRankingView['state'], string> = {
  negotiating: 'Dina is asking the suppliers for better prices',
  ready: 'Ready to award',
  awarded: 'Awarded',
  closed: 'Closed',
  no_policy: 'Collecting quotes',
};

const EXCLUDED_LABEL: Record<TenderExclusionReason, string> = {
  no_quote: 'No quote yet',
  declined: 'Declined to quote',
  expired: 'Quote expired',
  currency_mismatch: 'Quoted in another currency',
  over_budget: 'Over your budget',
};

/** Why a supplier was set aside and never asked (PeerLens), in the owner's words. */
const NOT_ASKED_LABEL: Record<TenderNotAskedView['reason'], string> = {
  own_poor_review: 'you rated them poorly on PeerLens',
  low_peerlens_trust: 'low PeerLens trust',
};

/** Core's refusal keys, in words a buyer acts on. */
export function refusalText(key: string): string {
  switch (key) {
    case 'counter_in_flight':
      return 'Dina is still waiting for this supplier to answer a counter-offer. Try again in a few minutes.';
    case 'tender_closed':
      return 'This tender has already been awarded or closed.';
    case 'tender_moved':
      return 'The tender changed while awarding. Refresh and try again.';
    case 'no_awardable_offer':
      return 'No offer can be awarded: every quote is missing, expired or over budget.';
    case 'quote_expired':
      return 'That quote has expired. Ask the supplier for a new one.';
    case 'access_denied':
      return 'Your staff grant does not cover this. Ask the owner.';
    case 'staff_presence_unavailable':
      return 'This business has no staff PIN check set up. Ask the owner.';
    case 'approval_expired':
    case 'unknown_approval':
      return 'The held order has lapsed. Award again to hold a fresh one.';
    case 'approval_already_used':
      return 'This order has already been sent.';
    case 'buyer_sender_unavailable':
      return 'Dina cannot send orders right now. Try again shortly.';
    case 'owner_device_not_connected':
      return CONNECT_OWNER_DEVICE_MESSAGE;
    default:
      return `Dina could not do that (${key.replace(/_/g, ' ')}).`;
  }
}

function money(minor: string, currency: string): string {
  if (!/^\d+$/.test(minor)) return minor;
  // The currency's own decimals (yen none, dinar three), not always two.
  try {
    return `${currency} ${formatMoneyAmount({ currency, minor_units: minor })}`;
  } catch {
    const padded = minor.padStart(3, '0');
    const amount = `${padded.slice(0, -2)}.${padded.slice(-2)}`;
    return currency === '' ? amount : `${currency} ${amount}`;
  }
}

export default function TenderScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ tender_id?: string; as?: string }>();
  const tenderId = typeof params.tender_id === 'string' ? params.tender_id : '';
  const asStaff = params.as === 'staff';
  const staffRef = useRef<StaffCoreClient | null>(null);

  const [view, setView] = useState<TenderRankingView | null>(null);
  const [story, setStory] = useState<ReadonlyMap<string, TenderStorySupplierView>>(new Map());
  // Per supplier, read once: its catalogue item for what it offered, and its
  // PeerLens trust. Both are detail; the ranking never waits for them.
  const [catalog, setCatalog] = useState<ReadonlyMap<string, CatalogItem | null>>(new Map());
  const [trust, setTrust] = useState<ReadonlyMap<string, SupplierTrust | null>>(new Map());
  const detailAsked = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The held order to send: from this visit's award, or the tender's own record. */
  const [heldApproval, setHeldApproval] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The order this tender sent, as My Orders sees it: followed live until it
  // is on its way, so the screen does not stop at "sent".
  const [myOrder, setMyOrder] = useState<PlacedOrderDto | null>(null);
  const router = useRouter();

  const backend = useCallback(async (): Promise<TenderBackend | null> => {
    if (backendOverride !== null) return backendOverride;
    if (!asStaff) {
      const owner = getOwnerCommerceClient();
      if (owner === null) return null;
      return {
        presence: 'passphrase',
        tenderRanking: (id) => owner.tenderRanking(id),
        tenderStory: (id) => owner.tenderStory(id),
        offeredItem: (did, product) => publishedItemFor(did, product),
        supplierTrust: (did) => supplierTrustFor(did),
        placedOrders: () => owner.placedOrders(),
        ownReviews: async () => loadOwnSupplierReviews(await ownerDidHere()),
        awardTender: (args) => owner.awardTender(args),
        sendHeldOrder: (id) => owner.sendHeldOrder(id),
        provePresence: (passphrase) => owner.provePresence(passphrase),
      };
    }
    if (staffRef.current === null) {
      const identity = await loadStaffIdentity();
      if (identity === null) return null;
      staffRef.current = new StaffCoreClient(
        staffTransportFor(identity, makeStaffWebSocket, 30_000),
      );
    }
    const staff = staffRef.current;
    return {
      presence: 'pin',
      tenderRanking: (id) => staff.tenderRanking(id),
      // The clerk sees what the owner sees of the bargaining: the story (the
      // same purchasing check as the ranking), the catalogue photo and the
      // supplier's PeerLens trust (public reads). Placed orders stay the owner's.
      tenderStory: (id) => staff.tenderStory(id),
      offeredItem: (did, product) => publishedItemFor(did, product),
      supplierTrust: (did) => supplierTrustFor(did),
      awardTender: (args) => staff.awardTender(args),
      sendHeldOrder: (id) => staff.sendHeldOrder(id),
      provePresence: (pin) => staff.provePresence(pin),
    };
  }, [asStaff]);

  const reload = useCallback(async () => {
    const client = await backend();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      return;
    }
    if (tenderId === '') {
      setError('No tender was named.');
      return;
    }
    try {
      const answer = await client.tenderRanking(tenderId);
      setView(answer);
      // Offer "Send" only while the order is still held: the tender's own
      // held order when it has one, and nothing once it has gone or lapsed.
      if (answer.held_order === 'sent' || answer.held_order === 'lapsed') setHeldApproval(null);
      else if (answer.approval_id !== undefined) setHeldApproval(answer.approval_id);
      setError(null);
      if (answer.held_order === 'sent' && client.placedOrders !== undefined) {
        try {
          const placed = await client.placedOrders();
          const mine = placed.orders.find(
            (o) =>
              o.tenderId === tenderId &&
              (answer.awarded_supplier_did === undefined ||
                o.supplierDid === answer.awarded_supplier_did),
          );
          if (mine !== undefined) {
            setMyOrder(mine);
            // The send's one-line answer is history once the order is followed live.
            setNotice(null);
          }
        } catch {
          // The tender stands on its own; the order is still in My Orders.
        }
      }
      if (client.tenderStory !== undefined) {
        try {
          const told = await client.tenderStory(tenderId);
          setStory(new Map(told.suppliers.map((s) => [s.supplier_did, s])));
        } catch {
          // The ranking still stands on its own; the story is detail.
        }
      }
    } catch (err) {
      setError(refusalText(errorKeyOf(err)));
    }
  }, [backend, tenderId]);

  useEffect(() => {
    const wanted = [...story.values()].flatMap((s) => {
      const product = s.lines[0]?.product;
      return product === undefined || detailAsked.current.has(s.supplier_did)
        ? []
        : [{ did: s.supplier_did, product }];
    });
    if (wanted.length === 0) return;
    for (const w of wanted) detailAsked.current.add(w.did);
    void (async () => {
      const client = await backend();
      if (client === null) return;
      await Promise.all(
        wanted.map(async ({ did, product }) => {
          const [item, rated] = await Promise.all([
            client.offeredItem?.(did, product).catch(() => null) ?? null,
            client.supplierTrust?.(did).catch(() => null) ?? null,
          ]);
          setCatalog((prev) => new Map(prev).set(did, item));
          setTrust((prev) => new Map(prev).set(did, rated));
        }),
      );
    })();
  }, [story, backend]);

  // Quotes and counters land while the owner watches (Ask for quotes opens
  // this screen right after sending), so refresh while the tender can still
  // change; an awarded or closed tender is final — except that its SENT order
  // is followed until it is on its way (or has no track: refused, countered).
  const orderSettled = myOrder !== null && (orderStepsReached(myOrder) ?? 5) >= 5;
  const liveRef = useRef(true);
  liveRef.current =
    view === null ||
    (view.state !== 'awarded' && view.state !== 'closed') ||
    (view.state === 'awarded' && view.held_order === 'sent' && !orderSettled);
  useFocusEffect(
    useCallback(() => {
      void reload();
      const timer = setInterval(() => {
        if (liveRef.current) void reload();
      }, REFRESH_MS);
      return () => clearInterval(timer);
    }, [reload]),
  );

  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (secret) => {
      const client = await backend();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(secret);
    },
    onError: (err) => setNotice(refusalText(errorKeyOf(err))),
    onSettled: () => void reload(),
    secretKind: asStaff ? 'pin' : 'passphrase',
    reason: asStaff
      ? 'Awarding places an order, so enter your staff PIN.'
      : 'Awarding places an order, so Dina checks a person is here.',
  });

  /** Run a tap; a lapsed presence raises the passphrase or PIN sheet, then retries. */
  const withPresence = useCallback(
    async (operation: () => Promise<void>) => {
      setBusy(true);
      setNotice(null);
      try {
        await runGated(operation);
      } finally {
        setBusy(false);
      }
    },
    [runGated],
  );

  const award = useCallback(
    (supplierDid: string) =>
      withPresence(async () => {
        const client = await backend();
        if (client === null) return;
        const outcome = await client.awardTender({ tenderId, supplierDid });
        if (outcome.kind === 'pending_approval') {
          setNotice(
            'This order is over your limit, so the owner has to approve it. Award again once they do.',
          );
          return;
        }
        setHeldApproval(outcome.approvalId);
        setNotice('Order held. Review it, then send it to the supplier.');
      }),
    [backend, tenderId, withPresence],
  );

  const send = useCallback(
    () =>
      withPresence(async () => {
        const client = await backend();
        if (client === null || heldApproval === null) return;
        const outcome = await client.sendHeldOrder(heldApproval);
        setNotice(
          outcome.kind === 'pending_approval'
            ? 'This order is over your limit, so the owner has to approve it. Send again once they do.'
            : outcome.headline,
        );
      }),
    [backend, heldApproval, withPresence],
  );

  const canAward =
    view !== null &&
    (view.state === 'ready' || view.state === 'no_policy' || view.state === 'negotiating');
  const awardedTo = view?.awarded_supplier_did ?? '';

  // Core's tender knows suppliers by DID only; show the owner's name for
  // them (contact, else listing), and the DID only where no name is known or
  // two suppliers share one.
  const [names, setNames] = useState<Map<string, string | null>>(new Map());
  const refsKey =
    view === null
      ? ''
      : [
          ...view.ranked.map((o) => `${o.supplier_did}|${o.service_rkey}`),
          ...view.excluded.map((r) => `${r.supplier_did}|${r.service_rkey ?? 'self'}`),
          ...(view.not_asked ?? []).map((n) => `${n.supplier_did}|${n.service_rkey}`),
        ].join(',');
  useEffect(() => {
    if (refsKey === '') return;
    let live = true;
    const refs = refsKey.split(',').map((pair) => {
      const [supplierDid = '', serviceRkey = 'self'] = pair.split('|');
      return { supplierDid, serviceRkey };
    });
    void supplierNamesHere(refs).then((resolved) => {
      if (live) setNames(resolved);
    });
    return () => {
      live = false;
    };
  }, [refsKey]);
  const labels = useMemo(
    () =>
      supplierLabels(
        [...(view?.ranked ?? []), ...(view?.excluded ?? []), ...(view?.not_asked ?? [])].map(
          (row) => ({
            supplierDid: row.supplier_did,
            name: names.get(row.supplier_did) ?? null,
          }),
        ),
      ),
    [names, view],
  );
  const labelOf = (did: string): string => labels.get(did) ?? shortDid(did);

  /**
   * Award, after a word of warning when the supplier is one Ask for quotes
   * would set aside — by the same rule: the owner's own poor review first,
   * else a low PeerLens score over enough reviews to mean something. The
   * owner may still award. The check never rests on trust still loading in
   * the background: a supplier with no answer yet is looked up here first.
   */
  const awardChecked = async (supplierDid: string): Promise<void> => {
    const client = await backend();
    if (client === null) return;
    let rated = trust.get(supplierDid);
    if (rated === undefined) {
      rated = (await client.supplierTrust?.(supplierDid).catch(() => null)) ?? null;
      const known = rated;
      setTrust((prev) => new Map(prev).set(supplierDid, known));
    }
    // Read afresh for every award: the screen stays mounted, and a review the
    // owner wrote since (or a lookup that failed last time) must count now.
    const ownReviews =
      (await client.ownReviews?.().catch(() => null)) ?? new Map<string, OwnReview>();
    const ownReview = ownReviews.get(supplierDid);
    const poor = setAsideFor({
      ...(ownReview !== undefined ? { ownReview } : {}),
      trustScore: rated?.score ?? null,
      reviewCount: rated?.reviewCount ?? null,
    });
    if (poor !== null) {
      const name = labelOf(supplierDid);
      const reviews =
        rated?.reviewCount !== null && rated?.reviewCount !== undefined
          ? ` (${String(rated.reviewCount)} reviews)`
          : '';
      const why =
        poor.reason === 'own_poor_review'
          ? `You rated ${name} poorly on PeerLens.`
          : `${name} has poor reviews on PeerLens${reviews}.`;
      const ok = await confirmDecision(
        `Award to ${name}?`,
        `${why} Award anyway?`,
        'Award anyway',
        false,
      );
      if (!ok) return;
    }
    await award(supplierDid);
  };
  const heading = useMemo(() => {
    if (view === null) return '';
    // Before any supplier has answered there is nothing to negotiate yet.
    const waiting =
      view.ranked.length === 0 &&
      view.excluded.length > 0 &&
      view.excluded.every((row) => row.reason === 'no_quote');
    return waiting && (view.state === 'negotiating' || view.state === 'no_policy')
      ? 'Waiting for the suppliers to quote'
      : STATE_LABEL[view.state];
  }, [view]);

  return (
    <View style={styles.container} testID="tender-screen">
      <Stack.Screen options={{ title: 'Tender' }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {view === null && error === null && <ActivityIndicator style={styles.spinner} />}
        {error !== null && (
          <Text style={styles.error} testID="tender-error">
            {error}
          </Text>
        )}
        {view !== null && (
          <>
            <Text style={styles.state} testID="tender-state">
              {heading}
            </Text>
            {view.target_total !== undefined && view.currency !== undefined && (
              <Text style={styles.meta}>
                Target {money(view.target_total, view.currency)}
                {view.budget_ceiling !== undefined
                  ? ` · budget ${money(view.budget_ceiling, view.currency)}`
                  : ''}
              </Text>
            )}
            {view.state === 'negotiating' && (
              <Text style={styles.meta}>
                You can award now, or wait: Dina tells you once when the tender is ready.
              </Text>
            )}

            <Text style={styles.sectionTitle}>Offers</Text>
            {view.ranked.length === 0 && (
              <Text style={styles.empty} testID="tender-no-offers">
                No offer can be awarded yet.
              </Text>
            )}
            {view.ranked.map((offer, index) => (
              <View
                key={offer.supplier_did}
                style={styles.offer}
                testID={`tender-offer-${offer.supplier_did}`}
              >
                <View style={styles.offerText}>
                  <Text style={styles.offerTitle}>
                    {index === 0 ? 'Best offer · ' : ''}
                    {labelOf(offer.supplier_did)}
                  </Text>
                  {(() => {
                    const item = offeredItem(
                      story.get(offer.supplier_did),
                      catalog.get(offer.supplier_did),
                    );
                    return item === null ? null : (
                      <OfferedItemCard
                        item={item}
                        trust={trust.get(offer.supplier_did) ?? null}
                        testID={`tender-offered-${offer.supplier_did}`}
                      />
                    );
                  })()}
                  <Text style={styles.offerTotal} testID={`tender-total-${offer.supplier_did}`}>
                    {money(offer.total_minor, offer.currency)}
                  </Text>
                  <BargainingTimeline
                    story={story.get(offer.supplier_did)}
                    supplierLabel={labelOf(offer.supplier_did)}
                    testID={`tender-bargaining-${offer.supplier_did}`}
                  />
                  <Text style={styles.meta}>
                    {offer.credit_days > 0 ? `${String(offer.credit_days)} days' credit · ` : ''}
                    valid until {offer.valid_until.slice(0, 10)}
                    {offer.revision !== '1'
                      ? ` · revised ${String(Number(offer.revision) - 1)}×`
                      : ''}
                  </Text>
                  {offer.comparison_cost_minor !== offer.total_minor && (
                    <Text style={styles.meta}>
                      Costs you {money(offer.comparison_cost_minor, offer.currency)} after the
                      credit
                    </Text>
                  )}
                </View>
                {canAward && (
                  <Pressable
                    style={[styles.awardButton, busy && styles.disabled]}
                    disabled={busy}
                    onPress={() => void awardChecked(offer.supplier_did)}
                    testID={`tender-award-${offer.supplier_did}`}
                    accessibilityRole="button"
                  >
                    <Text style={styles.awardLabel}>Award</Text>
                  </Pressable>
                )}
                {view.state === 'awarded' && awardedTo === offer.supplier_did && (
                  <Text style={styles.awardedTag}>Awarded</Text>
                )}
              </View>
            ))}

            {view.excluded.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Not in the running</Text>
                {view.excluded.map((row) => {
                  // The offer's own price beside why it is out: an exclusion
                  // with the number hidden reads as arbitrary.
                  const told = story.get(row.supplier_did);
                  const head = told?.revisions.at(-1);
                  return (
                    <View key={row.supplier_did}>
                      <Text style={styles.meta} testID={`tender-excluded-${row.supplier_did}`}>
                        {labelOf(row.supplier_did)} —{' '}
                        {head !== undefined
                          ? `${money(head.total.minor_units, head.total.currency)} · `
                          : ''}
                        {EXCLUDED_LABEL[row.reason]}
                      </Text>
                      {(() => {
                        const item = offeredItem(told, catalog.get(row.supplier_did));
                        return item === null ? null : (
                          <OfferedItemCard
                            item={item}
                            trust={trust.get(row.supplier_did) ?? null}
                            testID={`tender-offered-${row.supplier_did}`}
                          />
                        );
                      })()}
                      <BargainingTimeline
                        story={told}
                        supplierLabel={labelOf(row.supplier_did)}
                        testID={`tender-bargaining-${row.supplier_did}`}
                      />
                    </View>
                  );
                })}
              </>
            )}

            {(view.not_asked ?? []).length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Not asked</Text>
                {(view.not_asked ?? []).map((row) => (
                  <View key={row.supplier_did} testID={`tender-not-asked-${row.supplier_did}`}>
                    <Text style={styles.meta}>
                      {labelOf(row.supplier_did)} —{' '}
                      {row.listed_from !== undefined
                        ? `listed from ${money(row.listed_from.minor_units, row.listed_from.currency)} · `
                        : ''}
                      {NOT_ASKED_LABEL[row.reason]}
                    </Text>
                    {row.note !== '' && (
                      <Text style={styles.meta} numberOfLines={2}>
                        {`“${row.note}”`}
                      </Text>
                    )}
                  </View>
                ))}
              </>
            )}

            {heldApproval === null && view.held_order === 'sent' && (
              <View style={styles.heldCard} testID="tender-sent">
                <Text style={styles.offerTitle}>Your order</Text>
                <Text style={styles.meta} testID="tender-order-headline">
                  {myOrder?.headline ?? 'Order sent to the supplier.'}
                </Text>
                {myOrder !== null && (
                  <OrderProgress
                    order={myOrder}
                    supplier={labelOf(myOrder.supplierDid)}
                    testID="tender-order-progress"
                  />
                )}
                <Pressable
                  onPress={() => router.push('/orders')}
                  testID="tender-open-orders"
                  accessibilityRole="link"
                >
                  <Text style={styles.link}>Open in My Orders</Text>
                </Pressable>
              </View>
            )}
            {heldApproval === null && view.held_order === 'lapsed' && (
              <Text style={styles.meta} testID="tender-lapsed">
                The held order lapsed before it was sent.
              </Text>
            )}
            {heldApproval !== null && (
              <View style={styles.heldCard} testID="tender-held">
                <Text style={styles.offerTitle}>Order held</Text>
                <Text style={styles.meta}>
                  Nothing has gone to the supplier yet. Send it when you are ready.
                </Text>
                <Pressable
                  style={[styles.sendButton, busy && styles.disabled]}
                  disabled={busy}
                  onPress={() => void send()}
                  testID="tender-send"
                  accessibilityRole="button"
                >
                  <Text style={styles.sendLabel}>Send order</Text>
                </Pressable>
              </View>
            )}
          </>
        )}
        {notice !== null && (
          <Text style={styles.notice} testID="tender-notice">
            {notice}
          </Text>
        )}
        {busy && <ActivityIndicator style={styles.spinner} />}
      </ScrollView>

      <PresenceSheet {...presenceSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  spinner: { marginTop: spacing.md },
  error: { ...textStyles.body, color: colors.error },
  state: { ...textStyles.body, fontWeight: '600', color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  empty: { ...textStyles.body, color: colors.textSecondary },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  offer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  offerText: { flex: 1 },
  offerTitle: { ...textStyles.body, color: colors.textPrimary },
  offerTotal: { ...textStyles.body, fontWeight: '600', color: colors.textPrimary, marginTop: 2 },
  awardButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  awardLabel: { ...textStyles.button, color: colors.bgPrimary },
  awardedTag: { ...textStyles.caption, color: colors.textSecondary, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  link: { ...textStyles.caption, color: colors.accent, marginTop: spacing.sm },
  heldCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  sendLabel: { ...textStyles.button, color: colors.bgPrimary },
  notice: { ...textStyles.body, color: colors.textPrimary, marginTop: spacing.md },
});
