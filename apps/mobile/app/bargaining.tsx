/**
 * Who bargains for you — the strategy setting per kind of deal
 * (docs/COMMITMENT_KERNEL.md §11, §15 step 11).
 *
 * Each kind of deal is bargained by Dina's fixed rules unless the owner
 * chooses Brain. Brain then plays inside the same limits Core holds: it never
 * sees the walk-away point, the limits or the totals, and every agreement the
 * owner would have confirmed still comes to them. Before a change is saved
 * the screen shows Core's own words on what Brain, and the AI provider, will
 * see. Saving needs a person present.
 *
 * A goods seller also picks here how much of a cheaper day's saving to pass
 * on; with Brain chosen they may leave that to Brain.
 *
 * Each kind loads on its own, so one that cannot be read leaves the others
 * usable (above all, switching Brain off). The screen reloads when it comes
 * back into view; a reply older than the latest read is dropped. One change
 * goes at a time: every control waits while a save, or its presence check,
 * is under way.
 */

import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { isPresenceRefusal, ownerErrorText } from '../src/services/owner_errors';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { StrategySettingView } from '@dina/core';

/** The kinds of deal, in the owner's words, and what Brain does in each. */
export const BARGAINING_KINDS: readonly { kind: string; title: string; brain: string }[] = [
  {
    kind: 'goods.buyer',
    title: 'Buying stock',
    brain: 'Brain picks each counter-offer, never below your target and never above your budget.',
  },
  {
    kind: 'goods.seller',
    title: 'Selling stock',
    brain: 'Brain sets how much of a cheaper delivery day’s saving goes to the buyer.',
  },
  {
    kind: 'delivery.shipper',
    title: 'Delivering for other businesses',
    brain:
      'Brain sets the fee for a run, between the least you agree to alone and your asking fee.',
  },
  {
    kind: 'shelf_space.host',
    title: 'Renting out shelf space',
    brain: 'Brain makes the first offer and answers counters, never below your floors.',
  },
  {
    kind: 'shelf_space.vendor',
    title: 'Renting shelf space',
    brain: 'Brain answers the store’s offers. Every agreement still comes to you.',
  },
  {
    kind: 'group.organizer',
    title: 'Arranging group bookings',
    brain: 'Brain picks the time among those every required guest accepted.',
  },
];

const SHARES = [
  { option: 'third', label: 'A third' },
  { option: 'half', label: 'Half' },
  { option: 'most', label: 'Most' },
] as const;

type Share = (typeof SHARES)[number]['option'];
interface Draft {
  strategy: 'fixed' | 'brain';
  valuesOn: boolean;
}

/** The share in use, in words. */
function shareInUse(
  share: NonNullable<StrategySettingView['saving_share']>,
  strategy: 'fixed' | 'brain',
): string {
  switch (share.set_by) {
    case 'brain':
      return `Brain passes on ${String(Math.round(share.share_bps / 100))}% of the saving.`;
    case 'closed':
      return share.personas.length === 1
        ? `Some of your selling rules are in /${share.personas[0] ?? ''}, which is closed now. Dina sends no quotes until you open it.`
        : `Some of your selling rules are in ${share.personas.map((p) => `/${p}`).join(', ')}, which are closed now. Dina sends no quotes until you open them.`;
    case 'unreadable':
      return 'Dina cannot read your selling rules now, so it sends no quotes.';
    default: {
      const label = SHARES.find((s) => s.option === share.option)?.label ?? 'Half';
      if (share.set_by === 'owner') return `${label} of the saving, as you chose.`;
      return strategy === 'brain'
        ? `${label} of the saving, until Brain sets a share.`
        : `${label} of the saving, the starting point until you choose.`;
    }
  }
}

/** One kind as last read: its setting, or why it could not be read. */
type Loaded = { view: StrategySettingView } | { error: string };

