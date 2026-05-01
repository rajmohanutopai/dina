/**
 * Region settings screen (TN-V2-CTX-002).
 *
 * Lets the viewer pick which ISO 3166-1 country drives the regional
 * filtering / boosting on trust-network results. The picker has three
 * sections:
 *
 *   1. **Auto (device locale)** — pinned at the top. Selecting it
 *      saves `region: null`, which restores the default-from-locale
 *      semantic on next read.
 *   2. **Search box** — filters the list on display-name or code
 *      (case-insensitive).
 *   3. **Country list** — alphabetical by localised display name,
 *      one row per ISO code.
 *
 * **Loyalty Law**: the chosen region is persisted only via
 * `useViewerPreferences().save()` → keystore. Nothing is sent over
 * the wire.
 *
 * Tap-to-save semantics: there's no separate Save button. Tapping a
 * row writes through immediately and pops back to the parent screen.
 * Standard mobile picker pattern (matches the system Settings app).
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
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

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import { colors, fonts, radius, spacing } from '../../src/theme';
import {
  buildCountryList,
  filterCountries,
  type Country,
} from '../../src/trust/preferences/country_list';

export default function RegionScreen(): React.ReactElement {
  const router = useRouter();
  const { profile, isHydrated, save } = useViewerPreferences();
  const [query, setQuery] = useState('');

  // Locale for display-name lookup. We pull it from the device once
  // (NOT from `profile.languages`) — display-name localisation is a
  // UI-side concern, not a stored preference. A user who set
  // `languages: ['fr-FR']` but lives in Germany still sees German
  // names if their device locale is German.
  const fullList = useMemo(() => buildCountryList(), []);
  const filtered = useMemo(() => filterCountries(fullList, query), [fullList, query]);

  const onSelect = useCallback(
    async (code: string | null) => {
      // Optimistic save — write through then pop. If the keystore
      // write throws, expo-router's router.back() still fires; the
      // user lands back on the parent with the OLD region intact (the
      // hook didn't update because the write failed). That's the
      // right behaviour: a save failure should NOT silently appear
      // committed.
      try {
        await save({
          ...profile,
          region: code,
        });
      } catch {
        // Best-effort: surface nothing now (no toast infra in this
        // screen). The hook didn't update, so the parent shows the
        // unchanged region — which IS the truth.
      }
      router.back();
    },
    [profile, router, save],
  );

  const renderItem: ListRenderItem<Country> = useCallback(
    ({ item }) => (
      <CountryRow
        country={item}
        isSelected={profile.region === item.code}
        onSelect={onSelect}
      />
    ),
    [profile.region, onSelect],
  );

  // Stable key extractor — the ISO code is unique per row by design.
  const keyExtractor = useCallback((item: Country) => item.code, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Region' }} />

      {/* Search box — filters the list inline, no submit step. */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search countries"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Search countries"
        />
      </View>

      {/* "Auto" row — pinned above the list. Always visible (the
          search filter doesn't consider it; if the user typed
          something they're explicitly choosing a country, not
          falling back to auto). */}
      <Pressable
        style={({ pressed }) => [styles.row, styles.autoRow, pressed && styles.rowPressed]}
        onPress={() => onSelect(null)}
        accessibilityRole="button"
        accessibilityLabel={`Auto, use device locale${
          profile.region === null ? ', currently selected' : ''
        }`}
        testID="region-row-auto"
      >
        <View style={styles.rowMain}>
          <Text style={styles.rowLabel}>Auto</Text>
          <Text style={styles.rowSublabel}>Use device locale</Text>
        </View>
        {profile.region === null && (
          <Ionicons name="checkmark" size={20} color={colors.accent} testID="region-check-auto" />
        )}
      </Pressable>

      <View style={styles.divider} />

      {/* Country list. `null` data is briefly possible if the locale
          builder throws — defensive empty-state for that. */}
      {!isHydrated ? (
        <View style={styles.placeholderWrap}>
          <Text style={styles.placeholderText}>Loading…</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.placeholderWrap}>
          <Text style={styles.placeholderText}>No countries match "{query.trim()}"</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          // 250 items × ~48pt rows = ~12000pt scroll surface. The
          // `getItemLayout` short-circuit lets RN skip the per-row
          // measurement pass, which is the difference between a smooth
          // scroll and a janky one on older devices.
          getItemLayout={getItemLayout}
          // Pre-render a slightly-larger window than the default so
          // fast scrolls don't reveal placeholder rows.
          initialNumToRender={20}
          windowSize={11}
          testID="region-country-list"
        />
      )}
    </View>
  );
}

// ─── Internal ─────────────────────────────────────────────────────────────

const ROW_HEIGHT = 48;

function getItemLayout(_: ArrayLike<Country> | null | undefined, index: number) {
  return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
}

interface CountryRowProps {
  readonly country: Country;
  readonly isSelected: boolean;
  readonly onSelect: (code: string) => void;
}

function CountryRow(props: CountryRowProps): React.ReactElement {
  const { country, isSelected, onSelect } = props;
  // Memoise the press handler within the row so the row's Pressable
  // doesn't re-render on every list re-render.
  const handlePress = useCallback(() => onSelect(country.code), [country.code, onSelect]);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${country.displayName}${isSelected ? ', currently selected' : ''}`}
      testID={`region-row-${country.code}`}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel}>{country.displayName}</Text>
        <Text style={styles.rowSublabel}>{country.code}</Text>
      </View>
      {isSelected && (
        <Ionicons
          name="checkmark"
          size={20}
          color={colors.accent}
          testID={`region-check-${country.code}`}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgCard,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    margin: spacing.md,
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
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgPrimary,
  },
  autoRow: {
    backgroundColor: colors.bgCard,
  },
  rowPressed: { backgroundColor: colors.bgTertiary },
  rowMain: { flex: 1, flexDirection: 'column', justifyContent: 'center' },
  rowLabel: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.textPrimary,
  },
  rowSublabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
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
