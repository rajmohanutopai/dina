/**
 * Trade — the §7 dual-role commerce home: one screen showing both
 * directions of the business. The ORDER INBOX (pending confirms, quotes,
 * tenders, unreceipted deliveries, short acceptances, unacknowledged
 * payments) on top; per-counterparty khata statements (the §4.4 fold,
 * with §4.5 derived dues flagged overdue) on tap.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { OwnerCommerceHttpError } from '@dina/core';

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { TradeInboxItemDto, TradeStatementAnswer } from '@dina/core';

const KIND_LABEL: Record<string, string> = {
  pending_confirm: 'Confirm an order draft',
  pending_quote: 'Quote awaiting your approval',
  open_tender: 'Tender collecting quotes',
  pending_decision: 'Order awaiting your decision',
  unreceipted_delivery: 'Delivery to receipt',
  short_acceptance: 'Short acceptance — dispute',
  unacknowledged_payment: 'Payment to acknowledge',
};

const ROLE_LABEL: Record<string, string> = { buyer: 'Buying', supplier: 'Supplying' };

function shortDid(did: string): string {
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}

export default function TradeScreen(): React.ReactElement {
  const router = useRouter();
  const [items, setItems] = useState<TradeInboxItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statementFor, setStatementFor] = useState<string | null>(null);
  const [statements, setStatements] = useState<TradeStatementAnswer[] | null>(null);

  const reload = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      setLoading(false);
      return;
    }
    try {
      const answer = await client.tradeInbox();
      setItems(answer.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const openStatement = useCallback(async (counterpartyDid: string) => {
    const client = getOwnerCommerceClient();
    if (client === null || counterpartyDid === '') return;
    setStatementFor(counterpartyDid);
    setStatements(null);
    try {
      // INR is the trade's launch currency; the statement route takes any.
      setStatements([await client.tradeStatement(counterpartyDid, 'INR')]);
    } catch (err) {
      if (err instanceof OwnerCommerceHttpError && err.errorKey === 'role_required') {
        // A dual-role pair is two ledgers (§4.4) — show both, named.
        try {
          setStatements([
            await client.tradeStatement(counterpartyDid, 'INR', 'supplier'),
            await client.tradeStatement(counterpartyDid, 'INR', 'buyer'),
          ]);
        } catch (inner) {
          Alert.alert('No statement', (inner as Error).message);
          setStatementFor(null);
        }
        return;
      }
      Alert.alert('No statement', (err as Error).message);
      setStatementFor(null);
    }
  }, []);

  const openItem = useCallback(
    (item: TradeInboxItemDto) => {
      if (item.kind === 'pending_confirm') {
        router.push({ pathname: '/order-draft', params: { draft_id: item.subject } });
        return;
      }
      if (item.kind === 'pending_quote') {
        const [draftId] = item.subject.split(':');
        router.push({ pathname: '/order-draft', params: { draft_id: draftId ?? item.subject } });
        return;
      }
      if (item.counterparty_did !== '') void openStatement(item.counterparty_did);
    },
    [router, openStatement],
  );

  const counterparties = [...new Set(items.map((i) => i.counterparty_did).filter((d) => d !== ''))];

  return (
    <View style={styles.container} testID="trade-screen">
      <Stack.Screen options={{ title: 'Trade' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.laneRow}>
          <Pressable
            style={styles.laneButton}
            testID="trade-orders"
            onPress={() => router.push('/orders')}
          >
            <Text style={styles.laneLabel}>Buying</Text>
            <Text style={styles.laneHint}>Photograph &amp; place orders</Text>
          </Pressable>
          <Pressable
            style={styles.laneButton}
            testID="trade-catalog"
            onPress={() => router.push('/catalog')}
          >
            <Text style={styles.laneLabel}>Supplying</Text>
            <Text style={styles.laneHint}>Catalog &amp; incoming orders</Text>
          </Pressable>
        </View>
        <Pressable
          style={styles.inviteRow}
          testID="trade-invites"
          onPress={() => router.push('/invites')}
        >
          <Text style={styles.inviteLabel}>Invite a counterparty</Text>
        </Pressable>

        <Text style={styles.sectionTitle}>Needs your attention</Text>
        {loading && <ActivityIndicator style={styles.spinner} />}
        {error !== null && <Text style={styles.error}>{error}</Text>}
        {!loading && error === null && items.length === 0 && (
          <Text style={styles.empty} testID="trade-inbox-empty">
            Nothing waiting. Deliveries to receipt, payments to acknowledge and quotes to approve
            land here.
          </Text>
        )}
        {items.map((item) => (
          <Pressable
            key={`${item.kind}-${item.subject}`}
            style={styles.itemRow}
            testID={`trade-item-${item.kind}-${item.subject}`}
            onPress={() => openItem(item)}
          >
            <View style={styles.itemText}>
              <Text style={styles.itemTitle}>{KIND_LABEL[item.kind] ?? item.kind}</Text>
              <Text style={styles.itemMeta}>
                {ROLE_LABEL[item.role]}
                {item.counterparty_did !== '' ? ` · ${shortDid(item.counterparty_did)}` : ''}
              </Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        ))}

        {counterparties.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Khata</Text>
            {counterparties.map((did) => (
              <Pressable
                key={did}
                style={styles.itemRow}
                testID={`trade-khata-${did}`}
                onPress={() => void openStatement(did)}
              >
                <Text style={[styles.itemTitle, styles.itemText]}>{shortDid(did)}</Text>
                <Text style={styles.chev}>›</Text>
              </Pressable>
            ))}
          </>
        )}

        {statementFor !== null && (
          <View style={styles.statementCard} testID="trade-statement">
            <Text style={styles.itemTitle}>{shortDid(statementFor)}</Text>
            {statements === null ? (
              <ActivityIndicator style={styles.spinner} />
            ) : (
              statements.map((answer) => {
                const balance = answer.statement as {
                  balance?: { direction: string; minor_units: string };
                  disputed_minor?: string;
                };
                return (
                  <View key={answer.role}>
                    {statements.length > 1 && (
                      <Text style={styles.itemMeta}>
                        {answer.role === 'supplier' ? 'I supply them' : 'They supply me'}
                      </Text>
                    )}
                    {balance.balance !== undefined && (
                      <Text style={styles.statementLine}>
                        {balance.balance.direction === 'buyer_owes'
                          ? 'Buyer owes'
                          : balance.balance.direction === 'supplier_owes'
                            ? 'Supplier owes'
                            : 'Settled'}
                        {balance.balance.direction === 'settled'
                          ? ''
                          : ` ₹${(Number(balance.balance.minor_units) / 100).toFixed(2)}`}
                      </Text>
                    )}
                    {balance.disputed_minor !== undefined && balance.disputed_minor !== '0' && (
                      <Text style={styles.disputed}>
                        Disputed: ₹{(Number(balance.disputed_minor) / 100).toFixed(2)}
                      </Text>
                    )}
                    {answer.dues.map((due) => (
                      <Text
                        key={`${due.purchase_order_id}-${due.due_at}`}
                        style={due.overdue ? styles.overdue : styles.statementLine}
                      >
                        {due.overdue ? 'Overdue' : 'Due'}{' '}
                        {new Date(due.due_at).toLocaleDateString()}: ₹
                        {(Number(due.amount.minor_units) / 100).toFixed(2)}
                      </Text>
                    ))}
                    {answer.dues.length === 0 && (
                      <Text style={styles.itemMeta}>No derived dues.</Text>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  laneRow: { flexDirection: 'row', gap: spacing.sm },
  laneButton: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  laneLabel: { ...textStyles.body, fontWeight: '600', color: colors.textPrimary },
  laneHint: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  inviteRow: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  inviteLabel: { ...textStyles.button, color: colors.bgPrimary },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  spinner: { marginTop: spacing.md },
  error: { ...textStyles.body, color: colors.error },
  empty: { ...textStyles.body, color: colors.textSecondary },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  itemText: { flex: 1 },
  itemTitle: { ...textStyles.body, color: colors.textPrimary },
  itemMeta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  chev: { ...textStyles.body, color: colors.textSecondary },
  statementCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  statementLine: { ...textStyles.body, color: colors.textPrimary, marginTop: spacing.xs },
  disputed: { ...textStyles.body, color: colors.error, marginTop: spacing.xs },
  overdue: { ...textStyles.body, color: colors.error, marginTop: spacing.xs, fontWeight: '600' },
});
