/**
 * My Listings — presentational list of a provider's service listings.
 *
 * A provider (one DID) can publish MANY listings (one row per AT-Proto rkey;
 * `self` is the default). This view is the multi-listing manager: per-row
 * Active/Paused toggle (the per-listing ON/OFF switch — distinct from node role
 * and from discoverability), tap-to-edit, delete, and "+ New listing".
 *
 * Presentational — listings + callbacks are injected; the screen
 * (`app/my-listings.tsx`) owns load/save/delete + navigation. Status changes
 * flow through `onToggleStatus(rkey, next)` so the screen can persist the full
 * config with the flipped status (pausing unpublishes + stops answering).
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

import type { Discoverability, ServiceListingStatus } from '@dina/protocol';

/** One row's view-model (derived from a ServiceListing by the screen). */
export interface ListingRow {
  readonly rkey: string;
  readonly name: string;
  readonly capabilityCount: number;
  readonly status: ServiceListingStatus;
  readonly discoverability: Discoverability;
}

export interface ListingsViewProps {
  readonly listings: readonly ListingRow[];
  /** Flip a listing's status (active ↔ paused). */
  readonly onToggleStatus: (rkey: string, next: ServiceListingStatus) => void;
  /** Open the per-listing editor for `rkey`. */
  readonly onEdit: (rkey: string) => void;
  /** Delete a listing (the screen confirms first). */
  readonly onDelete: (rkey: string) => void;
  /** Create a new listing. */
  readonly onNew: () => void;
}

const DISCOVERABILITY_LABEL: Record<Discoverability, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  known_only: 'Private',
};

/** Human one-liner under a listing's name: capability count · visibility. */
export function listingSubtitle(row: ListingRow): string {
  const caps = `${row.capabilityCount} ${row.capabilityCount === 1 ? 'capability' : 'capabilities'}`;
  return `${caps} · ${DISCOVERABILITY_LABEL[row.discoverability]}`;
}

export function ListingsView(props: ListingsViewProps): React.ReactElement {
  return (
    <View testID="listings-view">
      {props.listings.length === 0 ? (
        <Text style={styles.empty}>
          No services yet. Tap “New listing” to publish your first one.
        </Text>
      ) : (
        props.listings.map((row) => {
          const active = row.status === 'active';
          return (
            <View key={row.rkey} style={styles.row}>
              <Pressable
                testID={`listing-edit-${row.rkey}`}
                style={styles.rowBody}
                onPress={() => props.onEdit(row.rkey)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${row.name}`}
              >
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {row.name}
                  {row.rkey === 'self' ? <Text style={styles.defaultTag}>{'  · Default'}</Text> : null}
                </Text>
                <Text style={styles.rowSubtitle} numberOfLines={1}>
                  {listingSubtitle(row)}
                </Text>
              </Pressable>
              <Pressable
                testID={`listing-toggle-${row.rkey}`}
                style={[styles.statusPill, active ? styles.statusActive : styles.statusPaused]}
                onPress={() => props.onToggleStatus(row.rkey, active ? 'paused' : 'active')}
                accessibilityRole="switch"
                accessibilityState={{ checked: active }}
                accessibilityLabel={`${row.name} is ${active ? 'active' : 'paused'}. Tap to ${active ? 'pause' : 'activate'}.`}
              >
                <Text style={[styles.statusText, active ? styles.statusTextActive : styles.statusTextPaused]}>
                  {active ? 'Active' : 'Paused'}
                </Text>
              </Pressable>
              <Pressable
                testID={`listing-delete-${row.rkey}`}
                style={styles.deleteBtn}
                onPress={() => props.onDelete(row.rkey)}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${row.name}`}
                hitSlop={8}
              >
                <Text style={styles.deleteText}>{'✕'}</Text>
              </Pressable>
            </View>
          );
        })
      )}

      <Pressable
        testID="listing-new"
        style={styles.newBtn}
        onPress={props.onNew}
        accessibilityRole="button"
        accessibilityLabel="New listing"
      >
        <Text style={styles.newText}>{'+ New listing'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    paddingVertical: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: textStyles.body,
  defaultTag: { ...textStyles.tiny, color: colors.textMuted },
  rowSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  statusPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  statusActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  statusPaused: { backgroundColor: 'transparent', borderColor: colors.border },
  statusText: textStyles.bodySmall,
  statusTextActive: { color: colors.white },
  statusTextPaused: { color: colors.textMuted },
  deleteBtn: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs },
  deleteText: { ...textStyles.body, color: colors.textMuted },
  newBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  newText: { ...textStyles.body, color: colors.accent },
});
