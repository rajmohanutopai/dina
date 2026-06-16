/**
 * `InlineDemoServicePreviewCard` — chat-thread READ-ONLY "your services page"
 * preview for the GUIDED DEMO's salon finale. Shown after the salon hours are
 * stored, BEFORE the publish popup, so the user sees the listing they are about
 * to publish (the same fields My Listings shows): name, capability, the vault it
 * answers from, and a "Not published yet" status.
 *
 * Purely informational — NO actions. Publishing happens via the demo dock's
 * "Publish" button (which opens the confirmation popup). The chat row is
 * scope-bound (torn down with the demo scope).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

import type { ChatMessage } from '@dina/brain/chat';

export interface InlineDemoServicePreviewCardProps {
  message: ChatMessage;
}

interface DemoServicePreviewMetadata {
  kind: 'demo_service_preview';
  serviceName: string;
  capability: string;
  answersFrom: string;
  status: string;
}

function readMetadata(m: ChatMessage): DemoServicePreviewMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'demo_service_preview') return null;
  if (typeof md.serviceName !== 'string' || md.serviceName.length === 0) return null;
  return {
    kind: 'demo_service_preview',
    serviceName: md.serviceName,
    capability: typeof md.capability === 'string' ? md.capability : '',
    answersFrom: typeof md.answersFrom === 'string' ? md.answersFrom : '',
    status: typeof md.status === 'string' ? md.status : '',
  };
}

export function InlineDemoServicePreviewCard({
  message,
}: InlineDemoServicePreviewCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  if (meta === null) return null;

  return (
    <View style={styles.card} testID="demo-service-preview-card">
      <Text style={styles.label}>Your Services</Text>
      <Text style={styles.name} testID="demo-service-preview-name">
        {meta.serviceName}
      </Text>
      {meta.capability !== '' ? (
        <Text style={styles.capability}>{`• ${meta.capability}`}</Text>
      ) : null}
      {meta.answersFrom !== '' ? (
        <Text style={styles.detail}>Answers from: {meta.answersFrom}</Text>
      ) : null}
      {meta.status !== '' ? (
        <View style={styles.statusChip} testID="demo-service-preview-status">
          <Text style={styles.statusText}>{meta.status}</Text>
        </View>
      ) : null}
      <MessageTimestamp timestamp={message.timestamp} />
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
  },
  label: { ...textStyles.eyebrow, marginBottom: spacing.xs },
  name: { ...textStyles.bodyStrong, color: colors.textPrimary },
  capability: { ...textStyles.body, color: colors.textSecondary, marginTop: spacing.xs },
  detail: { ...textStyles.bodySmall, color: colors.textSecondary, marginTop: spacing.xs },
  statusChip: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgPrimary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusText: { ...textStyles.eyebrow, color: colors.textMuted },
});
