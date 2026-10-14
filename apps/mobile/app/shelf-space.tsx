/**
 * Shelf space — the hub (docs/SHELF_SPACE_NEGOTIATION.md).
 *
 * One screen for both sides of a slot deal:
 *
 *   - A STORE lists its open slots (a public record with no price in it),
 *     sets its terms and rules on the terms screen, and sees its agreements.
 *   - A BRAND finds slots, asks for one, and follows its requests. Dina
 *     bargains inside the brand's limits; the brand's owner is asked once, when
 *     an offer is ready.
 *
 * Every number on this screen comes from this node's own Core. A directory
 * (Zeev) sees listings only — never a rent, a share, a floor or a deal.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import {
  activateSlotPack,
  slotPackStatus,
  type BuyerInstallStatus,
  type SlotSide,
} from '../src/services/commerce_install';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { isPresenceRefusal, ownerErrorText } from '../src/services/owner_errors';
import {
  categoryLabel,
  CLOSE_REASON_LABELS,
  DELIVERY_LABELS,
  findSlots,
  NEGOTIATION_STATE_LABELS,
  SHELF_CATEGORIES,
  SLOT_KINDS,
  termsText,
} from '../src/services/shelf_space';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { TermListingCandidate } from '@dina/brain';
import type { TermListing } from '@dina/commerce-protocol';
import type {
  RankedTermOffer,
  TermAgreementSummary,
  TermListingView,
  TermNegotiationView,
  TermPolicy,
} from '@dina/core';

interface ShopState {
  /** Each side of the Slot Pack is its own install and consent (§4). */
  packs: Record<SlotSide, BuyerInstallStatus>;
  policy: TermPolicy;
  listings: TermListingView[];
  agreements: TermAgreementSummary[];
  negotiations: TermNegotiationView[];
  ranked: RankedTermOffer[];
}

