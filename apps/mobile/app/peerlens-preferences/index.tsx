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
 *
 * Region + Languages are live. Budget / Devices / Dietary /
 * Accessibility are collected but not yet consumed by the ranker
 * (the subject-metadata enrichers they filter on aren't shipped), so
 * they're shown as "Coming soon" and not navigable — we don't let a
 * user configure a knob that does nothing today.
 */

import { Stack, useRouter } from 'expo-router';
import React from 'react';
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
  comingSoon?: boolean;
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
    description: 'Spending range per category, so prices match what you would pay.',
    href: '/peerlens-preferences/budget',
    testID: 'peerlens-prefs-budget',
    comingSoon: true,
  },
  {
    label: 'Devices',
    description: 'Phones, laptops, and headphones you actually use.',
    href: '/peerlens-preferences/devices',
    testID: 'peerlens-prefs-devices',
    comingSoon: true,
  },
  {
    label: 'Dietary',
    description: 'Allergies and diets that shape food recommendations.',
    href: '/peerlens-preferences/dietary',
    testID: 'peerlens-prefs-dietary',
    comingSoon: true,
  },
  {
    label: 'Accessibility',
    description: 'Mobility, visual, and hearing needs that shape place recommendations.',
    href: '/peerlens-preferences/accessibility',
    testID: 'peerlens-prefs-accessibility',
    comingSoon: true,
  },
];

export default function PeerLensPreferencesIndex(): React.ReactElement {
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Review preferences', headerShown: true }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Dina uses these to personalise your review results on this device. Nothing here is sent
          off your device.
        </Text>

        <View style={styles.card}>
          {ROWS.map((row, idx) => {
            const isLast = idx === ROWS.length - 1;
            const comingSoon = row.comingSoon === true;
            return (
              <TouchableOpacity
                key={row.href}
                style={[styles.row, isLast && styles.rowLast]}
                onPress={() => router.push(row.href)}
                disabled={comingSoon}
                accessibilityRole="button"
                accessibilityState={{ disabled: comingSoon }}
                accessibilityLabel={`${row.label}. ${row.description}${
                  comingSoon ? '. Coming soon.' : ''
                }`}
                testID={row.testID}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, comingSoon && styles.rowLabelMuted]}>
                    {row.label}
                  </Text>
                  <Text style={styles.rowDescription}>{row.description}</Text>
                </View>
                {comingSoon ? (
                  <Text style={styles.soonBadge}>Soon</Text>
                ) : (
                  <Text style={styles.rowArrow}>{'›'}</Text>
                )}
              </TouchableOpacity>
            );
          })}
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
  rowLabelMuted: { color: colors.textMuted },
  rowDescription: {
    ...textStyles.caption,
    marginTop: 2,
  },
  rowArrow: {
    ...textStyles.h3,
    color: colors.textMuted,
  },
  soonBadge: {
    ...textStyles.caption,
    color: colors.textMuted,
    backgroundColor: colors.bgTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    overflow: 'hidden',
  },
});
