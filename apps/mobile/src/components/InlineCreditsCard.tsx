/**
 * Starter Credits chat cards — the low-balance nudge and the wall
 * (docs/CREDITS_DESIGN.md §UI 3+4).
 *
 * Copy rules enforced here (spec + App Review constraints):
 *   - "conversations", never "credits"/currency; estimates carry "≈".
 *   - In-app BYOK copy is the NEUTRAL "Use your own AI provider key"
 *     (no "free forever" in-app — guideline 3.1.1).
 *   - NO local-model option on mobile: there is no on-device inference, so the
 *     only "keep going" path offered here is bringing your own provider key.
 *   - NO mention of purchasable top-ups until IAP exists (#362).
 *   - Warm, zero-guilt tone; no red, no urgency language.
 *
 * The low-balance variant renders ONCE (Silence First): `onDismiss`
 * persists forever via credits.dismissLowBalanceCard().
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export type CreditsCardVariant = 'low-balance' | 'wall';

export interface InlineCreditsCardProps {
  variant: CreditsCardVariant;
  /** Estimated conversations left (low-balance variant). */
  estConversationsLeft?: number;
  /** Navigate to the AI-providers screen (provider key setup). */
  onSetUp: () => void;
  /** Low-balance only: dismiss forever. */
  onDismiss?: () => void;
}

export function InlineCreditsCard(props: InlineCreditsCardProps): React.JSX.Element {
  const { variant } = props;
  const isWall = variant === 'wall';

  return (
    <View style={styles.card} testID={`chat-card-credits-${variant}`}>
      <Text style={styles.title} testID={`credits-${variant}-title`}>
        {isWall
          ? 'You’ve used all your free starter conversations.'
          : `Your starter conversations are almost used up. About ${props.estConversationsLeft ?? 5} left.`}
      </Text>

      <Text style={styles.body} testID={`credits-${variant}-body`}>
        {isWall
          ? 'Everything you’ve saved stays yours, on this device. To keep talking, use your own AI provider key.'
          : 'To keep going, use your own AI provider key.'}
      </Text>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={props.onSetUp}
          testID={`credits-${variant}-setup`}
          accessibilityRole="button"
          accessibilityLabel="Set up an AI provider"
        >
          <Text style={styles.primaryButtonText}>Set up</Text>
        </TouchableOpacity>
        {!isWall && props.onDismiss !== undefined ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={props.onDismiss}
            testID="credits-low-balance-later"
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.secondaryButtonText}>Later</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5DDD0',
  },
  title: { fontSize: 15, fontWeight: '600', color: '#2B2620', lineHeight: 21 },
  body: { fontSize: 14, color: '#5C544A', marginTop: 8, lineHeight: 20 },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  primaryButton: {
    backgroundColor: '#2B2620',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  primaryButtonText: { color: '#F9F2EC', fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  secondaryButtonText: { color: '#5C544A', fontSize: 14 },
});
