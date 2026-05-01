/**
 * Vault hub — per-section Stack navigator.
 *
 * Same rationale as `app/trust/_layout.tsx`: without a Stack scoped
 * to the vault folder, drilling from `/vault` (the hub) into
 * `/vault/<name>` was a global tab transition rather than a
 * stack-push, so `router.back()` from a vault detail landed on
 * whatever tab was previously focused.
 *
 * With this Stack the vault hub keeps its tab-style header (driven
 * by the root `<Tabs>` with the hamburger), and per-vault detail
 * screens get the Stack's auto back-chevron header.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts } from '../../src/theme';
import { openMenu } from '../../src/navigation/menu_state';

function VaultIndexHamburger(): React.ReactElement {
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

function VaultIndexHelp(): React.ReactElement {
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

export default function VaultStackLayout(): React.ReactElement {
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
          title: 'Vaults',
          headerLeft: () => <VaultIndexHamburger />,
          headerRight: () => <VaultIndexHelp />,
        }}
      />
      <Stack.Screen name="[name]" options={{ title: 'Vault' }} />
    </Stack>
  );
}
