/**
 * `InlineDemoReviewCard` — chat-thread inline PeerLens review card for the
 * GUIDED DEMO's "give back" step (contribute a review for the chair just
 * researched).
 *
 * Why a dedicated demo card rather than the real `InlineReviewDraftCard`
 * (`metadata.lifecycle.kind === 'review_draft'`): the real card's Publish runs
 * the genuine publish path (`injectAttestation`, publish keys, AppView write),
 * which would push demo data to the real PeerLens network. This card's Publish
 * is INERT — it flips to a local "Published" confirmation and touches nothing.
 * The chat row is scope-bound (torn down with the demo scope).
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

import type { ChatMessage } from '@dina/brain/chat';

export interface InlineDemoReviewCardProps {
  message: ChatMessage;
}

interface DemoReviewMetadata {
  kind: 'demo_review';
  product: string;
  rating: number;
  text: string;
}

function readMetadata(m: ChatMessage): DemoReviewMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'demo_review') return null;
  if (typeof md.product !== 'string' || md.product.length === 0) return null;
  const rating = typeof md.rating === 'number' ? md.rating : 0;
  const text = typeof md.text === 'string' ? md.text : '';
  return { kind: 'demo_review', product: md.product, rating, text };
}

/** Five-glyph star line (★ filled to `rating`, ☆ for the rest). */
function stars(rating: number): string {
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export function InlineDemoReviewCard({
  message,
}: InlineDemoReviewCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [published, setPublished] = useState(false);

  // Inert in demo mode — flips to a local confirmation, no real publish path.
  const onPublish = useCallback(() => {
    setPublished(true);
  }, []);

  if (meta === null) return null;

  return (
    <View style={styles.card} testID="demo-review-card">
      <Text style={styles.label}>PeerLens review</Text>
      <View style={styles.headerRow}>
        <Text style={styles.product}>{meta.product}</Text>
        <Text style={styles.stars}>{stars(meta.rating)}</Text>
      </View>
      <Text style={styles.body}>{`"${meta.text}"`}</Text>
      {published ? (
        <Text testID="demo-review-published" style={styles.published}>
          Published to PeerLens.
        </Text>
      ) : (
        <TouchableOpacity
          testID="demo-review-publish"
          style={styles.publishBtn}
          onPress={onPublish}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Publish review"
        >
          <Text style={styles.publishText}>Publish review</Text>
        </TouchableOpacity>
      )}
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
  label: { ...textStyles.eyebrow, marginBottom: spacing.xs },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  product: { ...textStyles.bodyStrong, color: colors.textPrimary, flex: 1 },
  stars: { ...textStyles.body, color: colors.accent },
  body: { ...textStyles.bodySmall, color: colors.textSecondary, marginTop: spacing.xs, fontStyle: 'italic' },
  publishBtn: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  publishText: { ...textStyles.button, color: colors.white },
  published: { ...textStyles.bodySmall, color: colors.successTextDeep, marginTop: spacing.sm },
});
