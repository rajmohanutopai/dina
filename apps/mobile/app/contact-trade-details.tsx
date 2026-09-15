/**
 * A counterparty's trade details (RESEARCHER_KERNEL_ARCHITECTURE §5.D).
 *
 * The khata knows a counterparty by DID. A filing does not: an e-way bill
 * names their GSTIN, an invoice their registered name and billing address, a
 * reminder the number they answer on. This screen is where the owner states
 * those — the capture path the country-pack hooks were missing.
 *
 * NOTHING IS JUDGED HERE. Core validates (a GSTIN's checksum, a phone's
 * shape) and answers with findings; the screen shows them beside the fields.
 * A refusal writes nothing, so a saved form is a form Core accepted whole.
 *
 * One registration, not a list: a counterparty's tax number is the one a
 * filing prints, and a "+ add another" control on a screen nobody has asked
 * for yet is a control to maintain. The domain holds several; this surface
 * edits the first.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
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

import { loadTradeDetails, saveTradeDetails } from '../src/services/trade_details_source';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { TradeIdentityFinding } from '@dina/core';

/** The form, as flat text — the shapes are assembled at save. */
interface FormState {
  legalName: string;
  gstin: string;
  phone: string;
  email: string;
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
  phone: '',
  email: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
};

export default function ContactTradeDetailsScreen(): React.JSX.Element {
  const router = useRouter();
  const { did, name } = useLocalSearchParams<{ did?: string; name?: string }>();
  const contactDid = typeof did === 'string' ? did : '';
  const [form, setForm] = useState<FormState>(EMPTY);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [findings, setFindings] = useState<TradeIdentityFinding[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (contactDid === '') {
      setStatus('idle');
      return;
    }
    let live = true;
    void loadTradeDetails(contactDid)
      .then((details) => {
        if (!live) return;
        const address = details.billingAddress;
        setForm({
          legalName: details.legalName,
          gstin: details.registrations.find((r) => r.scheme === 'gstin')?.value ?? '',
          phone: details.phone ?? '',
          email: details.email ?? '',
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
  }, [contactDid]);

  const set = useCallback(
    (field: keyof FormState) => (value: string) => setForm((prev) => ({ ...prev, [field]: value })),
    [],
  );

  const save = useCallback(async (): Promise<void> => {
    setStatus('saving');
    setFindings([]);
    setError('');
    // ANY address field the owner typed means they meant to state an address.
    // Sending it lets Core say what is missing ("a street line is required")
    // beside the field; dropping it because the street happens to be blank
    // would throw their typing away without a word.
    const hasAddress = [form.line1, form.line2, form.city, form.region, form.postalCode, form.country].some(
      (value) => value.trim() !== '',
    );
    try {
      const result = await saveTradeDetails(contactDid, {
        legalName: form.legalName,
        registrations: form.gstin.trim() === '' ? [] : [{ scheme: 'gstin', value: form.gstin }],
        billingAddress: hasAddress
          ? {
              line1: form.line1,
              ...(form.line2.trim() !== '' ? { line2: form.line2 } : {}),
              city: form.city,
              ...(form.region.trim() !== '' ? { region: form.region } : {}),
              ...(form.postalCode.trim() !== '' ? { postalCode: form.postalCode } : {}),
              country: form.country,
            }
          : null,
        phone: form.phone,
        email: form.email,
      });
      setStatus('idle');
      if (result.length > 0) {
        setFindings(result);
        return;
      }
      router.back();
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [contactDid, form, router]);

  const matchesField = (findingField: string, field: string): boolean =>
    findingField === field || findingField.startsWith(`${field}[`) || findingField.startsWith(`${field}.`);
  const FIELD_KEYS = [
    'legalName',
    'registrations',
    'phone',
    'email',
    'billing_address.line1',
    'billing_address.line2',
    'billing_address.city',
    'billing_address.region',
    'billing_address.postalCode',
    'billing_address.country',
  ];
  const findingFor = (field: string): string | undefined =>
    findings.find((f) => matchesField(f.field, field))?.detail;
  /** Findings that belong beside no field on this form — never swallowed. */
  const unplacedFindings = findings.filter((f) => !FIELD_KEYS.some((key) => matchesField(f.field, key)));

  if (status === 'loading') {
    return (
      <View style={[styles.container, styles.centered]} testID="contact-trade-details-loading">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const busy = status === 'saving';
  const field = (
    key: keyof FormState,
    label: string,
    findingKey: string,
    props: { placeholder?: string; autoCapitalize?: 'none' | 'characters'; keyboardType?: 'email-address' | 'phone-pad' } = {},
  ): React.JSX.Element => {
    const problem = findingFor(findingKey);
    return (
      <View>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          testID={`contact-trade-${key}`}
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
          <Text testID={`contact-trade-finding-${key}`} style={styles.finding}>
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
          {typeof name === 'string' && name !== '' ? `What ${name} prints on a document. ` : ''}
          Dina uses these when you file an e-way bill, issue an invoice, or send a reminder. Leave
          anything you do not have blank.
        </Text>

        {field('legalName', 'Registered name', 'legalName', { placeholder: 'ChairMaker Industries LLP' })}
        {field('gstin', 'GSTIN', 'registrations', { placeholder: '27AAPFU0939F1ZV', autoCapitalize: 'characters' })}
        {field('phone', 'Phone', 'phone', { placeholder: '+91 98450 12345', keyboardType: 'phone-pad' })}
        {field('email', 'E-mail', 'email', { placeholder: 'sales@example.com', autoCapitalize: 'none', keyboardType: 'email-address' })}

        <Text style={styles.section}>Billing address</Text>
        {field('line1', 'Street', 'billing_address.line1', { placeholder: '4 Kalasipalya Road' })}
        {field('line2', 'Street (line 2)', 'billing_address.line2', { placeholder: 'Unit 3' })}
        {field('city', 'City', 'billing_address.city', { placeholder: 'Bengaluru' })}
        {field('region', 'State', 'billing_address.region', { placeholder: 'Karnataka' })}
        {field('postalCode', 'PIN / ZIP', 'billing_address.postalCode', { placeholder: '560002' })}
        {field('country', 'Country code', 'billing_address.country', { placeholder: 'IN', autoCapitalize: 'characters' })}

        {(error !== '' || unplacedFindings.length > 0) && (
          <Text testID="contact-trade-error" style={styles.error}>
            {[error, ...unplacedFindings.map((f) => f.detail)].filter((line) => line !== '').join('\n')}
          </Text>
        )}

        <View style={styles.buttons}>
          <Pressable
            testID="contact-trade-cancel"
            accessibilityRole="button"
            onPress={() => router.back()}
            disabled={busy}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            testID="contact-trade-save"
            accessibilityRole="button"
            onPress={() => void save()}
            disabled={busy || contactDid === ''}
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
