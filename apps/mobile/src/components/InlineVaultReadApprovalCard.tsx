/**
 * `InlineVaultReadApprovalCard` — chat-thread rich card for the
 * agent-driven vault_read approvals minted by
 * `installWorkflowApprovalChatBridge` (F-AGENT-VAULT-GATE round-2).
 *
 * Distinct from `InlineApprovalCard`: that one is wired to the chat-tab
 * pure-chat approval path (`ApprovalManager` + `getAskApprovalGateway`),
 * which doesn't drive workflow tasks. This one mirrors the Approvals tab
 * code path — it calls `approvePending` / `denyPending` from
 * `useServiceInbox`, which routes through the same
 * `approveWorkflowTask` / `cancelWorkflowTask` Core RPCs the Approvals
 * tab uses. Same backend, same side effects, just visible in chat.
 *
 * Scope picker — when the user taps Approve, an iOS Alert presents the
 * three-way choice (This time only / Allow for this session / Cancel),
 * matching the dialog the Approvals tab fires for the same task kind.
 * "Allow for this session" routes `scope='session'`, which the workflow
 * approve handler dispatches to `grantVaultReadSessionApproval(agentDid,
 * sessionId, persona)` so subsequent agent asks in the same CLI session
 * auto-pass the persona_guard until TTL.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { markNotificationRead } from '@dina/brain/notifications';

import {
  approvePending,
  denyPending,
  getApprovalLifecycle,
} from '../hooks/useServiceInbox';
import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

import type { ChatMessage } from '@dina/brain/chat';

export interface InlineVaultReadApprovalCardProps {
  message: ChatMessage;
}

interface VaultReadMetadata {
  approvalTaskId: string;
  persona: string;
  agentDid: string;
  /** WHY the agent wants access — shown so the decision is informed. */
  reason: string;
}

function readMetadata(m: ChatMessage): VaultReadMetadata | null {
  const md = m.metadata;
  if (!md) return null;
  if (md.approvalKind !== 'vault_read') return null;
  const taskId = md.approvalTaskId;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const persona = typeof md.persona === 'string' ? md.persona : '';
  const agentDid = typeof md.agentDid === 'string' ? md.agentDid : '';
  const reason = typeof md.reason === 'string' ? md.reason : '';
  return { approvalTaskId: taskId, persona, agentDid, reason };
}

