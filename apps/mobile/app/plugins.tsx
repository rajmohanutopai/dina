/**
 * Plugins — the owner screen for installing and managing plugins
 * (RESEARCHER_KERNEL_ARCHITECTURE.md §5.C2). Parallel to the Agents screen
 * (`paired-devices.tsx`): the top section lists what's installed and lets the
 * owner uninstall; below it sit two install doors — the FIRST-PARTY country
 * packs (§5.D, compiled into the build, no fetch) and the THIRD-PARTY release
 * door. Both stage a pending install that the same consent card decides.
 *
 * A plugin is named by its publisher's DID and a content-derived release rkey
 * (§5.C1). `beginPluginInstall` fetches + authenticates that release through the
 * repo-proof verifier and stages a PENDING install; the screen then shows a
 * `PluginConsentCard` with the exact capabilities. NOTHING runs until the owner
 * taps Install on that card (`confirmPluginInstall`). Decline, Cancel, a failed
 * confirm, and LEAVING the screen (blur) all tear the pending install down —
 * a staged install never lingers with no card to act on it. A runner that
 * pairs after that is refused by Core, so no device outlives the teardown.
 *
 * Until the phone wires a repo-proof verifier (C1-mobile), the third-party
 * door is closed and says so; the country packs and the manage list still work.
 *
 * The screen talks to Core through the in-process ceremony modules — no HTTP
 * round-trip, because the admin UI shares Core's JS runtime on mobile.
 */

import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, Alert } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COUNTRY_PACK_MANIFESTS, COUNTRY_PACKS } from '@dina/core';

import { PluginConsentCard } from '../src/components/PluginConsentCard';
import {
  beginCountryPackInstall,
  beginPluginInstall,
  declinePluginInstall,
  listInstalledPlugins,
  pluginInstallAvailable,
  uninstallPlugin,
  type CountryPack,
  type InstalledPlugin,
  type PluginConsentSummary,
} from '../src/services/plugin_install';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

