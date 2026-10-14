/**
 * One slot agreement (docs/SHELF_SPACE_NEGOTIATION.md §5.5–5.6).
 *
 * The terms both owners approved, what each period owes, and the three acts
 * that follow a deal:
 *
 *   - the party holding the takings SETTLES a period: the owner types the
 *     sales, Core derives the share and the rent for that period;
 *   - the other party ACCEPTS or DISPUTES the figures — which never marks
 *     anything paid; money moves outside Dina;
 *   - either party ENDS the deal, at once during the trial and with the
 *     agreed notice after it. Ending needs a person present.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  currencyExponent,
  formatMoney,
  type TermAgreementDetail,
  type TermAgreementSummary,
} from '@dina/core';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { isPresenceRefusal, ownerErrorText } from '../src/services/owner_errors';
import { toMinorUnits } from '../src/services/quote_request_form';
import { categoryLabel, termsText } from '../src/services/shelf_space';
import { colors, radius, spacing, textStyles } from '../src/theme';

/** Who owes whom, in the owner's words, from this side's point of view. */
export function statementText(
  statement: TermAgreementDetail['statement'],
  summary: Pick<TermAgreementSummary, 'role' | 'general'>,
): string {
  if (!statement.ok) return 'Nothing settled yet.';
  if (statement.direction === 'even') return 'All settled periods are square.';
  const amount = formatMoney({
    currency: summary.general.currency,
    minor_units: statement.owed_minor,
  });
  const youOwe = (statement.direction === 'vendor_owes_host') === (summary.role === 'vendor');
  return youOwe
    ? `You owe ${amount} for the periods accepted so far.`
    : `You are owed ${amount} for the periods accepted so far.`;
}

