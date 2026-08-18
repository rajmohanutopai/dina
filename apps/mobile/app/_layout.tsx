/**
 * Root layout — Expo Router file-based routing.
 *
 * Tab navigator: Chat, People, Network, Activity
 * Hamburger: Vault, Reminders, Settings, Help, Sign out
 * Hidden/deep-link routes: Approvals, Service settings, Vault drill-downs,
 *   Settings family, etc. (all `href: null`)
 *
 * Four primary surfaces (product IA, not implementation concepts):
 *   - Chat     — ask / remember / task / service answers / Dina conversation
 *   - People   — contacts, identities, people graph, relationships
 *   - Network  — services, providers, PeerLens reviews, trust discovery
 *                (the `/peerlens` index, reframed; route folder unchanged)
 *   - Activity — notifications, approvals, reminders, nudges, service results,
 *                safety prompts (the unified inbox)
 *
 * Reminders moved off the bottom bar (it fans out into the unified inbox
 * already) and lives in the menu sheet. Approvals is no longer a bottom
 * tab — it's an action bucket inside Activity, reachable as a hidden
 * deep-link route (`/approvals`).
 */

import '../src/polyfills';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  CormorantGaramond_600SemiBold,
  CormorantGaramond_600SemiBold_Italic,
} from '@expo-google-fonts/cormorant-garamond';
import {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
} from '@expo-google-fonts/figtree';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';
import {
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { Tabs, useRouter, usePathname, useGlobalSearchParams } from 'expo-router';
import React, { useEffect, useSyncExternalStore } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  TouchableOpacity,
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { markNotificationRead } from '@dina/brain/notifications';

import { DinaWordmark } from '../src/components/DinaWordmark';
import { GuidedDemoGate } from '../src/components/guided_demo/GuidedDemoGate';
import { UnlockGate } from '../src/components/unlock_gate';
import { FEATURES, FeatureIcon, type FeatureKey } from '../src/features';
import { useGuidedDemoActive } from '../src/guided_demo/active_context';
import { useAutoLock } from '../src/hooks/useAutoLock';
import { useBackupPrompt } from '../src/hooks/useBackupPrompt';
import { clearThread } from '../src/hooks/useChatThread';
import { useCreditsClaim } from '../src/hooks/useCreditsClaim';
import { useNodeBootstrap } from '../src/hooks/useNodeBootstrap';
import { useUnreadBadge } from '../src/hooks/useNotificationsBadge';
import { useRelayWake } from '../src/hooks/useRelayWake';
import { useReminderFireWatcher } from '../src/hooks/useReminderFireWatcher';
import { sealVault, useIsUnlocked } from '../src/hooks/useUnlock';
import { closeMenu, getMenuOpen, openMenu, subscribeMenuOpen } from '../src/navigation/menu_state';
import { parentRouteFor } from '../src/navigation/parent_route';
import { handleColdStartDeepLink, handleNotificationTap } from '../src/notifications/deep_link';
import {
  ensureChannels,
  rescheduleAllReminders,
  requestPushPermission,
} from '../src/notifications/local';
import { installReminderPushBridge } from '../src/notifications/reminder_push_bridge';
import { isTrustTabHidden } from '../src/peerlens/flags';
import { startReviewPublishWorker } from '../src/peerlens/review_publish_autodrain';
import { startReasoningCommitRecovery } from '../src/reasoning/reasoning_commit_recovery';
import { recordBoot } from '../src/services/diagnostics_history';
import { bootstrapInferredPreferences } from '../src/services/preferences_bootstrap';
import {
  subscribeRuntimeWarnings,
  getRuntimeWarnings,
  type RuntimeWarning,
} from '../src/services/runtime_warnings';
import { colors, navTitle, textStyles } from '../src/theme';

import type { BootDegradation } from '../src/services/boot_service';

// Horizontal Dina mark used in the Chat tab's header. Other tabs
// keep their text title — using the wordmark on every screen would
// dilute it. The asset is at retina resolution (1672×941, ratio
// 1.78), so width is generous and `contain` lets the height drive
// the rendered size without stretching.
function DinaHeaderTitle() {
  // The brand mark in the top bar is the spaced DINA wordmark — NOT the
  // domino-D glyph, which is reserved for the app icon alone.
  return <DinaWordmark />;
}

// Hamburger button + nav menu sheet rendered as `headerLeft` on
// every top-level tab.  Opens a modal listing the secondary
// destinations (Vault + Settings) that don't earn a permanent
// bottom-tab slot.  Top-left placement is the standard drawer spot
// on both iOS and Android and stays out of the way of a rightward
// `headerRight` content slot.
type NavMenuItem =
  | { feature: FeatureKey; href: string; action?: undefined; label?: undefined; ionicon?: undefined }
  | { feature: FeatureKey; href?: undefined; action: 'lock'; label?: undefined; ionicon?: undefined }
  /** Commerce destinations — not (yet) core FeatureKeys, so they carry
   *  their own label + icon instead of a registry lookup. */
  | {
      feature?: undefined;
      action?: undefined;
      href: string;
      label: string;
      ionicon: React.ComponentProps<typeof Ionicons>['name'];
    };

const NAV_MENU_ITEMS: NavMenuItem[] = [
  { feature: 'vault', href: '/vault' },
  { feature: 'reminders', href: '/reminders' },
  { href: '/orders', label: 'My Orders', ionicon: 'receipt-outline' },
  { href: '/catalog', label: 'My Catalog', ionicon: 'pricetags-outline' },
  // Notifications was here; now it's a bottom-bar tab so the menu
  // entry would just be a duplicate. Reachable via the bell-icon tab.
  { feature: 'settings', href: '/settings' },
  { feature: 'help', href: '/help' },
  // Action item — drops in-memory DEKs, closes SQLCipher handles, and
  // arms the one-shot force-prompt flag so the next vault access
  // prompts for a passphrase even when `startupMode === 'auto'` has
  // cached one in the keychain. UnlockGate's subscriber re-renders to
  // the "Welcome back" passphrase prompt on the next tick.
  // Named "Sign out" because the underlying SQLCipher files are always
  // encrypted at rest — this button locks the SESSION, not the vault.
  { feature: 'signOut', action: 'lock' },
];

function HeaderMenuButton({ onPress }: { onPress: () => void }) {
  // Hidden during a guided demo: the menu (Vault / Reminders / Settings / Help /
  // Sign out) is the last escape hatch once the dock covers the composer + tabs.
  // Keeping the user on the guided path is the whole point of the demo.
  if (useGuidedDemoActive()) return null;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      testID="root-layout-menu"
      accessibilityRole="button"
      accessibilityLabel="Open menu"
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Ionicons name="menu-outline" size={26} color={colors.tabInactive} />
    </Pressable>
  );
}

