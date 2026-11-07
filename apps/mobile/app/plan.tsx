/**
 * Today (docs/DAILY_PLAN.md §9): agents waiting for a yes, today's plan with
 * checkboxes and reasons, the evening review, an add-task field, and the
 * other open tasks folded under the plan.
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getAlertAccess, requestAlerts, type AlertAccess } from '../src/notifications/local';
import {
  addTask,
  addToToday,
  carryTask,
  decideAgentFeed,
  dropTask,
  finishReview,
  loadPlanSettings,
  loadToday,
  planToday,
  setTaskDone,
  shouldAutoPlan,
  type TodayView,
} from '../src/services/daily_plan';
import { colors, radius, shadows, spacing, textStyles } from '../src/theme';

import type { PlanTask } from '@dina/core';

/** While Today is open, look again this often, so a new day or the evening review shows. */
const REFRESH_MS = 60_000;
/** Wait this long after opening before planning on its own, so an agent's
 * batch held at MsgBox has arrived (docs/DAILY_PLAN.md §7). */
const AUTO_PLAN_DELAY_MS = 4000;

function personaLabel(persona: string): string {
  return persona === 'general' ? 'Personal' : persona.charAt(0).toUpperCase() + persona.slice(1);
}

/** The task's link when it is a plain https URL, else null. Intake already
 * refuses anything else; this checks again before the OS opens it. */
function safeLink(link: string): { url: string; host: string } | null {
  if (link === '') return null;
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && u.hostname !== ''
      ? { url: u.toString(), host: u.hostname }
      : null;
  } catch {
    return null;
  }
}

function dueLabel(t: PlanTask, now: number): string | null {
  if (t.dueAt === null) return null;
  const d = new Date(t.dueAt);
  const overdue = t.dueAt < now;
  const label = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return overdue ? `Overdue · ${label}` : `Due ${label}`;
}

