/**
 * Things that repeat (docs/DAILY_PLAN.md §24): the list with how each stands
 * this week, today's turn to tick, and a form to add one. Shared by a goal's
 * page and the Goals screen.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing, textStyles } from '../../theme';

import type { RoutineView } from '../../services/daily_plan';
import type { RoutineInput } from '@dina/core';

type RuleChoice = 'daily' | 'weekdays' | 'some' | 'week' | 'month';

const RULES: { key: RuleChoice; label: string }[] = [
  { key: 'daily', label: 'Every day' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'some', label: 'Some days' },
  { key: 'week', label: 'Times a week' },
  { key: 'month', label: 'Monthly' },
];
// Monday first, as the week runs. The number is JavaScript's getDay().
const DAY_CHIPS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
];

export function RoutinesCard(props: {
  routines: RoutineView[];
  /** The goal new routines serve, or '' for none. */
  goalId: string;
  onAdd: (input: RoutineInput) => void;
  onStop: (routineId: string) => void;
  onTick: (taskId: string, done: boolean) => void;
}): React.ReactElement {
  const [title, setTitle] = useState('');
  const [rule, setRule] = useState<RuleChoice>('week');
  const [days, setDays] = useState<number[]>([1, 3, 5]);
  const [times, setTimes] = useState(3);
  const [monthDay, setMonthDay] = useState('1');

  const submit = (): void => {
    if (title.trim() === '') return;
    const base = { title, goalId: props.goalId };
    const input: RoutineInput =
      rule === 'daily'
        ? { ...base, kind: 'days', weekdays: [0, 1, 2, 3, 4, 5, 6] }
        : rule === 'weekdays'
          ? { ...base, kind: 'days', weekdays: [1, 2, 3, 4, 5] }
          : rule === 'some'
            ? { ...base, kind: 'days', weekdays: days }
            : rule === 'week'
              ? { ...base, kind: 'per_week', timesPerWeek: times }
              : { ...base, kind: 'monthly', dayOfMonth: Number(monthDay) };
    setTitle('');
    props.onAdd(input);
  };

  return (
    <View style={styles.card} testID="routines-card">
      {props.routines.map(({ routine, rule: label, progress, today }, i) => {
        const done = today?.status === 'done';
        return (
          <View key={routine.id} style={styles.row} testID={`routine-row-${i}`}>
            {today !== null ? (
              <Pressable
                onPress={() => props.onTick(today.id, !done)}
                testID={`routine-tick-${i}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: done }}
                accessibilityLabel={`${routine.title}, today`}
                style={[styles.box, done && styles.boxOn]}
              >
                {done ? <Text style={styles.boxTick}>✓</Text> : null}
              </Pressable>
            ) : (
              <View style={styles.boxSpace} />
            )}
            <View style={styles.flex}>
              <Text style={styles.body}>{routine.title}</Text>
              <Text style={styles.sub} testID={`routine-progress-${i}`}>
                {label} · {progress}
              </Text>
            </View>
            <Pressable
              onPress={() => props.onStop(routine.id)}
              testID={`routine-stop-${i}`}
              accessibilityRole="button"
              accessibilityLabel={`Stop ${routine.title}`}
            >
              <Text style={styles.link}>Stop</Text>
            </Pressable>
          </View>
        );
      })}
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Something that repeats, e.g. Run"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        testID="routine-title"
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <View style={styles.chips}>
        {RULES.map((r) => (
          <Pressable
            key={r.key}
            style={[styles.chip, rule === r.key && styles.chipOn]}
            testID={`routine-rule-${r.key}`}
            accessibilityRole="button"
            accessibilityState={{ selected: rule === r.key }}
            onPress={() => setRule(r.key)}
          >
            <Text style={[styles.chipText, rule === r.key && styles.chipTextOn]}>{r.label}</Text>
          </Pressable>
        ))}
      </View>
      {rule === 'some' ? (
        <View style={styles.chips}>
          {DAY_CHIPS.map(({ day, label }) => {
            const on = days.includes(day);
            return (
              <Pressable
                key={day}
                style={[styles.chip, on && styles.chipOn]}
                testID={`routine-day-${day}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setDays((d) => (on ? d.filter((x) => x !== day) : [...d, day]))}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {rule === 'week' ? (
        <View style={styles.chips}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Pressable
              key={n}
              style={[styles.chip, times === n && styles.chipOn]}
              testID={`routine-times-${n}`}
              accessibilityRole="button"
              accessibilityState={{ selected: times === n }}
              onPress={() => setTimes(n)}
            >
              <Text style={[styles.chipText, times === n && styles.chipTextOn]}>{n}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {rule === 'month' ? (
        <View style={styles.row}>
          <Text style={[styles.body, styles.flex]}>Day of the month</Text>
          <TextInput
            value={monthDay}
            onChangeText={setMonthDay}
            style={styles.smallInput}
            testID="routine-month-day"
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            maxLength={2}
          />
        </View>
      ) : null}
      <Pressable
        style={[styles.primary, title.trim() === '' && styles.disabled]}
        disabled={title.trim() === ''}
        testID="routine-add"
        accessibilityRole="button"
        onPress={submit}
      >
        <Text style={styles.primaryText}>Add</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
  body: { ...textStyles.body, color: colors.textPrimary },
  sub: { ...textStyles.bodySmall, color: colors.textSecondary },
  link: { ...textStyles.bodySmall, color: colors.accent },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxSpace: { width: 22 },
  boxOn: { backgroundColor: colors.success, borderColor: colors.success },
  boxTick: { color: colors.white, fontSize: 13, fontWeight: '700' },
  input: {
    ...textStyles.body,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  smallInput: {
    ...textStyles.mono,
    width: 64,
    textAlign: 'center',
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgPrimary,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { ...textStyles.bodySmall, color: colors.textPrimary },
  chipTextOn: { color: colors.white },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  primaryText: { ...textStyles.bodyStrong, color: colors.white },
  disabled: { opacity: 0.5 },
});
