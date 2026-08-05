/**
 * `InlineQuarantineCard` — chat-thread review card for a D2D message
 * from an UNKNOWN sender.
 *
 * When a stranger's message arrives it decrypts + signature-verifies
 * fine, but the trust gate quarantines it (you only auto-accept from
 * contacts). Before this card existed, that message vanished into the
 * quarantine store with zero UI trace — a freshly-installed user
 * reasonably concludes "messages aren't coming through". This surfaces
 * the event inline, right in the chat, with two actions:
 *
 *   - Add to contacts → records the sender as a verified contact AND
 *     releases the held message back through the staging drain, so the
 *     same enrichment + reminder pipeline runs as if they'd been a
 *     contact all along. Future messages from them stage directly.
 *   - Block → drops the message + blocks the DID.
 *
 * The sender's message BODY is deliberately NOT shown until the user
 * decides (anti-spam: strangers can't push content onto your surface).
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';

import { updateMessageMetadataById, type ChatMessage } from '@dina/brain/chat';

import { acceptQuarantine, blockQuarantine } from '../hooks/quarantine_actions';
import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

export interface InlineQuarantineCardProps {
  message: ChatMessage;
}

interface QuarantineMetadata {
  quarantineId: string;
  senderDID: string;
  status: 'pending' | 'accepted' | 'blocked';
}

function readMetadata(m: ChatMessage): QuarantineMetadata | null {
  const lc = m.metadata?.lifecycle as
    | { kind?: unknown; quarantineId?: unknown; senderDID?: unknown; status?: unknown }
    | undefined;
  if (!lc || lc.kind !== 'quarantine_request') return null;
  if (typeof lc.quarantineId !== 'string' || lc.quarantineId.length === 0) return null;
  if (typeof lc.senderDID !== 'string' || lc.senderDID.length === 0) return null;
  const status = lc.status === 'accepted' || lc.status === 'blocked' ? lc.status : 'pending';
  return { quarantineId: lc.quarantineId, senderDID: lc.senderDID, status };
}

function persistResolution(
  message: ChatMessage,
  meta: QuarantineMetadata,
  status: 'accepted' | 'blocked',
): void {
  const lifecycle = message.metadata?.lifecycle;
  updateMessageMetadataById(message.threadId, message.id, {
    lifecycle: {
      ...(lifecycle !== null && typeof lifecycle === 'object'
        ? (lifecycle as Record<string, unknown>)
        : {}),
      kind: 'quarantine_request',
      quarantineId: meta.quarantineId,
      senderDID: meta.senderDID,
      status,
    },
  });
}

function shortDID(did: string): string {
  if (!did || did.length <= 22) return did || 'unknown';
  return `${did.slice(0, 14)}…${did.slice(-4)}`;
}

export function InlineQuarantineCard({
  message,
}: InlineQuarantineCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState<'accepted' | 'blocked' | null>(
    meta?.status === 'accepted' || meta?.status === 'blocked' ? meta.status : null,
  );

  const onAccept = useCallback(() => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    void acceptQuarantine(meta.quarantineId, meta.senderDID)
      .then((ok) => {
        if (!ok) return;
        persistResolution(message, meta, 'accepted');
        setResolved('accepted');
      })
      .finally(() => setPending(false));
  }, [message, meta, pending, resolved]);

  const onBlock = useCallback(() => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    void blockQuarantine(meta.quarantineId, meta.senderDID)
      .then((ok) => {
        if (!ok) return;
        persistResolution(message, meta, 'blocked');
        setResolved('blocked');
      })
      .finally(() => setPending(false));
  }, [message, meta, pending, resolved]);

  if (meta === null) return null;

  const disabled = pending || resolved !== null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>🔒 Unknown sender</Text>
      <Text testID={`quarantine-card-body-${meta.quarantineId}`} style={styles.body}>
        Someone who isn&apos;t in your contacts wants to message you.
      </Text>
      <Text testID={`quarantine-card-did-${meta.quarantineId}`} style={styles.did}>
        {shortDID(meta.senderDID)}
      </Text>
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`quarantine-block-${meta.quarantineId}`}
            style={[styles.btn, styles.block, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onBlock}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.blockText}>Block</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`quarantine-accept-${meta.quarantineId}`}
            style={[styles.btn, styles.accept, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onAccept}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.acceptText}>Add to contacts</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'accepted' && (
        <Text style={styles.statusAccepted}>Added to contacts. Processing their message…</Text>
      )}
      {resolved === 'blocked' && <Text style={styles.statusBlocked}>Blocked.</Text>}
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
  label: {
    ...textStyles.eyebrow,
    marginBottom: spacing.xs,
  },
  body: {
    ...textStyles.body,
    marginBottom: spacing.xs,
  },
  did: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 88,
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  accept: {
    backgroundColor: colors.textPrimary,
  },
  acceptText: {
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
  block: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  blockText: {
    ...textStyles.buttonSmall,
    color: colors.textPrimary,
  },
  statusAccepted: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  statusBlocked: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