/**
 * iOS-style back chevron used on every drill-down screen
 * (`/admin`, `/peerlens/[subjectId]`, `/chat/[did]`, …).
 *
 * We can't rely on Expo Router's automatic back button here: the
 * root layout uses `<Tabs>`, and the global `screenOptions.headerLeft`
 * — which injects the hamburger — silently overrides whatever the
 * navigator would otherwise render. Drill-down screens explicitly
 * pass this component as `headerLeft` so the user gets a visible
 * "<" affordance, while the 5 top-level tabs keep the hamburger.
 *
 * Why route-aware navigation instead of `router.back()`:
 *   With bare `<Tabs>` (no per-tab `<Stack>`), `router.back()` pops
 *   the previously-focused tab — not the previously-pushed screen.
 *   So PeerLens → Search → Back lands on the Chat tab if Chat was
 *   focused before the user switched to PeerLens. We compute the
 *   logical parent from the pathname and navigate there directly.
 *   Detailed rationale + the section-parent map live in
 *   `src/navigation/parent_route.ts`.
 *
 * Source-aware override: when the incoming route carries `?from=<path>`,
 * the back button honours that over the static parent-route map. Used
 * by the per-section help launcher (PeerLens's `(?)` button pushes
 * `/help?from=/trust`) so back from Help returns to the section the
 * user opened it from rather than the Chat default. The parent-route
 * map remains the fallback when no `from` is present.
 */
function HeaderBackButton({ onMenuFallback: _onMenuFallback }: { onMenuFallback: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ from?: string | string[] }>();
  const onPress = () => {
    const fromRaw = params.from;
    const from = typeof fromRaw === 'string' ? fromRaw : null;
    // Validate `from` is a same-origin path. Anything that doesn't
    // start with `/` (or starts with `//` — protocol-relative) falls
    // through to the parent-route map. Defensive against a malformed
    // deep link planting an absolute URL into history.
    const target =
      from !== null && from.startsWith('/') && !from.startsWith('//')
        ? from
        : parentRouteFor(pathname);
    // `replace` rather than `push` so a user repeatedly bouncing
    // between a section's root and a drill-down doesn't grow the
    // navigation stack indefinitely.
    router.replace(target as never);
  };
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      testID="root-layout-back"
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
      }}
    >
      <Ionicons name="chevron-back" size={26} color={colors.tabInactive} />
    </Pressable>
  );
}

/**
 * Always-visible Help button on the tab header. The empty-state CTA on
 * the Chat screen teaches first-time users; this is the same path
 * available from any tab once they're past the initial screen.
 */
function HeaderHelpButton({ onPress }: { onPress: () => void }) {
  // During a guided demo the header is an escape hatch (it routes straight to
  // Help, which carries the "replay the demo" CTA). Hide it so the demo dock is
  // the only interactive surface, matching the locked-down composer + tab bar.
  if (useGuidedDemoActive()) return null;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      testID="root-layout-help"
      accessibilityRole="button"
      accessibilityLabel="Open help"
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Ionicons name="help-circle-outline" size={24} color={colors.tabInactive} />
    </Pressable>
  );
}

