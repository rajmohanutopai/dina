/**
 * The drafted request for quotes, in chat (ASK_FOR_QUOTES_PLAN §2).
 *
 * Brain drafted it from what the owner said; the card shows what would be
 * asked and opens the Ask for quotes screen prefilled. Nothing is sent from
 * here: the owner picks the suppliers and taps Send on that screen.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';

import { parseQuoteRequestDraftParam } from '../services/quote_request_draft';
import { colors, radius, spacing, textStyles } from '../theme';

export function InlineQuoteRequestDraftCard({
  message,
}: {
  message: ChatMessage;
}): React.ReactElement | null {
  const router = useRouter();
  const lc = readLifecycle(message);
  if (lc === null || lc.kind !== 'quote_request_draft') return null;
  // The same untrusted-input parse the screen applies, so the card shows only
  // what the screen will prefill.
  const param = JSON.stringify(lc.draft);
  const draft = parseQuoteRequestDraftParam(param);
  if (draft === null || draft.lines.length === 0) return null;

  const limits: string[] = [];
  const money = (amount: string): string =>
    draft.currency !== undefined ? `${draft.currency} ${amount}` : amount;
  if (draft.limits.target !== '') limits.push(`target ${money(draft.limits.target)}`);
  if (draft.limits.ceiling !== '') limits.push(`up to ${money(draft.limits.ceiling)}`);

  return (
    <View style={styles.card} testID={`quote-draft-${lc.draftId}`}>
      <Text style={styles.title}>Request for quotes</Text>
      {draft.lines.map((line, i) => (
        <Text key={i} style={styles.line}>
          {line.quantity} {line.unitCode} · {line.text}
        </Text>
      ))}
      {draft.supplierQuery !== undefined && (
        <Text style={styles.meta}>Suppliers who sell: {draft.supplierQuery}</Text>
      )}
      {limits.length > 0 && <Text style={styles.meta}>{limits.join(', ')}</Text>}
      {draft.fromMemory !== undefined && (
        <Text style={styles.memory} testID={`quote-draft-memory-${lc.draftId}`}>
          {`From what you told me: ${draft.fromMemory}`}
        </Text>
      )}
      <Pressable
        testID={`quote-draft-open-${lc.draftId}`}
        style={styles.button}
        onPress={() =>
          router.push({ pathname: '/ask-quotes', params: { draft: param, from: '/' } })
        }
        accessibilityRole="button"
      >
        <Text style={styles.buttonLabel}>Review and pick suppliers</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  title: {
    ...textStyles.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  line: { ...textStyles.body, color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  memory: { ...textStyles.caption, color: colors.textPrimary, fontStyle: 'italic' },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonLabel: { ...textStyles.button, color: colors.bgPrimary },
});
