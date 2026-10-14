/**
 * Ask for a slot — the brand's side (docs/SHELF_SPACE_NEGOTIATION.md §7.1, §8).
 *
 * Reached from "Find a slot", or from a directory's app (Zeev) by deep link
 * carrying ONE thing: the listing's address (§6.3). The record is fetched from
 * AppView here and handed to this phone's Dina, which re-validates it (its
 * digest covers it) and binds the request to it.
 *
 * The brand says what it hopes to pay and the most it will pay; Dina bargains
 * inside those and asks the owner once, when an offer is ready. Nothing binds
 * until the owner says yes — and then the store's owner says yes too.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { ownerErrorText } from '../src/services/owner_errors';
import {
  categoryLabel,
  fetchSlotListing,
  readListingUri,
  requestToNegotiation,
  SLOT_KINDS,
  type RequestForm,
} from '../src/services/shelf_space';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { TermListingCandidate } from '@dina/brain';
import type { TermListing } from '@dina/commerce-protocol';

function initialForm(listing: Partial<TermListing>): RequestForm {
  return {
    tag: listing.tags?.[0] ?? '',
    products: '',
    skus: '',
    startDay: listing.available?.from.slice(0, 10) ?? '',
    endDay: '',
    currency: 'INR',
    targetRent: '',
    targetSharePercent: '0',
    maxRent: '',
    maxSharePercent: '0',
    expectedSales: '',
    period: 'monthly',
    rounds: '3',
    days: '3',
  };
}

export default function ShelfRequestScreen(): React.ReactElement {
  const router = useRouter();
  const params = useLocalSearchParams<{ listing?: string }>();
  const uri = readListingUri(params.listing);
  const [candidate, setCandidate] = useState<TermListingCandidate | null>(null);
  const [form, setForm] = useState<RequestForm | null>(null);
  const [problem, setProblem] = useState<string | null>(
    uri === null ? 'This link does not name a slot listing.' : null,
  );
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (uri === null) return;
    let live = true;
    fetchSlotListing(uri)
      .then((found) => {
        if (!live) return;
        if (found === null) {
          setProblem('That slot is no longer listed.');
          return;
        }
        setCandidate(found);
        setForm(initialForm(found.listing as Partial<TermListing>));
      })
      .catch((err: unknown) => live && setProblem(ownerErrorText(err)));
    return () => {
      live = false;
    };
  }, [uri]);

  const set = (patch: Partial<RequestForm>): void =>
    setForm((f) => (f === null ? f : { ...f, ...patch }));

  const send = useCallback(async () => {
    if (form === null || candidate === null || uri === null) return;
    const built = requestToNegotiation(form);
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    const client = getOwnerCommerceClient();
    if (client === null) return;
    setSending(true);
    setProblem(null);
    try {
      await client.startTermNegotiation({
        listing: candidate.listing,
        listing_uri: uri,
        tag: form.tag,
        attributes: built.attributes,
        start: built.start,
        end: built.end,
        policy: built.policy,
      });
      router.replace('/shelf-space');
    } catch (err) {
      setProblem(ownerErrorText(err));
    } finally {
      setSending(false);
    }
  }, [candidate, form, router, uri]);

  if (candidate === null || form === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="shelf-request-loading">
        <Stack.Screen options={{ title: 'Ask for a slot' }} />
        {problem !== null ? (
          <Text style={styles.error} testID="shelf-request-problem">
            {problem}
          </Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }

  const listing = candidate.listing as Partial<TermListing>;
  const per = form.period === 'monthly' ? 'month' : 'week';
  const field = (
    label: string,
    key: Exclude<keyof RequestForm, 'period'>,
    testID: string,
    numeric = false,
  ): React.ReactElement => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={form[key]}
        onChangeText={(v) => set({ [key]: v } as Partial<RequestForm>)}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        testID={testID}
        accessibilityLabel={label}
      />
    </View>
  );

  return (
    <View style={styles.container} testID="shelf-request-screen">
      <Stack.Screen options={{ title: 'Ask for a slot' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {listing.resource_ref} ·{' '}
            {SLOT_KINDS.find((k) => k.kind === listing.kind)?.label ?? listing.kind}
          </Text>
          <Text style={styles.cardLine}>{listing.region?.value}</Text>
          <Text style={styles.cardLine}>
            Free {listing.available?.from.slice(0, 10)} to {listing.available?.to.slice(0, 10)}
          </Text>
        </View>
        <Text style={styles.label}>Your category</Text>
        <View style={styles.chips}>
          {(listing.tags ?? []).map((tag) => (
            <Pressable
              key={tag}
              style={[styles.chip, form.tag === tag && styles.chipOn]}
              onPress={() => set({ tag })}
              testID={`shelf-request-tag-${tag}`}
            >
              <Text style={styles.chipText}>{categoryLabel(tag)}</Text>
            </Pressable>
          ))}
        </View>
        {field('What you would stock', 'products', 'shelf-request-products')}
        {field('Products to stock', 'skus', 'shelf-request-skus', true)}
        {field('From (YYYY-MM-DD)', 'startDay', 'shelf-request-start')}
        {field('Until (YYYY-MM-DD)', 'endDay', 'shelf-request-end')}
        {field('Currency', 'currency', 'shelf-request-currency')}
        <Text style={styles.label}>Your amounts are per</Text>
        <View style={styles.chips}>
          {(['monthly', 'weekly'] as const).map((period) => (
            <Pressable
              key={period}
              style={[styles.chip, form.period === period && styles.chipOn]}
              onPress={() => set({ period })}
              testID={`shelf-request-period-${period}`}
            >
              <Text style={styles.chipText}>{period === 'monthly' ? 'Month' : 'Week'}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.small}>
          A store that rents by the {form.period === 'monthly' ? 'week' : 'month'} is compared on
          the same scale: Dina converts, rounding in your favour.
        </Text>
        {field(`Rent you hope for, a ${per}`, 'targetRent', 'shelf-request-target-rent', true)}
        {field('Share you hope for, %', 'targetSharePercent', 'shelf-request-target-share', true)}
        {field(`Most rent you will pay, a ${per}`, 'maxRent', 'shelf-request-max-rent', true)}
        {field('Most share you will give, %', 'maxSharePercent', 'shelf-request-max-share', true)}
        {field(
          `Sales you expect a ${per} (to compare stores)`,
          'expectedSales',
          'shelf-request-expected',
          true,
        )}
        {field('Rounds of bargaining', 'rounds', 'shelf-request-rounds', true)}
        {field('Bargain for how many days (1–7)', 'days', 'shelf-request-days', true)}
        <Text style={styles.small}>
          Your limits stay in your Dina. The store sees only what Dina asks for, and nothing binds
          until you both say yes.
        </Text>
        {problem !== null && (
          <Text style={styles.error} testID="shelf-request-problem">
            {problem}
          </Text>
        )}
        <Pressable
          style={[styles.button, sending && styles.disabled]}
          onPress={() => void send()}
          disabled={sending}
          accessibilityRole="button"
          testID="shelf-request-send"
        >
          <Text style={styles.buttonText}>Ask this store</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  centered: { alignItems: 'center', justifyContent: 'center', padding: spacing.md },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  small: { ...textStyles.caption, color: colors.textSecondary },
  label: { ...textStyles.caption, color: colors.textPrimary },
  field: { gap: spacing.xs },
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
  button: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    marginTop: spacing.md,
  },
  buttonText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  error: { ...textStyles.body, color: colors.error },
});
