/**
 * Terms and rules — the store's private side of shelf space
 * (docs/SHELF_SPACE_NEGOTIATION.md §5.4).
 *
 * What a slot rents for, the lowest the owner will take, how far Dina may go
 * alone, and the category rules ("each juice brand already here adds 15%, at
 * most four"). All of it lives in this phone's Dina and nowhere else: no
 * listing, directory or brand ever sees a number from this screen — a brand
 * sees only the offers Dina makes it.
 *
 * Saving moves floors, so Core asks a person to be present first.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { isPresenceRefusal, ownerErrorText } from '../src/services/owner_errors';
import {
  emptyHolding,
  emptySlot,
  formToPolicy,
  policyToForm,
  SHELF_CATEGORIES,
  type HoldingForm,
  type SlotForm,
  type TermsForm,
} from '../src/services/shelf_space';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { TermPolicy } from '@dina/core';

/** The suggested rule the form offers (the Slot Pack has no config schema): 15% more per brand, at most four. */
const SUGGESTED_RULE = { premiumPercent: '15', maxBrands: '4' };

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testID: string;
  placeholder?: string;
  numeric?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        style={styles.input}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={props.numeric === true ? 'decimal-pad' : 'default'}
        testID={props.testID}
        accessibilityLabel={props.label}
      />
    </View>
  );
}

