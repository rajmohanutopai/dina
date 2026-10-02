/**
 * What a supplier offered, the way its catalogue shows it: the item's photo,
 * name, description and pack, and the bakery's PeerLens trust beside it.
 *
 * Everything here is the supplier's own published words, except the trust,
 * which is PeerLens's. The photo is one the supplier chose to publish on the
 * catalogue item (`images`, https only); a missing or broken photo falls back
 * to a plain icon, never to a guess.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

import { safeHttpsUrl } from './safe_url';
import { trustWords } from './SupplierPicker';

export interface OfferedItem {
  name: string;
  description: string | null;
  /** "1 each", "box of 12". */
  quantityText: string;
  /** The first published photo; null when the item has none. */
  imageUrl: string | null;
}

export interface SupplierTrust {
  score: number | null;
  reviewCount: number | null;
}

/** "Well trusted · 12 reviews"; "No reviews yet" when PeerLens has none. */
export function trustLine(trust: SupplierTrust): string {
  const words = trustWords(trust.score);
  if (trust.score === null || trust.reviewCount === null || trust.reviewCount <= 0) return words;
  return `${words} · ${String(trust.reviewCount)} review${trust.reviewCount === 1 ? '' : 's'}`;
}

export function OfferedItemCard({
  item,
  trust,
  testID,
}: {
  item: OfferedItem;
  trust: SupplierTrust | null;
  testID: string;
}): React.JSX.Element {
  const [broken, setBroken] = useState(false);
  const uri = broken ? null : safeHttpsUrl(item.imageUrl);
  return (
    <View style={styles.card} testID={testID}>
      {uri !== null ? (
        <Image
          source={{ uri }}
          style={styles.photo}
          resizeMode="cover"
          onError={() => setBroken(true)}
          accessibilityLabel={`Photo of ${item.name}`}
          testID={`${testID}-photo`}
        />
      ) : (
        <View style={[styles.photo, styles.placeholder]} testID={`${testID}-no-photo`}>
          <Ionicons name="image-outline" size={22} color={colors.textMuted} />
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={2} testID={`${testID}-name`}>
          {item.name}
        </Text>
        {item.description !== null && item.description !== '' && (
          <Text style={styles.description} numberOfLines={2} testID={`${testID}-description`}>
            {item.description}
          </Text>
        )}
        <Text style={styles.meta} testID={`${testID}-quantity`}>
          {item.quantityText}
        </Text>
        {trust !== null && (
          <View style={styles.trust}>
            <Ionicons
              name={trust.score === null ? 'star-outline' : 'star'}
              size={12}
              color={trust.score === null ? colors.textMuted : colors.warning}
            />
            <Text style={styles.meta} testID={`${testID}-trust`}>
              {trustLine(trust)}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
  },
  photo: { width: 64, height: 64, borderRadius: radius.sm },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgSecondary,
  },
  text: { flex: 1, justifyContent: 'center' },
  name: { ...textStyles.bodySmallStrong, color: colors.textPrimary },
  description: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  meta: { ...textStyles.caption, color: colors.textMuted },
  trust: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
});
