/**
 * PeerLens preferences — landing screen.
 *
 * One row per preference sub-page. Carved out of Settings so the
 * Settings list doesn't grow unbounded as PeerLens gains more knobs
 * (cosignature defaults, blocked categories, sentiment weighting,
 * etc.). Anything PeerLens-shaped lives here.
 *
 * Loyalty Law: every preference here stays on the device. None of
 * this is published to AppView; it only shapes how *your* Dina
 * surfaces / boosts / demotes results in your own trust-network
 * screens.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, radius, shadows, spacing, textStyles } from '../../src/theme';

interface Row {
  label: string;
  description: string;
  href:
    | '/peerlens-preferences/region'
    | '/peerlens-preferences/budget'
    | '/peerlens-preferences/devices'
    | '/peerlens-preferences/languages'
    | '/peerlens-preferences/dietary'
    | '/peerlens-preferences/accessibility';
  testID: string;
}

const ROWS: Row[] = [
  {
    label: 'Region',
    description: 'Where you are. Used to surface nearby places, services, and prices.',
    href: '/peerlens-preferences/region',
    testID: 'peerlens-prefs-region',
  },
  {
    label: 'Languages',
    description: 'Reviews in your languages get boosted; others stay reachable.',
    href: '/peerlens-preferences/languages',
    testID: 'peerlens-prefs-languages',
  },
  {
    label: 'Budget',
    description: 'Per-category spending bands to filter recommendations.',
    href: '/peerlens-preferences/budget',
    testID: 'peerlens-prefs-budget',
  },
  {
    label: 'Devices',
    description: 'Phones, laptops, headphones you actually use.',
    href: '/peerlens-preferences/devices',
    testID: 'peerlens-prefs-devices',
  },
  {
    label: 'Dietary',
    description: 'Allergies, preferences, restrictions for food recommendations.',
    href: '/peerlens-preferences/dietary',
    testID: 'peerlens-prefs-dietary',
  },
  {
    label: 'Accessibility',
    description: 'Mobility, visual, hearing needs that shape place recommendations.',
    href: '/peerlens-preferences/accessibility',
    testID: 'peerlens-prefs-accessibility',
  },
];

export default function PeerLensPreferencesIndex(): React.ReactElement {
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'PeerLens preferences', headerShown: true }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Shapes which results Dina surfaces in PeerLens. Everything here stays on this
          device.
        </Text>

        <View style={styles.card}>
          {ROWS.map((row, idx) => (
            <TouchableOpacity
              key={row.href}
              style={[styles.row, idx === ROWS.length - 1 && styles.rowLast]}
              onPress={() => router.push(row.href)}
              accessibilityRole="button"
              accessibilityLabel={`${row.label}. ${row.description}`}
              testID={row.testID}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowDescription}>{row.description}</Text>
              </View>
              <Text style={styles.rowArrow}>{'›'}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgPrimary },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  subtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...shadows.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    minHeight: 64,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowText: { flex: 1, marginRight: spacing.sm },
  rowLabel: textStyles.bodyLargeStrong,
  rowDescription: {
    ...textStyles.caption,
    marginTop: 2,
  },
  rowArrow: {
    ...textStyles.h3,
    color: colors.textMuted,
  },
});
