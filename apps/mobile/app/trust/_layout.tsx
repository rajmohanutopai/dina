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
import { StackIndexHeader } from '../../src/navigation/stack_index_header';

// CR-3 fix: render the index-screen header in JS via `Stack.Screen`
// `header` prop. Custom JSX placed in `headerLeft`/`headerRight` of
// the native iOS nav bar gets wrapped in UIBarButtonItem chrome that
// strips the React Native a11y traits — Pressable AND HeaderButton
// both produced an unlabeled `Group` in the AX tree (verified via
// `idb ui describe-all` 2026-05-01). The `header` prop replaces the
// native nav bar entirely with a JS-rendered View, where Pressable
// a11y traits propagate to VoiceOver correctly (same render path as
// the global Tabs root header which already works). The shared
// implementation lives at `src/navigation/stack_index_header.tsx`
// so Vault + Trust both use it.

function TrustIndexHeader(): React.ReactElement {
  const router = useRouter();
  // `?from=/trust` makes the help screen's back chevron return here
  // rather than the Chat tab. /help is registered at the global Tabs
  // root (not inside this Stack), so a bare push escapes the Trust
  // navigation history; the `from` query param is how
  // `HeaderBackButton` (in `app/_layout.tsx`) recovers the source
  // section.
  return (
    <StackIndexHeader
      title="Trust"
      onMenuPress={openMenu}
      onHelpPress={() => router.push({ pathname: '/help', params: { from: '/trust' } })}
    />
  );
}

/**
 * Always-visible back chevron for Stack drill-down screens.
 *
 * Why this exists: the Stack's auto-back chevron only renders when
 * the navigator has a previous route in its history. On cold-start
 * with state-restoration, expo-router can rehydrate directly into
 * a deep route (e.g. `/trust/search`) WITHOUT pushing the index
 * underneath — which leaves the user trapped on a screen with no
 * back affordance, no way to reach the Stack root. (Reproduced via
 * idb on 2026-05-01: tap Trust → Search → switch tabs → switch
 * back = Search restored, no chevron, tab-tap doesn't pop-to-top.)
 *
 * `canGoBack` is taken from the Stack's `headerLeft` callback prop
 * (the canonical Stack-scoped value) rather than `useNavigation()`
 * — the latter, when called from a header chrome component, resolves
 * to the OUTER Tabs navigator and reports `canGoBack: true` because
 * the user just came from another tab. Acting on that wrong-navigator
 * truth pops back to the prior tab (Chat) instead of the Stack root,
 * which is exactly the bug we're fixing.
 */
function TrustStackBack({ canGoBack }: { canGoBack: boolean }): React.ReactElement {
  const router = useRouter();
  const onPress = () => {
    if (canGoBack) {
      // Goes back inside the Stack — search → subject → reviewer →
      // back returns to the right level.
      router.back();
    } else {
      // Stack is shallow (cold-start rehydrated to a deep route).
      // `replace` rather than `push` so a user repeatedly bouncing
      // doesn't grow the Stack indefinitely with stale entries.
      router.replace('/trust');
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
        // `textPrimary` (`#1C1917`) replaces the prior `tabInactive`
        // (`#A8A29E`). The auto-back chevron uses this token; the
        // pale grey was nearly invisible on the off-white header
        // background. Custom `headerLeft` overrides below render
        // their own colored Ionicons and aren't affected.
        headerTintColor: colors.textPrimary,
        headerBackTitle: '',
        // Explicit headerLeft fallback for every drill-down — see
        // `TrustStackBack` above for why the auto-chevron isn't
        // sufficient on rehydrated stacks. `canGoBack` is the
        // Stack's own value, not the parent navigator's.
        headerLeft: ({ canGoBack }) => (
          <TrustStackBack canGoBack={canGoBack ?? false} />
        ),
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Trust',
          // CR-3: replace the native UINavigationBar entirely with the
          // JS-rendered StackIndexHeader so the hamburger + help
          // Pressables propagate a11y traits to VoiceOver. See the
          // top-of-file comment for the full rationale.
          header: () => <TrustIndexHeader />,
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
