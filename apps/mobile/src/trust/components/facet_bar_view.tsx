/**
 * Visual facet bar (TN-MOB-016 + TN-MOB-011 / Plan §8.3.1).
 *
 * Renders a horizontal-scrolling row of facet chips above the search
 * results. Each chip shows the value + count; tapping fires the
 * caller's `onTap(value)` to refine the search.
 *
 * The chip data + sort + overflow split is pre-computed by
 * `src/trust/facets.ts`'s `deriveFacets`; this component is a pure
 * renderer over the resulting `FacetBar`.
 *
 * Plan §8.3.1: "Long-tail facets collapse under 'More' once 5+ are
 * visible." The data layer's `primary`/`overflow` split implements
 * the threshold; this view renders `primary` inline and exposes a
 * "More" CTA when `overflow.length > 0` that hands the rest off to
 * a sheet (the sheet is the consumer's concern — this component
 * only fires `onShowMore`).
 *
 * **An "All" chip is always rendered** as the leftmost item — taps it
 * to clear the active facet. The All chip's pressed-state is driven
 * by `activeValue == null`.
 *
 * **Why a separate component**: same chip-row appears on the search
 * screen AND the trust-feed landing AND the subject-detail "explore
 * by category" surface. Inlining would drift visually + accessibility-
 * wise across the three.
 */

import React from 'react';
import { ScrollView, Pressable, Text, StyleSheet } from 'react-native';

import { colors, fonts, spacing, radius } from '../../theme';
import type { FacetBar } from '../facets';

export interface FacetBarViewProps {
  /** Pre-computed facet split from `deriveFacets()`. */
  facets: FacetBar;
  /**
   * Currently-active facet value. `null` means the "All" chip is
   * selected. Drives the per-chip pressed/highlighted style.
   */
  activeValue?: string | null;
  /** Tap handler — receives the facet value, or `null` for "All". */
  onTap?: (value: string | null) => void;
  /** Tap handler for the "More" CTA when `overflow.length > 0`. */
  onShowMore?: () => void;
}

export function FacetBarView(props: FacetBarViewProps): React.ReactElement | null {
  const { facets, activeValue = null, onTap, onShowMore } = props;
  // If there are no facets at all, render nothing — a chip-row with
  // just the "All" affordance is wasted vertical space when the
  // results don't carry any categorisable signal.
  if (facets.primary.length === 0 && facets.overflow.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
      testID="facet-bar"
      accessibilityLabel="Refine results"
    >
      <FacetChip
        label="All"
        active={activeValue === null}
        onPress={onTap ? () => onTap(null) : undefined}
        testID="facet-chip-all"
      />
      {facets.primary.map((facet) => (
        <FacetChip
          key={facet.value}
          label={`${facet.value} · ${facet.count}`}
          active={activeValue === facet.value}
          onPress={onTap ? () => onTap(facet.value) : undefined}
          testID={`facet-chip-${facet.value}`}
        />
      ))}
      {facets.overflow.length > 0 && onShowMore && (
        <FacetChip
          label="More"
          active={false}
          onPress={onShowMore}
          testID="facet-chip-more"
          accessibilityLabel={`More — ${facets.overflow.length} more`}
        />
      )}
    </ScrollView>
  );
}

interface FacetChipProps {
  label: string;
  active: boolean;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}

function FacetChip(props: FacetChipProps): React.ReactElement {
  const { label, active, onPress, testID, accessibilityLabel } = props;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        pressed && onPress && styles.chipPressed,
      ]}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    flexDirection: 'row',
  },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipPressed: { backgroundColor: colors.bgTertiary },
  chipLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
  },
  chipLabelActive: {
    color: colors.bgSecondary,
  },
});
