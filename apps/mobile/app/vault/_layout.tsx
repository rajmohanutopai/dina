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
import { StackIndexHeader } from '../../src/navigation/stack_index_header';

// CR-3 fix: see the matching note in `app/trust/_layout.tsx`. The
// shared `StackIndexHeader` is a JS-rendered View that replaces the
// native iOS UINavigationBar — Pressable a11y traits propagate to
// VoiceOver through it (the native nav-bar wrapper strips them).
function VaultIndexHeader(): React.ReactElement {
  const router = useRouter();
  // `?from=/vault` so the help-screen back chevron returns here
  // rather than the Chat-tab default in `parent_route.ts`. /help is
  // registered at the global Tabs root, so a bare push escapes this
  // Stack — same plumbing as `app/trust/_layout.tsx`.
  return (
    <StackIndexHeader
      title="Vaults"
      onMenuPress={openMenu}
      onHelpPress={() => router.push({ pathname: '/help', params: { from: '/vault' } })}
    />
  );
}

/**
 * Always-visible back chevron with a `/vault` fallback. Rehydrated
 * stacks may land directly on `/vault/<name>` without `/vault`
 * underneath — same trap pattern as Trust. `canGoBack` comes from
 * the Stack's `headerLeft` callback prop (Stack-scoped truth, not
 * parent Tabs') so popping doesn't accidentally cross-tab. See
 * `app/trust/_layout.tsx` for the full rationale.
 */
function VaultStackBack({ canGoBack }: { canGoBack: boolean }): React.ReactElement {
  const router = useRouter();
  const onPress = () => {
    if (canGoBack) {
      router.back();
    } else {
      router.replace('/vault');
    }
  };
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
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
        headerTintColor: colors.textPrimary,
        headerBackTitle: '',
        headerLeft: ({ canGoBack }) => (
          <VaultStackBack canGoBack={canGoBack ?? false} />
        ),
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Vaults',
          // CR-3: JS-rendered header so VoiceOver picks up the
          // hamburger + help. See `app/trust/_layout.tsx`'s matching
          // note for the rationale.
          header: () => <VaultIndexHeader />,
        }}
      />
      <Stack.Screen name="[name]" options={{ title: 'Vault' }} />
    </Stack>
  );
}
