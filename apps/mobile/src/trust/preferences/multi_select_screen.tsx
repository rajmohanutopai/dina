/**
 * Shared multi-select settings screen (TN-V2-CTX-005..007).
 *
 * Devices, dietary, and accessibility are all the same UX shape:
 *   - Header with title.
 *   - Optional description / hint.
 *   - List of fixed options, each with a label + optional description.
 *   - Tap a row → toggle selection in the underlying field.
 *
 * This component owns the layout + a11y. Per-field screens
 * (`app/trust-preferences/devices.tsx`, etc.) supply the option list
 * and the `onToggle` callback that wires through to
 * `useViewerPreferences().mutate(...)`.
 *
 * Generic over the value type so each screen's options can be a
 * narrow string-union (e.g. `DeviceCompat`) and the `onToggle`
 * signature stays type-safe at the call site.
 *
 * Tap-to-toggle, not commit-on-Done: the underlying `mutate()` is
 * race-safe (see user_preferences.ts), so rapid taps compose
 * correctly — there's no need for a separate Save button or local
 * staging state. Matches the system Settings app pattern.
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItem,
} from 'react-native';

import { colors, fonts, radius, spacing } from '../../theme';

export interface MultiSelectOption<T extends string> {
  /** The persisted value (must match the underlying field's enum). */
  readonly value: T;
  /** Human-readable label shown on the row. */
  readonly label: string;
  /** Optional secondary text. Use sparingly — keeps rows scannable. */
  readonly description?: string;
}

export interface MultiSelectScreenProps<T extends string> {
  /** Stack header title (e.g. "Devices"). */
  readonly title: string;
  /**
   * Optional explanatory text shown above the list. Use to clarify
   * what the field affects (e.g. "Filter products to ones compatible
   * with your devices.")
   */
  readonly description?: string;
  /** Fixed option list — order is the render order. */
  readonly options: ReadonlyArray<MultiSelectOption<T>>;
  /** Currently-selected values from the profile. */
  readonly selected: ReadonlyArray<T>;
  /**
   * Toggle callback. Called with the value the user tapped — the
   * caller is responsible for either adding or removing it from
   * the underlying array (typically via a `mutate(updater)` call).
   */
  readonly onToggle: (value: T) => void;
  /**
   * Used as the testID prefix and a11y-label prefix. e.g. "devices"
   * → "devices-row-ios", "devices-check-ios".
   */
  readonly testIdPrefix: string;
  /**
   * When `true`, render a search box at the top that filters the
   * list on label / description / value (case-insensitive). Default
   * `false` — small option lists (devices, dietary, accessibility)
   * don't need search; large lists (languages with ~80 entries) do.
   */
  readonly searchable?: boolean;
  /** Placeholder text for the search box. Default: "Search". */
  readonly searchPlaceholder?: string;
}

export function MultiSelectScreen<T extends string>(
  props: MultiSelectScreenProps<T>,
): React.ReactElement {
  const {
    title,
    description,
    options,
    selected,
    onToggle,
    testIdPrefix,
    searchable = false,
    searchPlaceholder = 'Search',
  } = props;

  const selectedSet = useMemo(() => new Set<T>(selected), [selected]);
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => (searchable ? filterOptions(options, query) : options),
    [searchable, options, query],
  );

  const renderItem: ListRenderItem<MultiSelectOption<T>> = useCallback(
    ({ item }) => (
      <Row
        option={item}
        isSelected={selectedSet.has(item.value)}
        onToggle={onToggle}
        testIdPrefix={testIdPrefix}
      />
    ),
    [selectedSet, onToggle, testIdPrefix],
  );

  const keyExtractor = useCallback(
    (item: MultiSelectOption<T>) => item.value,
    [],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title }} />
      {description && (
        <Text style={[styles.description, styles.descriptionInline]}>{description}</Text>
      )}
      {searchable && (
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={searchPlaceholder}
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={searchPlaceholder}
            testID={`${testIdPrefix}-search`}
          />
        </View>
      )}
      {searchable && filtered.length === 0 ? (
        <View style={styles.placeholderWrap} testID={`${testIdPrefix}-empty`}>
          <Text style={styles.placeholderText}>No matches for "{query.trim()}"</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          // Pinned in the styles below — letting RN skip per-row
          // measurement keeps the language list (80+ rows) smooth.
          getItemLayout={getItemLayout}
          initialNumToRender={20}
          windowSize={11}
          testID={`${testIdPrefix}-screen`}
        />
      )}
    </View>
  );
}

function filterOptions<T extends string>(
  options: ReadonlyArray<MultiSelectOption<T>>,
  query: string,
): ReadonlyArray<MultiSelectOption<T>> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return options;
  const needle = trimmed.toLowerCase();
  return options.filter(
    (opt) =>
      opt.value.toLowerCase().includes(needle) ||
      opt.label.toLowerCase().includes(needle) ||
      (opt.description !== undefined && opt.description.toLowerCase().includes(needle)),
  );
}

const ROW_HEIGHT = 52;

function getItemLayout(_: ArrayLike<unknown> | null | undefined, index: number) {
  return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
}

interface RowProps<T extends string> {
  readonly option: MultiSelectOption<T>;
  readonly isSelected: boolean;
  readonly onToggle: (value: T) => void;
  readonly testIdPrefix: string;
}

function Row<T extends string>(props: RowProps<T>): React.ReactElement {
  const { option, isSelected, onToggle, testIdPrefix } = props;
  const handlePress = useCallback(
    () => onToggle(option.value),
    [option.value, onToggle],
  );
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected }}
      accessibilityLabel={`${option.label}${
        option.description ? `, ${option.description}` : ''
      }`}
      testID={`${testIdPrefix}-row-${option.value}`}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel}>{option.label}</Text>
        {option.description && (
          <Text style={styles.rowDescription}>{option.description}</Text>
        )}
      </View>
      {isSelected && (
        <Ionicons
          name="checkmark"
          size={22}
          color={colors.accent}
          testID={`${testIdPrefix}-check-${option.value}`}
        />
      )}
    </Pressable>
  );
}

/**
 * Toggle helper for the consumer screens — adds the value if absent,
 * removes it if present. Pure function so the consumer's `mutate`
 * updater stays a one-liner. Returns a NEW array; original is
 * untouched (so the in-memory snapshot's referential-stability
 * contract holds).
 */
export function toggleArrayValue<T extends string>(
  arr: ReadonlyArray<T>,
  value: T,
): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  description: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  // Description is INSIDE the screen frame (above the search and the
  // list), so it gets matched padding to align with the list rows.
  descriptionInline: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgCard,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.textPrimary,
    padding: 0,
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
  },
  row: {
    minHeight: ROW_HEIGHT,
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgCard,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.bgTertiary },
  rowMain: { flex: 1 },
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
  placeholderWrap: {
    padding: spacing.lg,
    alignItems: 'center',
  },
  placeholderText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textMuted,
  },
});
