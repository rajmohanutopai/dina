/**
 * My Services — the provider home (multi-listing manager).
 *
 * Two concerns, two axes (kept distinct on purpose):
 *   1. NODE ROLE (requester / provider / both) — "is provider machinery
 *      running at all?" A node-level setting; changing it needs a restart.
 *   2. LISTINGS — "is THIS service live?" A provider (one DID) can publish many
 *      listings (`self` + custom rkeys). Each row has a per-listing Active/
 *      Paused switch (pause = keep config but unpublish + stop answering),
 *      tap-to-edit, delete, and there's a "+ New listing" path.
 *
 * The per-listing editor is `app/service-settings.tsx?rkey=<rkey>` (or no rkey
 * for a brand-new listing). Reached from Network → Services → "My services" and
 * from Settings → Service Sharing.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, ActivityIndicator } from 'react-native';

import { effectiveDiscoverability, type ServiceListingStatus } from '@dina/protocol';

import { ListingsView, type ListingRow } from '../src/components/listings_view';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import {
  ServiceConfigNotConfiguredError,
  deleteServiceListing,
  listServiceListings,
  saveServiceConfig,
  type ServiceListing,
} from '../src/hooks/useServiceConfigForm';
import { reloadApp } from '../src/services/reload_app';
import { saveRolePreference } from '../src/services/role_preference';
import { colors, radius, shadows, spacing, textStyles } from '../src/theme';

import type { NodeRole } from '../src/services/bootstrap';

function labelForRole(r: NodeRole): string {
  if (r === 'requester') return 'Requester only. Ask others, never serve.';
  if (r === 'provider') return 'Provider. Accept inbound service queries.';
  return 'Both. Ask others and serve your own listings.';
}

export default function MyListingsScreen(): React.ReactElement {
  const router = useRouter();
  const bootedNode = getBootedNode();
  const [role, setRole] = useState<NodeRole>(
    bootedNode !== null ? (bootedNode.role as NodeRole) : 'requester',
  );
  const [listings, setListings] = useState<ServiceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await listServiceListings();
      setListings(rows);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ServiceConfigNotConfiguredError) {
        setLoadError('Service settings couldn’t load yet. Dina may still be starting up. Reopen and try again.');
      } else {
        setLoadError((err as Error).message ?? 'Failed to load listings');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh whenever the screen regains focus (e.g. returning from the editor).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        if (!cancelled) await reload();
      })();
      return () => {
        cancelled = true;
      };
    }, [reload]),
  );

  const onChangeRole = useCallback(async (next: NodeRole) => {
    setRole(next);
    try {
      await saveRolePreference(next);
      Alert.alert(
        'Role updated',
        `Saved as ${next}. Dina needs to restart to apply this.`,
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Restart now', onPress: () => void reloadApp() },
        ],
      );
    } catch (err) {
      Alert.alert('Error', (err as Error).message ?? 'Failed to save role');
    }
  }, []);

  const onToggleStatus = useCallback(
    async (rkey: string, next: ServiceListingStatus) => {
      const listing = listings.find((l) => l.rkey === rkey);
      if (listing === undefined) return;
      try {
        // Persist the full (already-valid) config with the flipped status. A
        // `paused` listing unpublishes + stops answering; `active` re-publishes.
        await saveServiceConfig({ ...listing.config, status: next }, rkey);
        await reload();
      } catch (err) {
        Alert.alert('Error', (err as Error).message ?? 'Failed to update listing');
      }
    },
    [listings, reload],
  );

  const onDelete = useCallback(
    (rkey: string) => {
      const listing = listings.find((l) => l.rkey === rkey);
      const name = listing?.config.name ?? rkey;
      Alert.alert('Delete listing', `Permanently delete “${name}”? This unpublishes and removes it.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteServiceListing(rkey);
                await reload();
              } catch (err) {
                Alert.alert('Error', (err as Error).message ?? 'Failed to delete listing');
              }
            })();
          },
        },
      ]);
    },
    [listings, reload],
  );

  const onEdit = useCallback(
    (rkey: string) => router.push(`/service-settings?rkey=${encodeURIComponent(rkey)}`),
    [router],
  );
  const onNew = useCallback(() => router.push('/service-settings'), [router]);

  const rows: ListingRow[] = listings.map((l) => ({
    rkey: l.rkey,
    name: l.config.name,
    capabilityCount: Object.keys(l.config.capabilities).length,
    status: l.config.status ?? 'active',
    discoverability: effectiveDiscoverability(l.config),
  }));

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'My Services' }} />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* NODE ROLE — node-level: "is provider machinery running at all?" */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>ROLE</Text>
          <View style={styles.card}>
            {(['requester', 'provider', 'both'] as NodeRole[]).map((opt) => (
              <Pressable
                key={opt}
                style={[styles.row, role === opt ? styles.rowSelected : null]}
                onPress={() => onChangeRole(opt)}
                testID={`my-listings-role-${opt}`}
                accessibilityRole="button"
                accessibilityState={{ selected: role === opt }}
                accessibilityLabel={`Set role to ${opt}`}
              >
                <Text style={styles.rowTitle}>{labelForRole(opt)}</Text>
                {role === opt ? <Text style={styles.rowValue}>{'✓'}</Text> : null}
              </Pressable>
            ))}
          </View>
        </View>

        {/* LISTINGS — per-listing: "is THIS service live?" */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>YOUR LISTINGS</Text>
          <Text style={styles.sectionSubtitle}>
            Each is published independently. Pause one without touching the others.
          </Text>
          <View style={styles.card}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : loadError !== null ? (
              <Text style={styles.errorText}>{loadError}</Text>
            ) : (
              <ListingsView
                listings={rows}
                onToggleStatus={onToggleStatus}
                onEdit={onEdit}
                onDelete={onDelete}
                onNew={onNew}
              />
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.xxl },
  section: { marginTop: spacing.lg },
  sectionHeader: {
    ...textStyles.tiny,
    color: colors.textMuted,
    letterSpacing: 1,
    marginBottom: spacing.xs,
    marginLeft: spacing.xs,
  },
  sectionSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  rowSelected: {},
  rowTitle: { ...textStyles.body, flex: 1, paddingRight: spacing.sm },
  rowValue: { ...textStyles.body, color: colors.accent },
  errorText: { ...textStyles.bodySmall, color: colors.error },
});
