/**
 * A promise found in a Talk message, offered for tracking
 * (docs/PROMISES_AND_WAITS.md §4). Nothing is tracked until the owner taps
 * Track it; the answer is saved on the message, so the card shows it after a
 * restart and a second tap does nothing.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';

import { dismissPromiseOffer, trackPromiseOffer } from '../services/promises';
import { colors, radius, spacing, textStyles } from '../theme';

/** "Fri 13 Nov, 6:00 pm". */
export function promiseDueLabel(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

export function InlinePromiseOfferCard({
  message,
}: {
  message: ChatMessage;
}): React.ReactElement | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lc = readLifecycle(message);
  if (lc === null || lc.kind !== 'promise_offer') return null;
  const id = lc.talkMessageId;

  const answer = async (track: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (track) await trackPromiseOffer(message.id);
      else dismissPromiseOffer(message.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} testID={`promise-offer-${id}`}>
      <Text style={styles.title}>
        {lc.direction === 'owed_to_me' ? 'A promise to you' : 'A promise you made'}
      </Text>
      <Text style={styles.body} testID={`promise-offer-text-${id}`}>
        {message.content}
      </Text>
      {lc.dueAt !== null && (
        <Text style={styles.meta} testID={`promise-offer-due-${id}`}>
          By {promiseDueLabel(lc.dueAt)}
        </Text>
      )}
      {lc.status === 'open' && (
        <View style={styles.row}>
          <Pressable
            testID={`promise-offer-track-${id}`}
            style={[styles.button, styles.primary, busy && styles.disabled]}
            onPress={() => void answer(true)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={[styles.buttonLabel, styles.primaryLabel]}>Track it</Text>
          </Pressable>
          <Pressable
            testID={`promise-offer-dismiss-${id}`}
            style={[styles.button, styles.secondary, busy && styles.disabled]}
            onPress={() => void answer(false)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.buttonLabel}>Not now</Text>
          </Pressable>
        </View>
      )}
      {lc.status === 'tracked' && (
        <Pressable
          testID={`promise-offer-tracked-${id}`}
          onPress={() => router.push('/promises')}
          accessibilityRole="link"
        >
          <Text style={styles.done}>Tracking it. See Promises and waits.</Text>
        </Pressable>
      )}
      {lc.status === 'dismissed' && (
        <Text style={styles.meta} testID={`promise-offer-dismissed-${id}`}>
          Not tracked.
        </Text>
      )}
      {error !== null && <Text style={styles.error}>{error}</Text>}
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
  body: { ...textStyles.body, color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  done: { ...textStyles.caption, color: colors.accent, marginTop: spacing.xs },
  error: { ...textStyles.caption, color: colors.error, marginTop: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  button: {
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  primary: { backgroundColor: colors.accent },
  secondary: { borderWidth: 1, borderColor: colors.border },
  disabled: { opacity: 0.5 },
  buttonLabel: { ...textStyles.button, color: colors.textPrimary },
  primaryLabel: { color: colors.bgPrimary },
});
