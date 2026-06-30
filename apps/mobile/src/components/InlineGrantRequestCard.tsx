/**
 * `InlineGrantRequestCard` — chat-thread prompt for a contact's
 * `ask_to_enable` relationship-service request (Contact Services §5.2).
 *
 * When a MEDIUM (friend) contact's Dina sends a `service.grant_request` for a
 * default-offerable talk listing, Core decides "ask the owner" and emits a
 * pending event; the boot posts THIS one-time card into the contact's Talk
 * thread:
 *
 *   - Allow → mints the grant + delivers the `service.offer` via the existing
 *     provider path (`coreClient.issueServiceOffer`). The contact can then use
 *     the service; future requests pass the grant gate silently.
 *   - Not now → dismisses the card. No grant, no row, NO signal back to the
 *     contact (a refusal must not leak — spec §2).
 *
 * It is NOT pre-authorization: the prompt itself is the gate. Distant/unknown
 * contacts never reach this card (Core soft-rejects them with no prompt).
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';

import { recordPromptDismissed } from '../services/grant_decision_log';
import { readGrantPromptLifecycle, resolveGrantPrompt } from '../services/grant_prompt';
import { allowGrantRequest } from '../services/grant_request_actions';
import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

import type { ChatMessage } from '@dina/brain/chat';

export interface InlineGrantRequestCardProps {
  message: ChatMessage;
  /** Display name for the contact (falls back to a short DID). */
  contactName?: string;
}

function shortDID(did: string): string {
  if (!did || did.length <= 22) return did || 'someone';
  return `${did.slice(0, 14)}…${did.slice(-4)}`;
}

/** Humanize a capability id for the prompt — `availability_coordination` →
 *  "availability coordination". Kept simple; the capability set is small. */
function humanizeCapability(cap: string): string {
  return cap.replace(/[_.]/g, ' ');
}

export function InlineGrantRequestCard({
  message,
  contactName,
}: InlineGrantRequestCardProps): React.JSX.Element | null {
  const meta = readGrantPromptLifecycle(message);
  const [pending, setPending] = useState(false);
  // Local override of the optimistic outcome; null = defer to the PERSISTED
  // status (so a card that rehydrated terminal after a restart already shows
  // resolved without any local state).
  const [localResolved, setLocalResolved] = useState<'allowed' | 'dismissed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The persisted status is the source of truth across restarts; the local
  // override wins only while the tap is in-flight (before the patch lands).
  const persisted =
    meta?.status === 'allowed' || meta?.status === 'dismissed' ? meta.status : null;
  const resolved = localResolved ?? persisted;

  const onAllow = useCallback(() => {
    if (meta === null || pending || resolved !== null) return;
    setPending(true);
    setError(null);
    void allowGrantRequest({
      requesterDID: meta.requesterDID,
      rkey: meta.rkey,
      capability: meta.capability,
    })
      .then(() => {
        // Persist the terminal state so it survives a restart + the
        // idempotency scan treats it as handled.
        resolveGrantPrompt(meta.requesterDID, message.id, 'allowed');
        setLocalResolved('allowed');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setPending(false);
      });
  }, [meta, pending, resolved, message.id]);

  const onDismiss = useCallback(() => {
    if (meta === null || pending || resolved !== null) return;
    // No backend call — a refusal must not signal the contact (spec §2). Persist
    // the dismissal so the owner is never re-prompted for it after a restart.
    resolveGrantPrompt(meta.requesterDID, message.id, 'dismissed');
    // Owner-private log: record the prompt's terminal "not now" so Activity
    // reflects the real state instead of a perpetual "You were asked". Both the
    // metadata patch and this row are best-effort (the chat layer persists fire-
    // and-forget); the log is advisory, not a durability guarantee.
    recordPromptDismissed(meta.requesterDID, meta.capability);
    setLocalResolved('dismissed');
  }, [meta, pending, resolved, message.id]);

  if (meta === null) return null;

  const who = contactName !== undefined && contactName !== '' ? contactName : shortDID(meta.requesterDID);
  const what = humanizeCapability(meta.capability);
  const disabled = pending || resolved !== null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>🤝 Service request</Text>
      <Text testID={`grant-prompt-body-${meta.requesterDID}`} style={styles.body}>
        Allow {who} to use your {what} service?
      </Text>
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`grant-prompt-dismiss-${meta.requesterDID}`}
            style={[styles.btn, styles.dismiss, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onDismiss}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.dismissText}>Not now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`grant-prompt-allow-${meta.requesterDID}`}
            style={[styles.btn, styles.allow, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onAllow}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.allowText}>Allow</Text>
          </TouchableOpacity>
        </View>
      )}
      {error !== null && <Text style={styles.errorText}>Couldn’t allow: {error}</Text>}
      {resolved === 'allowed' && (
        <Text style={styles.statusAllowed}>Allowed. {who} can now ask.</Text>
      )}
      {resolved === 'dismissed' && <Text style={styles.statusDismissed}>Dismissed.</Text>}
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
  allow: {
    backgroundColor: colors.textPrimary,
  },
  allowText: {
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
  dismiss: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  dismissText: {
    ...textStyles.buttonSmall,
    color: colors.textPrimary,
  },
  errorText: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.xs,
  },
  statusAllowed: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  statusDismissed: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