export function InlineVaultReadApprovalCard({
  message,
}: InlineVaultReadApprovalCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [pending, setPending] = useState(false);
  // `null` ≡ still showing action buttons. The three resolved labels
  // correspond to the three actions the operator can take on the
  // card; an `approved` from a sister surface (the Approvals tab)
  // collapses to `approved-elsewhere` so the bubble shows a neutral
  // "Approved." label without claiming a scope this card didn't fire.
  const [resolved, setResolved] = useState<
    'approved-once' | 'approved-session' | 'approved-elsewhere' | 'denied' | null
  >(null);

  // Cross-surface sync: when the chat card mounts AND every 5s while
  // it's still pending, probe the workflow task. If the operator
  // already approved/denied via the Approvals tab (or any other
  // surface), the card flips to the resolved label automatically — no
  // need to tap, no need to re-focus the tab.
  //
  // The poll only runs while `resolved === null`; setting it from the
  // probe response causes the next effect run to early-return without
  // re-arming the interval, so a resolved card costs zero. The
  // `WorkflowRepository` only exposes a `created` event today, so we
  // poll for status changes instead of subscribing — when a richer
  // `subscribeApprovalResolved` event lands later this can replace the
  // setInterval without touching consumers.
  useEffect(() => {
    if (meta === null || resolved !== null) return;
    let cancelled = false;
    const probe = (): void => {
      void getApprovalLifecycle(meta.approvalTaskId)
        .then((lifecycle) => {
          if (cancelled) return;
          if (lifecycle === 'approved') setResolved('approved-elsewhere');
          else if (lifecycle === 'denied' || lifecycle === 'missing') setResolved('denied');
          // The Approvals-tab approve/deny paths already markRead when
          // they call `approvePending` / `denyPending`. But if the
          // task was resolved by a surface that DOESN'T go through
          // those hooks (CLI auto-approve via session-grant, push-
          // notification action, expiry sweep), the badge stays stuck.
          // Clear it here when the poll observes the resolution.
          // `markNotificationRead` is a no-op when the id is already
          // read or not in the inbox.
          if (lifecycle !== 'pending') markNotificationRead(meta.approvalTaskId);
        })
        .catch(() => {
          /* in-process probe rarely fails; ignore + try again on the
             next tick. The buttons stay visible so the operator can
             still take action manually. */
        });
    };
    probe(); // mount-time probe — catches the "already resolved" case.
    const handle = setInterval(probe, 5_000);
    return (): void => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [meta, resolved]);

  // Tap-time error recovery: if the local approve/deny call rejects,
  // re-probe the task — if it's already resolved (the common race
  // when the operator approved/denied on the Approvals tab between
  // mount-time check and tap), silently sync the local state instead
  // of surfacing an alert.
  const reconcileAfterError = useCallback(
    async (taskId: string, err: unknown): Promise<boolean> => {
      try {
        const live = await getApprovalLifecycle(taskId);
        if (live === 'approved') {
          setResolved('approved-elsewhere');
          return true;
        }
        if (live === 'denied' || live === 'missing') {
          setResolved('denied');
          return true;
        }
      } catch {
        /* fall through to surface the original error */
      }
      Alert.alert('Error', (err as Error).message ?? 'Failed to update approval');
      return false;
    },
    [],
  );

  const runApprove = useCallback(
    async (scope: 'single' | 'session'): Promise<void> => {
      if (meta === null || pending || resolved !== null) return;
      setPending(true);
      try {
        await approvePending(meta.approvalTaskId, 'vault_read', scope);
        setResolved(scope === 'session' ? 'approved-session' : 'approved-once');
      } catch (err) {
        await reconcileAfterError(meta.approvalTaskId, err);
      } finally {
        setPending(false);
      }
    },
    [meta, pending, resolved, reconcileAfterError],
  );

  const onApproveOnce = useCallback(() => void runApprove('single'), [runApprove]);
  const onApproveSession = useCallback(() => void runApprove('session'), [runApprove]);

  const onDeny = useCallback(async () => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    try {
      await denyPending(meta.approvalTaskId, 'vault_read');
      setResolved('denied');
    } catch (err) {
      await reconcileAfterError(meta.approvalTaskId, err);
    } finally {
      setPending(false);
    }
  }, [meta, pending, resolved, reconcileAfterError]);

  if (meta === null) return null;

  const personaLabel = meta.persona !== '' ? `/${meta.persona}` : 'this persona';
  const shortAgent =
    meta.agentDid.length > 28 ? `${meta.agentDid.slice(0, 28)}…` : meta.agentDid;
  const disabled = pending || resolved !== null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>🔐 Agent vault read</Text>
      <Text style={styles.body}>
        An agent wants to access {personaLabel}.
      </Text>
      {meta.reason !== '' && <Text style={styles.reason}>{meta.reason}</Text>}
      {shortAgent !== '' && <Text style={styles.agent}>{shortAgent}</Text>}
      {resolved === null && (
        // dina_details §13.4 — inline three-way scope picker on the card
        // itself instead of an iOS popup. `Deny` blocks; `Approve Once`
        // grants single-use (`scope='single'`); `Approve` grants for the
        // current `dina session` (`scope='session'`) so subsequent agent
        // asks for the same (agent, session, persona) tuple auto-pass
        // the persona_guard until TTL. Same code paths the Approvals tab
        // hits — see `approvePending` in `useServiceInbox`.
        <View style={styles.row}>
          <TouchableOpacity
            testID={`vault-read-deny-${meta.approvalTaskId}`}
            style={[styles.btn, styles.deny, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onDeny}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.denyText}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`vault-read-approve-once-${meta.approvalTaskId}`}
            style={[styles.btn, styles.approveOnce, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onApproveOnce}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.approveOnceText}>Approve Once</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`vault-read-approve-${meta.approvalTaskId}`}
            style={[styles.btn, styles.approve, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onApproveSession}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.approveText}>Approve</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'approved-once' && (
        <Text style={styles.statusApproved}>Approved once.</Text>
      )}
      {resolved === 'approved-session' && (
        <Text style={styles.statusApproved}>Approved for this session.</Text>
      )}
      {resolved === 'approved-elsewhere' && (
        // Sister surface (Approvals tab) approved this — neutral label
        // since this card didn't pick a scope.
        <Text style={styles.statusApproved}>Approved.</Text>
      )}
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
    ...textStyles.eyebrow,
    marginBottom: spacing.xs,
  },
  body: {
    ...textStyles.body,
    marginBottom: spacing.xs,
  },
  reason: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  agent: {
    ...textStyles.monoSmall,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    // Each button takes 1/3 of the row via `flex: 1` on .btn so the
    // three buttons read as a single segmented control regardless of
    // label length. Without this, content-sized buttons (`Deny` = 4
    // chars, `Approve Once` = 12) render at noticeably different
    // widths even when minWidth is set, which looks broken next to
    // each other.
    gap: spacing.xs,
  },
  btn: {
    flex: 1,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    // Every button has a 1px border for identical visual height; the
    // filled-primary "Approve" uses a same-color border so its
    // outline stays flush with the others (avoids it looking shorter
    // by 2px than the bordered Deny / Approve Once).
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  // "Approve" = session scope — the primary, longer-lived action,
  // styled as the filled primary button. Border matches background so
  // its outline is flush with the bordered Deny / Approve Once.
  approve: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary,
  },
  approveText: {
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
  // "Approve Once" = single-use — a less-committed action, rendered
  // as a bordered secondary button so it visually sits between Deny
  // and Approve.
  approveOnce: {
    backgroundColor: 'transparent',
    borderColor: colors.textPrimary,
  },
  approveOnceText: {
    ...textStyles.buttonSmall,
    color: colors.textPrimary,
  },
  deny: {
    // Soft-red border + soft-red bg so the button reads as destructive
    // at a glance — pairs visually with the red `Deny` text instead of
    // floating on a neutral gray border that fights the text color.
    backgroundColor: colors.errorBgSoft,
    borderColor: colors.error,
  },
  denyText: {
    ...textStyles.buttonSmall,
    color: colors.error,
  },
  statusApproved: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  statusDenied: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
