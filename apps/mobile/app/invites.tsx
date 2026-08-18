/**
 * Invites — the §8 ceremony's owner surface: mint an offer (one consent
 * tap → a paste/QR string), redeem a pasted code, act on HELD cold
 * offers, and read where every exchange stands.
 */

import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { OwnerCommerceHttpError } from '@dina/core';

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
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
  const [presencePrompt, setPresencePrompt] = useState<{ retry: () => Promise<void> } | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const reload = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setLoading(false);
      return;
    }
    try {
      const answer = await client.listInvites();
      setInvites(answer.invites);
    } catch {
      // The list is best-effort surface; actions report their own errors.
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  /** Run the mint; on `no_user_presence` raise the passphrase sheet. */
  const withPresence = useCallback(
    async (operation: () => Promise<void>) => {
      setMinting(true);
      try {
        await operation();
      } catch (err) {
        if (err instanceof OwnerCommerceHttpError && err.errorKey === 'no_user_presence') {
          setPresencePrompt({ retry: operation });
        } else {
          Alert.alert('Could not create the invite', (err as Error).message);
        }
      } finally {
        setMinting(false);
        void reload();
      }
    },
    [reload],
  );

  const submitPresence = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null || presencePrompt === null) return;
    const retry = presencePrompt.retry;
    setMinting(true);
    try {
      await client.provePresence(passphrase);
      setPresencePrompt(null);
      setPassphrase('');
      await retry();
    } catch {
      Alert.alert('Not verified', 'That passphrase did not verify. Try again.');
    } finally {
      setMinting(false);
      void reload();
    }
  }, [passphrase, presencePrompt, reload]);

  const mint = useCallback(
    (direction: 'i_supply_you' | 'you_supply_me') => {
      const client = getOwnerCommerceClient();
      if (client === null) return;
      void withPresence(async () => {
        const minted = await client.mintInvite({
          direction,
          serviceRkeys: ['self'],
        });
        await Share.share({ message: minted.code });
      });
    },
    [withPresence],
  );

  const redeem = useCallback(() => {
    void (async () => {
      const client = getOwnerCommerceClient();
      if (client === null || code.trim() === '') return;
      setRedeeming(true);
      try {
        await client.redeemInvite({ code: code.trim(), serviceRkeys: ['self'] });
        setCode('');
        Alert.alert('Invite accepted', 'The relationship activates once both sides confirm.');
      } catch (err) {
        Alert.alert('Could not redeem', (err as Error).message);
      } finally {
        setRedeeming(false);
        void reload();
      }
    })();
  }, [code, reload]);

  const acceptHeld = useCallback(
    (entry: InviteListEntry, nonce: string) => {
      Alert.alert(
        'Accept this introduction?',
        `${shortDid(entry.counterparty_did)} wants a trading relationship (${entry.direction === 'you_supply_me' ? 'you supply them' : 'they supply you'}).`,
        [
          { text: 'Ignore', style: 'cancel' },
          {
            text: 'Accept',
            onPress: () => {
              void (async () => {
                try {
                  await getOwnerCommerceClient()?.acceptHeldInvite({
                    nonce,
                    serviceRkeys: ['self'],
                  });
                } catch (err) {
                  Alert.alert('Could not accept', (err as Error).message);
                }
                void reload();
              })();
            },
          },
        ],
      );
    },
    [reload],
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
            No invites yet.
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
                {entry.counterparty_did === '' ? 'Unredeemed offer' : shortDid(entry.counterparty_did)}
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

      {/* §8 — minting hands standing authority to whoever redeems it. */}
      <Modal visible={presencePrompt !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="presence-sheet">
            <Text style={styles.sectionTitle}>Confirm it’s you</Text>
            <Text style={styles.hint}>
              An invite hands its redeemer real standing, so Dina checks a person is here.
            </Text>
            <TextInput
              testID="presence-passphrase"
              style={styles.input}
              secureTextEntry
              placeholder="Your passphrase"
              placeholderTextColor={colors.textSecondary}
              value={passphrase}
              onChangeText={setPassphrase}
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => {
                  setPresencePrompt(null);
                  setPassphrase('');
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable testID="presence-submit" onPress={() => void submitPresence()}>
                <Text style={styles.link}>Verify</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  link: { ...textStyles.body, color: colors.core },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
});
