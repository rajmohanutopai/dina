/**
 * My Orders — the buyer's order home: the orders already PLACED (Core's
 * `/v1/commerce/orders/placed` — sent, accepted, a payment link, paid, on the
 * way) and the photographed drafts (§5 of the photo-commerce design), plus the
 * two actions that start one: photograph an order sheet, or ask for quotes.
 *
 * A placed order is rendered as Core describes it: the headline is Core's
 * shared projection, the chips read the evidence Core summarised, and the one
 * action here — "Open payment link" — opens an https checkout page and does
 * nothing else (the same rule the approval card follows).
 *
 * Capture → bounded, EXIF-stripped artifacts + a single-use egress
 * authorization (order photo_capture); extraction through the §3 gate
 * creates the draft with every machine-read value `proposed`; the buyer
 * lands exactly where the review work is: the order-draft screen.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { formatMoneyAmount } from '@dina/core';

import { BargainingTimeline } from '../src/components/BargainingTimeline';
import { OfferedItemCard, type SupplierTrust } from '../src/components/OfferedItemCard';
import { OrderProgress, orderStepsReached } from '../src/components/OrderProgress';
import { PresenceSheet } from '../src/components/PresenceSheet';
import { safeHttpsUrl } from '../src/components/safe_url';
import { ShopOrders } from '../src/components/ShopOrders';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import {
  activateBuyerInstall,
  buyerInstallConsentSummary,
  buyerInstallStatus,
} from '../src/services/commerce_install';
import { confirmDecision } from '../src/services/confirm_decision';
import { publishedItemFor, supplierTrustFor } from '../src/services/offered_catalog';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { errorKeyOf, ownerErrorText } from '../src/services/owner_errors';
import { normalizePickedPages } from '../src/services/photo_pipeline';
import { showMessage } from '../src/services/show_message';
import {
  placedOrderRefs,
  shortDid,
  supplierLabels,
  supplierNamesHere,
} from '../src/services/supplier_names';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type {
  CatalogItem,
  OrderDraftSummary,
  PlacedOrderDto,
  TenderStorySupplierView,
} from '@dina/core';

const STATE_LABEL: Record<OrderDraftSummary['state'], string> = {
  open: 'Needs review',
  awaiting_answers: 'Waiting on suppliers',
  closed: 'Closed',
};

/** The order's own state, in one word — Core's headline says the rest. */
const PLACED_STATE_CHIP: Record<PlacedOrderDto['state'], string> = {
  submitted_unconfirmed: 'Sent',
  outcome_unknown: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  countered: 'Countered',
  never_received: 'Not received',
};

type PlacedProgress = NonNullable<PlacedOrderDto['progress']>;

const PAYMENT_CHIP: Record<NonNullable<PlacedProgress['payment']>['state'], string> = {
  authorized: 'Payment authorised',
  captured: 'Payment captured',
  refunded: 'Refunded',
  failed: 'Payment failed',
};

const FULFILMENT_CHIP: Record<NonNullable<PlacedProgress['fulfilment']>['state'], string> = {
  production_started: 'In production',
  ready: 'Ready',
  handed_to_carrier: 'On the way',
};

function money(amount: { currency: string; minor_units: string }): string {
  // The currency's own decimals (yen none, dinar three), not always two.
  try {
    return `${amount.currency} ${formatMoneyAmount(amount)}`;
  } catch {
    return `${amount.currency} ${amount.minor_units}`;
  }
}

/** Has the buyer's side of paying already happened (or been reported)? */
function paid(progress: PlacedProgress): boolean {
  return progress.paymentRecorded || progress.payment?.state === 'captured';
}

/**
 * The chips a placed order carries, in the order the trade happens: the
 * order's state, the payment link, the payment, the buyer's own record, the
 * fulfilment step. Each is one fact Core reported — none is inferred here.
 */
function placedOrderChips(order: PlacedOrderDto): string[] {
  const chips = [PLACED_STATE_CHIP[order.state]];
  const progress = order.progress;
  if (progress === null) return chips;
  if (progress.checkoutLink !== null && !paid(progress)) {
    chips.push(progress.checkoutLink.expired ? 'Payment link expired' : 'Payment link received');
  }
  if (progress.payment !== null) chips.push(PAYMENT_CHIP[progress.payment.state]);
  if (progress.paymentRecorded) chips.push('Recorded as paid');
  if (progress.fulfilment !== null) chips.push(FULFILMENT_CHIP[progress.fulfilment.state]);
  return chips;
}

