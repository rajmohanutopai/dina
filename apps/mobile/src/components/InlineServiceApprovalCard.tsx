/**
 * `InlineServiceApprovalCard` — chat-thread inline renderer for D2D
 * service-approval messages produced by `defaultApprovalNotifier` in
 * `bootstrap.ts` (5.65). Parallel to `InlineApprovalCard` (5.21-H-i)
 * but for service-capability gates (a peer wants to run a capability
 * on this node) rather than vault-persona reads.
 *
 * The thread message carries `metadata.kind === 'service_approval'`
 * + the task fields the buttons need (`taskId`, `capability`,
 * `fromDID`, `serviceName`). Tapping Approve / Deny invokes the
 * brain orchestrator's installed handlers directly via the new
 * `getServiceApproveCommandHandler` / `getServiceDenyCommandHandler`
 * getters — same code path as the `/service_approve` slash command,
 * so the rest of the orchestration chain (Core RPC, workflow
 * transition, response bridge) doesn't have to know anything new.
 *
 * The card disables both buttons after the first tap to prevent
 * double-fires; the orchestrator handler returns an `ack` string
 * that we surface as a system message in the same thread.
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import type { ChatMessage } from '@dina/brain/chat';
import { addSystemMessage } from '@dina/brain/chat';
import {
  getServiceApproveCommandHandler,
  getServiceDenyCommandHandler,
} from '@dina/brain/chat';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';

export interface InlineServiceApprovalCardProps {
  message: ChatMessage;
}

interface ServiceApprovalMetadata {
  kind: 'service_approval';
  taskId: string;
  capability: string;
  fromDID: string;
  serviceName: string;
  approveCommand: string;
}

function readMetadata(m: ChatMessage): ServiceApprovalMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'service_approval') return null;
  if (typeof md.taskId !== 'string' || md.taskId === '') return null;
  if (typeof md.capability !== 'string') return null;
  if (typeof md.fromDID !== 'string') return null;
  return {
    kind: 'service_approval',
    taskId: md.taskId,
    capability: md.capability,
    fromDID: md.fromDID,
    serviceName: typeof md.serviceName === 'string' ? md.serviceName : '',
    approveCommand: typeof md.approveCommand === 'string' ? md.approveCommand : '',
  };
}

function shortDID(did: string): string {
  if (!did || did.length <= 20) return did || 'Unknown';
  return `${did.slice(0, 12)}…${did.slice(-4)}`;
}

export function InlineServiceApprovalCard({
  message,
}: InlineServiceApprovalCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState<'approved' | 'denied' | 'unhandled' | null>(null);

  const onApprove = useCallback(async () => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    try {
      const handler = getServiceApproveCommandHandler();
      if (handler === null) {
        addSystemMessage(message.threadId, `Approval handler not wired (task ${meta.taskId}).`);
        setResolved('unhandled');
        return;
      }
      const { ack } = await handler(meta.taskId);
      addSystemMessage(message.threadId, ack);
      setResolved('approved');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      addSystemMessage(message.threadId, `Couldn't approve "${meta.taskId}": ${detail}`);
      setResolved('unhandled');
    } finally {
      setPending(false);
    }
  }, [meta, message.threadId, pending, resolved]);

  const onDeny = useCallback(async () => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    try {
      const handler = getServiceDenyCommandHandler();
      if (handler === null) {
        addSystemMessage(message.threadId, `Denial handler not wired (task ${meta.taskId}).`);
        setResolved('unhandled');
        return;
      }
      const { ack } = await handler(meta.taskId, '');
      addSystemMessage(message.threadId, ack);
      setResolved('denied');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      addSystemMessage(message.threadId, `Couldn't deny "${meta.taskId}": ${detail}`);
      setResolved('unhandled');
    } finally {
      setPending(false);
    }
  }, [meta, message.threadId, pending, resolved]);

  if (meta === null) return null;

  const requesterLabel = meta.serviceName !== '' ? meta.serviceName : shortDID(meta.fromDID);
  const disabled = pending || resolved !== null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Service approval</Text>
      <Text style={styles.body}>
        <Text style={styles.requester}>{requesterLabel}</Text> wants to run{' '}
        <Text style={styles.capability}>{meta.capability}</Text>.
      </Text>
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`service-approval-deny-${meta.taskId}`}
            style={[styles.btn, styles.deny, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onDeny}
            activeOpacity={0.7}
          >
            <Text style={styles.denyText}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`service-approval-approve-${meta.taskId}`}
            style={[styles.btn, styles.approve, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onApprove}
            activeOpacity={0.7}
          >
            <Text style={styles.approveText}>Approve</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'approved' && <Text style={styles.statusLine}>Approved.</Text>}
      {resolved === 'denied' && <Text style={styles.statusLine}>Denied.</Text>}
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
  requester: {
    fontFamily: fonts.sansSemibold,
  },
  capability: {
    fontFamily: fonts.monoMedium,
    fontSize: 14,
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
  statusLine: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
