/**
 * Shopping profile and key (UCP plan §3.5, §4.8; U7), at the foot of Settings
 * → Shopping: whether shops can find the profile, which device handles
 * shopping, the key in use, and the owner's four actions. "Use this device
 * for shopping" and "My key may be compromised" ask the owner to confirm it
 * is them; the second also asks for a second tap, since it ends the key for
 * good. Core does the work; this only says what it reports.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePresenceGate } from '../hooks/usePresenceGate';
import { getOwnerCommerceClient } from '../services/owner_commerce_client';
import { ownerErrorText } from '../services/owner_errors';
import { getOwnerUcpClient } from '../services/owner_ucp_client';
import {
  publicationActions,
  publicationDetailText,
  publicationSettling,
  publicationStatusText,
  shoppingKeyText,
} from '../services/ucp_publication_words';
import { colors, radius, spacing, textStyles } from '../theme';

import { PresenceSheet } from './PresenceSheet';

import type { UcpPublicationAction, UcpPublicationView } from '@dina/core';

const LABELS: Record<UcpPublicationAction, string> = {
  activate: 'Use this device for shopping',
  turn_off: 'Turn shopping off',
  rotate: 'Rotate my shopping key',
  compromised: 'My key may be compromised',
};

export function ShoppingKey(): React.JSX.Element | null {
  const [view, setView] = useState<UcpPublicationView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "My key may be compromised" waits for a second tap. */
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const client = getOwnerUcpClient();
    if (client === null) return;
    // A read that fails keeps what is shown; only "this node runs no UCP" (null) hides it.
    const read = await client.publication().catch(() => undefined);
    if (read !== undefined) setView(read);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // While something is moving (a retry, a rotation's wait), read again every 30 s.
  const settling = view !== null && publicationSettling(view);
  useEffect(() => {
    if (!settling) return undefined;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [settling, load]);

  const { run: runGated, sheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => setNote(ownerErrorText(err)),
    // After every attempt (done, failed, or cancelled): show what Core holds now.
    onSettled: () => void load(),
    reason: 'This changes which device or key shops trust, so Dina checks a person is here.',
  });

  const act = useCallback(
    async (action: UcpPublicationAction) => {
      const client = getOwnerUcpClient();
      if (client === null) return;
      setBusy(true);
      setNote(null);
      setConfirming(false);
      await runGated(async () => {
        setView(await client.publicationAction(action));
      });
      setBusy(false);
    },
    [runGated],
  );

  // Not running UCP here: nothing to show.
  if (view === null) return null;
  const can = publicationActions(view);
  const button = (action: UcpPublicationAction, shown: boolean, onPress: () => void) =>
    shown && (
      <Pressable
        key={action}
        testID={`shopping-key-${action}`}
        accessibilityRole="button"
        style={[styles.button, busy && styles.disabled]}
        disabled={busy}
        accessibilityState={{ disabled: busy }}
        onPress={onPress}
      >
        <Text style={styles.buttonLabel}>
          {action === 'compromised' && confirming
            ? 'Tap again: replace the key now'
            : LABELS[action]}
        </Text>
      </Pressable>
    );

  return (
    <View style={styles.box} testID="shopping-key">
      <Text style={styles.heading}>Shopping profile and key</Text>
      <Text style={styles.value} testID="shopping-key-status">
        {publicationStatusText(view)}
      </Text>
      {publicationDetailText(view) !== null && (
        <Text style={styles.meta} testID="shopping-key-detail">
          {publicationDetailText(view)}
        </Text>
      )}
      {shoppingKeyText(view).map((line) => (
        <Text key={line} style={styles.meta}>
          {line}
        </Text>
      ))}
      {button('activate', can.activate, () => void act('activate'))}
      {button('rotate', can.rotate, () => void act('rotate'))}
      {button('turn_off', can.turnOff, () => void act('turn_off'))}
      {confirming && (
        <Text style={styles.meta} testID="shopping-key-confirm">
          The current key is retired for good and Dina starts a new one at once. For up to five
          minutes a shop may still hold the old profile and refuse Dina's requests.
        </Text>
      )}
      {button('compromised', can.compromised, () =>
        confirming ? void act('compromised') : setConfirming(true),
      )}
      {note !== null && (
        <Text style={styles.note} testID="shopping-key-note">
          {note}
        </Text>
      )}
      <PresenceSheet {...sheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm, marginTop: spacing.md },
  heading: { ...textStyles.caption, color: colors.textSecondary, textTransform: 'uppercase' },
  value: { ...textStyles.body, color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  note: { ...textStyles.caption, color: colors.textPrimary },
  button: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  disabled: { opacity: 0.5 },
  buttonLabel: { ...textStyles.button, color: colors.accent },
});
