/**
 * Root layout — Expo Router file-based routing.
 *
 * Tab navigator: Chat, People, Trust, Approvals (provider-only)
 * Hamburger: Vault, Reminders, Notifications, Settings, Help
 *
 * Reminders + Notifications moved off the bottom bar — both are
 * secondary surfaces (reminders fan out into the unified inbox
 * already), so they live in the menu sheet instead. Trust Network
 * takes the freed-up bottom-bar slot.
 */

import '../src/polyfills';
import React, { useEffect, useSyncExternalStore } from 'react';
import { Tabs, useRouter, usePathname } from 'expo-router';
import { Image, Modal, Platform, Pressable, TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
} from '@expo-google-fonts/figtree';
import {
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { CormorantGaramond_600SemiBold_Italic } from '@expo-google-fonts/cormorant-garamond';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';
import * as Notifications from 'expo-notifications';
import { colors, fonts } from '../src/theme';
import { useNodeBootstrap } from '../src/hooks/useNodeBootstrap';
import { useIsUnlocked } from '../src/hooks/useUnlock';
import type { BootDegradation } from '../src/services/boot_service';
import {
  subscribeRuntimeWarnings,
  getRuntimeWarnings,
  type RuntimeWarning,
} from '../src/services/runtime_warnings';
import { UnlockGate } from '../src/components/unlock_gate';
import { useUnreadBadge } from '../src/hooks/useNotificationsBadge';
import {
  ensureChannels,
  rescheduleAllReminders,
  requestPushPermission,
} from '../src/notifications/local';
import { markNotificationRead } from '@dina/brain/src/notifications/inbox';
import { handleNotificationTap } from '../src/notifications/deep_link';
import { installReminderPushBridge } from '../src/notifications/reminder_push_bridge';
import { useReminderFireWatcher } from '../src/hooks/useReminderFireWatcher';
import { isTrustTabHidden } from '../src/trust/flags';

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
type NavMenuItem = {
  label: string;
  icon: IoniconName;
  href: string;
};

const NAV_MENU_ITEMS: NavMenuItem[] = [
  { label: 'Vault',         icon: 'lock-closed-outline',     href: '/vault'         },
  { label: 'Reminders',     icon: 'notifications-outline',   href: '/reminders'     },
  { label: 'Notifications', icon: 'mail-outline',            href: '/notifications' },
  { label: 'Settings',      icon: 'settings-outline',        href: '/settings'      },
  { label: 'Help',          icon: 'help-circle-outline',     href: '/help'          },
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
  onSelect: (href: string) => void;
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
  // when the user is already inside one of its sub-screens.
  const items = NAV_MENU_ITEMS.filter(
    (item) => !(currentPath === item.href || currentPath.startsWith(`${item.href}/`)),
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={navMenuStyles.backdrop} onPress={onClose}>
        <Pressable style={navMenuStyles.sheet} onPress={() => undefined}>
          {items.map((item) => (
            <TouchableOpacity
              key={item.href}
              style={navMenuStyles.row}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              onPress={() => onSelect(item.href)}
            >
              <Ionicons
                name={item.icon}
                size={22}
                color={colors.textPrimary}
                style={{ marginRight: 14 }}
              />
              <Text style={navMenuStyles.rowText}>{item.label}</Text>
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
  rowText: {
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.textPrimary,
    fontWeight: '500',
  },
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
  | 'Trust'
  | 'Approvals';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// One outline + one filled glyph per tab. Filled is shown when the tab
// is focused, outline otherwise — matches the iOS HIG convention.
const TAB_GLYPHS: Record<TabName, { outline: IoniconName; filled: IoniconName }> = {
  Chat:      { outline: 'chatbubble-outline',         filled: 'chatbubble' },
  People:    { outline: 'people-outline',             filled: 'people' },
  Trust:     { outline: 'shield-checkmark-outline',   filled: 'shield-checkmark' },
  Approvals: { outline: 'checkmark-circle-outline',   filled: 'checkmark-circle' },
};

function TabIcon({ name, focused }: { name: TabName; focused: boolean }) {
  const glyph = TAB_GLYPHS[name];
  const iconName = focused ? glyph.filled : glyph.outline;
  const tint = focused ? colors.tabActive : colors.tabInactive;
  return (
    <View style={tabIconStyles.container}>
      <Ionicons name={iconName} size={22} color={tint} />
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

  // Approvals is the only badge-bearing bottom tab now (Reminders +
  // Notifications moved to the hamburger menu). The unified-inbox hooks
  // for those still drive the in-screen UIs themselves; we just don't
  // surface their counts on the tab bar anymore.
  const approvalBadge = useUnreadBadge('approval');

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
  const [menuOpen, setMenuOpen] = React.useState(false);
  const handleMenuSelect = (href: string) => {
    setMenuOpen(false);
    router.push(href as never);
  };

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
        // eslint-disable-next-line no-console
        console.warn('[notifications] boot failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      disposeBridge();
    };
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
                fontFamily: fonts.heading,
                fontWeight: '600',
                fontSize: 17,
                color: colors.textPrimary,
                letterSpacing: 0.3,
              },
              headerShadowVisible: false,
              headerLeft: () => <HeaderMenuButton onPress={() => setMenuOpen(true)} />,
              headerRight: () => <HeaderHelpButton onPress={() => router.push('/help')} />,
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
                fontFamily: fonts.sans,
                fontSize: 11,
                fontWeight: '500',
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
              name="vault/index"
              options={{
                title: 'Vaults',
                // Reached via the hamburger menu (HeaderMenuButton).
                href: null,
              }}
            />
            <Tabs.Screen
              name="vault/[name]"
              options={{
                title: 'Vault',
                // Drill-down from `/vault`. Without this entry expo-router
                // would auto-register the dynamic route as a tab.
                href: null,
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
              name="trust/index"
              options={{
                title: 'Trust',
                tabBarIcon: ({ focused }) => <TabIcon name="Trust" focused={focused} />,
                // Hide the tab when AppView's `trust_v1_enabled` flag is
                // explicitly false (TN-FLAG-005 + TN-MOB-051). Default
                // visible — `null` from `getCachedTrustV1Enabled` (i.e.
                // unloaded / expired) does NOT hide so dev workflows
                // before the AppView config endpoint lands stay usable.
                href: isTrustTabHidden() ? null : undefined,
              }}
            />
            <Tabs.Screen
              name="reminders"
              options={{
                title: 'Reminders',
                // Reached via the hamburger menu. The route stays mounted
                // so deep links (notifications → reminder detail) still
                // work; href: null only hides the tab-bar entry.
                href: null,
              }}
            />
            <Tabs.Screen
              name="approvals"
              options={{
                title: 'Approvals',
                tabBarIcon: ({ focused }) => <TabIcon name="Approvals" focused={focused} />,
                // Hide when the node can't actually handle inbound provider
                // traffic yet (finding #12). `href: null` removes it from the
                // tab bar without unmounting the route.
                href: showProviderTabs ? undefined : null,
                tabBarBadge: approvalBadge,
              }}
            />
            <Tabs.Screen
              name="notifications"
              options={{
                title: 'Notifications',
                // Reached via the hamburger menu. Reminder fan-out into the
                // unified inbox still happens; the surface is just no
                // longer pinned to the bottom bar.
                href: null,
              }}
            />
            <Tabs.Screen
              name="settings"
              options={{
                title: 'Settings',
                // Reached via the hamburger menu (HeaderMenuButton).
                href: null,
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
              }}
            />
            <Tabs.Screen
              name="add-contact"
              options={{
                title: 'Add Contact',
                // Reached via the People tab's "+ Add" button; no tab of its own.
                href: null,
              }}
            />
            <Tabs.Screen
              name="chat/[did]"
              options={{
                title: 'Chat',
                // Per-peer drill-down; never a tab target.
                href: null,
              }}
            />
            <Tabs.Screen
              name="admin"
              options={{
                title: 'Admin',
                // Drill-down from Settings; not a tab target.
                href: null,
              }}
            />
          </Tabs>
        ) : null}
      </UnlockGate>
      <NavMenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
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
  return (
    <Pressable
      onPress={() => hasDetails && setExpanded((v) => !v)}
      style={[bannerStyles.wrap, { backgroundColor: bg, borderBottomColor: border }]}
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
    flex: 1,
    fontFamily: fonts.heading,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  secondary: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
    lineHeight: 15,
  },
});
