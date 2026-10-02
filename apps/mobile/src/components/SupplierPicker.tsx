/**
 * Search listed suppliers and pick who to ask for quotes (ASK_FOR_QUOTES_PLAN
 * §1). The buyer types what they want; results come from the AppView
 * (`supplier_finder`), most relevant and most trusted first; tapping a row
 * picks it. Picked suppliers stay as chips above the search, so a second
 * search adds to them rather than replacing them.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatMoneyAmount } from '@dina/core';

import { ownerErrorText } from '../services/owner_errors';
import { findSuppliersHere, type SupplierMatch } from '../services/supplier_finder';
import { shortDid, supplierLabels } from '../services/supplier_names';
import { colors, radius, spacing, textStyles } from '../theme';

import type { SetAside } from '../services/supplier_trust';

export interface PickedSupplier {
  supplierDid: string;
  serviceRkey: string;
  name: string | null;
  /** The currency the supplier's catalog prices are in, when it lists any. */
  currency?: string;
}

/** A supplier PeerLens set aside in a search, and why (not asked unless picked). */
export interface SetAsideSupplier {
  supplierDid: string;
  serviceRkey: string;
  name: string | null;
  setAside: SetAside;
  /** The lowest price it listed for what was searched, when it listed one. */
  indicativeFrom?: { currency: string; minorUnits: string };
}

export interface SupplierPickerProps {
  /** Seeds the search box (the first line's words, or a chat draft's phrase). */
  initialQuery: string;
  /** The buyer's delivery region, `postal_area:<code>`; undefined when unknown. */
  region?: string;
  preferredSuppliers?: readonly string[];
  blockedSuppliers?: readonly string[];
  picked: readonly PickedSupplier[];
  onChange: (picked: PickedSupplier[]) => void;
  /** At most this many may be picked (a tender's fan-out). */
  max: number;
  /** After each search: the suppliers PeerLens set aside in it. */
  onSetAside?: (suppliers: SetAsideSupplier[]) => void;
}

/** PeerLens trust in words; "no reviews yet" is not the same as low trust. */
export function trustWords(score: number | null): string {
  if (score === null) return 'No reviews yet';
  if (score >= 0.7) return 'Well trusted';
  if (score >= 0.4) return 'Some trust';
  return 'Low trust';
}

function priceFrom(p: { currency: string; minorUnits: string } | undefined): string | null {
  if (p === undefined || !/^\d+$/.test(p.minorUnits)) return null;
  try {
    return `from ${p.currency} ${formatMoneyAmount({ currency: p.currency, minor_units: p.minorUnits })}`;
  } catch {
    return null; // a price the wire rules refuse is not shown at all
  }
}

const keyOf = (s: { supplierDid: string; serviceRkey: string }): string =>
  `${s.supplierDid}\n${s.serviceRkey}`;