export default function TodayScreen(): React.ReactElement {
  const router = useRouter();
  const [view, setView] = useState<TodayView | null>(null);
  const [planning, setPlanning] = useState(false);
  const [draft, setDraft] = useState('');
  const [showOthers, setShowOthers] = useState(false);
  const [error, setError] = useState('');
  const [alerts, setAlerts] = useState<AlertAccess>('alerts');
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await loadToday());
      const { checkins } = await loadPlanSettings();
      setAlerts(checkins ? await getAlertAccess() : 'alerts');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const build = useCallback(async () => {
    setPlanning(true);
    setError('');
    try {
      await planToday();
    } catch (err) {
      setError(`Couldn't plan the day: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPlanning(false);
      await reload();
    }
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      void reload();
      const refresh = (): void => {
        void shouldAutoPlan().then((yes) => {
          if (yes) void build();
          else void reload();
        });
      };
      autoTimer.current = setTimeout(refresh, AUTO_PLAN_DELAY_MS);
      const every = setInterval(refresh, REFRESH_MS);
      // Back from the background on a new day: show that day, after the same
      // wait for an agent's batch.
      const sub = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        void reload();
        if (autoTimer.current !== null) clearTimeout(autoTimer.current);
        autoTimer.current = setTimeout(refresh, AUTO_PLAN_DELAY_MS);
      });
      return () => {
        if (autoTimer.current !== null) clearTimeout(autoTimer.current);
        clearInterval(every);
        sub.remove();
      };
    }, [reload, build]),
  );

  const act = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await reload();
  };

  if (view === null) {
    return (
      <View style={styles.container} testID="plan-loading">
        {error !== '' ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  const now = Date.now();
  const goalTitles = new Map(view.goals.map((g) => [g.id, g.title]));
  const dateLabel = new Date(now).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const done = view.planned.filter((p) => p.task.status === 'done').length;
  // Tasks that reached the list after today's plan was made (an agent's morning
  // batch, a chat to-do, an agent's tasks just allowed): say so, so they aren't
  // missed under the fold. An agent sending a known task again isn't news.
  const plannedAt = view.plan?.plannedAt ?? 0;
  const newSincePlan = view.others.filter((t) => t.openedAt > plannedAt).length;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="plan-screen"
    >
      <View style={styles.header}>
        <Text style={styles.date}>{dateLabel}</Text>
        {view.plan !== null && view.planned.length > 0 ? (
          <Text style={styles.progress} testID="plan-progress">
            {done} of {view.planned.length} done
          </Text>
        ) : null}
      </View>

      {alerts !== 'alerts' ? (
        <View style={styles.card} testID="plan-alerts">
          <Text style={styles.body}>
            {alerts === 'off'
              ? 'Notifications are off for Dina, so check-ins can’t reach you.'
              : alerts === 'quiet'
                ? 'Check-ins only reach your Notification Centre, so you may not see them.'
                : 'Let Dina alert you, so check-ins reach you.'}
          </Text>
          <Pressable
            style={styles.primarySmallFit}
            testID="plan-alerts-allow"
            accessibilityRole="button"
            onPress={() => {
              if (alerts === 'off') void Linking.openSettings();
              else void act(() => requestAlerts().then(setAlerts))();
            }}
          >
            <Text style={styles.primaryText}>
              {alerts === 'off' ? 'Open Settings' : 'Turn on alerts'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {view.pendingFeeds.map(({ feed, held }, i) => (
        <View
          key={`${feed.agentDid}:${feed.persona}`}
          style={styles.feedCard}
          testID={`plan-feed-${i}`}
        >
          <Text style={styles.body}>
            {feed.agentName !== '' ? feed.agentName : 'A paired agent'} wants to add {held}{' '}
            {held === 1 ? 'task' : 'tasks'} to {personaLabel(feed.persona)}.
          </Text>
          <Text style={styles.sub}>
            It can add tasks to {personaLabel(feed.persona)} only. It can&apos;t read your notes or
            other tasks.
          </Text>
          <View style={styles.row}>
            <Pressable
              style={styles.primarySmall}
              testID={`plan-feed-allow-${i}`}
              accessibilityRole="button"
              onPress={act(() => decideAgentFeed(feed.agentDid, feed.persona, true))}
            >
              <Text style={styles.primaryText}>Allow</Text>
            </Pressable>
            <Pressable
              style={styles.secondarySmall}
              testID={`plan-feed-block-${i}`}
              accessibilityRole="button"
              onPress={act(() => decideAgentFeed(feed.agentDid, feed.persona, false))}
            >
              <Text style={styles.secondaryText}>Block</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {view.plan === null ? (
        <View style={styles.card}>
          <Text style={styles.body}>
            {view.others.length === 0
              ? 'Nothing on your list yet. Add a task below, tell Dina in chat, or let your agents send them.'
              : `${view.others.length} open ${view.others.length === 1 ? 'task' : 'tasks'}. Dina can pick today's from them.`}
          </Text>
          {view.others.length > 0 ? (
            <Pressable
              style={[styles.primary, planning && styles.disabled]}
              disabled={planning}
              testID="plan-build"
              accessibilityRole="button"
              onPress={() => void build()}
            >
              {planning ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.primaryText}>Plan my day</Text>
              )}
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.section}>
          {view.plan.note !== '' ? <Text style={styles.note}>{view.plan.note}</Text> : null}
          {newSincePlan > 0 && !view.reviewDue ? (
            <Text style={styles.reviewHint} testID="plan-new-since">
              {newSincePlan} new {newSincePlan === 1 ? 'task' : 'tasks'} since you planned. Re-plan
              to fit {newSincePlan === 1 ? 'it' : 'them'} in.
            </Text>
          ) : null}
          {view.reviewDue ? (
            <Text style={styles.reviewHint} testID="plan-review-hint">
              Evening review: move what&apos;s left to tomorrow or drop it.
            </Text>
          ) : null}
          {view.planned.map(({ task, reason }) => (
            <TaskRow
              key={task.id}
              task={task}
              reason={reason}
              now={now}
              goalTitle={goalTitles.get(task.goalId)}
              review={view.reviewDue && task.status === 'open'}
              onToggle={act(() => setTaskDone(task.id, task.status !== 'done'))}
              onCarry={act(() => carryTask(task.id))}
              onDrop={act(() => dropTask(task.id))}
            />
          ))}
          {view.reviewDue ? (
            <Pressable
              style={styles.primary}
              testID="plan-review-finish"
              accessibilityRole="button"
              onPress={act(() => finishReview())}
            >
              <Text style={styles.primaryText}>Done for today</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.link}
              disabled={planning}
              testID="plan-replan"
              accessibilityRole="button"
              onPress={() => void build()}
            >
              <Text style={styles.linkText}>{planning ? 'Planning…' : 'Re-plan'}</Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.addRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a task"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          testID="plan-add-input"
          returnKeyType="done"
          onSubmitEditing={() => {
            const t = draft;
            setDraft('');
            void act(() => addTask(t))();
          }}
        />
        <Pressable
          style={[styles.addButton, draft.trim() === '' && styles.disabled]}
          disabled={draft.trim() === ''}
          testID="plan-add-submit"
          accessibilityRole="button"
          accessibilityLabel="Add task"
          onPress={() => {
            const t = draft;
            setDraft('');
            void act(() => addTask(t))();
          }}
        >
          <Ionicons name="add" size={22} color={colors.white} />
        </Pressable>
      </View>

      {view.plan !== null && view.others.length > 0 ? (
        <View style={styles.section}>
          <Pressable
            style={styles.foldHeader}
            testID="plan-others-toggle"
            accessibilityRole="button"
            onPress={() => setShowOthers((v) => !v)}
          >
            <Text style={styles.eyebrow}>OTHER OPEN TASKS ({view.others.length})</Text>
            <Ionicons
              name={showOthers ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.textSecondary}
            />
          </Pressable>
          {showOthers
            ? view.others.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  goalTitle={goalTitles.get(task.goalId)}
                  reason={
                    view.chases[task.id] !== undefined ? `Chase ${view.chases[task.id]}` : undefined
                  }
                  onToggle={act(() => setTaskDone(task.id, true))}
                  onAddToToday={act(() => addToToday(task.id))}
                  onDrop={act(() => dropTask(task.id))}
                />
              ))
            : null}
        </View>
      ) : null}

      {error !== '' ? (
        <Text style={styles.error} testID="plan-error">
          {error}
        </Text>
      ) : null}

      <Pressable
        style={styles.link}
        testID="plan-goals"
        accessibilityRole="button"
        onPress={() => router.push('/goals' as never)}
      >
        <Text style={styles.linkText}>My Goals, check-ins and agents</Text>
      </Pressable>
    </ScrollView>
  );
}

