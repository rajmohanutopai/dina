/**
 * The organizer's plan card (docs/GROUP_COORDINATION_ARCHITECTURE.md §9):
 * a row per household — answered, waiting, couldn't reach — the slots every
 * required household agreed on, and the organizer's decisions: choose a slot,
 * widen, drop a household from required, stop.
 *
 * The card is a VIEW. The `group_plan` lifecycle message carries only the plan
 * id; the plan itself lives in Core and changes as replies land, so the card
 * reads it through the owner-marked coordination client and refreshes while
 * the plan is open. Every decision goes back through the same client; the card
 * decides nothing itself.
 *
 * What the card never shows: WHY a household could not be reached (refused,
 * offline, never granted and silent are one state, §5), and anything one
 * household said to another (there is no such thing on the wire, §12). It does
 * name the household that emptied the fold when that household answered —
 * the doc's §13 wording, the notes' open question.
 *
 * A slot is offered as a CHOICE only when the fold converged — every required
 * household said yes. A fold that closed on a household nobody could reach is
 * shown as "works so far" with the §13 moves: go ahead without them, ask again
 * with other dates, or stop. The same three moves stand at confirm when a
 * household reneged, and a settled plan can still be reopened or cancelled.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';
import { getContact, type GroupPlanWire } from '@dina/core';

import { getOwnerCoordinationClient } from '../services/owner_coordination_client';
import { colors, radius, shadows, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

export interface InlineGroupPlanCardProps {
  message: ChatMessage;
}

/** How often an open plan re-reads its fold from Core (ms). */
export const GROUP_PLAN_REFRESH_MS = 4_000;

function householdName(did: string): string {
  const name = getContact(did)?.displayName;
  if (name !== undefined && name.trim() !== '') return name;
  return did.length > 14 ? `${did.slice(0, 10)}…${did.slice(-4)}` : did;
}

function slotText(slot: { start: string; end?: string }): string {
  return slot.end === undefined ? slot.start : `${slot.start} to ${slot.end}`;
}

function names(dids: readonly string[]): string {
  return dids.map(householdName).join(' and ');
}

/** "Sun 27, Sun 4 Oct" → candidate slots; empty lines dropped. */
export function parseCandidates(text: string): { start: string }[] {
  return text
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((start) => ({ start }));
}

