/**
 * The owner's readable export, in chat (REAL_LIFE_FIXES_2 §5).
 *
 * Shows what is in it and what is not (a closed or locked vault, and how to
 * include it). The button fetches the document from Core through the
 * owner's own device — Brain never holds it — and offers it to save.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';

import { shareReadableExport } from '../hooks/useShareExport';
import { getOwnerDispatcher } from '../services/owner_dispatcher';
import { colors, radius, spacing, textStyles } from '../theme';

export function InlineExportCard({ message }: { message: ChatMessage }): React.ReactElement | null {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'gone' | 'failed'>('idle');
  const lc = readLifecycle(message);
  const onSave = useCallback(async () => {
    if (lc === null || lc.kind !== 'export') return;
    const dispatcher = getOwnerDispatcher();
    if (dispatcher === null) {
      setState('failed');
      return;
    }
    setState('saving');
    const res = await dispatcher.dispatch({ method: 'GET', path: `/v1/owner-export/${encodeURIComponent(lc.exportId)}` });
    if (res.status === 404) {
      setState('gone');
      return;
    }
    if (res.status !== 200) {
      setState('failed');
      return;
    }
    setState((await shareReadableExport(JSON.stringify(res.body, null, 2))) === 'shared' ? 'saved' : 'failed');
  }, [lc]);
  if (lc === null || lc.kind !== 'export') return null;

  const included = lc.manifest.personas.filter((p) => p.included);
  const excluded = lc.manifest.personas.filter((p) => !p.included);
  return (
    <View style={styles.card} testID={`export-card-${lc.exportId}`}>
      <Text style={styles.title}>Your data</Text>
      {included.map((p) => (
        <Text key={p.persona} style={styles.line}>
          {p.persona}: {p.items} notes
        </Text>
      ))}
      <Text style={styles.line}>
        {lc.manifest.people} people · {lc.manifest.contacts} contacts · {lc.manifest.reminders} reminders
      </Text>
      {excluded.map((p) => (
        <Text key={p.persona} style={styles.meta} testID={`export-card-excluded-${p.persona}`}>
          Not included: {p.persona} ({p.why ?? 'closed'})
        </Text>
      ))}
      <Pressable
        testID={`export-card-save-${lc.exportId}`}
        style={styles.button}
        disabled={state === 'saving' || state === 'saved' || state === 'gone'}
        onPress={() => void onSave()}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>
          {state === 'saving'
            ? 'Preparing…'
            : state === 'saved'
              ? 'Saved'
              : state === 'gone'
                ? 'Expired: ask again'
                : state === 'failed'
                  ? 'Could not save: try again'
                  : 'Save my data'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  title: {
    ...textStyles.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  line: { ...textStyles.body, color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonText: { ...textStyles.button, color: colors.bgPrimary },
});