/** The https link to offer, or null: only a live link on an order not yet paid. */
function payableLink(order: PlacedOrderDto): string | null {
  const progress = order.progress;
  if (progress === null || progress.checkoutLink === null) return null;
  if (progress.checkoutLink.expired || paid(progress)) return null;
  return safeHttpsUrl(progress.checkoutLink.url);
}

/** How often My Orders reads again while an order is still moving. */
const ORDERS_REFRESH_MS = 10_000;

export default function OrdersScreen(): React.ReactElement {
  const router = useRouter();
  const [drafts, setDrafts] = useState<OrderDraftSummary[]>([]);
  const [placed, setPlaced] = useState<PlacedOrderDto[]>([]);
  const [placedError, setPlacedError] = useState<string | null>(null);
  // Shop (UCP) orders load on their own; the empty state waits for none of either kind.
  const [shopOrderCount, setShopOrderCount] = useState(0);
  // Supplier names for placed orders, as the listing names resolve.
  const [names, setNames] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderingEnabled, setOrderingEnabled] = useState(true);
  // What each placed order shows beyond Core's list, read once per order: the
  // item as the supplier's catalogue shows it, the supplier's PeerLens trust,
  // and — for an order from a tender — how its price was bargained.
  const [catalog, setCatalog] = useState<ReadonlyMap<string, CatalogItem | null>>(new Map());
  const [trust, setTrust] = useState<ReadonlyMap<string, SupplierTrust | null>>(new Map());
  const [stories, setStories] = useState<ReadonlyMap<string, TenderStorySupplierView>>(new Map());
  const detailAsked = useRef(new Set<string>());
  const [enabling, setEnabling] = useState(false);

  const reload = useCallback(async () => {
    // "Enable ordering" shows only when Core says the buyer pack is absent;
    // an unreachable read shows nothing rather than a consent for authority
    // the owner may already have granted.
    void buyerInstallStatus().then((status) => setOrderingEnabled(status.state !== 'absent'));
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      setLoading(false);
      return;
    }
    // Both lists, independently: a node without commerce (503) still has its
    // drafts, and a drafts failure must not hide an order already sent.
    const [draftsAnswer, placedAnswer] = await Promise.allSettled([
      client.orderDrafts(),
      client.placedOrders(),
    ]);
    if (draftsAnswer.status === 'fulfilled') {
      setDrafts(draftsAnswer.value.drafts);
      setError(null);
    } else {
      setError(ownerErrorText(draftsAnswer.reason));
    }
    if (placedAnswer.status === 'fulfilled') {
      setPlaced(placedAnswer.value.orders);
      setPlacedError(null);
      void supplierNamesHere(placedOrderRefs(placedAnswer.value.orders))
        .then(setNames)
        .catch(() => {
          /* keep what we know; the DID shows for the rest */
        });
    } else if (errorKeyOf(placedAnswer.reason) === 'commerce_unavailable') {
      // No commerce on this node: nothing was placed, and that is not an error.
      setPlaced([]);
      setPlacedError(null);
    } else {
      setPlacedError(ownerErrorText(placedAnswer.reason));
    }
    setLoading(false);
  }, []);

  // A payment link, a payment or a fulfilment step lands while the owner
  // watches (the supplier acts in its own system), so read again every few
  // seconds while any order is still on its way; a settled list stays still.
  const liveRef = useRef(false);
  liveRef.current = placed.some((order) => (orderStepsReached(order) ?? 5) < 5);
  useFocusEffect(
    useCallback(() => {
      void reload();
      const timer = setInterval(() => {
        if (liveRef.current) void reload();
      }, ORDERS_REFRESH_MS);
      return () => clearInterval(timer);
    }, [reload]),
  );

  useEffect(() => {
    const client = getOwnerCommerceClient();
    for (const order of placed) {
      const key = `${order.supplierDid}:${order.purchaseOrderId}`;
      if (detailAsked.current.has(key)) continue;
      detailAsked.current.add(key);
      const product = order.lines[0]?.product;
      if (product !== undefined) {
        void publishedItemFor(order.supplierDid, product).then((item) =>
          setCatalog((prev) => new Map(prev).set(key, item)),
        );
      }
      if (!detailAsked.current.has(`trust:${order.supplierDid}`)) {
        detailAsked.current.add(`trust:${order.supplierDid}`);
        void supplierTrustFor(order.supplierDid).then((rated) =>
          setTrust((prev) => new Map(prev).set(order.supplierDid, rated)),
        );
      }
      const tenderId = order.tenderId;
      if (tenderId !== null && client !== null) {
        client
          .tenderStory(tenderId)
          .then((told) => {
            const mine = told.suppliers.find((s) => s.supplier_did === order.supplierDid);
            if (mine !== undefined) setStories((prev) => new Map(prev).set(key, mine));
          })
          .catch(() => {
            /* the bargaining is detail; the order stands without it */
          });
      }
    }
  }, [placed]);

  const capture = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) return;
    setCapturing(true);
    try {
      const picker = await import('expo-image-picker');
      const picked = await picker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 5,
        base64: true,
        quality: 0.9,
      });
      if (picked.canceled || picked.assets.length === 0) return;
      // An iPhone camera photo is HEIC; anything not already JPEG/PNG is
      // transcoded on-device before the capture gate sniffs it.
      const pages = await normalizePickedPages(picked.assets);
      if (pages.length === 0) {
        showMessage('Nothing to read', 'The photos could not be loaded.');
        return;
      }
      const captured = await client.orderPhotoCapture(pages);
      const extracted = await client.orderPhotoExtract({
        draftId: captured.draft_id,
        authorizationId: captured.authorization_id,
      });
      router.push({
        pathname: '/order-draft',
        params: { draft_id: extracted.draft.draftId },
      });
    } catch (err) {
      const key = errorKeyOf(err);
      if (key === 'no_egress_broker' || key === 'provider_failed') {
        showMessage(
          'No photo reader configured',
          'Starter credits cover photo reading once claimed. Or add an OpenAI or OpenRouter key under Settings → AI Providers, then try again.',
        );
      } else {
        showMessage('Could not read the photo', ownerErrorText(err));
      }
    } finally {
      setCapturing(false);
      void reload();
    }
  }, [reload, router]);

  const abandonDraft = useCallback(
    (draft: OrderDraftSummary) => {
      void confirmDecision(
        'Abandon this order?',
        'The draft and its photographs are removed. A conversation whose order may already be on its way holds the draft until that settles.',
        'Abandon',
        true,
        'Keep',
      ).then((ok) => {
        if (!ok) return;
        void (async () => {
          try {
            await getOwnerCommerceClient()?.orderAbandon(draft.draft_id);
          } catch (err) {
            showMessage('Held', ownerErrorText(err));
          }
          void reload();
        })();
      });
    },
    [reload],
  );

  // Binding the pack's runner and consenting hand out authority, so Core asks
  // for a person present (§3.8); the sheet asks and the activation runs again.
  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => showMessage('Could not enable ordering', ownerErrorText(err)),
    onSettled: () => void reload(),
    reason:
      'Installing the buyer pack lets Dina place orders for you, so Dina checks a person is here.',
  });

  const enableOrdering = useCallback(() => {
    const consent = buyerInstallConsentSummary();
    void confirmDecision(
      `Install ${consent.name}?`,
      `This lets your Dina place orders with suppliers you choose. It may:\n\n${consent.capabilities.map((c) => `• ${c}`).join('\n')}`,
      'Install',
      false,
      'Not now',
    ).then((ok) => {
      if (!ok) return;
      setEnabling(true);
      void runGated(async () => {
        const outcome = await activateBuyerInstall();
        if (!outcome.ok) showMessage('Could not enable ordering', outcome.error);
      }).finally(() => setEnabling(false));
    });
  }, [runGated]);

  return (
    <View style={styles.container} testID="orders-screen">
      <Stack.Screen options={{ title: 'My Orders' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {!orderingEnabled && (
          <Pressable
            testID="orders-enable"
            style={styles.enableCard}
            disabled={enabling}
            onPress={enableOrdering}
          >
            {enabling ? (
              <ActivityIndicator />
            ) : (
              <>
                <Text style={styles.enableTitle}>Enable ordering on this phone</Text>
                <Text style={styles.enableBody}>
                  One-time consent: install the buyer pack so approved orders can be placed under
                  your authority.
                </Text>
              </>
            )}
          </Pressable>
        )}
        <Pressable
          testID="orders-capture"
          style={[styles.captureButton, capturing && styles.captureBusy]}
          disabled={capturing}
          onPress={() => void capture()}
        >
          {capturing ? (
            <ActivityIndicator color={colors.bgPrimary} />
          ) : (
            <Text style={styles.captureLabel}>Photograph an order</Text>
          )}
        </Pressable>
        <Text style={styles.captureHint}>
          Dina reads the lines off the photo. You confirm every quantity before anything reaches a
          supplier.
        </Text>
        <Pressable
          testID="orders-ask-quotes"
          style={styles.askButton}
          onPress={() => router.push({ pathname: '/ask-quotes', params: { from: '/orders' } })}
          accessibilityRole="button"
        >
          <Text style={styles.askLabel}>Ask suppliers for quotes</Text>
        </Pressable>

        {loading && <ActivityIndicator style={styles.spinner} />}
        {error !== null && (
          <Text style={styles.error} testID="orders-error">
            {error}
          </Text>
        )}
        {/* One sentence, not two, when both lists failed the same way
            (e.g. a browser not connected as the owner). */}
        {placedError !== null && placedError !== error && (
          <Text style={styles.error} testID="orders-placed-error">
            {placedError}
          </Text>
        )}
        {!loading &&
          error === null &&
          drafts.length === 0 &&
          placed.length === 0 &&
          shopOrderCount === 0 && (
            <Text style={styles.empty} testID="orders-empty">
              No orders yet. Photograph an order sheet or ask suppliers for quotes to start one.
            </Text>
          )}
        <ShopOrders onCount={setShopOrderCount} />
        {placed.length > 0 && (
          <Text style={styles.sectionTitle} testID="orders-placed-title">
            Placed orders
          </Text>
        )}
        {(() => {
          const labels = supplierLabels(
            placed.map((o) => ({
              supplierDid: o.supplierDid,
              name: o.supplierName ?? names.get(o.supplierDid) ?? null,
            })),
          );
          return placed.map((order) => {
            const link = payableLink(order);
            const key = `${order.supplierDid}:${order.purchaseOrderId}`;
            return (
              <View
                key={key}
                testID={`placed-order-${order.purchaseOrderId}`}
                style={styles.placedCard}
              >
                <View style={styles.placedHeader}>
                  <Text
                    style={styles.placedSupplier}
                    numberOfLines={1}
                    testID={`placed-order-supplier-${order.purchaseOrderId}`}
                  >
                    {labels.get(order.supplierDid) ?? shortDid(order.supplierDid)}
                  </Text>
                  {order.total !== null && (
                    <Text
                      style={styles.placedTotal}
                      testID={`placed-order-total-${order.purchaseOrderId}`}
                    >
                      {money(order.total)}
                    </Text>
                  )}
                </View>
                <Text
                  style={styles.placedHeadline}
                  testID={`placed-order-headline-${order.purchaseOrderId}`}
                >
                  {order.headline}
                </Text>
                {order.lines[0] !== undefined &&
                  (() => {
                    const line = order.lines[0];
                    const published = catalog.get(key);
                    const more =
                      order.lines.length > 1 ? ` · and ${String(order.lines.length - 1)} more` : '';
                    return (
                      <OfferedItemCard
                        item={{
                          name: line.name ?? published?.name ?? line.product.value,
                          description: published?.description ?? null,
                          quantityText: `${line.quantity.value} ${line.quantity.unit_code}${more}`,
                          imageUrl: published?.images?.[0] ?? null,
                        }}
                        trust={trust.get(order.supplierDid) ?? null}
                        testID={`placed-order-item-${order.purchaseOrderId}`}
                      />
                    );
                  })()}
                {order.detail !== null && <Text style={styles.draftMeta}>{order.detail}</Text>}
                <OrderProgress
                  order={order}
                  supplier={labels.get(order.supplierDid) ?? shortDid(order.supplierDid)}
                  testID={`placed-order-progress-${order.purchaseOrderId}`}
                />
                <View style={styles.chipRow}>
                  {placedOrderChips(order).map((chip) => (
                    <Text
                      key={chip}
                      style={styles.progressChip}
                      testID={`placed-order-chip-${order.purchaseOrderId}-${chip}`}
                    >
                      {chip}
                    </Text>
                  ))}
                </View>
                <BargainingTimeline
                  story={stories.get(key)}
                  supplierLabel={labels.get(order.supplierDid) ?? shortDid(order.supplierDid)}
                  testID={`placed-order-bargaining-${order.purchaseOrderId}`}
                />
                {order.tenderId !== null && (
                  <Pressable
                    testID={`placed-order-tender-${order.purchaseOrderId}`}
                    accessibilityRole="link"
                    onPress={() =>
                      router.push({
                        pathname: '/tender',
                        params: { tender_id: order.tenderId ?? '' },
                      })
                    }
                  >
                    <Text style={styles.tenderLink}>See all the offers in this tender</Text>
                  </Pressable>
                )}
                {link !== null && (
                  // The client's own act: opens the processor's page and nothing
                  // else. https only; no card data ever enters Dina.
                  <Pressable
                    testID={`placed-order-pay-${order.purchaseOrderId}`}
                    accessibilityRole="link"
                    style={styles.payButton}
                    onPress={() => {
                      void Linking.openURL(link).catch(() => {
                        /* opening is best-effort */
                      });
                    }}
                  >
                    <Text style={styles.payLabel}>Open payment link</Text>
                  </Pressable>
                )}
              </View>
            );
          });
        })()}
        {placed.length > 0 && drafts.length > 0 && (
          <Text style={styles.sectionTitle} testID="orders-drafts-title">
            Drafts
          </Text>
        )}
        {drafts.map((draft) => (
          <Pressable
            key={draft.draft_id}
            testID={`order-draft-${draft.draft_id}`}
            style={styles.draftRow}
            onPress={() =>
              router.push({ pathname: '/order-draft', params: { draft_id: draft.draft_id } })
            }
            onLongPress={() => abandonDraft(draft)}
          >
            <View style={styles.draftText}>
              <Text style={styles.draftTitle}>
                {`${String(draft.lines)} line${draft.lines === 1 ? '' : 's'}`}
                {draft.conversations > 0
                  ? ` · ${String(draft.conversations)} supplier${draft.conversations === 1 ? '' : 's'}`
                  : ''}
              </Text>
              <Text style={styles.draftMeta}>
                {new Date(draft.updated_at_ms).toLocaleDateString()} · hold to abandon
              </Text>
            </View>
            <Text style={styles.stateChip}>{STATE_LABEL[draft.state]}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <PresenceSheet {...presenceSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  enableCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  enableTitle: { ...textStyles.body, fontWeight: '600', marginBottom: spacing.xs },
  enableBody: { ...textStyles.caption, color: colors.textSecondary },
  captureButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  captureBusy: { opacity: 0.7 },
  captureLabel: { ...textStyles.button, color: colors.bgPrimary },
  askButton: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  askLabel: { ...textStyles.button, color: colors.accent },
  captureHint: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  spinner: { marginTop: spacing.xl },
  error: { ...textStyles.body, color: colors.error, marginTop: spacing.lg },
  empty: { ...textStyles.body, color: colors.textSecondary, marginTop: spacing.xl },
  draftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  draftText: { flex: 1 },
  draftTitle: { ...textStyles.body, color: colors.textPrimary },
  draftMeta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  stateChip: { ...textStyles.caption, color: colors.accent },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  placedCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  placedHeader: { flexDirection: 'row', alignItems: 'center' },
  placedSupplier: { ...textStyles.body, color: colors.textPrimary, flex: 1, fontWeight: '600' },
  placedTotal: { ...textStyles.body, color: colors.textPrimary, marginLeft: spacing.sm },
  placedHeadline: { ...textStyles.body, color: colors.textSecondary, marginTop: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.sm },
  tenderLink: { ...textStyles.caption, color: colors.accent, marginTop: spacing.sm },
  progressChip: {
    ...textStyles.caption,
    color: colors.accent,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  payButton: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  payLabel: { ...textStyles.button, color: colors.accent },
});
