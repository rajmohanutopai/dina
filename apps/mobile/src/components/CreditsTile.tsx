/**
 * "Dina Starter Credits" tile — AI-providers screen
 * (docs/CREDITS_DESIGN.md §UI 2).
 *
 * Renders only while a grant exists AND is the live OpenRouter source
 * (BYOK wins — the tile yields to the normal OpenRouter tile then).
 * No key string (it isn't the user's key), no Remove action (nothing
 * to manage), no currency — "≈ N conversations" only.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';


import { CREDITS_DEFAULT_CONFIG, getGrantCredential } from '../ai/credits';
import { useCredits } from '../hooks/useCredits';

export function CreditsTile(): React.JSX.Element | null {
  const credits = useCredits(0);
  const [pin, setPin] = useState<string>(CREDITS_DEFAULT_CONFIG.model_pin);
  useEffect(() => {
    void getGrantCredential().then((c) => {
      if (c !== null) setPin(c.modelPin);
    });
  }, []);
  if (!credits.grantActive) return null;

  const est = credits.estConversationsLeft;
  return (
    <View style={styles.tile} testID="ai-providers-credits-tile">
      <View style={styles.headerRow}>
        <Text style={styles.title}>Dina Starter Credits</Text>
        <View style={styles.activeBadge}>
          <Text style={styles.activeBadgeText}>ACTIVE</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>Free conversations to get you started</Text>

      <Text style={styles.meter} testID="ai-providers-credits-meter">
        {credits.showWall
          ? 'Free conversations used up'
          : est !== null
            ? `◔ ≈ ${est} conversations left`
            : '◔ checking your balance…'}
      </Text>

      <Text style={styles.detail}>Model: {pin.split('/')[1] ?? pin}</Text>
      <Text style={styles.detail} testID="ai-providers-credits-privacy">
        Privacy: runs directly through OpenRouter. Dina does not proxy or store these
        conversations.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5DDD0',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 17, fontWeight: '700', color: '#2B2620' },
  activeBadge: {
    backgroundColor: '#2B2620',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  activeBadgeText: { color: '#F9F2EC', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  subtitle: { fontSize: 13, color: '#5C544A', marginTop: 2 },
  meter: { fontSize: 15, fontWeight: '600', color: '#2B2620', marginTop: 12 },
  detail: { fontSize: 13, color: '#5C544A', marginTop: 8, lineHeight: 18 },
});
