/**
 * How an offer's price moved, round by round (NEGOTIATION_PLAN §4.5) — the
 * Tender screen's collapsible bargaining card.
 *
 * Folded, it is one line: "Bargaining · 2 rounds · 245.00 → 175.00 · saved
 * USD 70.00". Opened, one row per step, divided by hairlines: where the
 * supplier opened, then each round's ask and the supplier's answer. The same
 * expand pattern as the service card's handoff path, so the screen stays
 * quiet until the owner asks how the price was reached.
 *
 * Built only from the tender story (the signed revisions and the counters
 * this node sent); a revised answer is the next signed revision.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { formatMoneyAmount } from '@dina/core';

import { colors, spacing, textStyles } from '../theme';

import type { TenderStorySupplierView } from '@dina/core';

interface Money {
  currency: string;
  minor_units: string;
}

export type BargainingStep =
  | { kind: 'opened'; price: Money }
  | {
      kind: 'round';
      round: number;
      asked: Money | null;
      answer: 'lowered' | 'kept' | 'refused' | 'owner' | 'waiting';
      /** The supplier's new price when it came down. */
      price: Money | null;
      /**
       * How many times Dina asked in this round. More than one only while the
       * supplier's owner decides: the loop asks again with a growing wait, and
       * those asks are one round, as the loop itself counts them.
       */
      asks: number;
    };

export function moneyText(m: Money): string {
  if (!/^\d+$/.test(m.minor_units)) return `${m.currency} ${m.minor_units}`;
  try {
    return `${m.currency} ${formatMoneyAmount(m)}`;
  } catch {
    const padded = m.minor_units.padStart(3, '0');
    return `${m.currency} ${padded.slice(0, -2)}.${padded.slice(-2)}`;
  }
}

/**
 * The story as steps: the opening quote, then one step per round.
 *
 * Counted the way the negotiation loop counts (buyer_negotiation.ts): an ask
 * the supplier answered "my owner is deciding" (`pending`) is not a round of
 * its own, so a run of them at the same price reads as ONE round, "is asking
 * its owner", with how many times Dina asked. A counter that never left
 * (`unsent`) reached nobody and is not shown.
 */
export function bargainingSteps(story: TenderStorySupplierView | undefined): BargainingStep[] {
  const first = story?.revisions[0];
  if (story === undefined || first === undefined) return [];
  const steps: BargainingStep[] = [{ kind: 'opened', price: first.total }];
  let next = 1;
  let round = 0;
  for (const counter of story.counters) {
    if (counter.state === 'unsent') continue;
    const previous = steps.at(-1);
    if (
      counter.state === 'pending' &&
      previous?.kind === 'round' &&
      previous.answer === 'owner' &&
      sameMoney(previous.asked, counter.target_total)
    ) {
      previous.asks += 1;
      continue;
    }
    round += 1;
    const revision = story.revisions[next];
    if (counter.state === 'revised' && revision !== undefined) {
      next++;
      steps.push({
        kind: 'round',
        round,
        asked: counter.target_total,
        answer: 'lowered',
        price: revision.total,
        asks: 1,
      });
      continue;
    }
    steps.push({
      kind: 'round',
      round,
      asked: counter.target_total,
      answer:
        counter.state === 'held'
          ? 'kept'
          : counter.state === 'refused'
            ? 'refused'
            : counter.state === 'pending'
              ? 'owner'
              : 'waiting',
      price: null,
      asks: 1,
    });
  }
  return steps;
}

function sameMoney(a: Money | null, b: Money | null): boolean {
  return a?.currency === b?.currency && a?.minor_units === b?.minor_units;
}

/**
 * The folded line: rounds, where it opened, where it stands, what was saved.
 * Null when there is nothing to tell (no quote yet).
 */
export function bargainingSummary(story: TenderStorySupplierView | undefined): string | null {
  const first = story?.revisions[0];
  const last = story?.revisions.at(-1);
  if (story === undefined || first === undefined || last === undefined) return null;
  const rounds = bargainingSteps(story).filter((step) => step.kind === 'round').length;
  if (rounds === 0) return `Opened at ${moneyText(first.total)} · no bargaining yet`;
  const label = `Bargaining · ${String(rounds)} round${rounds === 1 ? '' : 's'}`;
  if (first.total.minor_units === last.total.minor_units) {
    return `${label} · held at ${moneyText(last.total)}`;
  }
  const opened = BigInt(first.total.minor_units);
  const now = BigInt(last.total.minor_units);
  const saved =
    now < opened && first.total.currency === last.total.currency
      ? ` · saved ${moneyText({ currency: last.total.currency, minor_units: String(opened - now) })}`
      : '';
  return `${label} · ${moneyText(first.total)} → ${moneyText(last.total)}${saved}`;
}

const ANSWER_TEXT: Record<'lowered' | 'kept' | 'refused' | 'owner' | 'waiting', string> = {
  lowered: 'came down to',
  owner: 'is asking its owner',
  kept: 'kept its price',
  refused: 'would not bargain',
  waiting: 'no answer yet',
};

export function BargainingTimeline({
  story,
  supplierLabel,
  testID,
}: {
  story: TenderStorySupplierView | undefined;
  supplierLabel: string;
  testID: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const summary = bargainingSummary(story);
  if (summary === null) return null;
  const steps = bargainingSteps(story);
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.toggle}
        onPress={() => setOpen((o) => !o)}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide how the price moved' : 'Show how the price moved'}
        accessibilityState={{ expanded: open }}
        testID={`${testID}-toggle`}
      >
        <Ionicons name="trending-down-outline" size={13} color={colors.textMuted} />
        <Text style={styles.summary} numberOfLines={2} testID={`${testID}-summary`}>
          {summary}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={colors.textMuted} />
      </TouchableOpacity>
      {open && (
        <View style={styles.list} testID={`${testID}-steps`}>
          {steps.map((step, i) => (
            <View key={i} style={[styles.row, i > 0 && styles.divided]}>
              {step.kind === 'opened' ? (
                <>
                  <Text style={styles.label}>Opening quote</Text>
                  <Text style={styles.amount}>{moneyText(step.price)}</Text>
                </>
              ) : (
                <>
                  <View style={styles.rowText}>
                    <Text style={styles.label}>
                      {`Round ${String(step.round)} · Dina asked ${
                        step.asked !== null ? moneyText(step.asked) : 'for less'
                      }`}
                    </Text>
                    <Text style={styles.answer}>
                      {`${supplierLabel} ${ANSWER_TEXT[step.answer]}${
                        step.asks > 1 ? ` · Dina asked ${String(step.asks)} times` : ''
                      }`}
                    </Text>
                  </View>
                  {step.price !== null && (
                    <Text style={styles.amount}>{moneyText(step.price)}</Text>
                  )}
                </>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.xs },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  summary: { ...textStyles.caption, color: colors.textSecondary, flex: 1 },
  list: {
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  rowText: { flex: 1, paddingRight: spacing.sm },
  label: { ...textStyles.caption, color: colors.textPrimary },
  answer: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  amount: { ...textStyles.caption, color: colors.textPrimary, fontWeight: '600' },
});
