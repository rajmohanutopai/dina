/**
 * Viewer-profile filter chips row (TN-V2-RANK-005 / RANK-016).
 *
 * Renders a horizontal scrollable row of chips, one per applicable
 * filter (see `applicableFilters` in `viewer_filters.ts`). Each chip
 * is a checkbox-style toggle: tapping flips the chip's selected state
 * and the parent screen re-runs `applyFilters` over the search
 * results.
 *
 * **Off by default.** The screen owns the active-filter set and
 * resets it per session — no persistence. The chip starts unselected
 * even when the underlying preference is set; the user explicitly
 * opts in.
 *
 * **Hidden when no chips apply.** If `applicableFilters(profile)` is
 * empty (e.g., the user has empty `languages` AND no other meta
 * fields are wired yet), the row collapses entirely — no header,
 * no padding, no visual gap. A "filter chips" affordance for a
 * profile with no filterable fields would just be confusing.
 */

import React, { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../theme';
import type { ViewerFilter, ViewerFilterId } from '../preferences/viewer_filters';

export interface ViewerFilterChipsViewProps {
  /** Applicable filters — the parent computes this with `applicableFilters(profile)`. */
  readonly filters: ReadonlyArray<ViewerFilter>;
  /** Currently-toggled-ON filter ids. */
  readonly active: ReadonlySet<ViewerFilterId>;
  /** Tap handler — receives the filter id. Caller flips the chip's state in `active`. */
  readonly onToggle: (id: ViewerFilterId) => void;
}

export function ViewerFilterChipsView(
  props: ViewerFilterChipsViewProps,
): React.ReactElement | null {
  const { filters, active, onToggle } = props;
  // Hide the entire row when no chips apply — see file header.
  if (filters.length === 0) return null;

  return (
    <View style={styles.container} testID="viewer-filter-chips">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {filters.map((f) => (
          <Chip
            key={f.id}
            filter={f}
            isActive={active.has(f.id)}
            onToggle={onToggle}
          />
        ))}
      </ScrollView>
    </View>
  );
}

interface ChipProps {
  readonly filter: ViewerFilter;
  readonly isActive: boolean;
  readonly onToggle: (id: ViewerFilterId) => void;
}

function Chip(props: ChipProps): React.ReactElement {
  const { filter, isActive, onToggle } = props;
  const handlePress = useCallback(() => onToggle(filter.id), [filter.id, onToggle]);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.chip,
        isActive && styles.chipActive,
        pressed && styles.chipPressed,
      ]}
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isActive }}
      accessibilityLabel={filter.label}
      testID={`viewer-filter-chip-${filter.id}`}
    >
      <Text style={[styles.chipLabel, isActive && styles.chipLabelActive]}>
        {filter.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgPrimary,
    paddingVertical: spacing.xs,
  },
  scroll: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.bgCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    // 36pt — matches the FacetBar chip inline-affordance floor and
    // the a11y test's `inlineAffordancePrefixes` contract for chips
    // that live inside a horizontal scroll row above the main content.
    minHeight: 36,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipPressed: { opacity: 0.7 },
  chipLabel: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipLabelActive: {
    color: colors.bgSecondary,
    fontFamily: fonts.sansMedium,
  },
});
