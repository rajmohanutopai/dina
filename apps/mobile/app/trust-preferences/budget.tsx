/**
 * Budget settings screen (TN-V2-CTX-003).
 *
 * Per-category budget tier picker. Each row is a 4-segment control:
 *   None | $ | $$ | $$$
 *
 * "None" = remove the category key from `profile.budget` entirely
 * (no filtering for this category). The other three set a tier.
 *
 * Different UX shape from the multi-select pattern (CTX-005..007):
 *   - Multi-select rows are checkbox-like (one bit per option,
 *     toggles on tap).
 *   - Budget rows are radio-like: exactly one of {None, $, $$, $$$}
 *     selected, tap a segment to switch.
 *
 * The segment control is built inline rather than reusing a shared
 * component because the row layout (label + horizontal segments)
 * isn't shared with any other screen yet — we'll extract on rule
 * of three.
 *
 * Loyalty Law: as with the rest of the viewer profile, the budget
 * map is local-only and never sent to AppView.
 */

import { Stack } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import { colors, fonts, radius, spacing } from '../../src/theme';
import {
  BUDGET_CATEGORIES,
  type BudgetCategory,
} from '../../src/trust/preferences/budget_categories';
import type { BudgetTier } from '../../src/services/user_preferences';

/** Segment value: `null` = "None"; otherwise the tier itself. */
type SegmentValue = null | BudgetTier;

const SEGMENTS: ReadonlyArray<{ value: SegmentValue; label: string }> = [
  { value: null, label: 'None' },
  { value: '$', label: '$' },
  { value: '$$', label: '$$' },
  { value: '$$$', label: '$$$' },
];

export default function BudgetScreen(): React.ReactElement {
  const { profile, mutate } = useViewerPreferences();

  const onSelect = useCallback(
    (categoryKey: string, value: SegmentValue) => {
      void mutate((p) => {
        // `null` clears the category key. Destructure-and-rest avoids
        // both a `delete` (which fights `Readonly<Record>`) and a
        // type cast — `_omit` captures and discards the cleared
        // value; `rest` is the new budget object minus that key.
        if (value === null) {
          const { [categoryKey]: _omit, ...rest } = p.budget;
          return { ...p, budget: rest };
        }
        return {
          ...p,
          budget: { ...p.budget, [categoryKey]: value },
        };
      });
    },
    [mutate],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Budget' }} />
      <ScrollView contentContainerStyle={styles.content} testID="budget-screen">
        <Text style={styles.description}>
          Set a budget tier per category. We'll boost subjects in your range and demote
          ones outside it. Skipped categories aren't filtered.
        </Text>
        <View style={styles.list}>
          {BUDGET_CATEGORIES.map((cat) => (
            <CategoryRow
              key={cat.key}
              category={cat}
              selected={profile.budget[cat.key] ?? null}
              onSelect={onSelect}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Internal ─────────────────────────────────────────────────────────────

interface CategoryRowProps {
  readonly category: BudgetCategory;
  readonly selected: SegmentValue;
  readonly onSelect: (categoryKey: string, value: SegmentValue) => void;
}

function CategoryRow(props: CategoryRowProps): React.ReactElement {
  const { category, selected, onSelect } = props;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel}>{category.label}</Text>
        {category.description && (
          <Text style={styles.rowDescription}>{category.description}</Text>
        )}
      </View>
      <SegmentControl
        categoryKey={category.key}
        selected={selected}
        onSelect={onSelect}
      />
    </View>
  );
}

interface SegmentControlProps {
  readonly categoryKey: string;
  readonly selected: SegmentValue;
  readonly onSelect: (categoryKey: string, value: SegmentValue) => void;
}

function SegmentControl(props: SegmentControlProps): React.ReactElement {
  const { categoryKey, selected, onSelect } = props;
  return (
    <View
      style={styles.segments}
      accessibilityRole="radiogroup"
      testID={`budget-segments-${categoryKey}`}
    >
      {SEGMENTS.map((seg) => (
        <Segment
          key={seg.value ?? 'none'}
          categoryKey={categoryKey}
          segment={seg}
          isSelected={seg.value === selected}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

interface SegmentProps {
  readonly categoryKey: string;
  readonly segment: { value: SegmentValue; label: string };
  readonly isSelected: boolean;
  readonly onSelect: (categoryKey: string, value: SegmentValue) => void;
}

function Segment(props: SegmentProps): React.ReactElement {
  const { categoryKey, segment, isSelected, onSelect } = props;
  // Memoise the press handler within the segment so the row's
  // Pressable doesn't re-render on every parent re-render. Each
  // segment owns its own callback bound to its own value.
  const handlePress = useCallback(
    () => onSelect(categoryKey, segment.value),
    [categoryKey, segment.value, onSelect],
  );
  // testID slug uses 'none' for null and the literal tier symbols
  // urlencoded-friendly: '$' → 'tier-1', '$$' → 'tier-2', '$$$' → 'tier-3'.
  // Plain `$` characters in a testID get parsed as variables in some
  // querytools, so we sanitise.
  const slug = segment.value === null ? 'none' : `tier-${segment.value.length}`;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.segment,
        isSelected && styles.segmentSelected,
        pressed && styles.segmentPressed,
      ]}
      onPress={handlePress}
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={segment.value === null ? 'No filter' : `Tier ${segment.label}`}
      testID={`budget-segment-${categoryKey}-${slug}`}
    >
      <Text style={[styles.segmentLabel, isSelected && styles.segmentLabelSelected]}>
        {segment.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  description: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  list: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowMain: {},
  rowLabel: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.textPrimary,
  },
  rowDescription: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  segments: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  segmentSelected: {
    backgroundColor: colors.accent,
  },
  segmentPressed: { opacity: 0.7 },
  segmentLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  segmentLabelSelected: {
    color: colors.bgSecondary,
  },
});
