/**
 * Shop orders (UCP plan §3.14, U3.4): orders Dina follows after a hand-off
 * to an online shop, shown beside the placed (D2D) orders. Every line is
 * Core's: the headline, the lines and the total as the shop last gave them
 * (a shop that only sends updates says so), and "Track or return at <shop>"
 * opening the shop's own order page. An order the shop sends updates for
 * but will not share can be marked done here; every other closes by
 * Dina's rule.
 *
 * Loaded on its own, so a node without shop orders (or a failure reading
 * them) never hides the placed orders beside it.
 */

import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatMoneyAmount, type UcpOrderView } from '@dina/core';

import { ownerErrorText } from '../services/owner_errors';
import { getOwnerUcpClient } from '../services/owner_ucp_client';
import { startRefusalText } from '../services/ucp_link_words';
import { colors, radius, spacing, textStyles } from '../theme';

import { safeHttpsUrl } from './safe_url';

/** The total as the owner reads it; one the display cannot read shows nothing rather than a guess. */
function totalText(order: UcpOrderView): string | null {
  const s = order.summary;
  if (s === null || s.total === null) return null;
  try {
    return `${s.currency} ${formatMoneyAmount({ currency: s.currency, minor_units: s.total })}`;
  } catch {
    return null;
  }
}

/** The lines, short: "2 × Sencha · and 1 more", or "1.5 kg Rice" for a line sold by weight. */
function linesText(order: UcpOrderView): string | null {
  const lines = (order.summary?.lines ?? []).filter((l) => l.status !== 'removed');
  const first = lines[0];
  if (first === undefined) return null;
  const more = lines.length > 1 ? ` · and ${String(lines.length - 1)} more` : '';
  const amount =
    first.unit !== undefined ? `${first.quantity} ${first.unit}` : `${first.quantity} ×`;
  return `${amount} ${first.title}${more}`;
}

export function ShopOrders({
  testID = 'shop-orders',
  onCount,
}: {
  testID?: string;
  /** How many shop orders there are, each time they load (the screen's empty state reads it). */
  onCount?: (count: number) => void;
}): React.ReactElement | null {
  const [orders, setOrders] = useState<UcpOrderView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ host: string; url: string } | null>(null);

  const load = useCallback(async () => {
    const client = getOwnerUcpClient();
    if (client === null) return;
    try {
      const loaded = (await client.orders()) ?? [];
      setOrders(loaded);
      setError(null);
      onCount?.(loaded.length);
    } catch (err) {
      setError(ownerErrorText(err));
    }
  }, [onCount]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const markDone = useCallback(
    async (order: UcpOrderView) => {
      const client = getOwnerUcpClient();
      if (client === null) return;
      setBusy(order.order_id);
      try {
        await client.markOrderDone(order.merchant_origin, order.order_id);
        await load();
      } catch (err) {
        setError(ownerErrorText(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // An order the merchant shares only with a linked account (§3.14, §3.17): the shop's sign-in.
  const linkAccount = useCallback(async (order: UcpOrderView) => {
    const client = getOwnerUcpClient();
    if (client === null || order.link_scopes === null) return;
    setBusy(order.order_id);
    try {
      const out = await client.startLink(order.merchant_origin, order.link_scopes);
      if (!out.started) setError(startRefusalText(out.reason, order.merchant_host));
      else if (out.opens === 'phone')
        setError(
          `Sent to your phone: approve the card there to sign in at ${order.merchant_host}.`,
        );
      // On the web app a page opened after a request is blocked: the owner taps it instead.
      else if (Platform.OS === 'web') setSignIn({ host: order.merchant_host, url: out.url });
      else await Linking.openURL(out.url);
    } catch (err) {
      setError(ownerErrorText(err));
    } finally {
      setBusy(null);
    }
  }, []);

  if (orders.length === 0 && error === null) return null;
  return (
    <View testID={testID}>
      <Text style={styles.sectionTitle} testID={`${testID}-title`}>
        Shop orders
      </Text>
      {error !== null && (
        <Text style={styles.error} testID={`${testID}-error`}>
          {error}
        </Text>
      )}
      {signIn !== null && (
        <Pressable
          testID={`${testID}-sign-in`}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(signIn.url).catch(() => undefined)}
        >
          <Text style={styles.link}>Open {signIn.host}’s sign-in</Text>
        </Pressable>
      )}
      {orders.map((order) => {
        const id = `${testID}-${order.order_id}`;
        const total = totalText(order);
        const lines = linesText(order);
        const link = safeHttpsUrl(order.permalink_url);
        return (
          <View key={`${order.merchant_origin}|${order.order_id}`} style={styles.card} testID={id}>
            <View style={styles.header}>
              <Text style={styles.shop} numberOfLines={1}>
                {order.merchant_host}
              </Text>
              {total !== null && <Text style={styles.total}>{total}</Text>}
            </View>
            <Text style={styles.headline} testID={`${id}-headline`}>
              {order.headline}
            </Text>
            {lines !== null && <Text style={styles.meta}>{lines}</Text>}
            {(order.notes ?? []).map((note) => (
              <Text key={note} style={styles.meta} testID={`${id}-note`}>
                {note}
              </Text>
            ))}
            {order.summary?.as_sent === true && (
              <Text style={styles.meta} testID={`${id}-as-sent`}>
                As last sent by {order.merchant_host}; it may be out of date.
              </Text>
            )}
            {link !== null && (
              <Pressable
                testID={`${id}-open`}
                accessibilityRole="link"
                onPress={() => void Linking.openURL(link).catch(() => undefined)}
              >
                <Text style={styles.link}>Track or return at {order.merchant_host}</Text>
              </Pressable>
            )}
            {order.link_scopes !== null && (
              <Pressable
                testID={`${id}-link`}
                accessibilityRole="button"
                disabled={busy === order.order_id}
                onPress={() => void linkAccount(order)}
              >
                <Text style={styles.link}>Link your account at {order.merchant_host}</Text>
              </Pressable>
            )}
            {order.state === 'not_shared' && (
              <Pressable
                testID={`${id}-done`}
                accessibilityRole="button"
                disabled={busy === order.order_id}
                onPress={() => void markDone(order)}
              >
                <Text style={styles.link}>Mark as done</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  error: { ...textStyles.body, color: colors.error, marginTop: spacing.sm },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  shop: { ...textStyles.body, color: colors.textPrimary, flex: 1, fontWeight: '600' },
  total: { ...textStyles.body, color: colors.textPrimary, marginLeft: spacing.sm },
  headline: { ...textStyles.body, color: colors.textSecondary, marginTop: spacing.xs },
  meta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  link: { ...textStyles.caption, color: colors.accent, marginTop: spacing.sm },
});
