/**
 * Promises and waits (docs/PROMISES_AND_WAITS.md): what the owner is waiting
 * on from others and what they promised, from every place Dina tracks it.
 * Talk promises and goal waits close here; the rest open their own screen.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useRefreshWhileOpen } from '../src/hooks/useRefreshWhileOpen';
import { closableHere, closePromise, loadPromises, promiseHref } from '../src/services/promises';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { PromiseItem, PromiseSource, PromisesAndWaits } from '@dina/core';

const SOURCE_LABEL: Record<PromiseSource, string> = {
  plan: 'Goal',
  talk: 'Talk',
  group_plan: 'Group booking',
  tender: 'Quotes',
  order: 'Order',
  agreement: 'Shelf deal',
};

function dueLabel(item: PromiseItem): string | null {
  if (item.dueAt === null) return null;
  const day = new Date(item.dueAt).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return item.late ? `Late, was due ${day}` : `By ${day}`;
}

function Row({
  item,
  busy,
  onOpen,
  onClose,
}: {
  item: PromiseItem;
  busy: boolean;
  onOpen: (() => void) | null;
  onClose: (() => void) | null;
}): React.ReactElement {
  const due = dueLabel(item);
  const closeLabel = item.direction === 'owed_to_me' ? 'Got it' : 'Done';
  return (
    <View style={styles.row} testID={`promise-row-${item.id}`}>
      <Pressable
        style={styles.rowMain}
        onPress={onOpen ?? undefined}
        disabled={onOpen === null}
        accessibilityRole={onOpen === null ? undefined : 'button'}
        testID={`promise-open-${item.id}`}
      >
        <Text style={styles.what}>{item.what}</Text>
        <Text style={styles.meta}>
          {item.direction === 'owed_to_me' ? `From ${item.who}` : `To ${item.who}`} ·{' '}
          {SOURCE_LABEL[item.source]}
        </Text>
        {due !== null && (
          <Text style={[styles.meta, item.late && styles.late]} testID={`promise-due-${item.id}`}>
            {due}
          </Text>
        )}
      </Pressable>
      {onClose !== null && (
        <Pressable
          style={[styles.close, busy && styles.disabled]}
          onPress={onClose}
          disabled={busy}
          accessibilityRole="button"
          testID={`promise-close-${item.id}`}
        >
          <Text style={styles.closeLabel}>{closeLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

export default function PromisesScreen(): React.ReactElement {
  const router = useRouter();
  const [data, setData] = useState<PromisesAndWaits | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      setData(loadPromises());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your promises just now.');
    }
  }, []);
  useRefreshWhileOpen(refresh);

  const close = async (item: PromiseItem): Promise<void> => {
    setBusy(item.id);
    try {
      await closePromise(item);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const section = (title: string, items: PromiseItem[], empty: string, testID: string) => (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {items.length === 0 ? (
        <Text style={styles.empty}>{empty}</Text>
      ) : (
        items.map((item) => {
          const href = promiseHref(item);
          return (
            <Row
              key={item.id}
              item={item}
              busy={busy === item.id}
              onOpen={href === null ? null : () => router.push(href as never)}
              onClose={closableHere(item) ? () => void close(item) : null}
            />
          );
        })
      )}
    </View>
  );

  const items = data?.items ?? [];
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="promises-screen"
    >
      <Text style={styles.intro}>
        What people owe you and what you promised, from goals, Talk, group bookings, quotes, orders
        and shelf deals. When a Talk message holds a promise, Dina asks in chat whether to track it.
      </Text>
      {error !== '' && <Text style={styles.error}>{error}</Text>}
      {data !== null && data.missing.length > 0 && (
        <Text style={styles.note} testID="promises-missing">
          Some places could not be read just now:{' '}
          {data.missing.map((s) => SOURCE_LABEL[s]).join(', ')}.
        </Text>
      )}
      {section(
        'Waiting on others',
        items.filter((i) => i.direction === 'owed_to_me'),
        'Nobody owes you anything right now.',
        'promises-owed-to-me',
      )}
      {section(
        'You promised',
        items.filter((i) => i.direction === 'owed_by_me'),
        'No promises of yours are being tracked.',
        'promises-owed-by-me',
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, gap: spacing.lg },
  intro: { ...textStyles.body, color: colors.textSecondary },
  error: { ...textStyles.caption, color: colors.error },
  note: { ...textStyles.caption, color: colors.warningTextDeep },
  section: { gap: spacing.sm },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
  },
  empty: { ...textStyles.body, color: colors.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  rowMain: { flex: 1, gap: 2 },
  what: { ...textStyles.body, color: colors.textPrimary },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  late: { color: colors.error },
  close: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  closeLabel: { ...textStyles.button, color: colors.textPrimary },
  disabled: { opacity: 0.5 },
});