export default function BargainingScreen(): React.ReactElement {
  const [loaded, setLoaded] = useState<Record<string, Loaded> | null>(null);
  /** The change the owner is looking at for one kind, before saying yes. */
  const [editing, setEditing] = useState<{ kind: string; draft: Draft } | null>(null);
  /** A save, or its presence check, is under way: every control waits. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The latest read; an older reply is dropped. */
  const readSeq = useRef(0);

  const load = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null) {
      setError('Dina is still starting up. Reopen and try again.');
      return;
    }
    const seq = ++readSeq.current;
    const read = await Promise.allSettled(
      BARGAINING_KINDS.map((k) => client.strategySetting(k.kind)),
    );
    if (seq !== readSeq.current) return;
    setLoaded(
      Object.fromEntries(
        BARGAINING_KINDS.map(({ kind }, i) => {
          const r = read[i];
          return [
            kind,
            r?.status === 'fulfilled' ? { view: r.value } : { error: ownerErrorText(r?.reason) },
          ];
        }),
      ),
    );
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
      'Choosing who bargains for you changes what Dina may agree, so Dina checks a person is here.',
  });

  const save = useCallback(async () => {
    if (editing === null || busy) return;
    const { kind, draft } = editing;
    setBusy(true);
    setNotice(null);
    setError(null);
    // `run` settles only once the save is done with, through the presence
    // sheet and its retry, so the busy flag holds across both.
    await runGated(async () => {
      const client = getOwnerCommerceClient();
      if (client === null) return;
      try {
        await client.setStrategy(kind, draft);
        setEditing(null);
        setNotice(
          draft.strategy === 'brain'
            ? 'Saved. Brain bargains for this now.'
            : 'Saved. Dina’s fixed rules bargain for this now.',
        );
      } catch (err) {
        if (isPresenceRefusal(err)) throw err;
        setError(ownerErrorText(err));
      }
    });
    await load();
    setBusy(false);
  }, [busy, editing, load, runGated]);

  const chooseShare = useCallback(
    async (option: Share | null, strategy: 'fixed' | 'brain') => {
      const client = getOwnerCommerceClient();
      if (client === null || busy) return;
      setBusy(true);
      setNotice(null);
      setError(null);
      try {
        await client.setSavingShare(option);
        setNotice(
          option === null
            ? 'Saved. Dina passes on half until Brain sets a share.'
            : strategy === 'brain'
              ? 'Saved. Brain may still change it while it bargains for you.'
              : 'Saved.',
        );
      } catch (err) {
        setError(ownerErrorText(err));
      }
      await load();
      setBusy(false);
    },
    [busy, load],
  );

  if (loaded === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="bargaining-loading">
        <Stack.Screen options={{ title: 'Who bargains for you' }} />
        {error !== null ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  return (
    <View style={styles.container} testID="bargaining-screen">
      <Stack.Screen options={{ title: 'Who bargains for you' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sub}>
          Dina’s fixed rules bargain for you unless you choose Brain. Either way Dina keeps to your
          floors and limits, and anything that needs your yes still comes to you.
        </Text>
        {error !== null && (
          <Text style={styles.error} testID="bargaining-error">
            {error}
          </Text>
        )}
        {notice !== null && (
          <Text style={styles.notice} testID="bargaining-saved">
            {notice}
          </Text>
        )}

        {BARGAINING_KINDS.map(({ kind, title, brain }) => {
          const entry = loaded[kind];
          if (entry === undefined) return null;
          if ('error' in entry) {
            return (
              <View key={kind} style={styles.card} testID={`bargaining-${kind}`}>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.error} testID={`bargaining-${kind}-error`}>
                  Dina could not read this setting. {entry.error}
                </Text>
                <Pressable
                  testID={`bargaining-${kind}-retry`}
                  style={styles.cancel}
                  disabled={busy}
                  onPress={() => void load()}
                  accessibilityRole="button"
                >
                  <Text style={styles.cancelText}>Try again</Text>
                </Pressable>
              </View>
            );
          }
          const { view } = entry;
          const draft = editing?.kind === kind ? editing.draft : null;
          const shown: Draft = draft ?? { strategy: view.strategy, valuesOn: view.values_on };
          const pick = (next: Draft): void => {
            const same =
              next.strategy === view.strategy &&
              (next.strategy === 'fixed' || next.valuesOn === view.values_on);
            setEditing(same ? null : { kind, draft: next });
          };
          return (
            <View key={kind} style={styles.card} testID={`bargaining-${kind}`}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.sub}>{brain}</Text>
              <View style={styles.choices}>
                {(['fixed', 'brain'] as const).map((strategy) => (
                  <Pressable
                    key={strategy}
                    testID={`bargaining-${kind}-${strategy}`}
                    style={[styles.choice, shown.strategy === strategy && styles.choiceOn]}
                    disabled={busy}
                    onPress={() => pick({ strategy, valuesOn: shown.valuesOn })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: shown.strategy === strategy }}
                  >
                    <Text
                      style={[
                        styles.choiceText,
                        shown.strategy === strategy && styles.choiceTextOn,
                      ]}
                    >
                      {strategy === 'fixed' ? 'Fixed rules' : 'Brain'}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {shown.strategy === 'brain' && view.values_apply && (
                <View style={styles.switchRow}>
                  <Text style={[styles.sub, styles.flex]}>
                    Brain may see what things are worth to you
                  </Text>
                  <Switch
                    testID={`bargaining-${kind}-values`}
                    value={shown.valuesOn}
                    disabled={busy}
                    onValueChange={(valuesOn) => pick({ strategy: 'brain', valuesOn })}
                    accessibilityLabel="Brain may see what things are worth to you"
                  />
                </View>
              )}
              {draft !== null && (
                <View style={styles.confirm} testID={`bargaining-${kind}-confirm`}>
                  <Text style={styles.body} testID={`bargaining-${kind}-disclosure`}>
                    {draft.strategy === 'brain'
                      ? draft.valuesOn
                        ? view.disclosures.with_values
                        : view.disclosures.without_values
                      : 'Brain stops bargaining for this. Dina’s fixed rules take over.'}
                  </Text>
                  <View style={styles.choices}>
                    <Pressable
                      testID={`bargaining-${kind}-save`}
                      style={[styles.save, busy && styles.disabled]}
                      disabled={busy}
                      onPress={() => void save()}
                      accessibilityRole="button"
                    >
                      <Text style={styles.saveText}>Save</Text>
                    </Pressable>
                    <Pressable
                      testID={`bargaining-${kind}-cancel`}
                      style={styles.cancel}
                      disabled={busy}
                      onPress={() => setEditing(null)}
                      accessibilityRole="button"
                    >
                      <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              )}
              {kind === 'goods.seller' && view.saving_share !== undefined && (
                <View style={styles.share}>
                  <Text style={styles.body}>Share of a cheaper day’s saving passed on</Text>
                  <Text style={styles.sub} testID="bargaining-share-in-use">
                    {shareInUse(view.saving_share, view.strategy)}
                  </Text>
                  <View style={styles.choices}>
                    {SHARES.map(({ option, label }) => {
                      const on =
                        view.saving_share?.set_by === 'owner' &&
                        view.saving_share.option === option;
                      return (
                        <Pressable
                          key={option}
                          testID={`bargaining-share-${option}`}
                          style={[styles.choice, on && styles.choiceOn]}
                          disabled={busy}
                          onPress={() => void chooseShare(option, view.strategy)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: on }}
                        >
                          <Text style={[styles.choiceText, on && styles.choiceTextOn]}>
                            {label}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {view.strategy === 'brain' && view.saving_share.set_by === 'owner' && (
                      <Pressable
                        testID="bargaining-share-brain"
                        style={styles.choice}
                        disabled={busy}
                        onPress={() => void chooseShare(null, view.strategy)}
                        accessibilityRole="button"
                      >
                        <Text style={styles.choiceText}>Leave it to Brain</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
      <PresenceSheet {...presenceSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  sub: { ...textStyles.body, color: colors.textSecondary },
  body: { ...textStyles.body, color: colors.textPrimary },
  title: { ...textStyles.body, color: colors.textPrimary, fontWeight: '600' },
  card: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  choiceOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  choiceText: { ...textStyles.caption, color: colors.textPrimary },
  choiceTextOn: { color: colors.bgPrimary },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
  confirm: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  share: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  save: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  saveText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  cancel: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  cancelText: { ...textStyles.body, color: colors.textSecondary },
  error: { ...textStyles.body, color: colors.error },
  notice: { ...textStyles.body, color: colors.textSecondary },
  disabled: { opacity: 0.6 },
});
