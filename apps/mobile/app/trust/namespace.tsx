/**
 * Trust Network — manage pseudonymous namespaces (TN-MOB-014 / Plan §3.5.2).
 *
 * Lists the user's existing namespaces (read from their current PLC
 * operation) and exposes an "+ Add namespace" CTA. The actual
 * signing + PLC submission flow is owned by the namespace runner
 * (TN-IDENT-005 + TN-IDENT-006); this screen is presentational and
 * delegates the side-effect to a callback.
 *
 * Why a presentational shell with injected callbacks:
 *   - The runner needs the master seed (keystore-resident) + rotation
 *     private key + PLC submit config. Wiring those into the screen
 *     directly would couple the screen to the keystore + the AppView
 *     client — both of which have their own initialisation order
 *     (post-unlock for keystore, post-handle-resolution for AppView).
 *   - The screen is testable with plain RTL — pass a fake `prior` op
 *     and a stub `onAddNamespace` callback, render, fire-press the
 *     CTA, assert the callback ran with the next index.
 *   - Future surfaces (the namespace screen embedded in a settings
 *     deeplink, the post-rotation incident UI) can reuse the same
 *     presentational component with different runners.
 *
 * Data source contract:
 *   - `prior` is the user's current PLC `signedOperation` JSON. The
 *     screen-layer wrapper resolves it via `getPlcOperation(did)` from
 *     the local AppView client; if the network is offline / the user
 *     just rotated and the doc hasn't propagated, `prior` is `null`
 *     and the screen renders a soft-loading state.
 *   - `did` is the user's root DID. Used only for display + to
 *     construct the canonical verificationMethodId.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';

import { colors, fonts, spacing, radius } from '../../src/theme';

/**
 * How long the screen waits for `prior` (the user's PLC operation)
 * before surfacing a friendly "DID not yet resolved" message instead
 * of spinning forever. PLC reads are fast when the AppView is reachable;
 * a 5s budget catches "AppView unreachable" and unblocks the UI.
 */
const LOAD_BUDGET_MS = 5000;
import {
  deriveNamespaceRows,
  canAddNamespace,
  nextNamespaceIndexFor,
  type NamespaceRow,
} from '../../src/trust/namespace_screen_data';

export interface NamespaceScreenProps {
  /**
   * Root DID (`did:plc:xxxx`). Optional — defaults to empty string so
   * the screen mounts as a routable Expo Router default export when no
   * runner is wired. Tests pass it explicitly.
   */
  did?: string;
  /**
   * The user's current PLC signed operation. `null` when not yet
   * resolved (offline, post-rotation propagation window) — the screen
   * renders a loading state and disables the Add CTA.
   */
  prior?: Record<string, unknown> | null;
  /** Whether the runner is actively submitting an Add operation. */
  isAdding?: boolean;
  /** Fired when the user taps "+ Add namespace". Receives the next index. */
  onAddNamespace?: (nextIndex: number) => void;
  /**
   * Fired when the user taps a namespace row. The screen-level wrapper
   * uses this to navigate into a per-namespace detail / disable flow.
   */
  onSelectNamespace?: (row: NamespaceRow) => void;
}

