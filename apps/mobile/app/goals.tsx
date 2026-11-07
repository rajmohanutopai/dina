/**
 * Goals (docs/DAILY_PLAN.md §9): the goals the plan serves, the check-in
 * times and hours, and which agents may add tasks.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { RoutinesCard } from '../src/components/plan/routines_card';
import { useRefreshWhileOpen } from '../src/hooks/useRefreshWhileOpen';
import {
  addGoal,
  addRoutine,
  checkinsInQuietHours,
  decideAgentFeed,
  goalSummary,
  listAgentFeeds,
  listGoals,
  loadPlanSettings,
  loadRoutines,
  mergeFormFields,
  savePlanSettings,
  setGoalActive,
  setTaskDone,
  stopRoutine,
  type PlanSettings,
  type RoutineView,
} from '../src/services/daily_plan';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { PlanFeed, PlanGoal } from '@dina/core';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function personaLabel(persona: string): string {
  return persona === 'general' ? 'Personal' : persona.charAt(0).toUpperCase() + persona.slice(1);
}

export default function GoalsScreen(): React.ReactElement {
  const router = useRouter();
  const [goals, setGoals] = useState<PlanGoal[]>([]);
  const [feeds, setFeeds] = useState<PlanFeed[]>([]);
  const [routines, setRoutines] = useState<RoutineView[]>([]);
  const [settings, setSettings] = useState<PlanSettings | null>(null);
  const [times, setTimes] = useState({
    planTime: '',
    middayTime: '',
    eveningTime: '',
    quietStart: '',
    quietEnd: '',
    hours: '',
  });
  const savedTimes = useRef<typeof times | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setGoals(listGoals());
    setFeeds(listAgentFeeds());
    setRoutines(loadRoutines(''));
    const s = await loadPlanSettings();
    setSettings(s);
    const fields = {
      planTime: s.planTime,
      middayTime: s.middayTime,
      eveningTime: s.eveningTime,
      quietStart: s.quietStart,
      quietEnd: s.quietEnd,
      hours: String(s.capacityHours),
    };
    // A tap elsewhere on the screen mustn't wipe a time being typed.
    const was = savedTimes.current;
    savedTimes.current = fields;
    setTimes((t) => (was === null ? fields : mergeFormFields(t, was, fields)));
  }, []);

  const refresh = useCallback(() => void reload(), [reload]);
  useRefreshWhileOpen(refresh);

  const saveTimes = async (): Promise<void> => {
    setError('');
    setMessage('');
    const bad = (
      ['planTime', 'middayTime', 'eveningTime', 'quietStart', 'quietEnd'] as const
    ).filter((k) => !HHMM.test(times[k]));
    const hours = Number(times.hours);
    if (bad.length > 0) {
      setError('Write times as HH:MM on a 24-hour clock, for example 08:00 or 18:30.');
      return;
    }
    if (!Number.isFinite(hours) || hours <= 0 || hours > 16) {
      setError('Hours for tasks must be between 1 and 16.');
      return;
    }
    try {
      const saved = await savePlanSettings({
        planTime: times.planTime,
        middayTime: times.middayTime,
        eveningTime: times.eveningTime,
        quietStart: times.quietStart,
        quietEnd: times.quietEnd,
        capacityHours: hours,
      });
      const silent = checkinsInQuietHours(saved);
      setMessage(
        silent.length > 0
          ? `Saved. ${silent.join(', ')} falls inside quiet hours, so Dina won't send it.`
          : 'Saved.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await reload();
  };

  const act = (fn: () => Promise<unknown>): void => {
    setError('');
    void fn()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .then(reload);
  };

  const submitGoal = (): void => {
    if (draft.trim() === '') return;
    try {
      addGoal(draft);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    void reload();
  };

  if (settings === null) return <View style={styles.container} testID="goals-loading" />;

  const active = goals.filter((g) => g.active);
  const archived = goals.filter((g) => !g.active);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="goals-screen"
    >
      <Pressable
        style={styles.todayLink}
        testID="goals-today"
        accessibilityRole="button"
        onPress={() => router.push('/plan' as never)}
      >
        <Text style={styles.body}>Today&apos;s plan</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
      </Pressable>

      <Text style={styles.eyebrow}>GOALS</Text>
      <Text style={styles.sub}>
        The plan makes room for these, and the weekly note says when one gets no time. Open a goal
        to give it phases, dates and a budget.
      </Text>
      {active.map((g, i) => {
        const sum = goalSummary(g);
        const sub = [
          g.targetAt !== null
            ? `By ${new Date(g.targetAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
            : '',
          sum.hasDraft ? 'Draft plan waiting' : sum.line,
        ]
          .filter((x) => x !== '')
          .join(' · ');
        return (
          <View key={g.id} style={styles.goalRow} testID={`goal-${g.id}`}>
            <Pressable
              style={styles.flex}
              testID={`goal-open-${i}`}
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/goal', params: { id: g.id } })}
            >
              <Text style={styles.body}>{g.title}</Text>
              {sub !== '' ? <Text style={styles.sub}>{sub}</Text> : null}
              {sum.lateDays > 0 ? (
                <Text style={styles.late}>
                  {sum.lateDays} {sum.lateDays === 1 ? 'day' : 'days'} late
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              onPress={() => act(() => setGoalActive(g.id, false))}
              testID={`goal-archive-${g.id}`}
              accessibilityRole="button"
            >
              <Text style={styles.linkText}>Archive</Text>
            </Pressable>
          </View>
        );
      })}
      <View style={styles.addRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a goal, e.g. Run three times a week"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          testID="goal-add-input"
          returnKeyType="done"
          onSubmitEditing={submitGoal}
        />
        <Pressable
          style={[styles.primarySmall, draft.trim() === '' && styles.disabled]}
          disabled={draft.trim() === ''}
          testID="goal-add-submit"
          accessibilityRole="button"
          onPress={submitGoal}
        >
          <Text style={styles.primaryText}>Add</Text>
        </Pressable>
      </View>
      {archived.length > 0 ? (
        <View style={styles.section}>
          {archived.map((g) => (
            <View key={g.id} style={styles.goalRow}>
              <Text style={[styles.sub, styles.flex]}>{g.title}</Text>
              <Pressable
                onPress={() => act(() => setGoalActive(g.id, true))}
                testID={`goal-restore-${g.id}`}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>Restore</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.eyebrow}>THINGS THAT REPEAT</Text>
      <Text style={styles.sub}>
        Each turn lands on your plan by itself. One you miss lapses, so they never pile up. To tie
        one to a goal, add it on that goal&apos;s page.
      </Text>
      <RoutinesCard
        routines={routines}
        goalId=""
        onAdd={(input) => act(() => addRoutine(input))}
        onStop={(id) => act(() => stopRoutine(id))}
        onTick={(id, done) => act(() => setTaskDone(id, done))}
      />

      <Text style={styles.eyebrow}>CHECK-INS</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={[styles.body, styles.flex]}>Send check-ins</Text>
          <Switch
            value={settings.checkins}
            testID="plan-checkins"
            onValueChange={(on) => void savePlanSettings({ checkins: on }).then(reload)}
            accessibilityLabel="Send check-ins"
          />
        </View>
        <Text style={styles.sub}>
          Dina sends these only, at your times, and never during quiet hours. If you stop opening
          the app, the morning check-in thins out over two weeks and then stops.
        </Text>
        {(
          [
            ['planTime', 'Morning plan', 'plan-time-morning'],
            ['middayTime', 'Midday check', 'plan-time-midday'],
            ['eveningTime', 'Evening review', 'plan-time-evening'],
            ['quietStart', 'Quiet hours start', 'plan-quiet-start'],
            ['quietEnd', 'Quiet hours end', 'plan-quiet-end'],
          ] as const
        ).map(([key, label, id]) => (
          <View key={key} style={styles.switchRow}>
            <Text style={[styles.body, styles.flex]}>{label}</Text>
            <TextInput
              value={times[key]}
              onChangeText={(v) => setTimes((t) => ({ ...t, [key]: v }))}
              style={styles.timeInput}
              testID={id}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
        ))}
        <View style={styles.switchRow}>
          <Text style={[styles.body, styles.flex]}>Hours for tasks each day</Text>
          <TextInput
            value={times.hours}
            onChangeText={(v) => setTimes((t) => ({ ...t, hours: v }))}
            style={styles.timeInput}
            testID="plan-hours"
            keyboardType="decimal-pad"
            maxLength={4}
          />
        </View>
        <View style={styles.switchRow}>
          <Text style={[styles.body, styles.flex]}>Weekly note on</Text>
          <Pressable
            testID="plan-weekly-day"
            accessibilityRole="button"
            onPress={() =>
              void savePlanSettings({ weeklyDay: (settings.weeklyDay + 1) % 7 }).then(reload)
            }
          >
            <Text style={styles.linkText}>{DAYS[settings.weeklyDay]}</Text>
          </Pressable>
        </View>
        <Pressable
          style={styles.primary}
          testID="plan-settings-save"
          accessibilityRole="button"
          onPress={() => void saveTimes()}
        >
          <Text style={styles.primaryText}>Save times</Text>
        </Pressable>
      </View>

      <Text style={styles.eyebrow}>AGENTS THAT ADD TASKS</Text>
      {feeds.length === 0 ? (
        <Text style={styles.sub}>
          None yet. When a paired agent first sends tasks, Today asks whether to allow it.
        </Text>
      ) : (
        feeds.map((f, i) => (
          <View
            key={`${f.agentDid}:${f.persona}`}
            style={styles.goalRow}
            testID={`plan-agent-${i}`}
          >
            <View style={styles.flex}>
              <Text style={styles.body}>{f.agentName !== '' ? f.agentName : 'A paired agent'}</Text>
              <Text style={styles.sub}>
                {personaLabel(f.persona)} ·{' '}
                {f.state === 'allowed'
                  ? 'Allowed'
                  : f.state === 'blocked'
                    ? 'Blocked'
                    : 'Waiting for you'}
              </Text>
            </View>
            <Pressable
              testID={`plan-agent-toggle-${i}`}
              accessibilityRole="button"
              onPress={() =>
                void decideAgentFeed(f.agentDid, f.persona, f.state !== 'allowed').then(reload)
              }
            >
              <Text style={styles.linkText}>{f.state === 'allowed' ? 'Block' : 'Allow'}</Text>
            </Pressable>
          </View>
        ))
      )}

      {message !== '' ? (
        <Text style={styles.sub} testID="goals-message">
          {message}
        </Text>
      ) : null}
      {error !== '' ? (
        <Text style={styles.error} testID="goals-error">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
  section: { gap: spacing.xs },
  todayLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  eyebrow: { ...textStyles.eyebrow, letterSpacing: 0.6, marginTop: spacing.md },
  body: { ...textStyles.body, color: colors.textPrimary },
  sub: { ...textStyles.bodySmall, color: colors.textSecondary },
  flex: { flex: 1 },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
  timeInput: {
    ...textStyles.mono,
    width: 72,
    textAlign: 'center',
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
  },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  primarySmall: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  primaryText: { ...textStyles.bodyStrong, color: colors.white },
  disabled: { opacity: 0.5 },
  linkText: { ...textStyles.bodySmall, color: colors.accent },
  error: { ...textStyles.bodySmall, color: colors.error },
  late: { ...textStyles.bodySmall, color: colors.warningTextMid },
});