export default function ShelfSpaceScreen(): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<ShopState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Publish form
  const [slotRef, setSlotRef] = useState('');
  const [kind, setKind] = useState('shelf');
  const [postal, setPostal] = useState('');
  const [wanted, setWanted] = useState<string[]>([]);
  // Find form
  const [findTag, setFindTag] = useState<string | null>(null);
  const [findPostal, setFindPostal] = useState('');
  const [found, setFound] = useState<TermListingCandidate[] | null>(null);
  const [finding, setFinding] = useState(false);

  const load = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) return;
    try {
      const [seller, buyer, policy, listings, agreements, negotiations] = await Promise.all([
        slotPackStatus('seller'),
        slotPackStatus('buyer'),
        client.termPolicy(),
        client.termListings(),
        client.termAgreements(),
        client.termNegotiations(),
      ]);
      setState({
        packs: { seller, buyer },
        policy: policy.policy,
        listings: listings.listings,
        agreements: agreements.agreements,
        negotiations: negotiations.negotiations,
        ranked: negotiations.ranked,
      });
      setError(null);
    } catch (err) {
      setError(ownerErrorText(err));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => setError(ownerErrorText(err)),
    reason:
      'Turning on shelf space, or publishing or withdrawing a public listing, needs a person here.',
  });

  const turnOn = useCallback(
    (side: SlotSide) => {
      setNotice(null);
      setError(null);
      // A presence refusal is raised by activateSlotPack, so the sheet asks
      // and the whole ceremony runs again from the start.
      void runGated(async () => {
        const outcome = await activateSlotPack(side);
        if (!outcome.ok) {
          setError(ownerErrorText({ errorKey: outcome.error }));
          return;
        }
        await load();
      });
    },
    [load, runGated],
  );

  const toggleWanted = (tag: string): void => {
    setWanted((now) => (now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag]));
  };

  const publish = useCallback(() => {
    setNotice(null);
    setError(null);
    if (slotRef === '' || postal.trim() === '' || wanted.length === 0) {
      setError('Pick a slot, give its postal code, and choose the categories you want.');
      return;
    }
    void runGated(async () => {
      const client = getOwnerCommerceClient();
      if (client === null) return;
      try {
        await client.publishTermListing({
          resource_ref: slotRef,
          kind,
          region: { scheme: 'postal_area', value: postal.trim().toUpperCase() },
          tags: wanted,
        });
        setNotice('Listed. Brands can now find this slot; they never see your terms.');
        await load();
      } catch (err) {
        if (isPresenceRefusal(err)) throw err;
        setError(ownerErrorText(err));
      }
    });
  }, [kind, load, postal, runGated, slotRef, wanted]);

  const withdraw = useCallback(
    (listingId: string) => {
      setNotice(null);
      setError(null);
      void runGated(async () => {
        const client = getOwnerCommerceClient();
        if (client === null) return;
        try {
          const done = await client.withdrawTermListing(listingId);
          // Withdrawn here at once, so no new request binds to it; the public
          // record may still stand if the directory could not be reached.
          setNotice(
            done.record_removed
              ? 'Withdrawn. No new brand can ask for it.'
              : 'Withdrawn here, so no brand can ask for it — but its public listing could not be removed yet.',
          );
          await load();
        } catch (err) {
          if (isPresenceRefusal(err)) throw err;
          setError(ownerErrorText(err));
        }
      });
    },
    [load, runGated],
  );

  const search = useCallback(async () => {
    setFinding(true);
    setError(null);
    try {
      setFound(
        await findSlots({
          ...(findTag !== null ? { tag: findTag } : {}),
          ...(findPostal.trim() !== ''
            ? {
                region_scheme: 'postal_area' as const,
                region_value: findPostal.trim().toUpperCase(),
              }
            : {}),
        }),
      );
    } catch (err) {
      setError(ownerErrorText(err));
    } finally {
      setFinding(false);
    }
  }, [findPostal, findTag]);

  if (state === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="shelf-space-loading">
        <Stack.Screen options={{ title: 'Shelf space' }} />
        {error !== null ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  const published = state.listings.filter((l) => l.state === 'published');
  return (
    <View style={styles.container} testID="shelf-space-screen">
      <Stack.Screen options={{ title: 'Shelf space' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error !== null && (
          <Text style={styles.error} testID="shelf-space-error">
            {error}
          </Text>
        )}
        {notice !== null && <Text style={styles.notice}>{notice}</Text>}

        <Text style={styles.heading}>Your shop</Text>
        {/* Shown whatever the store's half is doing: a listing still out there,
            or a public record still standing, needs its Withdraw / Remove
            most when renting has been switched off. */}
        {state.listings
          .filter((l) => l.state === 'withdrawn' && l.recordPublic)
          .map(({ listing: { listing_id: id } }) => (
            <View key={`unremoved-${id}`} style={styles.card} testID={`shelf-unremoved-${id}`}>
              <Text style={styles.cardLine}>
                {id}: a public record may still show. Brands who find it are refused.
              </Text>
              <Pressable
                onPress={() => withdraw(id)}
                accessibilityRole="button"
                testID={`shelf-unremoved-${id}-retry`}
              >
                <Text style={styles.link}>Remove</Text>
              </Pressable>
            </View>
          ))}
        {published.map(({ listing }) => (
          <View
            key={listing.listing_id}
            style={styles.card}
            testID={`shelf-listing-${listing.listing_id}`}
          >
            <Text style={styles.cardTitle}>
              {listing.resource_ref} ·{' '}
              {SLOT_KINDS.find((k) => k.kind === listing.kind)?.label ?? listing.kind}
            </Text>
            <Text style={styles.cardLine}>Wants: {listing.tags.map(categoryLabel).join(', ')}</Text>
            <Text style={styles.cardLine}>
              Free {listing.available.from.slice(0, 10)} to {listing.available.to.slice(0, 10)}
            </Text>
            <Pressable
              onPress={() => withdraw(listing.listing_id)}
              accessibilityRole="button"
              testID={`shelf-withdraw-${listing.listing_id}`}
            >
              <Text style={styles.link}>Withdraw</Text>
            </Pressable>
          </View>
        ))}
        {state.packs.seller.state !== 'active' ? (
          <TurnOnCard side="seller" status={state.packs.seller} onPress={() => turnOn('seller')} />
        ) : (
          <>
            <Text style={styles.sub}>
              {state.policy.enabled
                ? `Renting out ${String(state.policy.resources.length)} slot(s). Brands ${state.policy.access === 'anyone' ? 'may ask without an introduction' : 'you do not know need your yes first'}.`
                : 'Renting out slots is off.'}
            </Text>
            <Pressable
              style={styles.button}
              onPress={() => router.push('/shelf-terms')}
              accessibilityRole="button"
              testID="shelf-terms-open"
            >
              <Text style={styles.buttonText}>Terms and rules</Text>
            </Pressable>

            {state.policy.enabled && state.policy.resources.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>List a slot</Text>
                <View style={styles.chips}>
                  {state.policy.resources.map((r) => (
                    <Pressable
                      key={r.resource_ref}
                      style={[styles.chip, slotRef === r.resource_ref && styles.chipOn]}
                      onPress={() => setSlotRef(r.resource_ref)}
                      testID={`shelf-publish-slot-${r.resource_ref}`}
                    >
                      <Text style={styles.chipText}>{r.resource_ref}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.chips}>
                  {SLOT_KINDS.map((k) => (
                    <Pressable
                      key={k.kind}
                      style={[styles.chip, kind === k.kind && styles.chipOn]}
                      onPress={() => setKind(k.kind)}
                      testID={`shelf-publish-kind-${k.kind}`}
                    >
                      <Text style={styles.chipText}>{k.label}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  style={styles.input}
                  value={postal}
                  onChangeText={setPostal}
                  placeholder="Postal code"
                  placeholderTextColor={colors.textMuted}
                  testID="shelf-publish-postal"
                />
                <Text style={styles.cardLine}>Categories you want</Text>
                <View style={styles.chips}>
                  {SHELF_CATEGORIES.map((c) => (
                    <Pressable
                      key={c.tag}
                      style={[styles.chip, wanted.includes(c.tag) && styles.chipOn]}
                      onPress={() => toggleWanted(c.tag)}
                      testID={`shelf-publish-tag-${c.tag}`}
                    >
                      <Text style={styles.chipText}>{c.label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.small}>
                  The listing is public. It carries no rent, share or rule of yours.
                </Text>
                <Pressable
                  style={styles.button}
                  onPress={publish}
                  accessibilityRole="button"
                  testID="shelf-publish"
                >
                  <Text style={styles.buttonText}>Publish listing</Text>
                </Pressable>
              </View>
            )}
          </>
        )}

        <Text style={styles.heading}>Agreements</Text>
        {state.agreements.length === 0 && <Text style={styles.sub}>None yet.</Text>}
        {state.agreements.map((a) => (
          <Pressable
            key={a.proposalDigest}
            style={styles.card}
            onPress={() =>
              router.push({ pathname: '/shelf-agreement', params: { digest: a.proposalDigest } })
            }
            accessibilityRole="button"
            testID={`shelf-agreement-${a.proposalDigest.slice(0, 12)}`}
          >
            <Text style={styles.cardTitle}>
              {a.role === 'host' ? 'You rent out' : 'You rent'} {a.resourceRef} ·{' '}
              {categoryLabel(a.general.tag)}
            </Text>
            <Text style={styles.cardLine}>{termsText(a.terms, a.general)}</Text>
            <Text style={styles.cardLine}>
              {a.state === 'accepted'
                ? `Until ${(a.endsAt ?? a.general.end).slice(0, 10)}`
                : a.state === 'proposed'
                  ? a.role === 'host'
                    ? 'Waiting for your yes in Notifications'
                    : 'Waiting for the store’s answer'
                  : 'Not agreed'}
            </Text>
            {a.delivery !== null && a.delivery !== undefined && (
              <Text
                style={styles.cardLine}
                testID={`shelf-agreement-${a.proposalDigest.slice(0, 12)}-delivery`}
              >
                {a.role === 'host' ? 'Your answer' : 'Your proposal'}:{' '}
                {DELIVERY_LABELS[a.delivery] ?? a.delivery}
              </Text>
            )}
          </Pressable>
        ))}

        <Text style={styles.heading}>Find a slot</Text>
        {state.packs.buyer.state !== 'active' ? (
          <TurnOnCard side="buyer" status={state.packs.buyer} onPress={() => turnOn('buyer')} />
        ) : (
          <>
            <View style={styles.chips}>
              {SHELF_CATEGORIES.map((c) => (
                <Pressable
                  key={c.tag}
                  style={[styles.chip, findTag === c.tag && styles.chipOn]}
                  onPress={() => setFindTag(findTag === c.tag ? null : c.tag)}
                  testID={`shelf-find-tag-${c.tag}`}
                >
                  <Text style={styles.chipText}>{c.label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.flex]}
                value={findPostal}
                onChangeText={setFindPostal}
                placeholder="Postal code"
                placeholderTextColor={colors.textMuted}
                testID="shelf-find-postal"
              />
              <Pressable
                style={styles.buttonSmall}
                onPress={() => void search()}
                accessibilityRole="button"
                testID="shelf-find"
              >
                <Text style={styles.buttonText}>Find</Text>
              </Pressable>
            </View>
            {finding && <ActivityIndicator />}
            {found !== null && found.length === 0 && (
              <Text style={styles.sub}>No slots match.</Text>
            )}
            {(found ?? []).map((candidate) => {
              const listing = candidate.listing as Partial<TermListing>;
              return (
                <Pressable
                  key={candidate.uri}
                  style={styles.card}
                  onPress={() =>
                    router.push({ pathname: '/shelf-request', params: { listing: candidate.uri } })
                  }
                  accessibilityRole="button"
                  testID={`shelf-found-${listing.listing_id ?? candidate.uri}`}
                >
                  <Text style={styles.cardTitle}>
                    {listing.resource_ref ?? 'A slot'} ·{' '}
                    {SLOT_KINDS.find((k) => k.kind === listing.kind)?.label ?? listing.kind}
                  </Text>
                  <Text style={styles.cardLine}>
                    Wants: {(listing.tags ?? []).map(categoryLabel).join(', ')}
                  </Text>
                  <Text style={styles.cardLine}>{listing.region?.value ?? ''}</Text>
                </Pressable>
              );
            })}
          </>
        )}

        <Text style={styles.heading}>Your requests</Text>
        {state.negotiations.length === 0 && <Text style={styles.sub}>None yet.</Text>}
        {state.negotiations.map((n) => {
          const rank = state.ranked.findIndex((r) => r.requestId === n.requestId);
          const ranked = rank >= 0 ? state.ranked[rank] : undefined;
          return (
            <View key={n.requestId} style={styles.card} testID={`shelf-negotiation-${n.requestId}`}>
              <Text style={styles.cardTitle}>{NEGOTIATION_STATE_LABELS[n.state] ?? n.state}</Text>
              {n.head !== null && (
                <Text style={styles.cardLine}>{termsText(n.head.terms, n.head.general)}</Text>
              )}
              {ranked?.costPerPeriodMinor !== undefined && n.head !== null && (
                <Text style={styles.cardLine}>
                  #{String(rank + 1)} by expected cost a{' '}
                  {ranked.costPeriod === 'weekly' ? 'week' : 'month'}
                </Text>
              )}
              {n.state === 'closed' && (
                <Text style={styles.cardLine}>
                  {CLOSE_REASON_LABELS[n.closeReason] ?? n.closeReason}
                </Text>
              )}
              {n.state === 'ready' && (
                <Text style={styles.cardLine}>Your yes is waiting in Notifications.</Text>
              )}
              {n.proposalDelivery !== null && n.proposalDelivery !== undefined && (
                <Text style={styles.cardLine} testID={`shelf-negotiation-${n.requestId}-delivery`}>
                  Your proposal: {DELIVERY_LABELS[n.proposalDelivery] ?? n.proposalDelivery}
                </Text>
              )}
            </View>
          );
        })}
      </ScrollView>
      <PresenceSheet {...presenceSheet} />
    </View>
  );
}

const TURN_ON_TEXT: Record<SlotSide, { title: string; body: string; button: string }> = {
  seller: {
    title: 'Rent out shelf space',
    body: 'Turns on the Slot Pack for your store: Dina bargains with brands inside the floors you set, and you approve every deal.',
    button: 'Turn on for my store',
  },
  buyer: {
    title: 'Rent shelf space',
    body: 'Turns on the Slot Pack for your brand: Dina bargains with stores inside the limits you set, and you approve every deal.',
    button: 'Turn on for my brand',
  },
};

function TurnOnCard(props: {
  side: SlotSide;
  status: BuyerInstallStatus;
  onPress: () => void;
}): React.ReactElement {
  const text = TURN_ON_TEXT[props.side];
  return (
    <View style={styles.card} testID={`shelf-turn-on-${props.side}-card`}>
      <Text style={styles.cardTitle}>{text.title}</Text>
      <Text style={styles.cardLine}>{text.body}</Text>
      {props.status.state === 'unavailable' ? (
        <Text style={styles.cardLine}>Not available yet: {props.status.reason}</Text>
      ) : (
        <Pressable
          style={styles.button}
          onPress={props.onPress}
          accessibilityRole="button"
          testID={`shelf-turn-on-${props.side}`}
        >
          <Text style={styles.buttonText}>{text.button}</Text>
        </Pressable>
      )}
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
  },
  buttonSmall: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  buttonText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  link: { ...textStyles.caption, color: colors.accent, fontWeight: '600' },
  error: { ...textStyles.body, color: colors.error },
  notice: { ...textStyles.body, color: colors.textSecondary },
});
