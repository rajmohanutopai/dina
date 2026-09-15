/**
 * `InlineComparisonCard` — chat-thread renderer for a `'dina'` message tagged
 * with `metadata.lifecycle.kind === 'commerce_comparison'`: the money-free
 * where-to-buy card from the product-research loop
 * (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A4/A5).
 *
 * The brain already built and validated the CardSpec; this re-validates it as
 * UNTRUSTED at the render boundary — a corrupt / imported / legacy chat row
 * (readLifecycle only checks the discriminator, then casts) must not bypass the
 * card safety rules — and draws it with `SafeCardRenderer`, the same generic
 * renderer service-result cards use. So the where-to-buy links ride the existing
 * https-only `link` block: no "buy" action, Dina credits the source and the
 * human completes the purchase there (Cart Handover).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';
import { validateCardSpec } from '@dina/protocol';

import { colors, radius, spacing } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';
import { SafeCardRenderer } from './SafeCardRenderer';

export interface InlineComparisonCardProps {
  message: ChatMessage;
}

export function InlineComparisonCard({
  message,
}: InlineComparisonCardProps): React.JSX.Element | null {
  const lc = readLifecycle(message);
  if (lc === null || lc.kind !== 'commerce_comparison') return null;
  const spec = validateCardSpec(lc.cardSpec, { trusted: false });
  if (spec === null) return null;
  return (
    <View testID="chat-card-commerce-response" style={styles.card}>
      <SafeCardRenderer spec={spec} />
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
});
