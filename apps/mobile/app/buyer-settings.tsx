/**
 * Buying preferences — the buyer's saved currency and delivery areas.
 *
 * Ask for quotes starts from these: the currency a tender is in, and the
 * postal code it delivers to (a supplier's catalog is filtered by it). There
 * was no screen to set them, so a buyer trading in anything but the INR
 * fallback had to retype it on every request.
 *
 * Core holds the whole buyer settings record and takes it back whole, so this
 * screen reads it, changes only the currency and the delivery areas (postal
 * codes added or removed, other areas removed), and writes the rest back
 * exactly as stored — even a stored record Core now refuses, which opens here
 * with what is wrong listed. Saving hands out authority in advance (who may be
 * asked, in what currency), so Core asks a person to be present first.
 */

import { Stack } from 'expo-router';
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

import { DEFAULT_TENDER_FANOUT, type BuyerSettingsDto, type SettingsFindingDto } from '@dina/core';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { isPresenceRefusal, ownerErrorText } from '../src/services/owner_errors';
import { ownerDidHere } from '../src/services/supplier_finder';
import { colors, radius, spacing, textStyles } from '../src/theme';

const POSTAL = 'postal_area';

/** How a delivery area that is not a postal code reads on its chip. */
function areaLabel(area: unknown): string {
  if (area !== null && typeof area === 'object') {
    const { scheme, value } = area as { scheme?: unknown; value?: unknown };
    if (typeof scheme === 'string' && typeof value === 'string') {
      return `${scheme.replace(/_/g, ' ')}: ${value}`;
    }
  }
  return 'Unreadable area';
}

function isPostal(area: unknown): area is { scheme: string; value: string } {
  return (
    area !== null &&
    typeof area === 'object' &&
    (area as { scheme?: unknown }).scheme === POSTAL &&
    typeof (area as { value?: unknown }).value === 'string'
  );
}

/** Settings for a buyer who has saved none yet: everything empty but the identity. */
function freshSettings(actingIdentityDid: string): BuyerSettingsDto {
  return {
    actingIdentityDid,
    locations: [],
    preferredSuppliers: [],
    blockedSuppliers: [],
    allowedCategoryIds: [],
    quoteFanoutCeiling: DEFAULT_TENDER_FANOUT,
    approvalPolicySummary: '',
    currency: '',
    preferredUnitCodes: [],
    publishReviews: false,
  };
}

