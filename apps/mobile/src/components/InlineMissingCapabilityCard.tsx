/**
 * First-party empty-discovery card. Rendered when Dina Services discovery finds
 * zero live providers for a capability. This is not a provider-authored card:
 * the network state remains "no providers", and Dina shows the developer
 * path for filling that slot.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';

import { colors, radius, shadows, spacing, textStyles } from '../theme';

export interface InlineMissingCapabilityCardProps {
  message: ChatMessage;
}

export const DINA_SERVICES_GUIDE_URL =
  'https://github.com/rajmohanutopai/dina/blob/main/docs/DINA_SERVICES_PROVIDER_GUIDE.md';

export function InlineMissingCapabilityCard({
  message,
}: InlineMissingCapabilityCardProps): React.JSX.Element | null {
  const lc = readLifecycle(message);
  if (lc === null || lc.kind !== 'missing_capability') return null;

  const openGuide = (): void => {
    void Linking.openURL(DINA_SERVICES_GUIDE_URL).catch(() => {
      /* external guide is best-effort */
    });
  };

  return (
    <View style={styles.card}>
      <View style={styles.eyebrowRow}>
        <Ionicons name="search-outline" size={14} color={colors.textMuted} />
        <Text style={styles.eyebrow}>SERVICE GAP</Text>
      </View>

      <Text style={styles.title}>Provider not found</Text>

      <View style={styles.capabilityPill}>
        <Text style={styles.capabilityText} numberOfLines={1}>
          {lc.capability}
        </Text>
      </View>

      <Text style={styles.body}>
        Dina found zero live providers for this capability on the Dina Services Network.
      </Text>
      <Text style={styles.body}>
        This is open network space: claim it by publishing a provider profile for the
        namespace.
      </Text>

      <View style={styles.steps}>
        <Step icon="document-text-outline" label="Read the provider guide" />
        <Step icon="terminal-outline" label="Connect an agent or service" />
        <Step icon="git-network-outline" label="Publish the provider profile" />
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionButton, styles.primaryButton]}
          onPress={openGuide}
          accessibilityRole="link"
          accessibilityLabel="Open Dina Services provider guide"
          testID="missing-capability-provider-guide"
        >
          <Ionicons name="open-outline" size={16} color={colors.bgPrimary} />
          <Text style={styles.primaryButtonText}>Open Provider Guide</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>Dina system fallback · no provider was selected</Text>
    </View>
  );
}

function Step({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}): React.JSX.Element {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepIcon}>
        <Ionicons name={icon} size={14} color={colors.textSecondary} />
      </View>
      <Text style={styles.stepText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
    ...shadows.sm,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  eyebrow: {
    ...textStyles.eyebrow,
    color: colors.textMuted,
  },
  title: {
    ...textStyles.h2,
    marginBottom: spacing.sm,
  },
  capabilityPill: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: radius.full,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },
  capabilityText: {
    ...textStyles.monoSmall,
    color: colors.textPrimary,
  },
  body: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  steps: {
    gap: spacing.xs,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepIcon: {
    width: 26,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionButton: {
    minHeight: 42,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  primaryButton: {
    backgroundColor: colors.textPrimary,
    flexGrow: 1,
  },
  primaryButtonText: {
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
  footer: {
    ...textStyles.caption,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
});