export default function ShelfAgreementScreen(): React.ReactElement {
  const { digest } = useLocalSearchParams<{ digest?: string }>();
  const [summary, setSummary] = useState<TermAgreementSummary | null>(null);
  const [detail, setDetail] = useState<TermAgreementDetail | null>(null);
  const [gross, setGross] = useState<Record<string, string>>({});
  const [endOn, setEndOn] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null || typeof digest !== 'string') return;
    try {
      const [all, one] = await Promise.all([client.termAgreements(), client.termAgreement(digest)]);
      setSummary(all.agreements.find((a) => a.proposalDigest === digest) ?? null);
      setDetail(one);
    } catch (err) {
      setProblem(ownerErrorText(err));
    }
  }, [digest]);

  useEffect(() => {
    void load();
  }, [load]);

  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => setProblem(ownerErrorText(err)),
    reason: 'Ending an agreement cannot be undone, so Dina checks a person is here.',
  });

  const act = useCallback(
    async (body: () => Promise<unknown>, done: string) => {
      setProblem(null);
      setNotice(null);
      try {
        await body();
        setNotice(done);
        await load();
      } catch (err) {
        setProblem(ownerErrorText(err));
      }
    },
    [load],
  );

  if (summary === null || detail === null || typeof digest !== 'string') {
    return (
      <View style={[styles.container, styles.centered]} testID="shelf-agreement-loading">
        <Stack.Screen options={{ title: 'Slot agreement' }} />
        {problem !== null ? <Text style={styles.error}>{problem}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  const client = getOwnerCommerceClient();
  const holdsTakings = (summary.general.cash_handler === 'host') === (summary.role === 'host');
  const currency = summary.general.currency;

  return (
    <View style={styles.container} testID="shelf-agreement-screen">
      <Stack.Screen options={{ title: 'Slot agreement' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>
          {summary.role === 'host' ? 'You rent out' : 'You rent'} {summary.resourceRef} ·{' '}
          {categoryLabel(summary.general.tag)}
        </Text>
        <Text style={styles.sub}>{termsText(summary.terms, summary.general)}</Text>
        <Text style={styles.sub}>
          {summary.general.start.slice(0, 10)} to{' '}
          {(summary.endsAt ?? summary.general.end).slice(0, 10)} · notice{' '}
          {String(summary.general.exit_notice_days)} days
        </Text>
        <Text style={styles.sub}>
          {holdsTakings
            ? 'You keep the takings and settle each period.'
            : 'The other side keeps the takings and settles each period.'}
        </Text>
        <Text style={styles.statement} testID="shelf-agreement-statement">
          {statementText(detail.statement, summary)}
        </Text>
        <Text style={styles.small}>
          Accepting a period's figures does not mark it paid. Money moves outside Dina.
        </Text>

        <Text style={styles.heading}>Periods</Text>
        {detail.schedule.map((slot) => {
          const key = slot.start;
          const unanswered =
            slot.settlementDigest !== null && detail.unanswered.includes(slot.settlementDigest);
          return (
            <View key={key} style={styles.card} testID={`period-${key.slice(0, 10)}`}>
              <Text style={styles.cardTitle}>
                {slot.start.slice(0, 10)} to {slot.end.slice(0, 10)}
                {slot.kind === 'trial' ? ' · trial' : ''}
              </Text>
              <Text style={styles.cardLine}>
                Rent due {formatMoney({ currency, minor_units: slot.feeDueMinor })}
              </Text>
              {holdsTakings && (slot.settlementDigest === null || slot.answer === 'disputed') && (
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.flex]}
                    value={gross[key] ?? ''}
                    onChangeText={(v) => setGross({ ...gross, [key]: v })}
                    placeholder={
                      slot.answer === 'disputed' ? 'Corrected sales this period' : 'Sales this period'
                    }
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    testID={`period-${key.slice(0, 10)}-gross`}
                  />
                  <Pressable
                    style={styles.buttonSmall}
                    accessibilityRole="button"
                    testID={`period-${key.slice(0, 10)}-settle`}
                    onPress={() => {
                      // A signed note: an untouched field must not claim zero sales.
                      const typed = (gross[key] ?? '').trim();
                      if (typed === '') {
                        setProblem('Type the sales for this period (0 if there were none).');
                        return;
                      }
                      const minor = toMinorUnits(typed, currencyExponent(currency));
                      if (minor === null || client === null) {
                        setProblem('Sales is an amount, like 25000.');
                        return;
                      }
                      // A disputed note is replaced by a correction (§5.6), never edited.
                      const replaces =
                        slot.answer === 'disputed' && slot.settlementDigest !== null
                          ? { replaces_settlement_digest: slot.settlementDigest }
                          : {};
                      void act(
                        () =>
                          client.issueTermSettlement(digest, {
                            period_start: slot.start,
                            period_end: slot.end,
                            gross_minor: minor,
                            ...replaces,
                          }),
                        'Sent. The other side accepts or disputes the figures.',
                      );
                    }}
                  >
                    <Text style={styles.buttonText}>
                      {slot.answer === 'disputed' ? 'Send corrected figures' : 'Settle'}
                    </Text>
                  </Pressable>
                </View>
              )}
              {slot.answer === 'accepted' && <Text style={styles.cardLine}>Accepted</Text>}
              {slot.answer === 'disputed' && (
                <Text style={styles.cardLine} testID={`period-${key.slice(0, 10)}-disputed`}>
                  {holdsTakings
                    ? 'The other side disputed these figures.'
                    : 'You disputed these figures; waiting for a correction.'}
                </Text>
              )}
              {unanswered && !holdsTakings && client !== null && (
                <View style={styles.row}>
                  <Pressable
                    style={styles.buttonSmall}
                    accessibilityRole="button"
                    testID={`period-${key.slice(0, 10)}-accept`}
                    onPress={() =>
                      void act(
                        () =>
                          client.acknowledgeTermSettlement(
                            slot.settlementDigest as string,
                            'accepted',
                          ),
                        'Accepted.',
                      )
                    }
                  >
                    <Text style={styles.buttonText}>Accept</Text>
                  </Pressable>
                  <Pressable
                    style={styles.buttonSmall}
                    accessibilityRole="button"
                    testID={`period-${key.slice(0, 10)}-dispute`}
                    onPress={() =>
                      void act(
                        () =>
                          client.acknowledgeTermSettlement(
                            slot.settlementDigest as string,
                            'disputed',
                          ),
                        'Disputed.',
                      )
                    }
                  >
                    <Text style={styles.buttonText}>Dispute</Text>
                  </Pressable>
                </View>
              )}
              {unanswered && holdsTakings && (
                <Text style={styles.cardLine}>Waiting for the other side</Text>
              )}
            </View>
          );
        })}

        {detail.status === 'accepted' &&
          summary.endsAt !== null &&
          Date.parse(summary.endsAt) > Date.now() && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>End this agreement</Text>
              <TextInput
                style={styles.input}
                value={endOn}
                onChangeText={setEndOn}
                placeholder="End on (YYYY-MM-DD), or leave empty for now"
                placeholderTextColor={colors.textMuted}
                testID="shelf-agreement-end-on"
              />
              <Pressable
                style={styles.buttonDanger}
                accessibilityRole="button"
                testID="shelf-agreement-end"
                onPress={() => {
                  const effective = endOn.trim() === '' ? undefined : `${endOn.trim()}T00:00:00Z`;
                  void runGated(async () => {
                    const c = getOwnerCommerceClient();
                    if (c === null) return;
                    try {
                      await c.terminateTermAgreement(digest, effective);
                      setNotice('Ended. The other side is told.');
                      await load();
                    } catch (err) {
                      if (isPresenceRefusal(err)) throw err;
                      setProblem(ownerErrorText(err));
                    }
                  });
                }}
              >
                <Text style={styles.buttonText}>End agreement</Text>
              </Pressable>
            </View>
          )}
        {problem !== null && (
          <Text style={styles.error} testID="shelf-agreement-problem">
            {problem}
          </Text>
        )}
        {notice !== null && <Text style={styles.notice}>{notice}</Text>}
      </ScrollView>
      <PresenceSheet {...presenceSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  heading: {
    ...textStyles.body,
    color: colors.textPrimary,
    fontWeight: '600',
    marginTop: spacing.sm,
  },
  sub: { ...textStyles.body, color: colors.textSecondary },
  statement: { ...textStyles.body, color: colors.textPrimary, fontWeight: '600' },
  small: { ...textStyles.caption, color: colors.textSecondary },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  cardTitle: { ...textStyles.body, color: colors.textPrimary, fontWeight: '600' },
  cardLine: { ...textStyles.caption, color: colors.textSecondary },
  input: {
    ...textStyles.body,
    color: colors.textPrimary,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  buttonSmall: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  buttonDanger: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.error,
  },
  buttonText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  error: { ...textStyles.body, color: colors.error },
  notice: { ...textStyles.body, color: colors.textSecondary },
});
