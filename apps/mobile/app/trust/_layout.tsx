/**
 * Trust tab — per-tab Stack navigator.
 *
 * Why this layout exists at all: the root `app/_layout.tsx` uses
 * `<Tabs>` with no nested Stacks. Without a Stack scoped to the
 * Trust tab, every drill-down (`/trust/search`, `/trust/[subjectId]`,
 * `/trust/reviewer/[did]`, …) became a global tab transition under
 * the hood, which meant `router.back()` popped to the previously-
 * focused tab rather than the previously-pushed screen. So
 * Trust → Search → Back ended up on Chat.
 *
 * With a Stack here, each push within `/trust/...` adds to a
 * Trust-scoped history, and the Stack's automatic back chevron pops
 * cleanly: search → subject → reviewer → back goes to subject, not
 * to /trust.
 *
 * Header strategy:
 *   - **Index (`/trust`)** — Stack header with the hamburger on the
 *     left + help on the right. Mirrors the look of the root Tabs
 *     header used by non-Stack tabs (Chat, People, Notifications,
 *     Approvals).
 *   - **Drill-downs** — Stack default header with the automatic back
 *     chevron and the per-route title.
 *   - The root Tabs header is hidden for the trust tab via
 *     `headerShown: false` on the Tabs.Screen — letting both render
 *     would produce a duplicate header band.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts } from '../../src/theme';
import { openMenu } from '../../src/navigation/menu_state';

function TrustIndexHamburger(): React.ReactElement {
  return (
    <Pressable
      onPress={openMenu}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Open menu"
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Ionicons name="menu-outline" size={26} color={colors.tabInactive} />
    </Pressable>
  );
}

function TrustIndexHelp(): React.ReactElement {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push('/help')}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Open help"
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Ionicons name="help-circle-outline" size={24} color={colors.tabInactive} />
    </Pressable>
  );
}

export default function TrustStackLayout(): React.ReactElement {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.bgPrimary,
          ...(Platform.OS === 'ios' ? { shadowOpacity: 0 } : { elevation: 0 }),
        },
        headerTitleStyle: {
          fontFamily: fonts.heading,
          fontWeight: '600',
          fontSize: 17,
          color: colors.textPrimary,
        },
        headerShadowVisible: false,
        headerTintColor: colors.tabInactive,
        headerBackTitle: '',
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Trust',
          headerLeft: () => <TrustIndexHamburger />,
          headerRight: () => <TrustIndexHelp />,
        }}
      />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
      {/*
        Subject + reviewer titles are placeholders — the runner that
        resolves the actual subject/reviewer name swaps them in via
        `navigation.setOptions({ title })` once the wire data lands.
      */}
      <Stack.Screen name="[subjectId]" options={{ title: 'Subject' }} />
      <Stack.Screen name="reviewer/[did]" options={{ title: 'Reviewer' }} />
      <Stack.Screen name="write" options={{ title: 'Write a review' }} />
      <Stack.Screen name="outbox" options={{ title: 'Outbox' }} />
      <Stack.Screen name="namespace" options={{ title: 'Namespaces' }} />
    </Stack>
  );
}
