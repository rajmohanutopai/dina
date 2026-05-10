/**
 * Subject anchor card — the "what you're reviewing" header.
 *
 * Renders in edit mode and in compose mode when the form was deep-
 * linked from a subject detail page. Distinct from `SubjectCardView`:
 *
 *   - `SubjectCardView` is the search/feed result row (full card with
 *     score band, friends pill, top-reviewer line, context chips).
 *   - `SubjectAnchorView` is the compact "this is the subject" header
 *     for the write/edit screen — kind icon, title, subtitle. No
 *     trust signals, no chips, no tap target. Pure visual anchor so
 *     the user knows what they're writing about.
 *
 * The naming intentionally distinguishes intent: a *card* is a row in
 * a list; an *anchor* is a header on a form. Same noun, different
 * affordance. A future maintainer should NOT be tempted to merge them.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { colors, fonts, spacing, radius } from '../../theme';

import { deriveCardSubtitle } from '../subject_card';

/**
 * Per-kind icon. Kept in this file (not the band_theme module) because
 * the icon set here is anchor-specific — `subject_card_view` uses a
 * different visual language (score-band stripe instead of icon). If a
 * third anchor surface ever ships, hoist this map to a shared module.
 */
const KIND_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  product: 'cube-outline',
  place: 'location-outline',
  organization: 'business-outline',
  did: 'person-outline',
  content: 'document-text-outline',
  dataset: 'server-outline',
  claim: 'help-circle-outline',
};

const FALLBACK_ICON: keyof typeof Ionicons.glyphMap = 'help-circle-outline';

export interface SubjectAnchorViewProps {
  /** The subject's title (resolved name, did, uri, or fallback). */
  title: string;
  /** Subject kind (product / place / etc.) — drives the icon. */
  kind: string | null;
  /**
   * Category string (e.g. 'commerce/product/furniture'). Rendered as
   * a humanised subtitle via the same `deriveCardSubtitle` helper the
   * search/feed cards use, so the labels stay consistent across
   * surfaces.
   */
  category: string | null;
  /** Optional testID for tests + a11y traversal. */
  testID?: string;
}

export function SubjectAnchorView(props: SubjectAnchorViewProps): React.ReactElement {
  const { title, kind, category, testID = 'subject-anchor' } = props;
  const iconName = (kind !== null && KIND_ICON[kind]) || FALLBACK_ICON;
  const subtitle = deriveCardSubtitle(category, kind);
  const a11yLabel = subtitle !== null ? `${title}, ${subtitle}` : title;

  return (
    <View
      style={styles.anchor}
      testID={testID}
      accessibilityRole="header"
      accessibilityLabel={a11yLabel}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={iconName} size={20} color={colors.textSecondary} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {subtitle !== null && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  title: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.textPrimary,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
});