export function SupplierPicker(props: SupplierPickerProps): React.ReactElement {
  const router = useRouter();
  const [query, setQuery] = useState(props.initialQuery);
  const [results, setResults] = useState<SupplierMatch[] | null>(null);
  const [hiddenForReviews, setHiddenForReviews] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    setSearching(true);
    setError(null);
    try {
      const found = await findSuppliersHere({
        text: query,
        ...(props.region !== undefined ? { region: props.region } : {}),
        ...(props.preferredSuppliers !== undefined
          ? { preferredSuppliers: props.preferredSuppliers }
          : {}),
        ...(props.blockedSuppliers !== undefined
          ? { blockedSuppliers: props.blockedSuppliers }
          : {}),
      });
      setResults(found.suppliers);
      setHiddenForReviews(found.hiddenForPoorReviews);
      props.onSetAside?.(
        found.suppliers.flatMap((f) =>
          f.setAside === null
            ? []
            : [
                {
                  supplierDid: f.supplierDid,
                  serviceRkey: f.serviceRkey,
                  name: f.name,
                  setAside: f.setAside,
                  ...(f.indicativeFrom !== undefined ? { indicativeFrom: f.indicativeFrom } : {}),
                },
              ],
        ),
      );
      if (found.words.length === 0) setError('Type what you want, like “cakes”.');
    } catch (err) {
      setResults(null);
      setHiddenForReviews(false);
      setError(ownerErrorText(err));
    } finally {
      setSearching(false);
    }
  }, [props.blockedSuppliers, props.onSetAside, props.preferredSuppliers, props.region, query]);

  const pickedKeys = new Set(props.picked.map(keyOf));
  const labels = supplierLabels([...props.picked, ...(results ?? [])]);
  const labelOf = (s: { supplierDid: string }): string =>
    labels.get(s.supplierDid) ?? shortDid(s.supplierDid);
  // Review the supplier on PeerLens as an organisation with its DID, so the
  // review is about this supplier and the next search reads it.
  const review = (s: SupplierMatch): void => {
    router.push({
      pathname: '/peerlens/write',
      params: {
        createKind: 'organization',
        initialName: s.name ?? '',
        initialDid: s.supplierDid,
        // Back, Cancel and a finished publish come back here, form intact.
        returnTo: '/ask-quotes',
      },
    });
  };
  const reviewLink = (s: SupplierMatch): React.ReactElement => (
    <Pressable
      testID={`supplier-review-${s.supplierDid}`}
      style={styles.reviewLink}
      onPress={() => review(s)}
      accessibilityRole="link"
      accessibilityLabel={`Review ${labelOf(s)} on PeerLens`}
    >
      <Text style={styles.reviewLinkText}>Review</Text>
    </Pressable>
  );
  const toggle = (s: SupplierMatch): void => {
    const key = keyOf(s);
    if (pickedKeys.has(key)) {
      props.onChange(props.picked.filter((p) => keyOf(p) !== key));
    } else if (props.picked.length < props.max) {
      props.onChange([
        ...props.picked,
        {
          supplierDid: s.supplierDid,
          serviceRkey: s.serviceRkey,
          name: s.name,
          ...(s.indicativeFrom !== undefined ? { currency: s.indicativeFrom.currency } : {}),
        },
      ]);
    }
  };

  return (
    <View testID="supplier-picker">
      {props.picked.length > 0 && (
        <View style={styles.chips}>
          {props.picked.map((p) => (
            <Pressable
              key={keyOf(p)}
              testID={`supplier-chip-${p.supplierDid}`}
              style={styles.chip}
              onPress={() => props.onChange(props.picked.filter((x) => keyOf(x) !== keyOf(p)))}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${p.name ?? p.supplierDid}`}
            >
              <Text style={styles.chipText}>{labelOf(p)} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.searchRow}>
        <TextInput
          testID="supplier-search"
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="What do they sell? e.g. cakes"
          placeholderTextColor={colors.textMuted}
          onSubmitEditing={() => void search()}
          returnKeyType="search"
        />
        <Pressable
          testID="supplier-search-go"
          style={[styles.searchButton, searching && styles.disabled]}
          disabled={searching}
          onPress={() => void search()}
          accessibilityRole="button"
        >
          <Text style={styles.searchLabel}>Search</Text>
        </Pressable>
      </View>
      <Text style={styles.meta} testID="supplier-region">
        {props.region !== undefined
          ? `Suppliers who deliver to ${props.region.replace(/^postal_area:/, '')}`
          : 'No delivery area saved: showing suppliers anywhere.'}
      </Text>
      {searching && <ActivityIndicator style={styles.spinner} />}
      {error !== null && (
        <Text style={styles.error} testID="supplier-search-error">
          {error}
        </Text>
      )}
      {hiddenForReviews && (
        <Text style={styles.meta} testID="supplier-hidden-reviews">
          Some matching suppliers were not shown because of poor reviews on PeerLens.
        </Text>
      )}
      {results !== null && results.length === 0 && error === null && (
        <Text style={styles.empty} testID="supplier-none">
          No listed supplier matches that. Try another word.
        </Text>
      )}
      {results?.map((s) => {
        const picked = pickedKeys.has(keyOf(s));
        const full = !picked && props.picked.length >= props.max;
        const price = priceFrom(s.indicativeFrom);
        if (s.setAside !== null && !picked) {
          // Shown so the owner sees PeerLens at work, never picked by a stray
          // tap: asking this supplier takes the explicit "Ask anyway".
          return (
            <View
              key={keyOf(s)}
              testID={`supplier-set-aside-${s.supplierDid}`}
              style={[styles.row, styles.rowSetAside]}
            >
              <View style={styles.rowText}>
                <Text style={styles.name}>{labelOf(s)}</Text>
                <Text style={styles.warning} testID={`supplier-set-aside-why-${s.supplierDid}`}>
                  {`⚠ ${s.setAside.words} · not asked`}
                </Text>
                {s.setAside.note !== '' && (
                  <Text style={styles.meta} numberOfLines={2}>
                    {`“${s.setAside.note}”`}
                  </Text>
                )}
              </View>
              {reviewLink(s)}
              <Pressable
                testID={`supplier-ask-anyway-${s.supplierDid}`}
                style={[styles.askAnyway, full && styles.disabled]}
                disabled={full}
                onPress={() => toggle(s)}
                accessibilityRole="button"
                accessibilityLabel={`Ask ${labelOf(s)} anyway`}
                accessibilityState={{ disabled: full }}
              >
                <Text style={styles.askAnywayLabel}>Ask anyway</Text>
              </Pressable>
            </View>
          );
        }
        return (
          <View key={keyOf(s)} style={[styles.row, picked && styles.rowPicked]}>
            <Pressable
              testID={`supplier-result-${s.supplierDid}`}
              style={[styles.rowPick, full && styles.disabled]}
              disabled={full}
              onPress={() => toggle(s)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: picked, disabled: full }}
            >
              <View style={styles.rowText}>
                <Text style={styles.name}>
                  {labelOf(s)}
                  {s.preferred ? ' · preferred' : ''}
                </Text>
                <Text style={styles.meta}>
                  {s.setAside !== null
                    ? `⚠ ${s.setAside.words} · asked anyway`
                    : trustWords(s.trustScore)}
                  {s.itemsMatched > 0
                    ? ` · ${String(s.itemsMatched)} matching item${s.itemsMatched === 1 ? '' : 's'}`
                    : ''}
                  {price !== null ? ` · ${price}` : ''}
                </Text>
              </View>
              <Text style={styles.tick}>{picked ? '✓' : ''}</Text>
            </Pressable>
            {reviewLink(s)}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: { ...textStyles.caption, color: colors.bgPrimary },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...textStyles.body,
  },
  searchButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  searchLabel: { ...textStyles.button, color: colors.bgPrimary },
  spinner: { marginTop: spacing.md },
  meta: { ...textStyles.caption, color: colors.textSecondary, marginTop: spacing.xs },
  error: { ...textStyles.body, color: colors.error, marginTop: spacing.sm },
  empty: { ...textStyles.body, color: colors.textSecondary, marginTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowPicked: { borderColor: colors.accent },
  rowPick: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  reviewLink: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginLeft: spacing.xs,
  },
  reviewLinkText: { ...textStyles.caption, color: colors.accent },
  rowSetAside: { opacity: 0.75, borderColor: colors.warning },
  warning: { ...textStyles.caption, color: colors.warning, marginTop: spacing.xs },
  askAnyway: {
    borderWidth: 1,
    borderColor: colors.textSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginLeft: spacing.sm,
  },
  askAnywayLabel: { ...textStyles.caption, color: colors.textPrimary },
  rowText: { flex: 1 },
  name: { ...textStyles.body, color: colors.textPrimary },
  tick: { ...textStyles.body, color: colors.accent, width: 20, textAlign: 'right' },
  disabled: { opacity: 0.5 },
});