export default function PluginsScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const bottomPad = insets.bottom + 49 + spacing.md;

  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [publisherDid, setPublisherDid] = useState('');
  const [rkey, setRkey] = useState('');
  const [beginning, setBeginning] = useState(false);
  const [pending, setPending] = useState<PluginConsentSummary | null>(null);
  const available = pluginInstallAvailable();

  // Leaving the screen with a consent undecided is a Decline (§15.3: expiry and
  // cancellation converge on one cleanup path). The ref lets the blur cleanup
  // see the CURRENT pending install without re-subscribing on every change.
  const pendingRef = useRef<PluginConsentSummary | null>(null);
  pendingRef.current = pending;
  useFocusEffect(
    useCallback(() => {
      return () => {
        const staged = pendingRef.current;
        if (staged === null) return;
        pendingRef.current = null;
        setPending(null);
        void declinePluginInstall(staged.installId);
      };
    }, []),
  );

  const refresh = useCallback(() => {
    try {
      setInstalled(listInstalledPlugins());
    } catch (err) {
      console.warn('[plugins] list failed', err instanceof Error ? err.message : String(err));
      setInstalled([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleBegin = useCallback(async () => {
    const did = publisherDid.trim();
    const key = rkey.trim();
    if (did === '' || key === '') {
      Alert.alert('Publisher and release required', 'Enter the publisher DID and the release key.');
      return;
    }
    setBeginning(true);
    try {
      const outcome = await beginPluginInstall(did, key);
      if (outcome.ok) {
        setPending(outcome.consent);
        refresh();
      } else if (outcome.unavailable) {
        // A build-level absence, never a network problem to retry.
        Alert.alert('Not available on this phone yet', outcome.error);
      } else {
        // A transient failure (PDS unreachable) is worth a retry; a permanent
        // one (bad proof) is not — say which so the owner isn't left guessing.
        Alert.alert(
          outcome.transient ? "Couldn't reach the publisher" : 'Release could not be verified',
          outcome.transient
            ? `${outcome.error}\n\nCheck the connection and try again.`
            : `${outcome.error}\n\nThis release did not pass authenticity checks.`,
        );
      }
    } catch (err) {
      Alert.alert('Install failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBeginning(false);
    }
  }, [publisherDid, rkey, refresh]);

  // The first-party door: no fetch, no verifier — the build vouches for its
  // own manifest. Staging is synchronous; the card then runs the same pairing
  // and consent as any runner plugin.
  const handleCountryPack = useCallback(
    (pack: CountryPack) => {
      try {
        const outcome = beginCountryPackInstall(pack);
        if (outcome.state === 'staged') {
          setPending(outcome.consent);
          refresh();
        } else if (outcome.state === 'already_active') {
          Alert.alert('Already installed', 'This pack is active — it is listed above.');
        } else {
          Alert.alert(
            outcome.transient ? 'Not ready yet' : 'Pack could not be staged',
            outcome.transient ? `${outcome.error}\n\nTry again in a moment.` : outcome.error,
          );
        }
      } catch (err) {
        Alert.alert('Install failed', err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const handleConsentDone = useCallback(
    (outcome: 'confirmed' | 'declined' | 'failed', detail?: string) => {
      const staged = pending;
      setPending(null);
      if (outcome === 'confirmed') {
        setPublisherDid('');
        setRkey('');
      }
      if (outcome === 'failed') {
        Alert.alert('Install failed', detail ?? 'The plugin could not be installed.');
        // A failed confirm leaves the staged install pending with no card to act
        // on it — tear it down (revoking any paired runner device) so the owner
        // starts clean rather than waiting on the sweeper.
        if (staged !== null) {
          void declinePluginInstall(staged.installId).finally(refresh);
          return;
        }
      }
      refresh();
    },
    [pending, refresh],
  );

  // Cancel on the consent section is a Decline — never leave a staged install
  // lingering with no consent behind it.
  const handleDismissPending = useCallback(() => {
    if (pending === null) return;
    void declinePluginInstall(pending.installId).finally(() => {
      setPending(null);
      refresh();
    });
  }, [pending, refresh]);

  const handleUninstall = useCallback(
    (plugin: InstalledPlugin) => {
      Alert.alert(
        `Uninstall "${plugin.pluginId}"?`,
        'The plugin loses access immediately. A runner plugin’s paired device is revoked. Reinstalling requires the publisher’s release again.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Uninstall',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  const result = await uninstallPlugin(plugin.installId);
                  if (!result.ok) {
                    Alert.alert(...uninstallRefusal(result.error, result.detail));
                  }
                } catch (err) {
                  Alert.alert('Uninstall failed', err instanceof Error ? err.message : String(err));
                } finally {
                  refresh();
                }
              })();
            },
          },
        ],
      );
    },
    [refresh],
  );

  // The install the owner is still deciding on lives on the card below, not in
  // the manage list; an older pending (a ceremony the app was closed on) stays
  // listed so it can be removed by hand ahead of the sweeper.
  const listed = pending === null ? installed : installed.filter((p) => p.installId !== pending.installId);

  return (
    <>
      <Stack.Screen options={{ title: 'Plugins' }} />
      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        bottomOffset={24}
      >
        <Section title={`INSTALLED (${listed.length})`}>
          {listed.length === 0 ? (
            <Text style={styles.empty}>No plugins installed yet.</Text>
          ) : (
            listed.map((p) => (
              <View key={p.installId} style={styles.row} testID={`plugin-row-${p.installId}`}>
                <View style={styles.rowMain}>
                  <Text style={styles.pluginId}>{p.pluginId}</Text>
                  <Text style={styles.status}>{p.status}</Text>
                </View>
                <Pressable
                  testID={`plugin-uninstall-${p.installId}`}
                  onPress={() => handleUninstall(p)}
                  style={({ pressed }) => [styles.uninstall, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`Uninstall ${p.pluginId}`}
                >
                  <Text style={styles.uninstallText}>Uninstall</Text>
                </Pressable>
              </View>
            ))
          )}
          <Pressable testID="plugins-refresh" onPress={refresh} style={styles.refreshButton}>
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </Section>

        {pending !== null ? (
          <Section title="CONFIRM INSTALL">
            <PluginConsentCard consent={pending} onDone={handleConsentDone} />
            <Pressable
              testID="plugins-dismiss-pending"
              onPress={handleDismissPending}
              style={styles.refreshButton}
              accessibilityRole="button"
            >
              <Text style={styles.refreshText}>Cancel</Text>
            </Pressable>
          </Section>
        ) : (
          <Section title="COUNTRY PACKS">
            <Text style={styles.help}>
              The rails a market runs on — payment status, tax registries, filings, reminders —
              as a plugin Dina ships. Installing shows a setup code for the runner that holds the
              provider account; nothing runs until you confirm what it may do.
            </Text>
            {COUNTRY_PACKS.map((pack) => {
              const manifest = COUNTRY_PACK_MANIFESTS[pack];
              return (
                <View key={pack} style={styles.row} testID={`plugins-country-pack-${pack}`}>
                  <Text style={styles.pluginId}>{manifest.display_name}</Text>
                  <Text style={styles.status}>{manifest.short_description}</Text>
                  <Pressable
                    testID={`plugins-country-pack-install-${pack}`}
                    onPress={() => handleCountryPack(pack)}
                    style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Install ${manifest.display_name}`}
                  >
                    <Text style={styles.secondaryButtonText}>Install</Text>
                  </Pressable>
                </View>
              );
            })}
          </Section>
        )}

        {pending !== null ? null : !available ? (
          <Section title="INSTALL A PLUGIN">
            <Text style={styles.help} testID="plugins-unavailable">
              This phone can’t verify third-party plugins yet, so installing is off here until a
              later build. Anything listed above can still be managed.
            </Text>
          </Section>
        ) : (
          <Section title="INSTALL A PLUGIN">
            <Text style={styles.help}>
              A plugin is a signed contract, never code inside Dina. Enter the publisher’s
              identity and the release you were given; Dina fetches and verifies it, then shows you
              exactly what it can do before anything runs.
            </Text>

            <Text style={styles.label}>Publisher DID</Text>
            <TextInput
              testID="plugins-publisher-did"
              style={styles.input}
              value={publisherDid}
              onChangeText={setPublisherDid}
              placeholder="did:plc:…"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.label}>Release key</Text>
            <TextInput
              testID="plugins-rkey"
              style={styles.input}
              value={rkey}
              onChangeText={setRkey}
              placeholder="release rkey"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Pressable
              testID="plugins-begin"
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || beginning) && styles.primaryButtonDisabled,
              ]}
              disabled={beginning}
              onPress={() => void handleBegin()}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {beginning ? 'Verifying…' : 'Verify release'}
              </Text>
            </Pressable>
          </Section>
        )}
      </KeyboardAwareScrollView>
    </>
  );
}

/** Title + message for a refused uninstall, in the owner's terms. */
function uninstallRefusal(
  error: 'unknown_install' | 'obligations_open' | 'teardown_incomplete',
  detail?: string,
): [string, string] {
  switch (error) {
    case 'unknown_install':
      return ['Nothing to uninstall', 'That install is no longer present.'];
    case 'obligations_open':
      return [
        'Orders still open',
        detail ?? 'Resolve the orders this plugin is serving (deliver, cancel, or reconcile them), then uninstall.',
      ];
    case 'teardown_incomplete':
      return [
        'Removed, but not fully',
        'The plugin can no longer act, but its runner device could not be revoked durably yet. Dina keeps retrying in the background.',
      ];
  }
}

function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.card}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    ...textStyles.label,
    color: colors.textSecondary,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    marginLeft: spacing.sm,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadows.sm,
  },
  help: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  label: {
    ...textStyles.bodySmallStrong,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    ...textStyles.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: {
    ...textStyles.bodyStrong,
    color: colors.white,
  },
  empty: {
    ...textStyles.body,
    color: colors.textSecondary,
    fontStyle: 'italic',
    textAlign: 'center',
    padding: spacing.md,
  },
  row: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowMain: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  pluginId: textStyles.bodyStrong,
  status: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  uninstall: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.error,
  },
  pressed: { opacity: 0.6 },
  secondaryButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  secondaryButtonText: {
    ...textStyles.caption,
    color: colors.accent,
  },
  uninstallText: {
    ...textStyles.caption,
    color: colors.error,
  },
  refreshButton: { alignSelf: 'flex-end', padding: spacing.sm },
  refreshText: {
    ...textStyles.bodySmall,
    color: colors.accent,
  },
});
