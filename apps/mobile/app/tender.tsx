/**
 * Tender (NEGOTIATION_PLAN §4.5, §4.7) — the ranked offers of one tender, an
 * Award button on each, and Send once the order is held. One screen for the
 * owner (in-process client) and a clerk (`as=staff`, the sealed relay).
 *
 * The tender is drawn as Dina's tender card (HOSTED_DINA §6.4):
 * `buildTenderCard` from `@dina/core`, the builder the owner's Dina page and
 * the owner's ChatGPT dot use, drawn by `SafeCardRenderer`. This screen loads
 * what the card shows (names and trust looked up here) and carries its
 * buttons.
 *
 * Every gate is Core's: presence, the clerk's grant and cap, a counter still
 * in flight, a tender already awarded. The screen carries the taps and says
 * what Core answered — including "waiting for the owner" when a clerk's award
 * or send is over the cap, which is a normal outcome, not an error.
 */

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { buildTenderCard, orderStepsReached, StaffCoreClient, staffTransportFor } from '@dina/core';

import { type SupplierTrust } from '../src/components/OfferedItemCard';
import { PresenceSheet } from '../src/components/PresenceSheet';
import { SafeCardRenderer } from '../src/components/SafeCardRenderer';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { confirmDecision } from '../src/services/confirm_decision';
import { supplierTrustFor } from '../src/services/offered_catalog';
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
import { colors, spacing, textStyles } from '../src/theme';

import type {
  OrderSendOutcome,
  PlacedOrderDto,
  PlacedOrdersAnswer,
  TenderAwardOutcome,
  TenderRankingView,
  TenderStoryView,
} from '@dina/core';
import type { CardAction } from '@dina/protocol';

/** What the screen needs from either client. */
export interface TenderBackend {
  presence: 'passphrase' | 'pin';
  tenderRanking(tenderId: string): Promise<TenderRankingView>;
  /** How each supplier got here; absent where the client cannot read it. */
  tenderStory?(tenderId: string): Promise<TenderStoryView>;
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
  awardTender(args: {
    tenderId: string;
    supplierDid?: string;
    alternativeId?: string;
  }): Promise<TenderAwardOutcome>;
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

export default function TenderScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ tender_id?: string; as?: string }>();
  const tenderId = typeof params.tender_id === 'string' ? params.tender_id : '';
  const asStaff = params.as === 'staff';
  const staffRef = useRef<StaffCoreClient | null>(null);

  const [view, setView] = useState<TenderRankingView | null>(null);
  const [story, setStory] = useState<TenderStoryView | null>(null);
  // Per supplier, read once: its PeerLens trust. Detail; the card never waits for it.
  const [trust, setTrust] = useState<ReadonlyMap<string, SupplierTrust | null>>(new Map());
  const trustAsked = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The order this tender sent, as My Orders sees it: followed live until it
  // is on its way, so the card does not stop at "sent".
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
      // same purchasing check as the ranking) and the supplier's PeerLens
      // trust (a public read). Placed orders stay the owner's.
      tenderStory: (id) => staff.tenderStory(id),
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
          setStory(await client.tenderStory(tenderId));
        } catch {
          // The ranking still stands on its own; the story is detail.
        }
      }
    } catch (err) {
      setError(refusalText(errorKeyOf(err)));
    }
  }, [backend, tenderId]);

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
    // Each supplier's PeerLens trust, once.
    const wanted = [...new Set(refs.map((r) => r.supplierDid))].filter(
      (did) => did !== '' && !trustAsked.current.has(did),
    );
    for (const did of wanted) trustAsked.current.add(did);
    if (wanted.length > 0) {
      void (async () => {
        const client = await backend();
        if (client === null || client.supplierTrust === undefined) return;
        const lookup = client.supplierTrust;
        await Promise.all(
          wanted.map(async (did) => {
            const rated = await lookup(did).catch(() => null);
            setTrust((prev) => new Map(prev).set(did, rated));
          }),
        );
      })();
    }
    return () => {
      live = false;
    };
  }, [refsKey, backend]);
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
  const labelOf = useCallback((did: string): string => labels.get(did) ?? shortDid(did), [labels]);

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
    (supplierDid: string, alternativeId?: string) =>
      withPresence(async () => {
        const client = await backend();
        if (client === null) return;
        const outcome = await client.awardTender({
          tenderId,
          supplierDid,
          ...(alternativeId === undefined ? {} : { alternativeId }),
        });
        if (outcome.kind === 'pending_approval') {
          setNotice(
            'This order is over your limit, so the owner has to approve it. Award again once they do.',
          );
          return;
        }
        setNotice('Order held. Review it, then send it to the supplier.');
      }),
    [backend, tenderId, withPresence],
  );

  const send = useCallback(
    (approvalId: string) =>
      withPresence(async () => {
        const client = await backend();
        if (client === null) return;
        const outcome = await client.sendHeldOrder(approvalId);
        setNotice(
          outcome.kind === 'pending_approval'
            ? 'This order is over your limit, so the owner has to approve it. Send again once they do.'
            : outcome.headline,
        );
      }),
    [backend, withPresence],
  );

  /**
   * Award, after a word of warning when the supplier is one Ask for quotes
   * would set aside — by the same rule: the owner's own poor review first,
   * else a low PeerLens score over enough reviews to mean something. The
   * owner may still award. The check never rests on trust still loading in
   * the background: a supplier with no answer yet is looked up here first.
   */
  const awardChecked = async (supplierDid: string, alternativeId?: string): Promise<void> => {
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
    await award(supplierDid, alternativeId);
  };

  /** A card button, carried out here with this screen's own gates. */
  const onAction = (action: CardAction): void => {
    if (action.command === 'tender.award' && action.params.supplier_did !== undefined) {
      void awardChecked(action.params.supplier_did, action.params.alternative_id);
    } else if (action.command === 'tender.send' && action.params.approval_id !== undefined) {
      void send(action.params.approval_id);
    }
  };

  const card = useMemo(
    () =>
      view === null
        ? null
        : buildTenderCard({
            ranking: view,
            story,
            nameOf: (did) => labelOf(did),
            trustOf: (did) => {
              const rated = trust.get(did);
              return rated === null || rated === undefined
                ? null
                : { score: rated.score, reviews: rated.reviewCount ?? 0 };
            },
            order:
              myOrder === null
                ? null
                : { headline: myOrder.headline, stepsReached: orderStepsReached(myOrder) },
            audience: asStaff ? 'staff' : 'owner',
            buttons: true,
          }),
    [view, story, labelOf, trust, myOrder, asStaff],
  );

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
        {card !== null && (
          <View testID="tender-card">
            <SafeCardRenderer spec={card} onAction={onAction} actionsDisabled={busy} />
          </View>
        )}
        {view?.held_order === 'sent' && (
          <Pressable
            onPress={() => router.push('/orders')}
            testID="tender-open-orders"
            accessibilityRole="link"
          >
            <Text style={styles.link}>Open in My Orders</Text>
          </Pressable>
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
  link: { ...textStyles.caption, color: colors.accent, marginTop: spacing.sm },
  notice: { ...textStyles.body, color: colors.textPrimary, marginTop: spacing.md },
});