export default function NamespaceScreen(props: NamespaceScreenProps = {}): React.ReactElement {
  const { did = '', prior = null, isAdding = false, onAddNamespace, onSelectNamespace } = props;
  const rows = React.useMemo(() => deriveNamespaceRows(did, prior), [did, prior]);
  const nextIdx = nextNamespaceIndexFor(prior);
  const canAdd = canAddNamespace(prior) && !isAdding;

  // Auto-timeout: when no `prior` op is supplied within the load
  // budget, surface a graceful "couldn't reach trust network" message
  // instead of spinning forever. Skipped in controlled mode (when the
  // caller passes `prior` explicitly — tests + a future runner).
  const [timedOut, setTimedOut] = React.useState(false);
  const [retryNonce, setRetryNonce] = React.useState(0);
  React.useEffect(() => {
    if (props.prior !== undefined) return;
    setTimedOut(false);
    const id = setTimeout(() => setTimedOut(true), LOAD_BUDGET_MS);
    return () => clearTimeout(id);
  }, [retryNonce, props.prior]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="namespace-screen"
    >
      <View style={styles.header}>
        <Text style={styles.title}>Pseudonymous namespaces</Text>
        <Text style={styles.subtitle}>
          Compartments of your identity. Each namespace publishes under its own key —
          attestations made under one are kept separate from your root identity in
          reviewer trust scoring.
        </Text>
      </View>

      {prior === null && timedOut ? (
        <View style={styles.empty} testID="namespace-error">
          <Ionicons name="cloud-offline-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>DID document unavailable</Text>
          <Text style={styles.emptyBody}>
            Couldn&apos;t reach the trust network to read your namespaces. Check your
            connection and try again.
          </Text>
          <Pressable
            onPress={() => setRetryNonce((n) => n + 1)}
            style={({ pressed }) => [
              styles.cta,
              pressed && styles.ctaPressed,
              { marginTop: spacing.md },
            ]}
            testID="namespace-retry"
            accessibilityRole="button"
            accessibilityLabel="Retry"
          >
            <Ionicons name="refresh" size={16} color={colors.bgSecondary} />
            <Text style={styles.ctaLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : prior === null ? (
        <View style={styles.loading} testID="namespace-loading">
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading your DID document…</Text>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.empty} testID="namespace-empty">
          <Ionicons name="layers-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No namespaces yet</Text>
          <Text style={styles.emptyBody}>
            Tap below to create your first namespace. You can use it to publish
            attestations under a separate compartment of your identity.
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <Pressable
              key={row.fragment}
              onPress={onSelectNamespace ? () => onSelectNamespace(row) : undefined}
              style={({ pressed }) => [
                styles.row,
                pressed && onSelectNamespace ? styles.rowPressed : undefined,
              ]}
              testID={`namespace-row-${row.index}`}
              accessibilityRole={onSelectNamespace ? 'button' : undefined}
              accessibilityLabel={`Namespace ${row.fragment}`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowFragment}>{row.fragment}</Text>
                <Text style={styles.rowVmId} numberOfLines={1} ellipsizeMode="middle">
                  {row.verificationMethodId}
                </Text>
              </View>
              {onSelectNamespace ? (
                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
              ) : null}
            </Pressable>
          ))}
        </View>
      )}

      <Pressable
        onPress={canAdd && nextIdx !== null && onAddNamespace
          ? () => onAddNamespace(nextIdx)
          : undefined}
        disabled={!canAdd || nextIdx === null}
        style={({ pressed }) => [
          styles.cta,
          (!canAdd || nextIdx === null) && styles.ctaDisabled,
          pressed && canAdd && nextIdx !== null ? styles.ctaPressed : undefined,
        ]}
        testID="namespace-add-cta"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canAdd || nextIdx === null, busy: isAdding }}
        accessibilityLabel={
          isAdding
            ? 'Adding namespace'
            : nextIdx !== null
              ? `Add namespace_${nextIdx}`
              : 'Add namespace'
        }
      >
        {isAdding ? (
          <ActivityIndicator color={colors.bgSecondary} />
        ) : (
          <>
            <Ionicons name="add" size={20} color={colors.bgSecondary} />
            <Text style={styles.ctaLabel}>
              {nextIdx !== null ? `Add namespace_${nextIdx}` : 'Add namespace'}
            </Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  header: { marginBottom: spacing.lg },
  title: { fontFamily: fonts.heading, fontSize: 22, color: colors.textPrimary },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  loading: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
  },
  loadingText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  empty: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: spacing.lg,
  },
  list: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.bgTertiary },
  rowMain: { flex: 1, gap: spacing.xs },
  rowFragment: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    color: colors.textPrimary,
  },
  rowVmId: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: spacing.sm,
    minHeight: 48, // a11y tap-target floor (44pt iOS / 48dp Android)
  },
  ctaDisabled: { backgroundColor: colors.textMuted },
  ctaPressed: { backgroundColor: colors.accentHover },
  ctaLabel: {
    fontFamily: fonts.headingBold,
    fontSize: 15,
    color: colors.bgSecondary,
  },
});
