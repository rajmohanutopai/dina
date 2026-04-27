/**
 * `InlineApprovalCard` — chat-thread inline renderer for approval
 * messages produced by the Pattern A coordinator bridge (5.21-H).
 *
 * Distinct from the Approvals-tab card: this one lives inline in
 * the chat thread, right where the user asked the question, so
 * tapping Approve / Deny mirrors the natural reading order of the
 * conversation. The thread message carries the approval id +
 * persona in metadata; tapping a button drives `approveCard` /
 * `denyCard` from `useChatApprovals`, which prefer
 * `getAskApprovalGateway()` when installed (Pattern A) and fall
 * back to bare `ApprovalManager` mutations otherwise.
 *
 * The card disables both buttons after the first tap (or when the
 * underlying approval is no longer pending) to avoid double-fires
 * during the resume window.
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import type { ChatMessage } from '@dina/brain/src/chat/thread';
import { approveCard, denyCard } from '../hooks/useChatApprovals';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';

export interface InlineApprovalCardProps {
  /** The chat message carrying the approval metadata. */
  message: ChatMessage;
  /** Operator DID — passed through to `approveCard` for audit. */
  approverDID: string;
}

interface AskApprovalMetadata {
  kind: 'ask_approval';
  askId: string;
  approvalId: string;
  persona?: string;
  requesterDid: string;
}

function readMetadata(m: ChatMessage): AskApprovalMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'ask_approval') return null;
  if (typeof md.approvalId !== 'string' || md.approvalId.length === 0) return null;
  if (typeof md.askId !== 'string' || md.askId.length === 0) return null;
  if (typeof md.requesterDid !== 'string') return null;
  const meta: AskApprovalMetadata = {
    kind: 'ask_approval',
    askId: md.askId,
    approvalId: md.approvalId,
    requesterDid: md.requesterDid,
  };
  if (typeof md.persona === 'string') meta.persona = md.persona;
  return meta;
}

export function InlineApprovalCard({ message, approverDID }: InlineApprovalCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState<'approved' | 'denied' | null>(null);

  const onApprove = useCallback(async () => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    try {
      const card = await approveCard(meta.approvalId, 'single', approverDID);
      setResolved(card?.status === 'approved' ? 'approved' : null);
    } finally {
      setPending(false);
    }
  }, [meta, pending, resolved, approverDID]);

  const onDeny = useCallback(async () => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    try {
      const card = await denyCard(meta.approvalId);
      setResolved(card?.status === 'denied' ? 'denied' : null);
    } finally {
      setPending(false);
    }
  }, [meta, pending, resolved]);

  if (meta === null) return null;

  const personaLabel = meta.persona ? `/${meta.persona}` : 'this persona';
  const disabled = pending || resolved !== null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Approval needed</Text>
      <Text style={styles.body}>
        Dina wants to read{meta.persona ? ` ${personaLabel}` : ''} to answer your question.
      </Text>
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`approval-deny-${meta.approvalId}`}
            style={[styles.btn, styles.deny, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onDeny}
            activeOpacity={0.7}
          >
            <Text style={styles.denyText}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`approval-approve-${meta.approvalId}`}
            style={[styles.btn, styles.approve, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onApprove}
            activeOpacity={0.7}
          >
            <Text style={styles.approveText}>Approve</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'approved' && <Text style={styles.statusApproved}>Approved — fetching answer…</Text>}
      {resolved === 'denied' && <Text style={styles.statusDenied}>Denied.</Text>}
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
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  body: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    color: colors.textPrimary,
    lineHeight: 22,
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
  approve: {
    backgroundColor: colors.textPrimary,
  },
  approveText: {
    fontFamily: fonts.sansSemibold,
    color: colors.bgPrimary,
    fontSize: 14,
  },
  deny: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  denyText: {
    fontFamily: fonts.sansMedium,
    color: colors.textPrimary,
    fontSize: 14,
  },
  statusApproved: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  statusDenied: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