export default function BuyerSettingsScreen(): React.ReactElement {
  /**
   * The record a save sends back, as Core stored it — field for field, even
   * a field Core now refuses. Only the currency and the delivery areas are
   * this screen's to change; anything else wrong stays visible as a finding
   * rather than being quietly replaced by a default.
   */
  const [base, setBase] = useState<Record<string, unknown> | null>(null);
  const [currency, setCurrency] = useState('');
  const [postals, setPostals] = useState<string[]>([]);
  /** Delivery areas that are not postal codes, as stored; the owner may remove them. */
  const [otherAreas, setOtherAreas] = useState<unknown[]>([]);
  const [newPostal, setNewPostal] = useState('');
  const [findings, setFindings] = useState<SettingsFindingDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Why the stored preferences need saving again, when Core refused them as stored. */
  const [storedProblem, setStoredProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      return;
    }
    try {
      const answer = await client.buyerSettingsToEdit();
      let stored: Record<string, unknown>;
      if (!answer.configured || answer.settings === null) {
        stored = freshSettings((await ownerDidHere()) ?? '') as unknown as Record<string, unknown>;
      } else {
        stored = answer.settings as Record<string, unknown>;
      }
      if (answer.configured && answer.findings.length > 0) {
        // Stored, but refused as stored: open it anyway, say what is wrong,
        // and let a save put it right (or start over when it is unreadable).
        setFindings(answer.findings);
        setStoredProblem(
          answer.settings === null
            ? 'Your saved buying preferences could not be read. Saving here starts them over.'
            : 'Your saved buying preferences need fixing before Dina can use them. Fix what is listed below and save.',
        );
      }
      const areas: unknown[] = Array.isArray(stored.locations) ? stored.locations : [];
      setBase(stored);
      setCurrency(typeof stored.currency === 'string' ? stored.currency : '');
      setPostals(areas.filter(isPostal).map((r) => r.value));
      setOtherAreas(areas.filter((r) => !isPostal(r)));
      setError(null);
    } catch (err) {
      setError(ownerErrorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => setError(ownerErrorText(err)),
    reason:
      'These settings decide what Dina may ask suppliers for, so Dina checks a person is here.',
  });

  const addPostal = (): void => {
    const code = newPostal.trim();
    if (code === '' || postals.includes(code)) {
      setNewPostal('');
      return;
    }
    setPostals([...postals, code]);
    setNewPostal('');
  };

  const currencyProblem =
    currency !== '' && !/^[A-Z]{3}$/.test(currency)
      ? 'A currency is a three-letter code, like INR or USD.'
      : null;

  const save = useCallback(() => {
    if (base === null || currencyProblem !== null) return;
    // Only the currency and the delivery areas change; every other setting
    // goes back exactly as stored, and so does every other area the owner
    // did not remove.
    const next = {
      ...base,
      currency,
      locations: [...otherAreas, ...postals.map((value) => ({ scheme: POSTAL, value }))],
    } as unknown as BuyerSettingsDto;
    setNotice(null);
    setError(null);
    void runGated(async () => {
      const client = getOwnerCommerceClient();
      if (client === null) return;
      try {
        const outcome = await client.saveBuyerSettings(next);
        if (outcome.ok) {
          setFindings([]);
          setStoredProblem(null);
          setBase(next as unknown as Record<string, unknown>);
          setNotice('Saved. Ask for quotes starts from these.');
        } else {
          setFindings(outcome.findings);
        }
      } catch (err) {
        if (isPresenceRefusal(err)) throw err;
        setError(ownerErrorText(err));
      }
    });
  }, [base, currency, currencyProblem, otherAreas, postals, runGated]);

  if (base === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="buyer-settings-loading">
        <Stack.Screen options={{ title: 'Buying preferences' }} />
        {error !== null ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  return (
    <View style={styles.container} testID="buyer-settings-screen">
      <Stack.Screen options={{ title: 'Buying preferences' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sub}>
          Ask for quotes starts from these. You can still change them on any request.
        </Text>
        {storedProblem !== null && (
          <Text style={styles.error} testID="buyer-stored-problem">
            {storedProblem}
          </Text>
        )}

        <Text style={styles.section}>Currency</Text>
        <TextInput
          testID="buyer-currency"
          style={[styles.input, styles.currency, currencyProblem !== null && styles.inputBad]}
          value={currency}
          onChangeText={(text) => setCurrency(text.toUpperCase().replace(/[^A-Z]/g, ''))}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={3}
          placeholder="INR"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Currency, a three-letter code"
        />
        {currencyProblem !== null && <Text style={styles.finding}>{currencyProblem}</Text>}

        <Text style={styles.section}>Delivery postal codes</Text>
        <Text style={styles.sub}>Suppliers are found by the areas they deliver to.</Text>
        <View style={styles.chips}>
          {postals.map((code) => (
            <Pressable
              key={code}
              testID={`buyer-postal-${code}`}
              style={styles.chip}
              onPress={() => setPostals(postals.filter((c) => c !== code))}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${code}`}
            >
              <Text style={styles.chipText}>{code} ✕</Text>
            </Pressable>
          ))}
          {postals.length === 0 && (
            <Text style={styles.sub} testID="buyer-postal-none">
              None saved yet.
            </Text>
          )}
        </View>
        <View style={styles.row}>
          <TextInput
            testID="buyer-postal-input"
            style={[styles.input, styles.flex]}
            value={newPostal}
            onChangeText={setNewPostal}
            onSubmitEditing={addPostal}
            placeholder="Postal code"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
          />
          <Pressable
            testID="buyer-postal-add"
            style={styles.add}
            onPress={addPostal}
            accessibilityRole="button"
          >
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>

        {otherAreas.length > 0 && (
          <>
            <Text style={styles.section}>Other delivery areas</Text>
            <View style={styles.chips}>
              {otherAreas.map((area, index) => (
                <Pressable
                  key={`${areaLabel(area)}-${String(index)}`}
                  testID={`buyer-area-${String(index)}`}
                  style={styles.chip}
                  onPress={() => setOtherAreas(otherAreas.filter((_, i) => i !== index))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${areaLabel(area)}`}
                >
                  <Text style={styles.chipText}>{areaLabel(area)} ✕</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {findings.map((f, i) => (
          <Text key={`${f.field}-${String(i)}`} style={styles.finding} testID="buyer-finding">
            {f.detail}
          </Text>
        ))}
        {error !== null && (
          <Text style={styles.error} testID="buyer-settings-error">
            {error}
          </Text>
        )}
        {notice !== null && (
          <Text style={styles.notice} testID="buyer-settings-saved">
            {notice}
          </Text>
        )}

        <Pressable
          testID="buyer-settings-save"
          style={[styles.save, currencyProblem !== null && styles.disabled]}
          disabled={currencyProblem !== null}
          onPress={save}
          accessibilityRole="button"
        >
          <Text style={styles.saveText}>Save</Text>
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
  sub: { ...textStyles.body, color: colors.textSecondary },
  section: {
    ...textStyles.body,
    color: colors.textPrimary,
    fontWeight: '600',
    marginTop: spacing.md,
  },
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
  currency: { width: 96 },
  inputBad: { borderColor: colors.error },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: { ...textStyles.caption, color: colors.bgPrimary },
  add: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addText: { ...textStyles.body, color: colors.bgPrimary, fontWeight: '600' },
  finding: { ...textStyles.caption, color: colors.error },
  error: { ...textStyles.body, color: colors.error },
  notice: { ...textStyles.body, color: colors.textSecondary },
  save: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    marginTop: spacing.lg,
  },
  saveText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  disabled: { opacity: 0.6 },
});