export function InlineGroupPlanCard({ message }: InlineGroupPlanCardProps): React.JSX.Element | null {
  const lc = readLifecycle(message);
  const planId = lc !== null && lc.kind === 'group_plan' ? lc.planId : '';
  const [plan, setPlan] = useState<GroupPlanWire | null>(null);
  const [missing, setMissing] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wider, setWider] = useState('');
  const alive = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const client = getOwnerCoordinationClient();
    if (client === null || planId === '') {
      setUnreadable(true);
      return;
    }
    try {
      const fresh = await client.get(planId);
      if (!alive.current) return;
      setUnreadable(false);
      if (fresh === null) setMissing(true);
      else setPlan(fresh);
    } catch {
      // A failed read keeps the last fold and says so; the next tick reads again.
      if (alive.current) setUnreadable(true);
    }
  }, [planId]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const open = plan !== null && plan.state !== 'settled' && plan.state !== 'abandoned';
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => void refresh(), GROUP_PLAN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  /** Run one decision through the owner client; true when Core took it. */
  const decide = useCallback(async (action: () => Promise<GroupPlanWire>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (alive.current) setPlan(next);
      return true;
    } catch (err) {
      const key = (err as { errorKey?: string }).errorKey;
      if (alive.current) setError(key !== undefined ? refusalText(key) : "Couldn't do that. Try again.");
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  if (lc === null || lc.kind !== 'group_plan') return null;

  if (missing) {
    return (
      <View testID={`group-plan-card-${planId}`} style={[styles.card, styles.cardMuted]}>
        <Text style={styles.title}>{lc.intent || 'Group plan'}</Text>
        <Text style={styles.subtitle}>This plan was deleted.</Text>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  if (plan === null) {
    return (
      <View testID={`group-plan-card-${planId}`} style={styles.card}>
        <View style={styles.headerRow}>
          {unreadable ? null : <ActivityIndicator size="small" color={colors.textMuted} />}
          <Text style={styles.title}>{lc.intent || 'Group plan'}</Text>
        </View>
        {unreadable ? (
          <Text testID={`group-plan-unreadable-${planId}`} style={styles.error}>
            Couldn't read this plan right now.
          </Text>
        ) : (
          <Text style={styles.subtitle}>Reading the plan…</Text>
        )}
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  const client = getOwnerCoordinationClient();
  const fold = plan.fold;
  const agreed = fold?.agreed ?? [];
  const settled = plan.state === 'settled';
  const stopped = plan.state === 'abandoned';
  const closed = settled || stopped;
  // The round is over when every required household is accounted for.
  const roundClosed =
    fold !== null &&
    (plan.state === 'folded' || plan.state === 'confirming') &&
    !plan.guests.some((g) => g.required && g.outcome === 'waiting');
  // A choice is a choice only when every required household said yes (§4).
  const canChoose = plan.state === 'folded' && fold?.state === 'converged';
  const emptiedBy = fold?.emptied_by ?? [];
  const unreachableRequired = plan.guests.filter((g) => g.required && g.outcome === 'unreachable').map((g) => g.contact_did);
  // The §13 moves after a round that did not converge: go ahead without the
  // household that blocked it (unreachable, or answered and emptied the fold).
  const droppable = roundClosed && !canChoose ? [...new Set([...unreachableRequired, ...emptiedBy])] : [];
  const showMoves = (roundClosed && !canChoose) || settled;
  // An open widen input is only useful while the organizer can still act.
  const canWiden = client !== null && (roundClosed || settled) && !busy && parseCandidates(wider).length > 0;

  let outcomeLine: string | null = null;
  if (plan.state === 'confirming' && roundClosed) {
    outcomeLine =
      emptiedBy.length > 0
        ? `${names(emptiedBy)} can't make ${plan.chosen !== null ? slotText(plan.chosen) : 'it'} after all.`
        : `Couldn't reach ${names(unreachableRequired)} to confirm.`;
  } else if (plan.state === 'confirming' && plan.chosen !== null) {
    outcomeLine = `Confirming ${slotText(plan.chosen)} with everyone…`;
  } else if (plan.state === 'folded' && !canChoose) {
    outcomeLine =
      emptiedBy.length > 0
        ? `No slot works for ${names(emptiedBy)}.`
        : unreachableRequired.length > 0
          ? `Couldn't reach ${names(unreachableRequired)}.`
          : 'No slot works for everyone.';
  } else if (plan.state === 'proposing') {
    outcomeLine = 'Waiting for replies…';
  }

  return (
    <View testID={`group-plan-card-${planId}`} style={[styles.card, closed ? styles.cardMuted : null]}>
      <View style={styles.eyebrowRow}>
        <Ionicons name="people-outline" size={14} color={colors.textMuted} />
        <Text style={styles.eyebrow}>{eyebrowFor(plan)}</Text>
      </View>
      <Text testID={`group-plan-card-title-${planId}`} style={styles.title}>
        {plan.intent}
      </Text>

      {plan.guests.map((g) => (
        <View key={g.contact_did} style={styles.guestRow} testID={`group-plan-guest-${planId}-${g.contact_did}`}>
          <Ionicons name={outcomeIcon(g.outcome)} size={16} color={outcomeColor(g.outcome)} />
          <Text style={styles.guestName} numberOfLines={1}>
            {householdName(g.contact_did)}
            {g.required ? '' : ' (optional)'}
          </Text>
          <Text style={[styles.guestOutcome, { color: outcomeColor(g.outcome) }]}>{outcomeText(g)}</Text>
        </View>
      ))}

      {settled && plan.chosen !== null ? (
        <Text testID={`group-plan-settled-${planId}`} style={styles.settled}>
          Settled: {slotText(plan.chosen)}
        </Text>
      ) : null}
      {stopped ? <Text style={styles.subtitle}>You stopped this plan.</Text> : null}
      {outcomeLine !== null ? (
        <Text testID={`group-plan-outcome-${planId}`} style={styles.foldLabel}>
          {outcomeLine}
        </Text>
      ) : null}

      {!closed && plan.state !== 'confirming' && agreed.length > 0 ? (
        <View style={styles.foldBlock}>
          <Text style={styles.foldLabel}>{canChoose ? 'Works for everyone required:' : 'Works so far:'}</Text>
          {agreed.map((slot) => (
            <TouchableOpacity
              key={slot.start}
              testID={`group-plan-choose-${planId}-${slot.start}`}
              style={[styles.actionButton, styles.primaryButton, !canChoose || busy ? styles.disabled : null]}
              disabled={!canChoose || busy || client === null}
              onPress={() => {
                // Guarded in the handler too: a slot that is not a choice must
                // not act, whatever fires the press.
                if (canChoose && !busy && client !== null) void decide(() => client.choose(planId, slot));
              }}
              accessibilityRole="button"
              accessibilityLabel={canChoose ? `Choose ${slotText(slot)}` : slotText(slot)}
            >
              <Text style={styles.primaryButtonText}>{canChoose ? `Choose ${slotText(slot)}` : slotText(slot)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {showMoves && client !== null ? (
        <View style={styles.decisions}>
          {droppable.map((did) => (
            <TouchableOpacity
              key={did}
              testID={`group-plan-optional-${planId}-${did}`}
              style={[styles.actionButton, busy ? styles.disabled : null]}
              disabled={busy}
              onPress={() => void decide(() => client.makeOptional(planId, did))}
              accessibilityRole="button"
            >
              <Text style={styles.actionText}>Go ahead without {householdName(did)}</Text>
            </TouchableOpacity>
          ))}
          <View style={styles.widenRow}>
            <TextInput
              testID={`group-plan-widen-input-${planId}`}
              style={styles.widenInput}
              value={wider}
              onChangeText={setWider}
              placeholder="Other dates, comma-separated"
              placeholderTextColor={colors.textMuted}
              editable={!busy}
            />
            <TouchableOpacity
              testID={`group-plan-widen-${planId}`}
              style={[styles.actionButton, !canWiden ? styles.disabled : null]}
              disabled={!canWiden}
              onPress={() => {
                const candidates = parseCandidates(wider);
                void decide(() => client.widen(planId, candidates)).then((taken) => {
                  if (taken && alive.current) setWider('');
                });
              }}
              accessibilityRole="button"
            >
              <Text style={styles.actionText}>Ask again</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {!stopped && client !== null ? (
        <TouchableOpacity
          testID={`group-plan-stop-${planId}`}
          style={[styles.stopButton, busy ? styles.disabled : null]}
          disabled={busy}
          onPress={() => void decide(() => client.abandon(planId))}
          accessibilityRole="button"
        >
          <Text style={styles.stopText}>{settled ? 'Cancel this plan' : 'Stop this plan'}</Text>
        </TouchableOpacity>
      ) : null}

      {error !== null ? (
        <Text testID={`group-plan-error-${planId}`} style={styles.error}>
          {error}
        </Text>
      ) : null}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

function eyebrowFor(plan: GroupPlanWire): string {
  switch (plan.state) {
    case 'proposing':
      return `ROUND ${plan.round} · ASKING`;
    case 'folded':
      return `ROUND ${plan.round} · YOUR CALL`;
    case 'confirming':
      return `ROUND ${plan.round} · CONFIRMING`;
    case 'settled':
      return 'SETTLED';
    default:
      return 'STOPPED';
  }
}

function outcomeIcon(outcome: GroupPlanWire['guests'][number]['outcome']): keyof typeof Ionicons.glyphMap {
  if (outcome === 'answered') return 'checkmark-circle-outline';
  if (outcome === 'unreachable') return 'remove-circle-outline';
  return 'time-outline';
}

function outcomeColor(outcome: GroupPlanWire['guests'][number]['outcome']): string {
  if (outcome === 'answered') return colors.success;
  if (outcome === 'unreachable') return colors.textMuted;
  return colors.warning;
}

function outcomeText(g: GroupPlanWire['guests'][number]): string {
  if (g.outcome === 'unreachable') return "Couldn't reach";
  if (g.outcome === 'waiting') return 'Waiting';
  if (g.reply?.status === 'accepted') {
    const n = g.reply.accepted_slots?.length ?? 0;
    return n === 0 ? 'None work' : n === 1 ? '1 slot works' : `${n} slots work`;
  }
  if (g.reply?.status === 'counter') return 'Suggested other dates';
  return 'Asked a question';
}

function refusalText(key: string): string {
  switch (key) {
    case 'rounds_exhausted':
      return 'That was the last round Dina can ask. Talk to them directly from here.';
    case 'slot_not_agreed':
      return 'That slot is not one everyone agreed on.';
    case 'required_unanswered':
      return 'A required household never answered. Go ahead without them, or ask again.';
    case 'wrong_state':
      return 'The plan moved on. Wait a moment.';
    case 'no_required_guest':
      return 'At least one household has to be required.';
    default:
      return "Couldn't do that. Try again.";
  }
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
  cardMuted: { opacity: 0.8 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xs },
  eyebrow: { ...textStyles.eyebrow, color: colors.textMuted },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.sm },
  subtitle: { fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs },
  guestRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  guestName: { flex: 1, fontSize: 14, color: colors.textPrimary },
  guestOutcome: { fontSize: 12 },
  settled: { fontSize: 14, fontWeight: '600', color: colors.success, marginTop: spacing.sm },
  foldBlock: { marginTop: spacing.sm, gap: spacing.xs },
  foldLabel: { fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs },
  decisions: { marginTop: spacing.sm, gap: spacing.xs },
  widenRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  widenInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.textPrimary,
  },
  actionButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    alignSelf: 'flex-start',
  },
  actionText: { fontSize: 13, color: colors.textPrimary },
  primaryButton: { backgroundColor: colors.accent, borderColor: colors.accent },
  primaryButtonText: { fontSize: 13, color: colors.bgPrimary, fontWeight: '600' },
  stopButton: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  stopText: { fontSize: 12, color: colors.textMuted },
  disabled: { opacity: 0.5 },
  error: { fontSize: 12, color: colors.error, marginTop: spacing.xs },
});
