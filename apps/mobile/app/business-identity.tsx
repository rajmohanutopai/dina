/**
 * The node's OWN business, on paper (RESEARCHER_KERNEL_ARCHITECTURE §5.D).
 *
 * The other half of the owner's "Settings + contacts" decision: a filing names
 * TWO parties, and until this screen existed the owner could state the
 * counterparty's identity but never their own — so the India e-way-bill hook
 * could only ever answer "no GSTIN in your business settings", pointing at a
 * screen that did not exist.
 *
 * NOTHING IS JUDGED HERE. Core validates (the GSTIN checksum, the address a
 * document can print) and answers with findings, which land beside the field
 * they belong to; a refusal stores nothing.
 */

import { useRouter } from 'expo-router';
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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { SettingsFindingDto } from '@dina/core';

interface FormState {
  legalName: string;
  gstin: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

const EMPTY: FormState = {
  legalName: '',
  gstin: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
};

/** Which form field a finding belongs beside. */
const FIELD_OF: Record<string, keyof FormState> = {
  legalName: 'legalName',
  registrations: 'gstin',
  'address.line1': 'line1',
  'address.line2': 'line2',
  'address.city': 'city',
  'address.region': 'region',
  'address.postalCode': 'postalCode',
  'address.country': 'country',
};

export default function BusinessIdentityScreen(): React.JSX.Element {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [findings, setFindings] = useState<SettingsFindingDto[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      setStatus('idle');
      return;
    }
    void client
      .businessIdentity()
      .then((answer) => {
        if (!live) return;
        if (!answer.configured) {
          setStatus('idle');
          return;
        }
        if ('error' in answer) {
          // Stored settings that no longer validate are a fault the owner has
          // to see — the node is failing closed on their own policy.
          setFindings(answer.findings);
          setError('The stored identity no longer validates. Correct it and save.');
          setStatus('idle');
          return;
        }
        const address = answer.settings.address;
        setForm({
          legalName: answer.settings.legalName,
          gstin: answer.settings.registrations.find((r) => r.scheme === 'gstin')?.value ?? '',
          line1: address?.line1 ?? '',
          line2: address?.line2 ?? '',
          city: address?.city ?? '',
          region: address?.region ?? '',
          postalCode: address?.postalCode ?? '',
          country: address?.country ?? '',
        });
        setStatus('idle');
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('idle');
      });
    return () => {
      live = false;
    };
  }, []);

  const set = useCallback(
    (field: keyof FormState) => (value: string) => setForm((prev) => ({ ...prev, [field]: value })),
    [],
  );

  const save = useCallback(async (): Promise<void> => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      return;
    }
    setStatus('saving');
    setFindings([]);
    setError('');
    // Any address field the owner typed means they meant to state an address;
    // Core says what is missing rather than the screen dropping their typing.
    const hasAddress = [form.line1, form.line2, form.city, form.region, form.postalCode, form.country].some(
      (value) => value.trim() !== '',
    );
    try {
      const result = await client.saveBusinessIdentity({
        legalName: form.legalName,
        registrations: form.gstin.trim() === '' ? [] : [{ scheme: 'gstin', value: form.gstin }],
        ...(hasAddress
          ? {
              address: {
                line1: form.line1,
                ...(form.line2.trim() !== '' ? { line2: form.line2 } : {}),
                city: form.city,
                ...(form.region.trim() !== '' ? { region: form.region } : {}),
                ...(form.postalCode.trim() !== '' ? { postalCode: form.postalCode } : {}),
                country: form.country,
              },
            }
          : {}),
      });
      setStatus('idle');
      if (!result.ok) {
        setFindings(result.findings);
        return;
      }
      router.back();
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [form, router]);

  const findingFor = (key: keyof FormState): string | undefined =>
    findings.find((f) => FIELD_OF[f.field.replace(/\[\d+\]$/, '')] === key)?.detail;
  const unplaced = findings.filter((f) => FIELD_OF[f.field.replace(/\[\d+\]$/, '')] === undefined);

  if (status === 'loading') {
    return (
      <View style={[styles.container, styles.centered]} testID="business-identity-loading">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const busy = status === 'saving';
  const field = (
    key: keyof FormState,
    label: string,
    props: { placeholder?: string; autoCapitalize?: 'none' | 'characters' } = {},
  ): React.JSX.Element => {
    const problem = findingFor(key);
    return (
      <View>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          testID={`business-identity-${key}`}
          value={form[key]}
          onChangeText={set(key)}
          editable={!busy}
          autoCorrect={false}
          spellCheck={false}
          placeholderTextColor={colors.textMuted}
          style={[styles.input, problem !== undefined && styles.inputBad]}
          {...props}
        />
        {problem !== undefined && (
          <Text testID={`business-identity-finding-${key}`} style={styles.finding}>
            {problem}
          </Text>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sub}>
          What your business prints on a document. Dina uses this when a country pack files an e-way
          bill or issues an invoice for you. Leave anything you do not have blank.
        </Text>

        {field('legalName', 'Registered name', { placeholder: 'Utopai Furniture LLP' })}
        {field('gstin', 'GSTIN', { placeholder: '27AAPFU0939F1ZV', autoCapitalize: 'characters' })}

        <Text style={styles.section}>Registered address</Text>
        {field('line1', 'Street', { placeholder: '12 Nehru Road' })}
        {field('line2', 'Street (line 2)', { placeholder: 'Second floor' })}
        {field('city', 'City', { placeholder: 'Bengaluru' })}
        {field('region', 'State', { placeholder: 'Karnataka' })}
        {field('postalCode', 'PIN / ZIP', { placeholder: '560001' })}
        {field('country', 'Country code', { placeholder: 'IN', autoCapitalize: 'characters' })}

        {(error !== '' || unplaced.length > 0) && (
          <Text testID="business-identity-error" style={styles.error}>
            {[error, ...unplaced.map((f) => f.detail)].filter((line) => line !== '').join('\n')}
          </Text>
        )}

        <View style={styles.buttons}>
          <Pressable
            testID="business-identity-cancel"
            accessibilityRole="button"
            onPress={() => router.back()}
            disabled={busy}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            testID="business-identity-save"
            accessibilityRole="button"
            onPress={() => void save()}
            disabled={busy}
            style={({ pressed }) => [styles.save, pressed && styles.pressed, busy && styles.disabled]}
          >
            {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.saveText}>Save</Text>}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  sub: { ...textStyles.body, color: colors.textSecondary, marginBottom: spacing.sm },
  section: { ...textStyles.body, color: colors.textPrimary, fontWeight: '600', marginTop: spacing.md },
  label: { ...textStyles.caption, color: colors.textSecondary, marginBottom: spacing.xs },
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
  inputBad: { borderColor: colors.error },
  finding: { ...textStyles.caption, color: colors.error, marginTop: spacing.xs },
  error: { ...textStyles.body, color: colors.error, marginTop: spacing.sm },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  cancel: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: { ...textStyles.body, color: colors.textSecondary },
  save: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  saveText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.6 },
});
