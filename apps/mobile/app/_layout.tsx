/**
 * Root layout — Expo Router file-based routing.
 *
 * Tab navigator: Chat, People, PeerLens, Approvals (provider-only)
 * Hamburger: Vault, Reminders, Notifications, Settings, Help
 *
 * Reminders + Notifications moved off the bottom bar — both are
 * secondary surfaces (reminders fan out into the unified inbox
 * already), so they live in the menu sheet instead. PeerLens
 * takes the freed-up bottom-bar slot.
 */

import '../src/polyfills';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FEATURES, FeatureIcon, type FeatureKey } from '../src/features';
import { FEATURE_NAMES } from '@dina/core';
import { CormorantGaramond_600SemiBold_Italic } from '@expo-google-fonts/cormorant-garamond';
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
import { Image, Modal, Platform, Pressable, TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { markNotificationRead } from '@dina/brain/notifications';
import { UnlockGate } from '../src/components/unlock_gate';
import { useAutoLock } from '../src/hooks/useAutoLock';
import { useHasActiveAgent } from '../src/hooks/useHasActiveAgent';
import { useNodeBootstrap } from '../src/hooks/useNodeBootstrap';
import { useUnreadBadge } from '../src/hooks/useNotificationsBadge';
import { useReminderFireWatcher } from '../src/hooks/useReminderFireWatcher';
import { sealVault, useIsUnlocked } from '../src/hooks/useUnlock';
import {
  closeMenu,
  getMenuOpen,
  openMenu,
  subscribeMenuOpen,
} from '../src/navigation/menu_state';
import { parentRouteFor } from '../src/navigation/parent_route';
import { handleNotificationTap } from '../src/notifications/deep_link';
import {
  ensureChannels,
  rescheduleAllReminders,
  requestPushPermission,
} from '../src/notifications/local';
import { installReminderPushBridge } from '../src/notifications/reminder_push_bridge';
import { bootstrapInferredPreferences } from '../src/services/preferences_bootstrap';
import {
  subscribeRuntimeWarnings,
  getRuntimeWarnings,
  type RuntimeWarning,
} from '../src/services/runtime_warnings';
import { colors, navTitle, textStyles } from '../src/theme';
import { isTrustTabHidden } from '../src/peerlens/flags';

import type { BootDegradation } from '../src/services/boot_service';

// Horizontal Dina mark used in the Chat tab's header. Other tabs
// keep their text title — using the wordmark on every screen would
// dilute it. The asset is at retina resolution (1672×941, ratio
// 1.78), so width is generous and `contain` lets the height drive
// the rendered size without stretching.
const dinaHeaderLogo = require('../assets/branding/dina-logo-horizontal.png');

function DinaHeaderTitle() {
  return (
    <Image
      source={dinaHeaderLogo}
      resizeMode="contain"
      style={{ height: 40, width: 120 }}
      accessibilityLabel="Dina"
    />
  );
}

// Hamburger button + nav menu sheet rendered as `headerLeft` on
// every top-level tab.  Opens a modal listing the secondary
// destinations (Vault + Settings) that don't earn a permanent
// bottom-tab slot.  Top-left placement is the standard drawer spot
// on both iOS and Android and stays out of the way of a rightward
// `headerRight` content slot.
type NavMenuItem =
  | { feature: FeatureKey; href: string; action?: undefined }
  | { feature: FeatureKey; href?: undefined; action: 'lock' };

const NAV_MENU_ITEMS: NavMenuItem[] = [
  { feature: 'vault',    href: '/vault'    },
  { feature: 'reminders', href: '/reminders' },
  // Notifications was here; now it's a bottom-bar tab so the menu
  // entry would just be a duplicate. Reachable via the bell-icon tab.
  { feature: 'settings', href: '/settings' },
  { feature: 'help',     href: '/help'     },
  // Action item — drops in-memory DEKs, closes SQLCipher handles, and
  // arms the one-shot force-prompt flag so the next vault access
  // prompts for a passphrase even when `startupMode === 'auto'` has
  // cached one in the keychain. UnlockGate's subscriber re-renders to
  // the "Welcome back" passphrase prompt on the next tick.
  // Named "Sign out" because the underlying SQLCipher files are always
  // encrypted at rest — this button locks the SESSION, not the vault.
  { feature: 'signOut',  action: 'lock'   },
];

function HeaderMenuButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
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
function HeaderBackButton({
  onMenuFallback: _onMenuFallback,
}: {
  onMenuFallback: () => void;
}) {
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
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
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
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={navMenuStyles.backdrop}
        onPress={onClose}
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
          // Same reasoning as the backdrop — the sheet container
          // is a no-op tap sink (its onPress prevents close-on-card-
          // tap). Let the row TouchableOpacities own AX exposure.
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {items.map((item) => (
            <TouchableOpacity
              key={item.href ?? `action:${item.action}`}
              style={navMenuStyles.row}
              accessibilityRole="button"
              accessibilityLabel={FEATURES[item.feature].menuLabel ?? FEATURES[item.feature].name}
              onPress={() => onSelect(item)}
            >
              <View style={{ marginRight: 14 }}>
                <FeatureIcon feature={item.feature} size={22} color={colors.textPrimary} />
              </View>
              <Text style={navMenuStyles.rowText}>
                {FEATURES[item.feature].menuLabel ?? FEATURES[item.feature].name}
              </Text>
            </TouchableOpacity>
          ))}
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

/**
 * Degradation codes that mean "this node cannot serve provider-role
 * traffic yet."
 *
 * Review #7 removed `discovery.no_appview` — it's a REQUESTER-side
 * problem ("my /service searches come back empty"), not a provider
 * one. A node can publish + serve without local AppView lookup.
 *
 * Review #8 added `transport.sendd2d.noop` — without a real D2D
 * sender, service.response envelopes go to /dev/null, so a provider
 * profile that looks healthy is actually silently dropping every
 * reply.
 */
const PROVIDER_BLOCKERS: ReadonlySet<string> = new Set([
  'publisher.stub',
  'transport.msgbox.missing',
  'identity.did_key',
  'execution.no_runner',
  'persistence.in_memory',
  'transport.sendd2d.noop',
]);

type TabName =
  | 'Chat'
  | 'People'
  | 'PeerLens'
  | 'Notifications'
  | 'Approvals';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Maps each tab to its feature key — icons and labels come from the registry.
const TAB_FEATURE: Record<TabName, FeatureKey> = {
  Chat:          'chat',
  People:        'people',
  PeerLens:      'peerlens',
  Notifications: 'notifications',
  Approvals:     'security',
};

function TabIcon({ name, focused }: { name: TabName; focused: boolean }) {
  const tint = focused ? colors.tabActive : colors.tabInactive;
  return (
    <View style={tabIconStyles.container}>
      <FeatureIcon feature={TAB_FEATURE[name]} size={22} color={tint} focused={focused} />
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

  // Gate the provider-facing tabs (Approvals + Service Sharing) on
  // BOTH role AND blockers (review #16). A requester-only node is
  // deliberately not a provider, so inviting the user into Approvals
  // is a dead-end flow.
  const runningAsProvider =
    bootState.node !== null &&
    (bootState.node.role === 'provider' || bootState.node.role === 'both');
  const providerBlocked = bootState.degradations.some((d) => PROVIDER_BLOCKERS.has(d.code));
  const showProviderTabs = runningAsProvider && !providerBlocked;

  // The Approvals tab serves three approval kinds — provider-mode
  // service queries, paired-agent intent validations (`dina validate`
  // from OpenClaw / dina-cli-agent), and locked-vault staging access.
  // The latter two fire from any paired `agent`-role device, not just
  // when this node publishes services. Without an OR'd agent gate, a
  // user with OpenClaw paired but no provider profile can never see
  // their pending intent-validation approvals.
  const hasActiveAgent = useHasActiveAgent();
  const showApprovalsTab = showProviderTabs || hasActiveAgent;

  // Two badge-bearing bottom tabs:
  //   - Approvals: provider-only inbound service queries that need a
  //     human decision (gated on provider role + readiness).
  //   - Notifications: unified inbox of every kind (reminder / approval
  //     / nudge / briefing / ask_approval). Pinned to the bar because
  //     it's where the user looks for "what's new" — the hamburger-menu
  //     version was easy to miss and led to stale unread counts.
  const approvalBadge = useUnreadBadge('approval');
  const notificationsBadge = useUnreadBadge();

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
  // Menu open state lives in a module singleton so per-tab Stack
  // headers (`app/peerlens/_layout.tsx`, `app/vault/_layout.tsx`) can
  // open it from inside their nav trees too.
  const menuOpen = useSyncExternalStore(
    subscribeMenuOpen,
    getMenuOpen,
    getMenuOpen,
  );
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

  // Block render until fonts are loaded so every screen — including the
  // very first InfraSetupForm — gets Cormorant Garamond / Figtree on
  // first paint instead of flashing to system font. The blank off-white
  // view is invisible behind the native splash screen on first launch.
  if (!iconsFontLoaded) {
    return <View style={{ flex: 1, backgroundColor: colors.bgPrimary }} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <UnlockGate>
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
        ) : (() => {
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
                  ? 'Dina running in dev-degraded mode.'
                  : 'Runtime warnings active.'
              }
              details={[
                ...formatDegradations(surfaceDegradations),
                ...formatRuntimeWarnings(runtimeWarnings),
              ]}
            />
          );
        })()}
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
              tabBarIcon: ({ focused }) => null,
            }}
          >
            <Tabs.Screen
              name="index"
              options={{
                title: 'Chat',
                headerTitle: () => <DinaHeaderTitle />,
                tabBarIcon: ({ focused }) => <TabIcon name="Chat" focused={focused} />,
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
                  title: FEATURE_NAMES.peerlens,
                  tabBarIcon: ({ focused: f }: { focused: boolean }) => (
                    <TabIcon name="PeerLens" focused={f} />
                  ),
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
                  tabBarStyle: hideTabBar
                    ? { display: 'none' }
                    : undefined,
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
              options={{ title: 'PeerLens preferences', href: null, headerLeft: renderHeaderBackButton }}
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
              options={{ title: 'Accessibility', href: null, headerLeft: renderHeaderBackButton }}
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
                title: 'Notifications',
                tabBarIcon: ({ focused }) => (
                  <TabIcon name="Notifications" focused={focused} />
                ),
                tabBarBadge: notificationsBadge,
              }}
            />
            <Tabs.Screen
              name="approvals"
              options={{
                title: 'Approvals',
                tabBarIcon: ({ focused }) => <TabIcon name="Approvals" focused={focused} />,
                // Hide when the node can't actually handle inbound provider
                // traffic yet (finding #12). `href: null` removes it from the
                // tab bar without unmounting the route. Also visible whenever
                // a delegation-claiming agent is paired so intent-validation
                // approvals from OpenClaw / dina-cli-agent have a surface.
                href: showApprovalsTab ? undefined : null,
                tabBarBadge: approvalBadge,
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
              name="policy"
              options={{
                title: 'Agent policies',
                // Reached via Settings → MORE → Agent policies; not a tab target.
                href: null,

                headerLeft: renderHeaderBackButton,
              }}
            />
            <Tabs.Screen
              name="service-settings"
              options={{
                title: 'Service Sharing',
                // Hidden from the tab bar — reached via drill-down from Settings.
                // Also hidden entirely when the node isn't provider-capable so
                // the drill-down target doesn't expose a dead-end flow.
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
      </UnlockGate>
      <NavMenuSheet
        visible={menuOpen}
        onClose={closeMenu}
        onSelect={handleMenuSelect}
        currentPath={pathname}
      />
    </View>
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
 * Codes that represent expected demo-build defaults rather than real
 * runtime issues. Ship in `bootState.degradations` for the admin
 * screen + bug reports, but suppress from the user-facing yellow
 * banner so a normal demo launch reads as "Dina is fine" instead of
 * "something is degraded \u2014 what did I break?".
 *
 * Why each is here:
 *   - `discovery.stub` \u2014 running against the in-memory AppView
 *     fixture is the *expected* state for the demo build; surfacing
 *     it as a warning every launch made the banner permanent
 *     wallpaper.
 */
const BANNER_SUPPRESS_CODES = new Set<string>(['discovery.stub']);

/**
 * Filter out demo-expected codes so the yellow banner only fires on
 * degradations that actually want operator attention. The full list
 * remains in `bootState.degradations` for diagnostics.
 */
function bannerWorthyDegradations(list: BootDegradation[]): BootDegradation[] {
  return list.filter((d) => !BANNER_SUPPRESS_CODES.has(d.code));
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
