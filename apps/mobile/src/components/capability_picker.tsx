/**
 * Category → Capability picker (SERVICE_CAPABILITY_CATALOG_DESIGN.md §1 / §8 / §37).
 *
 * The product model is "Category → Official capability → listing": a normal
 * provider should NOT type capability ids. This picker drives the two steps:
 *   1. "What kind of service is this?"  — pick a category.
 *   2. "What can this service answer or do?" — pick an official capability in
 *      that category. Capabilities are cross-category (§9.1), so the same
 *      capability surfaces under each of its categories; the CHOSEN category
 *      travels onto the listing (it controls policy/consent/ranking).
 *
 * Presentational — the catalog + selection state + callbacks are injected (the
 * parent owns boot/fetch/persistence). Custom (namespaced) capabilities are a
 * separate advanced flow, not this picker (§8 / §3.2).
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';

import {
  capabilitiesInCategory,
  sortedCategories,
  type CatalogData,
} from '../services/catalog_source';
import { colors, radius, spacing, textStyles } from '../theme';

import type { CapabilityDefinition } from '@dina/protocol';

export interface CapabilityPickerProps {
  readonly catalog: CatalogData;
  readonly selectedCategoryId: string | null;
  readonly onSelectCategory: (categoryId: string) => void;
  readonly selectedCapabilityId: string | null;
  /** Fires with the picked capability AND the concrete category it was picked under. */
  readonly onSelectCapability: (capability: CapabilityDefinition, categoryId: string) => void;
}

/** Short human label for a non-stable lifecycle (stable shows nothing). */
function lifecycleLabel(lifecycle: CapabilityDefinition['lifecycle']): string | null {
  switch (lifecycle) {
    case 'beta':
      return 'Beta';
    case 'deprecated':
      return 'Deprecated';
    case 'draft':
      return 'Draft';
    default:
      return null; // stable / retired (retired is already filtered out)
  }
}

export function CapabilityPicker(props: CapabilityPickerProps): React.ReactElement {
  const categories = sortedCategories(props.catalog);
  const caps =
    props.selectedCategoryId !== null
      ? capabilitiesInCategory(props.catalog, props.selectedCategoryId)
      : [];

  return (
    <View testID="capability-picker">
      <Text style={styles.stepHeading}>What kind of service is this?</Text>
      <View style={styles.categoryWrap}>
        {categories.map((cat) => {
          const selected = cat.id === props.selectedCategoryId;
          return (
            <Pressable
              key={cat.id}
              testID={`picker-category-${cat.id}`}
              onPress={() => props.onSelectCategory(cat.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={cat.display_name}
              style={({ pressed }) => [
                styles.categoryChip,
                selected && styles.categoryChipSelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.categoryChipText, selected && styles.categoryChipTextSelected]}>
                {cat.display_name}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {props.selectedCategoryId !== null ? (
        <View style={styles.capabilitySection}>
          <Text style={styles.stepHeading}>What can this service answer or do?</Text>
          {caps.length === 0 ? (
            <Text style={styles.emptyText}>
              No official capabilities here yet. Use an advanced custom capability instead.
            </Text>
          ) : (
            <ScrollView style={styles.capabilityList}>
              {caps.map((cap) => {
                const selected = cap.id === props.selectedCapabilityId;
                const badge = lifecycleLabel(cap.lifecycle);
                return (
                  <Pressable
                    key={cap.id}
                    testID={`picker-capability-${cap.id}`}
                    onPress={() => props.onSelectCapability(cap, props.selectedCategoryId as string)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${cap.display_name}. ${cap.short_description}`}
                    style={({ pressed }) => [
                      styles.capabilityRow,
                      selected && styles.capabilityRowSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.capabilityHeader}>
                      <Text style={styles.capabilityName}>{cap.display_name}</Text>
                      <Text style={styles.officialTag}>Official Dina capability</Text>
                      {badge !== null ? <Text style={styles.lifecycleBadge}>{badge}</Text> : null}
                    </View>
                    <Text style={styles.capabilityDesc} numberOfLines={2}>
                      {cap.short_description}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stepHeading: {
    ...textStyles.bodyStrong,
    marginBottom: spacing.sm,
  },
  pressed: { opacity: 0.6 },
  categoryWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  categoryChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  categoryChipSelected: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary,
  },
  categoryChipText: textStyles.bodySmall,
  categoryChipTextSelected: { color: colors.bgPrimary },
  capabilitySection: {
    marginTop: spacing.lg,
  },
  capabilityList: {
    maxHeight: 320,
  },
  capabilityRow: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    marginBottom: spacing.sm,
  },
  capabilityRowSelected: {
    borderColor: colors.accent,
    borderWidth: 1.5,
  },
  capabilityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  capabilityName: textStyles.body,
  officialTag: {
    ...textStyles.tiny,
    color: colors.textMuted,
  },
  lifecycleBadge: {
    ...textStyles.tiny,
    color: colors.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  capabilityDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  emptyText: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
  },
});
