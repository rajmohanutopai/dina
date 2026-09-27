/**
 * Invites — the §8 ceremony's owner surface: mint an offer (one consent
 * tap → a paste/QR string), redeem a pasted code, act on HELD cold
 * offers, and read where every exchange stands.
 */

import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { confirmDecision } from '../src/services/confirm_decision';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { isPresenceRefusal, ownerErrorText } from '../src/services/owner_errors';
import { showMessage } from '../src/services/show_message';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { InviteListEntry } from '@dina/core';

const STATE_LABEL: Record<InviteListEntry['state'], string> = {
  offered: 'Waiting to be redeemed',
  held: 'Cold offer — needs your decision',
  redeemed: 'Redeemed, activating',
  active: 'Active',
  revoked: 'Ended',
};

function shortDid(did: string): string {
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}

export default function InvitesScreen(): React.ReactElement {
  const [invites, setInvites] = useState<InviteListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  /** The code just minted, shown so it can be copied where sharing is unavailable. */
  const [minted, setMinted] = useState<string | null>(null);
  /** Why the list could not load (a browser not connected as the owner). */
  const [listError, setListError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setLoading(false);
      return;
    }
    try {
      const answer = await client.listInvites();
      setInvites(answer.invites);
      setListError(null);
    } catch (err) {
      setListError(ownerErrorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // §8 — minting, redeeming and accepting an introduction all create a
  // trading relationship that carries standing access: presence-gated.
  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => showMessage('Could not do that', ownerErrorText(err)),
    onSettled: () => void reload(),
    reason: 'An invite creates a trading relationship, so Dina checks a person is here.',
  });

  /** Run a gated invite action; a failure other than presence is said under `title`. */
  const gated = useCallback(
    (title: string, operation: () => Promise<void>) =>
      runGated(async () => {
        try {
          await operation();
        } catch (err) {
          if (isPresenceRefusal(err)) throw err;
          showMessage(title, ownerErrorText(err));
        }
      }),
    [runGated],
  );

  const mint = useCallback(
    (direction: 'i_supply_you' | 'you_supply_me') => {
      const client = getOwnerCommerceClient();
      if (client === null) return;
      setMinting(true);
      void gated('Could not create the invite', async () => {
        const answer = await client.mintInvite({
          direction,
          serviceRkeys: ['self'],
        });
        setMinted(answer.code);
        // The code is on screen either way; the share sheet is a shortcut
        // (most desktop browsers have none).
        await Share.share({ message: answer.code }).catch(() => undefined);
      }).finally(() => setMinting(false));
    },
    [gated],
  );

  const redeem = useCallback(() => {
    const client = getOwnerCommerceClient();
    const typed = code.trim();
    if (client === null || typed === '') return;
    setRedeeming(true);
    void gated('Could not redeem', async () => {
      await client.redeemInvite({ code: typed, serviceRkeys: ['self'] });
      setCode('');
      showMessage('Invite accepted', 'The relationship activates once both sides confirm.');
    }).finally(() => setRedeeming(false));
  }, [code, gated]);

  const acceptHeld = useCallback(
    (entry: InviteListEntry, nonce: string) => {
      void (async () => {
        const accept = await confirmDecision(
          'Accept this introduction?',
          `${shortDid(entry.counterparty_did)} wants a trading relationship (${entry.direction === 'you_supply_me' ? 'you supply them' : 'they supply you'}).`,
          'Accept',
          false,
          'Ignore',
        );
        if (!accept) return;
        const client = getOwnerCommerceClient();
        if (client === null) return;
        await gated('Could not accept', async () => {
          await client.acceptHeldInvite({ nonce, serviceRkeys: ['self'] });
        });
      })();
    },
    [gated],
  );
  return (
    <View style={styles.container} testID="invites-screen">
      <Stack.Screen options={{ title: 'Invites' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionTitle}>Invite a counterparty</Text>
        <View style={styles.laneRow}>
          <Pressable
            style={styles.mintButton}
            disabled={minting}
            testID="invite-mint-supplier"
            onPress={() => mint('you_supply_me')}
          >
            <Text style={styles.mintLabel}>They supply me</Text>
          </Pressable>
          <Pressable
            style={styles.mintButton}
            disabled={minting}
            testID="invite-mint-buyer"
            onPress={() => mint('i_supply_you')}
          >
            <Text style={styles.mintLabel}>I supply them</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          One tap creates a single-use code to share on WhatsApp or as a QR. Redeeming it is their
          consent; nothing activates until both sides confirm.
        </Text>
        {minted !== null && (
          <View style={styles.mintedBox}>
            <Text style={styles.hint}>Your invite code (single use):</Text>
            <Text style={styles.mintedCode} selectable testID="invite-minted-code">
              {minted}
            </Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>Redeem a code</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="dinainvite1:…"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          testID="invite-code-input"
        />
        <Pressable
          style={[styles.redeemButton, (redeeming || code.trim() === '') && styles.busy]}
          disabled={redeeming || code.trim() === ''}
          onPress={redeem}
          testID="invite-redeem"
        >
          {redeeming ? (
            <ActivityIndicator color={colors.bgPrimary} />
          ) : (
            <Text style={styles.mintLabel}>Redeem</Text>
          )}
        </Pressable>

        <Text style={styles.sectionTitle}>Relationships</Text>
        {loading && <ActivityIndicator style={styles.spinner} />}
        {!loading && invites.length === 0 && (
          <Text style={styles.empty} testID="invites-empty">
            {listError ?? 'No invites yet.'}
          </Text>
        )}
        {invites.map((entry, index) => (
          <Pressable
            key={`${entry.counterparty_did}-${String(index)}`}
            style={styles.row}
            disabled={entry.state !== 'held' || entry.nonce === undefined}
            onPress={() => {
              if (entry.nonce !== undefined) acceptHeld(entry, entry.nonce);
            }}
            testID={`invite-row-${String(index)}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>
                {entry.counterparty_did === ''
                  ? 'Unredeemed offer'
                  : shortDid(entry.counterparty_did)}
              </Text>
              <Text style={styles.rowMeta}>
                {STATE_LABEL[entry.state]}
                {/* Only the REDEEMER waits for the activation pong; an
                    inviter's active row is simply active, so "confirming"
                    on it read as a state that never resolved. */}
                {entry.state === 'active' && entry.role === 'redeemer' && !entry.activation_proven
                  ? ' · confirming'
                  : ''}
                {entry.state === 'held' ? ' · tap to decide' : ''}
              </Text>
            </View>
            <Text style={styles.chip}>
              {entry.direction === 'you_supply_me' ? 'supplier' : 'buyer'}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <PresenceSheet {...presenceSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  laneRow: { flexDirection: 'row', gap: spacing.sm },
  mintButton: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  mintLabel: { ...textStyles.button, color: colors.bgPrimary },
  hint: { ...textStyles.caption, color: colors.textSecondary, marginTop: spacing.sm },
  input: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...textStyles.body,
  },
  redeemButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  busy: { opacity: 0.6 },
  spinner: { marginTop: spacing.md },
  empty: { ...textStyles.body, color: colors.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowText: { flex: 1 },
  rowTitle: { ...textStyles.body, color: colors.textPrimary },
  rowMeta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  chip: { ...textStyles.caption, color: colors.accent },
  mintedBox: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  mintedCode: { ...textStyles.body, color: colors.textPrimary, fontFamily: 'monospace' },
});
