/**
 * Root layout — Expo Router file-based routing.
 *
 * Tab navigator: Chat, Vault, People, Reminders, Settings
 * Styled with Dina warm design system.
 */

import '../src/polyfills';
import React, { useSyncExternalStore } from 'react';
import { Tabs } from 'expo-router';
import { Platform, View, Text, StyleSheet } from 'react-native';
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

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Chat: '\u2726', // sparkle
    Vault: '\u229E', // squared plus (vault)
    People: '\u2603', // placeholder — will swap
    Reminders: '\u25CB', // circle
    Approvals: '\u2713', // check mark (pending review)
    Settings: '\u2699', // gear
  };

  // Simple icon mapping using SF Symbols-like unicode
  const iconMap: Record<string, string> = {
    Chat: 'chat',
    Vault: 'vault',
    People: 'people',
    Reminders: 'bell',
    Approvals: 'approvals',
    Settings: 'gear',
  };

  return (
    <View style={tabIconStyles.container}>
      <View style={[tabIconStyles.dot, focused && tabIconStyles.dotActive]} />
    </View>
  );
}

const tabIconStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 2,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'transparent',
    marginBottom: 2,
  },
  dotActive: {
    backgroundColor: colors.accent,
  },
});

export default function RootLayout() {
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
  const showTabs = bootState.status !== 'error';

  // Gate the provider-facing tabs (Approvals + Service Sharing) on
  // BOTH role AND blockers (review #16). A requester-only node is
  // deliberately not a provider, so inviting the user into Approvals
  // is a dead-end flow.
  const runningAsProvider =
    bootState.node !== null &&
    (bootState.node.role === 'provider' || bootState.node.role === 'both');
  const providerBlocked = bootState.degradations.some((d) => PROVIDER_BLOCKERS.has(d.code));
  const showProviderTabs = runningAsProvider && !providerBlocked;

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
        ) : bootState.degradations.length > 0 || runtimeWarnings.length > 0 ? (
          <BootBanner
            kind="warning"
            primary={
              bootState.degradations.length > 0
                ? 'Dina running in dev-degraded mode.'
                : 'Runtime warnings active.'
            }
            details={[
              ...formatDegradations(bootState.degradations),
              ...formatRuntimeWarnings(runtimeWarnings),
            ]}
          />
        ) : null}
        {showTabs ? (
          <Tabs
            screenOptions={{
              headerShown: true,
              headerStyle: {
                backgroundColor: colors.bgPrimary,
                ...(Platform.OS === 'ios' ? { shadowOpacity: 0 } : { elevation: 0 }),
              },
              headerTitleStyle: {
                fontWeight: '600',
                fontSize: 17,
                color: colors.textPrimary,
                letterSpacing: 0.3,
              },
              headerShadowVisible: false,
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
                tabBarIcon: ({ focused }) => <TabIcon name="Chat" focused={focused} />,
              }}
            />
            <Tabs.Screen
              name="vault"
              options={{
                title: 'Vault',
                tabBarIcon: ({ focused }) => <TabIcon name="Vault" focused={focused} />,
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
              name="reminders"
              options={{
                title: 'Reminders',
                tabBarIcon: ({ focused }) => <TabIcon name="Reminders" focused={focused} />,
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
              }}
            />
            <Tabs.Screen
              name="settings"
              options={{
                title: 'Settings',
                tabBarIcon: ({ focused }) => <TabIcon name="Settings" focused={focused} />,
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
                title: 'Paired Devices',
                // Hidden from the tab bar — reached via drill-down from Settings.
                // Admin surface for `dina-admin device pair`; no dedicated tab.
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
  const bg = kind === 'error' ? '#FDE8E8' : kind === 'warning' ? '#FFF4DB' : '#EBF4FF';
  const border = kind === 'error' ? '#DC2626' : kind === 'warning' ? '#D97706' : '#2563EB';
  return (
    <View style={[bannerStyles.wrap, { backgroundColor: bg, borderBottomColor: border }]}>
      <Text style={bannerStyles.primary}>{primary}</Text>
      {details.map((line, i) => (
        <Text key={i} style={bannerStyles.secondary}>
          {line}
        </Text>
      ))}
    </View>
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

function formatRuntimeWarnings(list: readonly RuntimeWarning[]): string[] {
  return list.map((w) => `\u26A0 ${w.code}: ${w.message}`);
}

const bannerStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 2,
  },
  primary: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  secondary: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
    lineHeight: 15,
  },
});
