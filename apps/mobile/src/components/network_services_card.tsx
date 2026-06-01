/**
 * Network → Services module (spec 5.1 / 5.5).
 *
 * The first-level module on the Network tab that makes Dina Services a
 * discoverable primary surface instead of a hidden Settings preference.
 * Two affordances:
 *
 *   - "Find a service" — service discovery happens by asking Dina in
 *     Chat (the real code path; a marketplace/search screen is an
 *     explicit non-goal). So this routes to Chat where the user asks
 *     naturally (spec 7.3).
 *   - "Publish a service" / "My services" — routes to `/service-settings`
 *     (role / discoverability / listing / capabilities). Copy adapts to
 *     provider mode: a requester-only node invites publishing; a
 *     provider/both node manages existing listings (spec 5.5).
 *
 * Presentational by design — `isProvider` + the two handlers are
 * injected so the card is unit-testable in isolation and the Network
 * screen owns the boot/router wiring (matching the screen's existing
 * prop-injection pattern). No provider-blocker warning here: the spec
 * keeps the "saved locally but not discoverable" warning on the
 * publish surface (`/service-settings`), shown only when the user is
 * actually trying to publish (spec 5.5).
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

export interface NetworkServicesCardProps {
  /**
   * True when this node runs as a service provider (role `provider` or
   * `both`). Drives the publish-row copy: providers manage listings,
   * requesters are invited to publish.
   */
  isProvider: boolean;
  /** Tap "Find a service" — discovery happens by asking in Chat. */
  onFindService: () => void;
  /** Tap the publish/manage row — routes to `/service-settings`. */
  onPublishOrManage: () => void;
}

export function NetworkServicesCard({
  isProvider,
  onFindService,
  onPublishOrManage,
}: NetworkServicesCardProps): React.ReactElement {
  const publishLabel = isProvider ? 'My services' : 'Publish a service';
  const publishSublabel = isProvider
    ? 'Configure listings, discoverability, and capabilities.'
    : 'Offer what this Dina can do to the network.';

  return (
    <View style={styles.card} testID="network-services-card">
      <View style={styles.header}>
        <Ionicons name="compass-outline" size={18} color={colors.textPrimary} />
        <Text style={styles.heading} accessibilityRole="header">
          Services
        </Text>
      </View>
      <Text style={styles.subtitle}>
        Ask other Dinas for live answers, or publish what this Dina can do.
      </Text>

      <ServiceRow
        testID="network-services-find"
        icon="search-outline"
        label="Find a service"
        sublabel="Ask in Chat for a live answer from the network."
        onPress={onFindService}
      />
      <View style={styles.rowDivider} />
      <ServiceRow
        testID="network-services-publish"
        icon="megaphone-outline"
        label={publishLabel}
        sublabel={publishSublabel}
        onPress={onPublishOrManage}
      />
    </View>
  );
}

function ServiceRow({
  testID,
  icon,
  label,
  sublabel,
  onPress,
}: {
  testID: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  sublabel: string;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${sublabel}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Ionicons name={icon} size={18} color={colors.textSecondary} style={styles.rowIcon} />
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSublabel} numberOfLines={1}>
          {sublabel}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  heading: textStyles.bodyStrong,
  subtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  rowPressed: { opacity: 0.6 },
  rowIcon: { width: 22, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowLabel: textStyles.body,
  rowSublabel: {
    ...textStyles.tiny,
    color: colors.textMuted,
    marginTop: 1,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 22 + spacing.sm,
  },
});
