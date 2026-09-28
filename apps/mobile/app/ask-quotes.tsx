/**
 * Ask for quotes (ASK_FOR_QUOTES_PLAN §2): describe what you want, pick who
 * to ask, say where to deliver and, if you like, how far to negotiate; then
 * Dina sends one request per supplier and opens the Tender screen.
 *
 * Owner-only, on the phone (in-process) and in a browser connected as the
 * owner. No passphrase: asking for quotes spends nothing; awarding asks.
 * A chat card can open this screen prefilled (`draft` param); nothing is sent
 * until the owner taps Send here.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { DEFAULT_TENDER_FANOUT } from '@dina/core';

import { SupplierPicker, type PickedSupplier } from '../src/components/SupplierPicker';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { ownerErrorText } from '../src/services/owner_errors';
import { parseQuoteRequestDraftParam } from '../src/services/quote_request_draft';
import {
  DEADLINE_CHOICES,
  EMPTY_LIMITS,
  LINE_UNITS,
  MAX_LINE_TEXT,
  buildTenderRequest,
  emptyLine,
  type LimitsDraft,
  type LineDraft,
} from '../src/services/quote_request_form';
import { showMessage } from '../src/services/show_message';
import { colors, radius, spacing, textStyles } from '../src/theme';

function shortDid(did: string): string {
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}

export default function AskQuotesScreen(): React.ReactElement {
  const router = useRouter();
  const params = useLocalSearchParams<{ draft?: string }>();
  const prefill = useMemo(() => parseQuoteRequestDraftParam(params.draft), [params.draft]);

  const [lines, setLines] = useState<LineDraft[]>(
    prefill !== null && prefill.lines.length > 0 ? prefill.lines : [emptyLine()],
  );
  const [picked, setPicked] = useState<PickedSupplier[]>([]);
  const [postal, setPostal] = useState('');
  const [savedRegions, setSavedRegions] = useState<string[]>([]);
  const [currency, setCurrency] = useState('INR');
  const [preferred, setPreferred] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [limits, setLimits] = useState<LimitsDraft>(prefill?.limits ?? EMPTY_LIMITS);
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // The buyer's saved delivery areas, currency and supplier lists.
  useEffect(() => {
    const client = getOwnerCommerceClient();
    if (client === null) return;
    let live = true;
    client
      .buyerSettings()
      .then((answer) => {
        if (!live || !answer.configured) return;
        const postals = answer.settings.locations
          .filter((r) => r.scheme === 'postal_area')
          .map((r) => r.value);
        setSavedRegions(postals);
        if (postals[0] !== undefined)
          setPostal((current) => (current === '' ? (postals[0] ?? '') : current));
        if (/^[A-Z]{3}$/.test(answer.settings.currency)) setCurrency(answer.settings.currency);
        setPreferred(answer.settings.preferredSuppliers);
        setBlocked(answer.settings.blockedSuppliers);
      })
      .catch((err: unknown) => {
        if (live) setSettingsError(ownerErrorText(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const setLine = (i: number, patch: Partial<LineDraft>): void =>
    setLines((all) => all.map((line, j) => (j === i ? { ...line, ...patch } : line)));

  const send = useCallback(async () => {
    const outcome = buildTenderRequest({
      lines,
      suppliers: picked.map((p) => ({ supplierDid: p.supplierDid, serviceRkey: p.serviceRkey })),
      region: postal.trim() === '' ? null : { scheme: 'postal_area', value: postal.trim() },
      currency,
      limits,
    });
    if (!outcome.ok) {
      setProblems(outcome.problems);
      return;
    }
    setProblems([]);
    const client = getOwnerCommerceClient();
    if (client === null) {
      setProblems(['Dina is still starting up. Try again in a moment.']);
      return;
    }
    setSending(true);
    try {
      const answer = await client.createTender(outcome.request);
      const missed = answer.members.filter((m) => !m.sent);
      const open = (): void =>
        router.replace({ pathname: '/tender', params: { tender_id: answer.tenderId } });
      if (missed.length > 0) {
        const names = missed.map((m) => {
          const who = picked.find((p) => p.supplierDid === m.supplierDid);
          return who?.name ?? shortDid(m.supplierDid);
        });
        showMessage(
          'Not every request went out',
          `Dina could not reach ${names.join(', ')}. The others were asked.`,
          open,
        );
      } else {
        open();
      }
    } catch (err) {
      setProblems([ownerErrorText(err)]);
    } finally {
      setSending(false);
    }
  }, [currency, limits, lines, picked, postal, router]);

  const firstText = lines[0]?.text ?? '';
  const initialQuery = prefill?.supplierQuery ?? firstText;

  return (
    <View style={styles.container} testID="ask-quotes-screen">
      <Stack.Screen options={{ title: 'Ask for quotes' }} />
      {/* The supplier search and limits sit low on the form; keep the field
          being typed into above the keyboard. */}
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <Text style={styles.sectionTitle}>What you want</Text>
        {lines.map((line, i) => (
          <View key={i} style={styles.card} testID={`ask-line-${String(i)}`}>
            <TextInput
              testID={`ask-line-text-${String(i)}`}
              style={styles.input}
              value={line.text}
              onChangeText={(text) => setLine(i, { text })}
              placeholder="e.g. Floral celebration cake, 20 servings"
              placeholderTextColor={colors.textMuted}
              maxLength={MAX_LINE_TEXT}
              multiline
            />
            <View style={styles.quantityRow}>
              <TextInput
                testID={`ask-line-quantity-${String(i)}`}
                style={[styles.input, styles.quantity]}
                value={line.quantity}
                onChangeText={(quantity) => setLine(i, { quantity })}
                keyboardType="decimal-pad"
              />
              <View style={styles.units}>
                {LINE_UNITS.map((unit) => (
                  <Pressable
                    key={unit.code}
                    testID={`ask-line-unit-${String(i)}-${unit.code}`}
                    style={[styles.unit, line.unitCode === unit.code && styles.unitOn]}
                    onPress={() => setLine(i, { unitCode: unit.code })}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: line.unitCode === unit.code }}
                  >
                    <Text
                      style={[styles.unitText, line.unitCode === unit.code && styles.unitTextOn]}
                    >
                      {unit.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {lines.length > 1 && (
              <Pressable
                testID={`ask-line-remove-${String(i)}`}
                onPress={() => setLines((all) => all.filter((_, j) => j !== i))}
                accessibilityRole="button"
              >
                <Text style={styles.link}>Remove</Text>
              </Pressable>
            )}
          </View>
        ))}
        <Pressable
          testID="ask-line-add"
          onPress={() => setLines((all) => [...all, emptyLine()])}
          accessibilityRole="button"
        >
          <Text style={styles.link}>+ Add another item</Text>
        </Pressable>

        <Text style={styles.sectionTitle}>Deliver to</Text>
        {savedRegions.length > 1 && (
          <View style={styles.units}>
            {savedRegions.map((code) => (
              <Pressable
                key={code}
                testID={`ask-region-${code}`}
                style={[styles.unit, postal === code && styles.unitOn]}
                onPress={() => setPostal(code)}
              >
                <Text style={[styles.unitText, postal === code && styles.unitTextOn]}>{code}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <TextInput
          testID="ask-postal"
          style={styles.input}
          value={postal}
          onChangeText={setPostal}
          placeholder="Postal code"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
        />
        {settingsError !== null && <Text style={styles.meta}>{settingsError}</Text>}

        <Text style={styles.sectionTitle}>
          Who to ask ({String(picked.length)} of up to {String(DEFAULT_TENDER_FANOUT)})
        </Text>
        <SupplierPicker
          initialQuery={initialQuery}
          {...(postal.trim() !== '' ? { region: `postal_area:${postal.trim()}` } : {})}
          preferredSuppliers={preferred}
          blockedSuppliers={blocked}
          picked={picked}
          onChange={setPicked}
          max={DEFAULT_TENDER_FANOUT}
        />

        <Text style={styles.sectionTitle}>Negotiate (optional)</Text>
        <Text style={styles.meta}>
          Dina counters toward your target and never accepts above your ceiling, in {currency}.
        </Text>
        <View style={styles.quantityRow}>
          <TextInput
            testID="ask-target"
            style={[styles.input, styles.half]}
            value={limits.target}
            onChangeText={(target) => setLimits((l) => ({ ...l, target }))}
            placeholder="Target"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
          />
          <TextInput
            testID="ask-ceiling"
            style={[styles.input, styles.half]}
            value={limits.ceiling}
            onChangeText={(ceiling) => setLimits((l) => ({ ...l, ceiling }))}
            placeholder="Ceiling"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
          />
        </View>
        <TextInput
          testID="ask-rounds"
          style={styles.input}
          value={limits.maxRounds}
          onChangeText={(maxRounds) => setLimits((l) => ({ ...l, maxRounds }))}
          placeholder="Rounds of counter-offers (1–10)"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
        />
        <Text style={styles.meta}>Each round waits for suppliers up to</Text>
        <View style={styles.units}>
          {DEADLINE_CHOICES.map((choice) => {
            const on = limits.deadlineSeconds === choice.seconds;
            return (
              <Pressable
                key={choice.seconds}
                testID={`ask-deadline-${String(choice.seconds)}`}
                style={[styles.unit, on && styles.unitOn]}
                onPress={() =>
                  setLimits((l) => ({ ...l, deadlineSeconds: on ? null : choice.seconds }))
                }
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.unitText, on && styles.unitTextOn]}>{choice.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {problems.length > 0 && (
          <View style={styles.problems} testID="ask-problems">
            {problems.map((p) => (
              <Text key={p} style={styles.problem}>
                {p}
              </Text>
            ))}
          </View>
        )}
        <Pressable
          testID="ask-send"
          style={[styles.send, sending && styles.disabled]}
          disabled={sending}
          onPress={() => void send()}
          accessibilityRole="button"
        >
          {sending ? (
            <ActivityIndicator color={colors.bgPrimary} />
          ) : (
            <Text style={styles.sendLabel}>Send requests</Text>
          )}
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  input: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    color: colors.textPrimary,
    ...textStyles.body,
    marginBottom: spacing.sm,
  },
  quantityRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  quantity: { width: 72 },
  half: { flex: 1 },
  units: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  unit: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  unitOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  unitText: { ...textStyles.caption, color: colors.textPrimary },
  unitTextOn: { color: colors.bgPrimary },
  link: { ...textStyles.body, color: colors.accent, marginVertical: spacing.xs },
  meta: { ...textStyles.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  problems: { marginTop: spacing.lg, gap: spacing.xs },
  problem: { ...textStyles.body, color: colors.error },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  sendLabel: { ...textStyles.button, color: colors.bgPrimary },
  disabled: { opacity: 0.5 },
});