export default function ShelfTermsScreen(): React.ReactElement {
  const router = useRouter();
  const [base, setBase] = useState<TermPolicy | null>(null);
  const [form, setForm] = useState<TermsForm | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const client = getOwnerCommerceClient();
    if (client === null) return;
    let live = true;
    client
      .termPolicy()
      .then(({ policy }) => {
        if (!live) return;
        setBase(policy);
        const read = policyToForm(policy);
        setForm(read.slots.length === 0 ? { ...read, slots: [emptySlot()] } : read);
      })
      .catch((err: unknown) => live && setProblem(ownerErrorText(err)));
    return () => {
      live = false;
    };
  }, []);

  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => setProblem(ownerErrorText(err)),
    reason: 'These are your lowest terms, so Dina checks a person is here before changing them.',
  });

  const setSlot = (i: number, patch: Partial<SlotForm>): void => {
    setForm((f) =>
      f === null ? f : { ...f, slots: f.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) },
    );
  };

  const setHolding = (i: number, patch: Partial<HoldingForm>): void => {
    setForm((f) =>
      f === null
        ? f
        : { ...f, holdings: f.holdings.map((h, j) => (j === i ? { ...h, ...patch } : h)) },
    );
  };

  const toggleRule = (tag: string): void => {
    setForm((f) => {
      if (f === null) return f;
      const has = f.rules.some((r) => r.tag === tag);
      return {
        ...f,
        rules: has
          ? f.rules.filter((r) => r.tag !== tag)
          : [...f.rules, { tag, ...SUGGESTED_RULE }],
      };
    });
  };

  const save = useCallback(() => {
    if (form === null || base === null) return;
    setNotice(null);
    const built = formToPolicy(form, base);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setProblem(null);
    void runGated(async () => {
      const client = getOwnerCommerceClient();
      if (client === null) return;
      try {
        const saved = await client.saveTermPolicy(built.policy);
        setBase(built.policy);
        const stuck = saved.withdrawn.filter((w) => !w.record_removed).map((w) => w.listing_id);
        setNotice(
          [
            'Saved. Dina bargains inside these from now on.',
            saved.withdrawn.length > 0
              ? `Listings these terms no longer cover were withdrawn: ${saved.withdrawn.map((w) => w.listing_id).join(', ')}.`
              : '',
            stuck.length > 0
              ? `The public record of ${stuck.join(', ')} could not be removed yet; Shelf space offers to try again.`
              : '',
          ]
            .filter((line) => line !== '')
            .join(' '),
        );
      } catch (err) {
        if (isPresenceRefusal(err)) throw err;
        setProblem(ownerErrorText(err));
      }
    });
  }, [base, form, runGated]);

  if (form === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="shelf-terms-loading">
        <Stack.Screen options={{ title: 'Terms and rules' }} />
        {problem !== null ? <Text style={styles.error}>{problem}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  return (
    <View style={styles.container} testID="shelf-terms-screen">
      <Stack.Screen options={{ title: 'Terms and rules' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sub}>
          Only your Dina knows these. Brands see the offers Dina makes them; nobody sees your lowest
          terms.
        </Text>
        <View style={styles.row}>
          <Text style={[styles.label, styles.flex]}>Rent out shelf space</Text>
          <Switch
            value={form.enabled}
            onValueChange={(enabled) => setForm({ ...form, enabled })}
            testID="shelf-terms-enabled"
          />
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, styles.flex]}>
            Brands you do not know need your yes first
          </Text>
          <Switch
            value={form.access === 'contacts_or_card'}
            onValueChange={(on) => setForm({ ...form, access: on ? 'contacts_or_card' : 'anyone' })}
            testID="shelf-terms-contacts-or-card"
          />
        </View>
        <Field
          label="Rounds of bargaining"
          value={form.maxRounds}
          onChange={(maxRounds) => setForm({ ...form, maxRounds })}
          testID="shelf-terms-rounds"
          numeric
        />

        {form.slots.map((slot, i) => (
          <View key={i} style={styles.card} testID={`shelf-terms-slot-${String(i)}`}>
            <Field
              label="Slot name"
              value={slot.resourceRef}
              onChange={(v) => setSlot(i, { resourceRef: v })}
              testID={`slot-${String(i)}-name`}
              placeholder="slot-3"
            />
            <Field
              label="Currency"
              value={slot.currency}
              onChange={(v) => setSlot(i, { currency: v.toUpperCase() })}
              testID={`slot-${String(i)}-currency`}
            />
            <Text style={styles.label}>Rent is charged by the</Text>
            <View style={styles.chips}>
              {(['monthly', 'weekly'] as const).map((period) => (
                <Pressable
                  key={period}
                  style={[styles.chip, slot.period === period && styles.chipOn]}
                  onPress={() => setSlot(i, { period })}
                  testID={`slot-${String(i)}-period-${period}`}
                >
                  <Text style={styles.chipText}>{period === 'monthly' ? 'Month' : 'Week'}</Text>
                </Pressable>
              ))}
            </View>
            <Field
              label={`Rent you ask, a ${slot.period === 'weekly' ? 'week' : 'month'}`}
              value={slot.askingRent}
              onChange={(v) => setSlot(i, { askingRent: v })}
              testID={`slot-${String(i)}-asking-rent`}
              numeric
            />
            <Field
              label="Share of sales you ask, %"
              value={slot.askingSharePercent}
              onChange={(v) => setSlot(i, { askingSharePercent: v })}
              testID={`slot-${String(i)}-asking-share`}
              numeric
            />
            <Field
              label="Lowest rent you take"
              value={slot.floorRent}
              onChange={(v) => setSlot(i, { floorRent: v })}
              testID={`slot-${String(i)}-floor-rent`}
              numeric
            />
            <Field
              label="Lowest rent Dina agrees to alone (below it, Dina asks you)"
              value={slot.autoRent}
              onChange={(v) => setSlot(i, { autoRent: v })}
              testID={`slot-${String(i)}-auto-rent`}
              numeric
              placeholder="Same as the lowest"
            />
            <Field
              label="Lowest share you take, %"
              value={slot.floorSharePercent}
              onChange={(v) => setSlot(i, { floorSharePercent: v })}
              testID={`slot-${String(i)}-floor-share`}
              numeric
            />
            <Field
              label="Free from (YYYY-MM-DD)"
              value={slot.availableFrom}
              onChange={(v) => setSlot(i, { availableFrom: v })}
              testID={`slot-${String(i)}-from`}
            />
            <Field
              label="Free until (YYYY-MM-DD)"
              value={slot.availableTo}
              onChange={(v) => setSlot(i, { availableTo: v })}
              testID={`slot-${String(i)}-to`}
            />
            <View style={styles.row}>
              <Text style={[styles.label, styles.flex]}>The brand keeps its takings</Text>
              <Switch
                value={slot.cashHandler === 'vendor'}
                onValueChange={(on) => setSlot(i, { cashHandler: on ? 'vendor' : 'host' })}
                testID={`slot-${String(i)}-brand-keeps`}
              />
            </View>
            <Field
              label="Trial, days (optional)"
              value={slot.trialDays}
              onChange={(v) => setSlot(i, { trialDays: v })}
              testID={`slot-${String(i)}-trial-days`}
              numeric
            />
            <Field
              label="Trial rent"
              value={slot.trialRent}
              onChange={(v) => setSlot(i, { trialRent: v })}
              testID={`slot-${String(i)}-trial-rent`}
              numeric
            />
            <Field
              label="Notice to end, days"
              value={slot.exitNoticeDays}
              onChange={(v) => setSlot(i, { exitNoticeDays: v })}
              testID={`slot-${String(i)}-notice`}
              numeric
            />
            {form.slots.length > 1 && (
              <Pressable
                onPress={() => setForm({ ...form, slots: form.slots.filter((_, j) => j !== i) })}
                accessibilityRole="button"
                testID={`slot-${String(i)}-remove`}
              >
                <Text style={styles.link}>Remove this slot</Text>
              </Pressable>
            )}
          </View>
        ))}
        <Pressable
          onPress={() =>
            setForm({
              ...form,
              slots: [...form.slots, emptySlot(form.slots[0]?.currency ?? 'INR')],
            })
          }
          accessibilityRole="button"
          testID="shelf-terms-add-slot"
        >
          <Text style={styles.link}>Add a slot</Text>
        </Pressable>

        <Text style={styles.heading}>Category rules</Text>
        <Text style={styles.sub}>
          When brands of one category already share your shelves, a new one pays more, and you can
          cap how many.
        </Text>
        {SHELF_CATEGORIES.map((c) => {
          const rule = form.rules.find((r) => r.tag === c.tag);
          return (
            <View key={c.tag} style={styles.ruleRow}>
              <View style={styles.row}>
                <Text style={[styles.label, styles.flex]}>{c.label}</Text>
                <Switch
                  value={rule !== undefined}
                  onValueChange={() => toggleRule(c.tag)}
                  testID={`rule-${c.tag}`}
                />
              </View>
              {rule !== undefined && (
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.flex]}
                    value={rule.premiumPercent}
                    onChangeText={(v) =>
                      setForm({
                        ...form,
                        rules: form.rules.map((r) =>
                          r.tag === c.tag ? { ...r, premiumPercent: v } : r,
                        ),
                      })
                    }
                    keyboardType="decimal-pad"
                    testID={`rule-${c.tag}-premium`}
                    accessibilityLabel={`${c.label}: extra per brand already here, percent`}
                  />
                  <Text style={styles.small}>% more per brand</Text>
                  <TextInput
                    style={[styles.input, styles.narrow]}
                    value={rule.maxBrands}
                    onChangeText={(v) =>
                      setForm({
                        ...form,
                        rules: form.rules.map((r) =>
                          r.tag === c.tag ? { ...r, maxBrands: v } : r,
                        ),
                      })
                    }
                    keyboardType="number-pad"
                    testID={`rule-${c.tag}-max`}
                    accessibilityLabel={`${c.label}: most brands`}
                  />
                  <Text style={styles.small}>at most</Text>
                </View>
              )}
            </View>
          );
        })}

        <Text style={styles.heading}>Brands placed outside Dina</Text>
        <Text style={styles.sub}>
          A brand you agreed with in person still counts for its category&apos;s rule. Name its slot
          and Dina keeps that slot taken for those dates.
        </Text>
        {form.holdings.map((holding, i) => (
          <View key={i} style={styles.card} testID={`holding-${String(i)}`}>
            <Text style={styles.label}>Category</Text>
            <View style={styles.chips}>
              {SHELF_CATEGORIES.map((c) => (
                <Pressable
                  key={c.tag}
                  style={[styles.chip, holding.tag === c.tag && styles.chipOn]}
                  onPress={() => setHolding(i, { tag: c.tag })}
                  testID={`holding-${String(i)}-tag-${c.tag}`}
                >
                  <Text style={styles.chipText}>{c.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.label}>Slot</Text>
            <View style={styles.chips}>
              {['', ...form.slots.map((slot) => slot.resourceRef).filter((ref) => ref !== '')].map(
                (ref) => (
                  <Pressable
                    key={ref === '' ? '(none)' : ref}
                    style={[styles.chip, holding.resourceRef === ref && styles.chipOn]}
                    onPress={() => setHolding(i, { resourceRef: ref })}
                    testID={`holding-${String(i)}-slot-${ref === '' ? 'none' : ref}`}
                  >
                    <Text style={styles.chipText}>{ref === '' ? 'No slot' : ref}</Text>
                  </Pressable>
                ),
              )}
            </View>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.flex]}
                value={holding.startDay}
                onChangeText={(v) => setHolding(i, { startDay: v })}
                placeholder="From (YYYY-MM-DD)"
                placeholderTextColor={colors.textMuted}
                testID={`holding-${String(i)}-start`}
                accessibilityLabel="Holding from"
              />
              <TextInput
                style={[styles.input, styles.flex]}
                value={holding.endDay}
                onChangeText={(v) => setHolding(i, { endDay: v })}
                placeholder="Until (YYYY-MM-DD)"
                placeholderTextColor={colors.textMuted}
                testID={`holding-${String(i)}-end`}
                accessibilityLabel="Holding until"
              />
            </View>
            <Pressable
              onPress={() =>
                setForm({ ...form, holdings: form.holdings.filter((_, j) => j !== i) })
              }
              accessibilityRole="button"
              testID={`holding-${String(i)}-remove`}
            >
              <Text style={styles.link}>Remove</Text>
            </Pressable>
          </View>
        ))}
        <Pressable
          onPress={() => setForm({ ...form, holdings: [...form.holdings, emptyHolding()] })}
          accessibilityRole="button"
          testID="shelf-terms-add-holding"
        >
          <Text style={styles.link}>Add a brand placed outside Dina</Text>
        </Pressable>

        {problem !== null && (
          <Text style={styles.error} testID="shelf-terms-problem">
            {problem}
          </Text>
        )}
        {notice !== null && <Text style={styles.notice}>{notice}</Text>}
        <Pressable
          style={styles.button}
          onPress={save}
          accessibilityRole="button"
          testID="shelf-terms-save"
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          testID="shelf-terms-back"
        >
          <Text style={styles.link}>Back</Text>
        </Pressable>
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
    marginTop: spacing.md,
  },
  sub: { ...textStyles.body, color: colors.textSecondary },
  small: { ...textStyles.caption, color: colors.textSecondary },
  label: { ...textStyles.caption, color: colors.textPrimary },
  field: { gap: spacing.xs },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  ruleRow: { gap: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { ...textStyles.caption, color: colors.textPrimary },
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
  narrow: { width: 64 },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  button: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    marginTop: spacing.md,
  },
  buttonText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  link: { ...textStyles.caption, color: colors.accent, fontWeight: '600' },
  error: { ...textStyles.body, color: colors.error },
  notice: { ...textStyles.body, color: colors.textSecondary },
});
