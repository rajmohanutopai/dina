/**
 * Where a placed order is, and what happens next — for My Orders and the
 * Tender screen after Send.
 *
 * A five-step track (Sent · Accepted · Paid · Being made · On the way) and one
 * sentence naming the next step and who takes it. Every step is a fact Core
 * reported for the order (its state, and the progress the supplier's
 * integration attached: payment link, payment, fulfilment); nothing is
 * inferred from time passing. An order the supplier refused, countered or
 * never received has no track: Core's own headline says what happened.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, textStyles } from '../theme';

import type { PlacedOrderDto } from '@dina/core';

type Progress = NonNullable<PlacedOrderDto['progress']>;

export const ORDER_STEPS = ['Sent', 'Accepted', 'Paid', 'Being made', 'On the way'] as const;

function paid(progress: Progress | null): boolean {
  return progress !== null && (progress.paymentRecorded || progress.payment?.state === 'captured');
}

/** How many of `ORDER_STEPS` the order has reached; null when it has no track. */
export function orderStepsReached(order: PlacedOrderDto): number | null {
  if (order.state === 'submitted_unconfirmed' || order.state === 'outcome_unknown') return 1;
  if (order.state !== 'accepted') return null;
  const progress = order.progress;
  const fulfilment = progress?.fulfilment?.state;
  if (fulfilment === 'handed_to_carrier') return 5;
  if (fulfilment === 'production_started' || fulfilment === 'ready') return 4;
  if (paid(progress)) return 3;
  return 2;
}

/** The one sentence under the track: what happens next, and who does it. */
export function orderNextStep(order: PlacedOrderDto, supplier: string): string | null {
  switch (order.state) {
    case 'submitted_unconfirmed':
    case 'outcome_unknown':
      return `Waiting for ${supplier} to confirm the order.`;
    case 'accepted':
      break;
    default:
      return null;
  }
  const progress = order.progress;
  const fulfilment = progress?.fulfilment?.state;
  if (fulfilment === 'handed_to_carrier') return 'On the way to you.';
  if (fulfilment === 'ready') return `Ready at ${supplier}.`;
  if (fulfilment === 'production_started') return `${supplier} is making it.`;
  if (paid(progress)) return `Paid. Next: ${supplier} starts making it.`;
  if (progress?.payment?.state === 'failed') return 'The payment failed. Try the link again.';
  const link = progress?.checkoutLink ?? null;
  if (link !== null && !link.expired) return 'Next: pay with the payment link.';
  if (link !== null && link.expired) {
    return `The payment link expired. ${supplier} can send a new one.`;
  }
  return `Next: ${supplier} sends a payment link.`;
}

export function OrderProgress({
  order,
  supplier,
  testID,
}: {
  order: PlacedOrderDto;
  supplier: string;
  testID: string;
}): React.JSX.Element | null {
  const reached = orderStepsReached(order);
  const next = orderNextStep(order, supplier);
  if (reached === null && next === null) return null;
  return (
    <View style={styles.wrap} testID={testID}>
      {reached !== null && (
        <View
          style={styles.track}
          accessibilityLabel={`Order progress: ${ORDER_STEPS[reached - 1]}`}
        >
          {ORDER_STEPS.map((label, index) => {
            const done = index < reached;
            return (
              <View key={label} style={styles.step}>
                <View
                  style={[styles.bar, done ? styles.barDone : styles.barTodo]}
                  testID={`${testID}-step-${String(index)}-${done ? 'done' : 'todo'}`}
                />
                <Text
                  style={[styles.stepLabel, index === reached - 1 && styles.stepCurrent]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              </View>
            );
          })}
        </View>
      )}
      {next !== null && (
        <Text style={styles.next} testID={`${testID}-next`}>
          {next}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  track: { flexDirection: 'row', gap: 4 },
  step: { flex: 1 },
  bar: { height: 4, borderRadius: 2 },
  barDone: { backgroundColor: colors.success },
  barTodo: { backgroundColor: colors.bgTertiary },
  stepLabel: { ...textStyles.caption, color: colors.textMuted, marginTop: 4, fontSize: 11 },
  stepCurrent: { color: colors.textPrimary },
  next: { ...textStyles.caption, color: colors.textSecondary, marginTop: spacing.xs },
});