function TaskRow(props: {
  task: PlanTask;
  reason?: string;
  now: number;
  goalTitle?: string;
  review?: boolean;
  onToggle: () => void;
  onCarry?: () => void;
  onDrop?: () => void;
  onAddToToday?: () => void;
}): React.ReactElement {
  const { task } = props;
  const isDone = task.status === 'done';
  const due = dueLabel(task, props.now);
  const link = safeLink(task.link);
  return (
    <View style={styles.taskRow} testID={`plan-task-${task.id}`}>
      <Pressable
        onPress={props.onToggle}
        testID={`plan-done-${task.id}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isDone }}
        accessibilityLabel={task.title}
        hitSlop={8}
      >
        <Ionicons
          name={isDone ? 'checkmark-circle' : 'ellipse-outline'}
          size={24}
          color={isDone ? colors.accent : colors.textMuted}
        />
      </Pressable>
      <View style={styles.taskMain}>
        <Text style={[styles.body, isDone && styles.doneText]}>{task.title}</Text>
        {props.reason !== undefined && props.reason !== '' ? (
          <Text style={styles.sub}>{props.reason}</Text>
        ) : null}
        <View style={styles.meta}>
          {due !== null ? <Text style={styles.metaText}>{due}</Text> : null}
          <Text style={styles.metaText}>{personaLabel(task.persona)}</Text>
          {props.goalTitle !== undefined ? (
            <Text style={styles.metaText}>{props.goalTitle}</Text>
          ) : null}
          {task.routineId !== '' ? <Text style={styles.metaText}>Repeats</Text> : null}
          {task.carried > 0 ? <Text style={styles.metaText}>Carried {task.carried}×</Text> : null}
          {link !== null ? (
            <Pressable
              onPress={() => void Linking.openURL(link.url)}
              testID={`plan-open-${task.id}`}
              accessibilityRole="link"
              hitSlop={6}
            >
              <Text style={styles.metaLink}>Open {link.host}</Text>
            </Pressable>
          ) : null}
        </View>
        {props.review ? (
          <View style={styles.row}>
            <Pressable
              style={styles.secondarySmall}
              testID={`plan-carry-${task.id}`}
              onPress={props.onCarry}
            >
              <Text style={styles.secondaryText}>
                {task.routineId !== '' ? 'Skip today' : 'Tomorrow'}
              </Text>
            </Pressable>
            {task.routineId === '' ? (
              <Pressable
                style={styles.secondarySmall}
                testID={`plan-drop-${task.id}`}
                onPress={props.onDrop}
              >
                <Text style={styles.secondaryText}>Drop</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {props.onAddToToday !== undefined ? (
          <View style={styles.row}>
            <Pressable
              style={styles.secondarySmall}
              testID={`plan-today-${task.id}`}
              onPress={props.onAddToToday}
            >
              <Text style={styles.secondaryText}>Add to today</Text>
            </Pressable>
            <Pressable
              style={styles.secondarySmall}
              testID={`plan-drop-${task.id}`}
              onPress={props.onDrop}
            >
              <Text style={styles.secondaryText}>Drop</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { gap: spacing.xs },
  date: textStyles.h3,
  progress: { ...textStyles.bodySmall, color: colors.textSecondary },
  section: { gap: spacing.sm },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  feedCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.md,
    gap: spacing.sm,
  },
  body: { ...textStyles.body, color: colors.textPrimary },
  sub: { ...textStyles.bodySmall, color: colors.textSecondary },
  note: { ...textStyles.body, color: colors.textSecondary },
  reviewHint: { ...textStyles.bodySmallStrong, color: colors.textPrimary },
  doneText: { color: colors.textMuted, textDecorationLine: 'line-through' },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  taskRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadows.sm,
  },
  taskMain: { flex: 1, gap: 2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  metaText: { ...textStyles.tiny, color: colors.textSecondary },
  metaLink: { ...textStyles.tiny, color: colors.accent },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  primarySmall: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  primarySmallFit: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  primaryText: { ...textStyles.bodyStrong, color: colors.white },
  secondarySmall: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  secondaryText: { ...textStyles.bodySmall, color: colors.textPrimary },
  disabled: { opacity: 0.5 },
  link: { alignItems: 'center', paddingVertical: spacing.sm },
  linkText: { ...textStyles.bodySmall, color: colors.accent },
  addRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    ...textStyles.body,
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  foldHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { ...textStyles.eyebrow, letterSpacing: 0.6 },
  error: { ...textStyles.bodySmall, color: colors.error },
});
