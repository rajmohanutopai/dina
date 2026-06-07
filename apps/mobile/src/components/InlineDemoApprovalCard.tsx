/**
 * `InlineDemoApprovalCard` — chat-thread inline approve/deny card for the
 * GUIDED DEMO's agent-approval step ("an agent asks to read Health").
 *
 * Why a dedicated card rather than reusing `InlineApprovalCard`
 * (`ask_approval`), `InlineVaultReadApprovalCard`, or
 * `InlineServiceApprovalCard`: each of those resolves through real backing
 * infrastructure that a standalone demo request can't satisfy without leaking
 * into the user's real data —
 *   - ask_approval → `approveCard` routes through the AskApprovalGateway, which
 *     short-circuits with `unknown_approval` when no real agentic /ask is in
 *     flight (the demo has none), so the card never resolves;
 *   - vault_read → drives `approveWorkflowTask` + `grantVaultReadSessionApproval`,
 *     writing a real (UNSCOPED) agent grant — a user-scope leak from the demo;
 *   - service_approval → runs the `/service_approve` slash command against a
 *     real workflow task that doesn't exist for the demo.
 *
 * This card is backed ONLY by the real `ApprovalManager` (the genuine approval
 * mechanism), keyed by the demo request's id. Approve/Deny mutate the manager
 * directly — no gateway, no workflow task, no grant — so the interaction is real
 * and reliable but leaves nothing behind: the chat message is scope-bound (torn
 * down with the demo scope) and the runner's teardown denies any request the
 * user left pending.
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';

import { getApprovalManager } from '@dina/core';


import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

import type { ChatMessage } from '@dina/brain/chat';

export interface InlineDemoApprovalCardProps {
  message: ChatMessage;
}

interface DemoApprovalMetadata {
  kind: 'demo_approval';
  approvalId: string;
  persona?: string;
  preview?: string;
}

function readMetadata(m: ChatMessage): DemoApprovalMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'demo_approval') return null;
  if (typeof md.approvalId !== 'string' || md.approvalId.length === 0) return null;
  const meta: DemoApprovalMetadata = { kind: 'demo_approval', approvalId: md.approvalId };
  if (typeof md.persona === 'string') meta.persona = md.persona;
  if (typeof md.preview === 'string') meta.preview = md.preview;
  return meta;
}

/** Owner DID is irrelevant for the demo audit — a stable placeholder keeps the
 *  ApprovalManager.approveRequest signature satisfied. */
const DEMO_APPROVER = 'did:demo:owner';

function currentStatus(approvalId: string): 'approved' | 'denied' | null {
  const req = getApprovalManager().getRequest(approvalId);
  if (req?.status === 'approved') return 'approved';
  if (req?.status === 'denied') return 'denied';
  return null;
}

export function InlineDemoApprovalCard({
  message,
}: InlineDemoApprovalCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  // Initialise from the live manager state so a card re-mount (or a teardown
  // deny) reflects the resolved state instead of re-showing the buttons.
  const [resolved, setResolved] = useState<'approved' | 'denied' | null>(() =>
    meta ? currentStatus(meta.approvalId) : null,
  );

  const onApprove = useCallback(() => {
    if (meta === null || resolved !== null) return;
    try {
      getApprovalManager().approveRequest(meta.approvalId, 'single', DEMO_APPROVER);
      setResolved('approved');
    } catch {
      /* already resolved elsewhere — reflect the live state */
      setResolved(currentStatus(meta.approvalId));
    }
  }, [meta, resolved]);

  const onDeny = useCallback(() => {
    if (meta === null || resolved !== null) return;
    try {
      getApprovalManager().denyRequest(meta.approvalId);
      setResolved('denied');
    } catch {
      setResolved(currentStatus(meta.approvalId));
    }
  }, [meta, resolved]);

  if (meta === null) return null;

  const personaLabel = meta.persona ? `/${meta.persona}` : 'this persona';

  return (
    <View style={styles.card} testID={`demo-approval-card-${meta.approvalId}`}>
      <Text style={styles.label}>Approval needed</Text>
      <Text testID={`demo-approval-body-${meta.approvalId}`} style={styles.body}>
        {meta.preview ?? `An agent wants to read ${personaLabel}. Only you can approve it.`}
      </Text>
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`demo-approval-deny-${meta.approvalId}`}
            style={[styles.btn, styles.deny]}
            onPress={onDeny}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.denyText}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`demo-approval-approve-${meta.approvalId}`}
            style={[styles.btn, styles.approve]}
            onPress={onApprove}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.approveText}>Approve</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'approved' && <Text style={styles.statusApproved}>Approved.</Text>}
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
  label: { ...textStyles.eyebrow, marginBottom: spacing.xs },
  body: { ...textStyles.body, color: colors.textPrimary },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btn: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.sm },
  approve: { backgroundColor: colors.accent },
  approveText: { ...textStyles.button, color: colors.white },
  deny: { backgroundColor: colors.bgPrimary, borderWidth: 1, borderColor: colors.border },
  denyText: { ...textStyles.button, color: colors.textPrimary },
  statusApproved: { ...textStyles.bodySmall, color: colors.successTextDeep, marginTop: spacing.xs },
  statusDenied: { ...textStyles.bodySmall, color: colors.textSecondary, marginTop: spacing.xs },
});