function NavMenuSheet({
  visible,
  onClose,
  onSelect,
  currentPath,
  onClearChat,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (item: NavMenuItem) => void;
  /**
   * Pathname of the currently rendered screen, e.g. `/settings` or
   * `/vault/general`. The matching menu entry is omitted so the user
   * doesn't see "Settings" while already on Settings — tapping it
   * was a router.push to the same route, which read as broken.
   */
  currentPath: string;
  /** Clear the current Chat thread (history only — source data is kept). */
  onClearChat: () => void;
}) {
  // Match by prefix so deep routes like `/vault/general` still hide
  // the Vault entry. Exact equality alone would leave Vault visible
  // when the user is already inside one of its sub-screens. Action
  // items (no href) are always shown — they're not duplicating any
  // current route.
  const items = NAV_MENU_ITEMS.filter(
    (item) =>
      item.href === undefined ||
      !(currentPath === item.href || currentPath.startsWith(`${item.href}/`)),
  );
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={navMenuStyles.backdrop}
        onPress={onClose}
        testID="root-layout-menu-backdrop"
        // Backdrop is a tap-to-dismiss surface; it must NOT claim
        // the AX role for the whole subtree, otherwise iOS collapses
        // everything into a single AXGenericElement labelled with
        // the rows' joined text — VoiceOver users can't pick a row.
        // `accessible=false` (iOS) + `importantForAccessibility=
        // 'no-hide-descendants'` (Android) makes the parent
        // transparent to AX without hiding its children.
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <Pressable
          style={navMenuStyles.sheet}
          onPress={() => undefined}
          testID="root-layout-menu-sheet"
          // Same reasoning as the backdrop — the sheet container
          // is a no-op tap sink (its onPress prevents close-on-card-
          // tap). Let the row TouchableOpacities own AX exposure.
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {items.map((item) => {
            const label =
              item.feature !== undefined
                ? (FEATURES[item.feature].menuLabel ?? FEATURES[item.feature].name)
                : item.label;
            return (
              <TouchableOpacity
                key={item.href ?? `action:${item.action}`}
                style={navMenuStyles.row}
                testID={`root-layout-menu-row-${item.feature ?? item.href}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => onSelect(item)}
              >
                <View style={{ marginRight: 14 }}>
                  {item.feature !== undefined ? (
                    <FeatureIcon feature={item.feature} size={22} color={colors.textPrimary} />
                  ) : (
                    <Ionicons name={item.ionicon} size={22} color={colors.textPrimary} />
                  )}
                </View>
                <Text style={navMenuStyles.rowText}>{label}</Text>
              </TouchableOpacity>
            );
          })}
          {/* Clear the Chat thread (history only — reminders/vault are kept;
              the cards are re-rendered chat messages, not the source data).
              Lives at the bottom, after the feature rows. */}
          <TouchableOpacity
            key="action:clearChat"
            style={navMenuStyles.row}
            testID="root-layout-menu-row-clear-chat"
            accessibilityRole="button"
            accessibilityLabel="New chat (clear conversation)"
            onPress={onClearChat}
          >
            <View style={{ marginRight: 14 }}>
              <Ionicons name="create-outline" size={22} color={colors.textPrimary} />
            </View>
            <Text style={navMenuStyles.rowText}>New chat</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const navMenuStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.18)',
    justifyContent: 'flex-start',
  },
  sheet: {
    marginTop: Platform.OS === 'ios' ? 96 : 64,
    marginLeft: 12,
    backgroundColor: colors.bgPrimary,
    borderRadius: 14,
    paddingVertical: 6,
    minWidth: 200,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  rowText: textStyles.bodyLargeStrong,
});

type TabName = 'Chat' | 'People' | 'Network' | 'Activity';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Maps each tab to its feature key — icons come from the registry, the
// user-facing label is the `title` on each Tabs.Screen below. Network is
// the `peerlens` surface (reframed) and Activity is the `notifications`
// inbox; the feature keys stay canonical (see FEATURE_NAMES).
const TAB_FEATURE: Record<TabName, FeatureKey> = {
  Chat: 'chat',
  People: 'people',
  Network: 'peerlens',
  Activity: 'notifications',
};

// Per-tab icon override for SURFACES whose tab glyph should differ from the
// underlying feature's icon. Network is the `peerlens` surface, but PeerLens's
// glasses icon connotes "reviews/lens" specifically — wrong for the broader
// external-network surface (services + providers + trust discovery). A globe
// reads as "the outside network." PeerLens keeps its glasses icon everywhere
// else (help screen, feature lists) since the SUBSYSTEM identity is unchanged.
const TAB_ICON_OVERRIDE: Partial<Record<TabName, { outline: IoniconName; filled: IoniconName }>> = {
  Network: { outline: 'globe-outline', filled: 'globe' },
};

function TabIcon({ name, focused }: { name: TabName; focused: boolean }) {
  const tint = focused ? colors.tabActive : colors.tabInactive;
  const override = TAB_ICON_OVERRIDE[name];
  return (
    <View style={tabIconStyles.container}>
      {override !== undefined ? (
        <Ionicons name={focused ? override.filled : override.outline} size={22} color={tint} />
      ) : (
        <FeatureIcon feature={TAB_FEATURE[name]} size={22} color={tint} focused={focused} />
      )}
    </View>
  );
}

const tabIconStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 2,
  },
});

export default function RootLayout() {
  // Load the Ionicons font at runtime (see `TAB_GLYPHS` above). The
  // package is JS-only on the mobile workspace — the font's TTF asset
  // is shipped via the JS bundle + registered with the OS by
  // `expo-font` when this hook resolves. Without this, every
  // `<Ionicons />` would render as empty whitespace because iOS has
  // no font called "ionicons" registered.
  const [iconsFontLoaded] = useFonts({
    ...Ionicons.font,
    ...MaterialCommunityIcons.font,
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    CormorantGaramond_600SemiBold,
    CormorantGaramond_600SemiBold_Italic,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  // `useIsUnlocked` subscribes to the unlock module's transition events
  // so the boot hook re-runs when the user unlocks after first paint —
  // no longer gated on a navigation remount (issue #12). `enabled:
  // false` cleanly skips the effect while we wait.
  const unlocked = useIsUnlocked();

  // Auto-lock on app background (MT-40). Subscribes to React Native's
  // AppState while the vault is unlocked; on `background` transition
  // (durable — `inactive` is ignored as a transient overlay state)
  // schedules a `sealVault()` after the user-configured background
  // timeout (default 5 minutes, settable via Settings → Security).
  // The seal arms the same force-prompt flag that explicit Sign out
  // uses, so the next foreground re-entry prompts for a passphrase
  // even when `startupMode === 'auto'`.
  useAutoLock(unlocked);

  // Recovery-phrase backup nudge (deferred + value-proportionate). Pops the
  // backup-reminder page at a quiet moment once the vault holds enough to be
  // worth protecting — replaces the old first-run phrase wall + yellow banner.
  useBackupPrompt(unlocked);

  // Foreground → reconnect the relay immediately (#351 complement). iOS
  // suspends JS on background, killing the MsgBox socket; without this
  // the next keepalive tick has to notice staleness (up to ~90s) before
  // reconnecting, leaving the Home Node unreachable to agents/peers right
  // after the user reopens the app. `wakeRelay()` self-noops when healthy.
  useRelayWake(unlocked);

  // Starter Credits — fire-and-forget claim (enhancement, never a gate;
  // all sequencing lives in the credits state machine).
  useCreditsClaim(unlocked);

  // Explicit demo-mode toggle: reads the Expo public env var and
  // passes it through to the composer. Default off so a production
  // build never picks up Bus 42 demo state by accident (findings
  // #1, #15).
  const demoMode = process.env.EXPO_PUBLIC_DINA_DEMO === '1';
  const bootState = useNodeBootstrap({
    enabled: unlocked,
    overrides: { demoMode },
  });

  // Hide the tab tree when boot failed — rendering it anyway means every
  // screen tries to read Core globals that were never installed and
  // throws a fresh error per tab. Issue #15.
  const showTabs = bootState.status !== 'error' && iconsFontLoaded;

  // Activity tab badge — action-first (spec 5.4). Pending approvals take
  // priority so a safety decision never hides behind a chronological
  // unread count; when there are none, fall back to the total unread.
  // `useUnreadBadge` returns `string | undefined`, so `??` yields exactly
  // one count (never double-counted: approvals ARE a subset of unread, so
  // we show one OR the other, not their sum). Approvals is no longer its
  // own bottom tab — it's an action bucket inside Activity (spec 5.3).
  const approvalBadge = useUnreadBadge('approval');
  const notificationsBadge = useUnreadBadge();
  const activityBadge = approvalBadge ?? notificationsBadge;

  // Fire watcher mounted at the root so reminders post into the chat
  // thread + inbox regardless of which tab is currently visible.
  // Previously it lived inside `app/index.tsx` (Chat tab) — which meant
  // a reminder whose `due_at` passed while the user was on Reminders /
  // Notifications / Settings would silently miss the in-app fan-out
  // (the OS push still delivered, but no inline card / inbox row appeared
  // until the user wandered back to Chat). Mounting here means the 30 s
  // tick runs as long as the app is unlocked. `enabled: unlocked` keeps
  // the watcher off before the persona is open, since `fireMissedReminders`
  // touches reminder state.
  useReminderFireWatcher({ threadId: 'main', enabled: unlocked });

  const router = useRouter();
  const pathname = usePathname();
  const coldStartDeepLinkHandledRef = React.useRef(false);

  // Expo Router uses expo-linking's synchronous iOS registry for its initial
  // route. On a terminated-app custom-scheme launch that registry can be empty
  // even though React Native retained the launch URL; warm links are unaffected.
  // Re-read it once after unlock and pass it through the same narrow allowlist
  // used for untrusted notification links.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !unlocked || coldStartDeepLinkHandledRef.current) {
      return;
    }
    if (bootState.status !== 'ready') return;
    coldStartDeepLinkHandledRef.current = true;
    let cancelled = false;
    void handleColdStartDeepLink({
      getInitialURL: () => Linking.getInitialURL(),
      routerReplace: (path: string) => {
        if (!cancelled) router.replace(path as never);
      },
    });
    return () => {
      cancelled = true;
    };
  }, [bootState.status, router, unlocked]);

  // Menu open state lives in a module singleton so per-tab Stack
  // headers (`app/peerlens/_layout.tsx`, `app/vault/_layout.tsx`) can
  // open it from inside their nav trees too.
  const menuOpen = useSyncExternalStore(subscribeMenuOpen, getMenuOpen, getMenuOpen);
  const handleMenuSelect = (item: NavMenuItem) => {
    closeMenu();
    if (item.href !== undefined) {
      router.push(item.href as never);
      return;
    }
    if (item.action === 'lock') {
      // Pop back to the index tab first — most drill-down screens
      // assume the vault is open and would render half-blank against
      // a sealed vault. The UnlockGate subscriber overlays the
      // unlock screen on top of whatever route we land on.
      try {
        router.replace('/' as never);
      } catch {
        /* ignore — UnlockGate covers the screen regardless */
      }
      void sealVault();
    }
  };

  // Reused by every drill-down screen via `headerLeft` so the user
  // gets a visible back chevron instead of the inherited hamburger.
  // Top-level tabs keep the hamburger via the Tabs-level
  // `screenOptions.headerLeft` default below.
  const renderHeaderBackButton = React.useCallback(
    () => <HeaderBackButton onMenuFallback={openMenu} />,
    [],
  );

  // Notification system boot (5.59 / 5.61). Runs once after unlock —
  // sets up Android channels, requests OS permission (idempotent —
  // re-prompts only via explicit settings action), installs the
  // reminder → OS-push bridge, and re-issues any pending schedule
  // whose triggerAt is still in the future. All calls are tolerant
  // of permission denial (the persisted answer short-circuits
  // subsequent `requestPushPermission` calls).
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    const disposeBridge = installReminderPushBridge();
    void (async () => {
      try {
        await ensureChannels();
        if (cancelled) return;
        await requestPushPermission();
        if (cancelled) return;
        await rescheduleAllReminders();
      } catch (err) {
        console.warn('[notifications] boot failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      disposeBridge();
    };
  }, [unlocked]);

  // App-global PeerLens publish worker: once the node is up, drain queued
  // publish jobs — on boot and on every app foreground — without requiring the
  // user to open the Outbox screen.
  useEffect(() => {
    // Only with a fully-booted node — NOT 'idle' (locked / pre-boot) and not
    // during sign-out / auto-lock teardown, where draining could touch a node
    // being disposed while the vault is locked.
    if (bootState.status !== 'ready') return;
    return startReviewPublishWorker();
  }, [bootState.status]);

  // Core-owned reasoning writes use the same boot + foreground cadence. The
  // shared broker performs single-flight, backoff-bound replay; this effect is
  // lifecycle glue only and remains off while the vault/node is unavailable.
  useEffect(() => {
    if (bootState.status !== 'ready') return;
    return startReasoningCommitRecovery();
  }, [bootState.status]);

  // Viewer-preferences inference (region / languages / devices /
  // dietary). Runs ONCE on first launch — `bootstrapInferredPreferences`
  // delegates to `hydrateUserPreferences()` which short-circuits when
  // the keychain row already exists. The point: Dina shouldn't ask
  // the user to data-enter info she already has access to (device
  // locale, platform, vault). This effect runs after unlock so the
  // General-persona vault is open and the dietary keyword scan can
  // see real text.
  useEffect(() => {
    if (!unlocked) return;
    void bootstrapInferredPreferences().catch((err: unknown) => {
      console.warn('[preferences] inference failed:', err);
    });
  }, [unlocked]);

  // Push-tap deep link (5.68). Two paths:
  //   (1) Foreground / background — `addNotificationResponseReceivedListener`
  //   (2) Cold start (app was killed) — `getLastNotificationResponseAsync()`
  // The handler is in `notifications/deep_link.ts` so it can be unit
  // tested without React Testing Library. Both paths feed it the same
  // `data` payload.
  useEffect(() => {
    if (!unlocked) return;
    const deps = {
      routerPush: (path: string) => router.push(path as never),
      markRead: (id: string) => markNotificationRead(id),
    };
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationTap(response.notification.request.content.data ?? {}, deps);
    });
    void Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp !== null && resp !== undefined) {
        handleNotificationTap(resp.notification.request.content.data ?? {}, deps);
      }
    });
    return () => {
      sub.remove();
    };
  }, [unlocked, router]);

  // Live-subscribe to runtime warnings so async ServicePublisher
  // failures surface in the banner without a remount (review #15).
  const runtimeWarnings = useSyncExternalStore(
    subscribeRuntimeWarnings,
    getRuntimeWarnings,
    getRuntimeWarnings,
  );

  // Persist a snapshot of each boot's degradations + warnings so the history
  // survives relaunch (Admin → Diagnostics shows it). The live channels are
  // in-memory only, so a past boot's "limited mode" is otherwise lost — and a
  // user can't report what degraded. Records once per boot, on reaching ready.
  const bootRecordedRef = React.useRef(false);
  useEffect(() => {
    if (bootState.status === 'ready' && !bootRecordedRef.current) {
      bootRecordedRef.current = true;
      void recordBoot(bootState.degradations, runtimeWarnings);
    }
  }, [bootState.status, bootState.degradations, runtimeWarnings]);

  // Block render until fonts are loaded so the first app screen uses
  // Dina's shared type scale on first paint instead of flashing to a
  // fallback face. The blank off-white view is invisible behind the
  // native splash screen on first launch.
  if (!iconsFontLoaded) {
    return <View style={{ flex: 1, backgroundColor: colors.bgPrimary }} />;
  }

  return (
    <KeyboardProvider>
      <View
        style={{ flex: 1 }}
        testID={bootState.status === 'ready' ? 'root-layout-boot-ready' : undefined}
      >
        <UnlockGate>
          <GuidedDemoGate
            // Disable the first-run guided-demo gate under E2E autopilot
            // (same dev/e2e hook as the onboarding autopilot). Its
            // "seen" flag lives in a KV store that is ephemeral in the
            // limited-mode web thin-client, so the gate re-shows on every
            // boot-state flip and blocks a clean Chat. Off in production
            // (passphrase unset), so real first-run behavior is unchanged.
            enabled={
              bootState.status !== 'error' &&
              bootState.status !== 'booting' &&
              (process.env.EXPO_PUBLIC_DINA_DEV_PASSPHRASE ?? '') === ''
            }
          >
            {bootState.status === 'error' ? (
              <BootBanner
                kind="error"
                primary="Dina failed to start."
                details={[
                  bootState.error?.message ?? 'Unknown error',
                  // Review #5: include the degradations the hook preserved
                  // via BootStartupError so the operator can see WHICH
                  // missing piece triggered the failure. Previously only
                  // error.message rendered and the partial list was lost.
                  ...formatDegradations(bootState.degradations),
                ]}
              />
            ) : bootState.status === 'booting' ? (
              <BootBanner
                kind="info"
                primary="Starting Dina…"
                details={['Loading identity + runtime']}
              />
            ) : (
              (() => {
                // Only surface degradations the user can act on — demo-build
                // expected codes (e.g. `discovery.stub` for the in-memory
                // AppView fixture) are shipped in bootState.degradations for
                // diagnostics but suppressed from the banner so a clean demo
                // launch doesn't read as "something is broken".
                const surfaceDegradations = bannerWorthyDegradations(bootState.degradations);
                if (surfaceDegradations.length === 0 && runtimeWarnings.length === 0) {
                  return null;
                }
                return (
                  <BootBanner
                    kind="warning"
                    primary={
                      surfaceDegradations.length > 0
                        ? 'Dina is running in limited mode.'
                        : 'Runtime warnings active.'
                    }
                    details={[
                      ...formatDegradations(surfaceDegradations),
                      ...formatRuntimeWarnings(runtimeWarnings),
                    ]}
                  />
                );
              })()
            )}
            {showTabs ? (
              <Tabs
                screenOptions={{
                  headerShown: true,
                  headerStyle: {
                    backgroundColor: colors.bgPrimary,
                    ...(Platform.OS === 'ios' ? { shadowOpacity: 0 } : { elevation: 0 }),
                  },
                  headerTitleStyle: {
                    ...navTitle,
                    letterSpacing: 0.3,
                  },
                  headerShadowVisible: false,
                  headerLeft: () => <HeaderMenuButton onPress={openMenu} />,
                  headerRight: () => (
                    <HeaderHelpButton
                      onPress={() =>
                        router.push({ pathname: '/help', params: { from: pathname } } as never)
                      }
                    />
                  ),
                  tabBarStyle: {
                    backgroundColor: colors.bgPrimary,
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    paddingTop: 8,
                    height: Platform.OS === 'ios' ? 88 : 64,
                  },
                  tabBarActiveTintColor: colors.tabActive,
                  tabBarInactiveTintColor: colors.tabInactive,
                  tabBarLabelStyle: {
                    fontFamily: textStyles.tiny.fontFamily,
                    fontSize: textStyles.tiny.fontSize,
                    color: textStyles.tiny.color as string | undefined,
                    letterSpacing: 0.2,
                    marginTop: 2,
                  },
                  tabBarIcon: () => null,
                }}
              >
                <Tabs.Screen
                  name="index"
                  options={{
                    title: 'Chat',
                    headerTitle: () => <DinaHeaderTitle />,
                    tabBarIcon: ({ focused }) => <TabIcon name="Chat" focused={focused} />,
                    tabBarButtonTestID: 'tab-chat',
                    tabBarAccessibilityLabel: 'Chat tab',
                  }}
                />
                <Tabs.Screen
                  name="vault"
                  options={{
                    title: 'Vaults',
                    // Reached via the hamburger menu (HeaderMenuButton).
                    // The folder has its own Stack layout (`app/vault/_layout.tsx`)
                    // that scopes back-navigation to vault drill-downs, so a
                    // single Tabs.Screen entry is enough — every nested
                    // `vault/<name>` is rendered inside that Stack.
                    href: null,

                    // Same rationale as `trust` above — the Stack owns
                    // header rendering for the whole tab, including the
                    // index. Letting Tabs render its header would
                    // duplicate the band on every screen.
                    headerShown: false,
                  }}
                />
                <Tabs.Screen
                  name="people"
                  options={{
                    title: 'People',
                    tabBarIcon: ({ focused }) => <TabIcon name="People" focused={focused} />,
                    tabBarButtonTestID: 'tab-people',
                    tabBarAccessibilityLabel: 'People tab',
                  }}
                />
                <Tabs.Screen
                  name="peerlens"
                  options={({ route }) => {
                    // Hide the bottom tab bar on focused-flow PeerLens screens
                    // (compose / edit / outbox). Two reasons:
                    //   1. The fixed-bottom Publish CTA on `/peerlens/write`
                    //      sits in the same vertical band as the tab bar
                    //      (CTA y=801-852, tab bar y=795-840). Tapping the
                    //      Publish edit centre lands on a tab and pops the
                    //      half-completed compose — the worst possible UX
                    //      regression.
                    //   2. Compose / edit / outbox are focused secondary
                    //      flows. A user in the middle of writing a review
                    //      doesn't need a one-tap escape into Chat or
                    //      Notifications — that's a distraction at best
                    //      and an accidental data-loss at worst. Standard
                    //      mobile pattern (Twitter compose, Instagram
                    //      compose, etc.) hides the tab bar in these
                    //      flows.
                    const focused = getFocusedRouteNameFromRoute(route);
                    const hideTabBar = focused === 'write' || focused === 'outbox';
                    return {
                      // Bottom-tab label is "Network" — the top-level surface that
                      // CONTAINS PeerLens (trust) + Services. The route folder stays
                      // `/peerlens` (no pre-release route migration); the canonical
                      // `FEATURE_NAMES.peerlens` is unchanged. The header title is
                      // set to "Network" inside the PeerLens Stack layout.
                      title: 'Network',
                      tabBarIcon: ({ focused: f }: { focused: boolean }) => (
                        <TabIcon name="Network" focused={f} />
                      ),
                      tabBarButtonTestID: 'tab-network',
                      tabBarAccessibilityLabel: 'Network tab',
                      // The trust folder has its own Stack layout
                      // (`app/peerlens/_layout.tsx`) that scopes back-navigation
                      // properly: search → subject → reviewer → back goes
                      // to subject. With the Stack in place, every nested
                      // `trust/...` route is a Stack child rather than its
                      // own Tabs entry, so this single declaration covers
                      // the whole tab.
                      //
                      // `headerShown: false` here delegates ALL header rendering
                      // to the Stack — the Stack provides the hamburger header
                      // for the index, and the auto back-chevron header for
                      // drill-downs. Letting both render produces a duplicate
                      // header band on every screen.
                      headerShown: false,
                      //
                      // Hide the tab when AppView's `trust_v1_enabled` flag is
                      // explicitly false (TN-FLAG-005 + TN-MOB-051). Default
                      // visible — `null` from `getCachedTrustV1Enabled` (i.e.
                      // unloaded / expired) does NOT hide so dev workflows
                      // before the AppView config endpoint lands stay usable.
                      href: isTrustTabHidden() ? null : undefined,
                      tabBarStyle: hideTabBar ? { display: 'none' } : undefined,
                    };
                  }}
                />
                {/* PeerLens preferences sub-screens — reached from Settings,
                 * never their own tab. Without `href: null` Expo Router
                 * file-based routing auto-registers each as a bottom-bar
                 * entry, blowing out the tab bar with `Bud…`, `Diet…`,
                 * `Acc…` and three raw paths (`peerlens-preferences/region`,
                 * `…/devices`, `…/languages`) that don't even have a
                 * friendly title. Six leaks on a four-tab bar — the worst
                 * UX regression in the app. Each entry below mirrors the
                 * pattern used for `settings`, `help`, etc. above. */}
                <Tabs.Screen
                  name="peerlens-preferences/index"
                  options={{
                    title: 'Review preferences',
                    href: null,
                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="peerlens-preferences/region"
                  options={{ title: 'Region', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="peerlens-preferences/budget"
                  options={{ title: 'Budget', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="peerlens-preferences/devices"
                  options={{ title: 'Devices', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="peerlens-preferences/languages"
                  options={{ title: 'Languages', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="peerlens-preferences/dietary"
                  options={{ title: 'Dietary', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="peerlens-preferences/accessibility"
                  options={{
                    title: 'Accessibility',
                    href: null,
                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="oauth/callback"
                  // Internal ATProto OAuth redirect handler — NEVER a tab.
                  // `href: null` keeps it routable for the `<scheme>:/oauth/callback`
                  // redirect (so it's not "Unmatched Route") without a bottom-bar
                  // entry; it self-dismisses (router.back) after handing the code
                  // to the flow bridge, so no header is needed.
                  options={{ href: null, headerShown: false }}
                />
                {/* Commerce screens — hamburger-menu destinations, NEVER
                 * bottom tabs. Without these declarations file-based routing
                 * auto-registers each as a tab (the exact leak documented for
                 * peerlens-preferences above); worse, the leaked
                 * `order-draft` tab opened with no draft_id and spun for
                 * ever. First device run found it. */}
                <Tabs.Screen
                  name="orders"
                  options={{ title: 'My Orders', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="order-draft"
                  options={{ title: 'Order', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="catalog"
                  options={{ title: 'My Catalog', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="catalog-draft"
                  options={{ title: 'Catalog draft', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="trade"
                  options={{ title: 'Trade', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="invites"
                  options={{ title: 'Invites', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="staff-grants"
                  options={{ title: 'Staff', href: null, headerLeft: renderHeaderBackButton }}
                />
                <Tabs.Screen
                  name="reminders"
                  options={{
                    title: 'Reminders',
                    // Reached via the hamburger menu. The route stays mounted
                    // so deep links (notifications → reminder detail) still
                    // work; href: null only hides the tab-bar entry.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="notifications"
                  options={{
                    title: 'Activity',
                    tabBarIcon: ({ focused }) => <TabIcon name="Activity" focused={focused} />,
                    tabBarButtonTestID: 'tab-activity',
                    tabBarAccessibilityLabel: 'Activity tab',
                    // Action-first badge: pending approvals first, else unread.
                    tabBarBadge: activityBadge,
                  }}
                />
                <Tabs.Screen
                  name="approvals"
                  options={{
                    title: 'Approvals',
                    // Approvals is no longer a bottom tab (spec 5.3) — it's an
                    // action bucket inside Activity. `href: null` removes it from
                    // the bar UNCONDITIONALLY (even with provider/agent enabled —
                    // spec 7.1) without unmounting the route, so notification taps
                    // and `dina://approvals/<id>` deep links still resolve. As a
                    // focused deep-link target it gets a back chevron whose logical
                    // parent is Activity (see parent_route.ts).
                    href: null,
                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="settings"
                  options={{
                    title: 'Settings',
                    // Reached via the hamburger menu (HeaderMenuButton).
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="backup-reminder"
                  options={{
                    // Popped by useBackupPrompt at a quiet moment; its own buttons
                    // (Back up now / Remind me later) are the only exits, so no
                    // header. href: null keeps it off the tab bar but routable.
                    href: null,
                    headerShown: false,
                  }}
                />
                <Tabs.Screen
                  name="policy"
                  options={{
                    title: 'Agent policies',
                    // Reached via Settings → MORE → Agent policies; not a tab target.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="subscriptions"
                  options={{
                    // Reached via Settings → Subscriptions. Standing poll-mode
                    // watches (PSVC-4); hidden from the tab bar.
                    title: 'Subscriptions',
                    href: null,
                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="runs"
                  options={{
                    // Reached via Settings → Interactive runs. Live provider
                    // sessions (ISVC-9); hidden from the tab bar.
                    title: 'Interactive runs',
                    href: null,
                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="my-listings"
                  options={{
                    title: 'My Services',
                    // Hidden from the tab bar — the provider home (node role + every
                    // listing). Reached from Network → Services and Settings →
                    // Service Sharing.
                    href: null,
                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="service-settings"
                  options={{
                    title: 'Service Sharing',
                    // Hidden from the tab bar — the per-listing editor, reached from
                    // /my-listings (edit a row, or "+ New listing").
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="infrastructure"
                  options={{
                    title: 'Infrastructure',
                    // Advanced endpoint configuration. Hidden from the
                    // tab bar and reached from Settings → More.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="paired-devices"
                  options={{
                    // Title is "Agents", not "Paired Devices" — first-time
                    // users read the old label as "another phone running
                    // Dina", which this screen has nothing to do with
                    // (cross-Dina trust lives in Contacts). Route stays
                    // `/paired-devices` to keep deep links working.
                    title: 'Agents',
                    // Hidden from the tab bar — reached via drill-down from Settings.
                    // Admin surface for `dina-admin device pair`; no dedicated tab.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="ai-providers"
                  options={{
                    title: 'AI providers',
                    // Hidden from the tab bar — reached via Settings → AI
                    // PROVIDER → Manage providers. Owns the full BYOK key
                    // surface so the Settings screen can stay quiet.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="help"
                  options={{
                    title: 'Help',
                    // Reached via the hamburger menu — shouldn't have its own
                    // tab. Without this entry expo-router file-based routing
                    // would auto-register `app/help.tsx` as a bottom tab.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="add-contact"
                  options={{
                    title: 'Add Contact',
                    // Reached via the People tab's "+ Add" button; no tab of its own.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="chat/[did]"
                  options={{
                    title: 'Talk',
                    // Per-peer drill-down; never a tab target.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="admin"
                  options={{
                    title: 'Admin',
                    // Drill-down from Settings; not a tab target.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="recovery-phrase"
                  options={{
                    title: 'Recovery phrase',
                    // Drill-down from Settings → Security. Highest-stakes
                    // reveal in the app — never a tab target.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="change-passphrase"
                  options={{
                    title: 'Change passphrase',
                    // Drill-down from Settings → Security. Never a tab target.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
                <Tabs.Screen
                  name="confirm-recovery-phrase"
                  options={{
                    title: 'Confirm phrase',
                    // Drill-down from the chat-home banner OR the
                    // Settings → "Confirm recovery phrase" row that
                    // appears only while verification is pending.
                    href: null,

                    headerLeft: renderHeaderBackButton,
                  }}
                />
              </Tabs>
            ) : null}
          </GuidedDemoGate>
        </UnlockGate>
        <NavMenuSheet
          visible={menuOpen}
          onClose={closeMenu}
          onSelect={handleMenuSelect}
          currentPath={pathname}
          onClearChat={() => {
            closeMenu();
            clearThread('main');
          }}
        />
      </View>
    </KeyboardProvider>
  );
}

function BootBanner({
  kind,
  primary,
  details,
}: {
  kind: 'info' | 'warning' | 'error';
  primary: string;
  /** One line per entry. Comma-joined single-line form dropped a lot
   *  of actionable context (finding #13). */
  details: string[];
}) {
  // Collapse by default — the full warning list ate ~20% of every
  // screen's vertical space.  Tap the strip to expand and read the
  // codes; tap again to collapse.  `error` boots stay expanded so
  // the operator sees the failure without an extra interaction.
  const [expanded, setExpanded] = React.useState(kind === 'error');
  const bg = kind === 'error' ? '#FDE8E8' : kind === 'warning' ? '#FFF4DB' : '#EBF4FF';
  const border = kind === 'error' ? '#DC2626' : kind === 'warning' ? '#D97706' : '#2563EB';
  const hasDetails = details.length > 0;
  // Push the banner below the iOS dynamic island / notch. Without
  // this, the primary line gets clipped mid-word ("Runtime warnings
  // act…") on every iPhone since the X. `useSafeAreaInsets` reads
  // the device's actual safe-area top so we don't hardcode a 47-px
  // assumption that breaks on iPhone SE / Android.
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={() => hasDetails && setExpanded((v) => !v)}
      testID="root-layout-boot-banner"
      style={[
        bannerStyles.wrap,
        { backgroundColor: bg, borderBottomColor: border, paddingTop: insets.top + 8 },
      ]}
      accessibilityRole={hasDetails ? 'button' : undefined}
      accessibilityLabel={`${primary}${hasDetails ? ` (${details.length} item${details.length === 1 ? '' : 's'})` : ''}`}
    >
      <View style={bannerStyles.row}>
        <Text style={bannerStyles.primary} numberOfLines={expanded ? undefined : 1}>
          {primary}
          {!expanded && hasDetails ? `  ·  ${details.length}` : ''}
        </Text>
        {hasDetails && (
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={colors.textSecondary}
            style={{ marginLeft: 8 }}
          />
        )}
      </View>
      {expanded &&
        details.map((line, i) => (
          <Text key={i} style={bannerStyles.secondary}>
            {line}
          </Text>
        ))}
    </Pressable>
  );
}

/**
 * Render each degradation as its own bullet line:
 *   "• code: message"
 * The code is useful for copy/paste into bug reports; the message is
 * the operator-actionable explanation.
 */
function formatDegradations(list: BootDegradation[]): string[] {
  return list.map((d) => `\u2022 ${d.code}: ${d.message}`);
}

/**
 * ALLOW-LIST: the only degradation codes that fire the user-facing yellow
 * "limited mode" banner. Everything else (AppView/MsgBox reachability,
 * capability fallbacks, did:key fallback, demo stubs, \u2026) is infra/transient
 * the user can't act on \u2014 it stays in `bootState.degradations` for the admin
 * Diagnostics screen + persisted history, but must NOT alarm the user.
 *
 * We switched from a suppress-list to an allow-list deliberately: on a
 * consumer launch a degradation should be diagnostic-only BY DEFAULT, and
 * only genuinely critical, user-relevant ones surface. A boot that briefly
 * couldn't reach AppView/MsgBox (which then recovers) must not flash a scary
 * banner \u2014 the symptom that prompted this (a "limited mode \u00b7 N" banner that
 * cleared after unlock).
 *
 *   - `persistence.in_memory` \u2014 the vault DB didn't open, so data won't
 *     survive a restart. This is the one the user genuinely needs to know.
 */
const BANNER_WORTHY_CODES = new Set<string>(['persistence.in_memory']);

/**
 * Keep only the banner-worthy degradations for the yellow banner. The full
 * list remains in `bootState.degradations` (admin Diagnostics + history).
 */
function bannerWorthyDegradations(list: BootDegradation[]): BootDegradation[] {
  return list.filter((d) => BANNER_WORTHY_CODES.has(d.code));
}

function formatRuntimeWarnings(list: readonly RuntimeWarning[]): string[] {
  return list.map((w) => `\u26A0 ${w.code}: ${w.message}`);
}

const bannerStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  primary: {
    ...textStyles.bodySmallStrong,
    flex: 1,
  },
  secondary: {
    ...textStyles.tiny,
    marginTop: 2,
  },
});
