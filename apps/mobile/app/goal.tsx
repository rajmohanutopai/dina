/**
 * One goal's plan (docs/DAILY_PLAN.md §20): its date and budget, a drafted
 * plan to accept, the phases with their tasks and waits, the late banner,
 * and the money line. Opened from Goals with `?id=`.
 */

import { useLocalSearchParams, useNavigation } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { formatGoalMoney, shiftCalendarDays, type PlanCostKind, type PlanTask } from '@dina/core';

import { RoutinesCard } from '../src/components/plan/routines_card';
import { useRefreshWhileOpen } from '../src/hooks/useRefreshWhileOpen';
import {
  acceptGoalDraft,
  addGoalPhase,
  addGoalTask,
  addRoutine,
  deleteGoalPhase,
  discardGoalDraft,
  draftPlanForGoal,
  dropTask,
  finishGoalPhase,
  loadGoal,
  mergeFormFields,
  moveGoalPhase,
  moveLateDates,
  moveTaskToPhase,
  parseAmount,
  recordGoalCost,
  removeGoalCost,
  renameTask,
  reopenGoalPhase,
  setTaskDone,
  setTaskOrder,
  setTaskWait,
  startGoalPhase,
  stopRoutine,
  suggestTasksForPhase,
  updateGoalDetails,
  updatePhaseDetails,
  type GoalView,
} from '../src/services/daily_plan';
import { colors, radius, spacing, textStyles } from '../src/theme';

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const WAIT_CHOICES = [
  { label: '2 days', days: 2 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
];

/** `YYYY-MM-DD` → the end of that local day, ms; null when blank; undefined when bad. */
function parseYmd(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const m = YMD.exec(t);
  if (m === null) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59);
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? undefined : d.getTime();
}

function ymd(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shortDate(ms: number | null): string {
  return ms === null
    ? ''
    : new Date(ms).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function GoalScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const navigation = useNavigation();
  const [view, setView] = useState<GoalView | null>(null);
  const [missing, setMissing] = useState(false);
  const [details, setDetails] = useState({ title: '', notes: '', target: '', budget: '' });
  // What the form last loaded: ticking a task mustn't wipe what's being typed,
  // and moving a date must reach a date field nobody touched.
  const savedDetails = useRef<{ id: string; fields: typeof details } | null>(null);
  const [allCosts, setAllCosts] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [phaseDraft, setPhaseDraft] = useState({ title: '', target: '' });
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [waitFor, setWaitFor] = useState<{ taskId: string; who: string } | null>(null);
  const [taskEdit, setTaskEdit] = useState<{ id: string; title: string } | null>(null);
  const [phaseEdit, setPhaseEdit] = useState<{
    id: string;
    title: string;
    target: string;
    confirmDelete: boolean;
  } | null>(null);
  const [finishing, setFinishing] = useState('');
  const [cost, setCost] = useState<{
    label: string;
    amount: string;
    kind: PlanCostKind;
    quoteId: string;
  }>({
    label: '',
    amount: '',
    kind: 'quote',
    quoteId: '',
  });

  const reload = useCallback(() => {
    if (typeof id !== 'string' || id === '') {
      setMissing(true);
      return;
    }
    try {
      const v = loadGoal(id);
      setMissing(v === null);
      setView(v);
      if (v !== null) {
        const fields = {
          title: v.goal.title,
          notes: v.goal.notes,
          target: ymd(v.goal.targetAt),
          budget: v.goal.budgetCents === null ? '' : String(v.goal.budgetCents / 100),
        };
        const was = savedDetails.current;
        savedDetails.current = { id: v.goal.id, fields };
        setDetails((d) =>
          was === null || was.id !== v.goal.id ? fields : mergeFormFields(d, was.fields, fields),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useRefreshWhileOpen(reload);

  useEffect(() => {
    if (view !== null) navigation.setOptions({ title: view.goal.title });
  }, [navigation, view]);

  const act = async (label: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
    Keyboard.dismiss();
    setError('');
    setMessage('');
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
      reload();
    }
  };

  if (missing) {
    return (
      <View style={styles.container} testID="goal-missing">
        <Text style={[styles.sub, styles.pad]}>This goal no longer exists.</Text>
      </View>
    );
  }
  if (view === null) return <View style={styles.container} testID="goal-loading" />;

  const { goal, phases, loose, late, money } = view;
  const ready = new Set(view.ready);
  const allTasks = [...phases.flatMap((p) => p.tasks), ...loose];
  const waits = allTasks.filter((t) => t.status === 'open' && t.waitingOn !== '');
  const openQuotes = view.costs.filter((c) => c.kind === 'quote' && !c.settled);
  const paidToward = (quoteId: string): number =>
    view.costs
      .filter((c) => c.kind === 'paid' && c.quoteId === quoteId)
      .reduce((sum, c) => sum + c.amountCents, 0);

  const saveDetails = (): void => {
    const target = parseYmd(details.target);
    if (target === undefined) {
      setError('Write the date as YYYY-MM-DD, for example 2027-10-01.');
      return;
    }
    const budget = details.budget.trim() === '' ? null : parseAmount(details.budget);
    if (details.budget.trim() !== '' && budget === null) {
      setError('Write the budget as a number, for example 450,000.');
      return;
    }
    void act('details', () => {
      updateGoalDetails(goal.id, {
        title: details.title,
        notes: details.notes,
        targetAt: target,
        budgetCents: budget,
      });
      setMessage('Saved.');
    });
  };

  const submitTask = (phaseId: string): void => {
    const title = taskDrafts[phaseId] ?? '';
    if (title.trim() === '') return;
    setTaskDrafts((d) => ({ ...d, [phaseId]: '' }));
    void act('task', () => addGoalTask(goal.id, phaseId, title));
  };

  const submitPhase = (): void => {
    if (phaseDraft.title.trim() === '') return;
    const target = parseYmd(phaseDraft.target);
    if (target === undefined) {
      setError('Write the date as YYYY-MM-DD, or leave it empty.');
      return;
    }
    const title = phaseDraft.title;
    setPhaseDraft({ title: '', target: '' });
    void act('phase', () => addGoalPhase(goal.id, title, target));
  };

  const savePhaseEdit = (): void => {
    if (phaseEdit === null) return;
    const target = parseYmd(phaseEdit.target);
    if (target === undefined) {
      setError('Write the date as YYYY-MM-DD, or leave it empty.');
      return;
    }
    const { id: phaseId, title } = phaseEdit;
    setPhaseEdit(null);
    void act('phase', () => updatePhaseDetails(phaseId, { title, targetAt: target }));
  };

  const renderTask = (t: PlanTask): React.ReactElement => {
    const done = t.status === 'done';
    const waiting = !done && t.waitingOn !== '';
    const blocked = !done && !waiting && !ready.has(t.id) && t.blockedBy.length > 0;
    return (
      <View key={t.id} style={styles.taskBlock}>
        <View style={styles.taskRow}>
          <Pressable
            onPress={() => void act('task', () => setTaskDone(t.id, !done))}
            testID={`goal-task-done-${t.id}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: done }}
            style={[styles.box, done && styles.boxOn]}
          >
            {done ? <Text style={styles.boxTick}>✓</Text> : null}
          </Pressable>
          <View style={styles.flex}>
            <Text style={[styles.body, done && styles.doneText]}>{t.title}</Text>
            {waiting ? (
              <Text style={styles.waitText}>
                Waiting on {t.waitingOn}
                {t.waitingUntil !== null ? ` · promised ${shortDate(t.waitingUntil)}` : ''}
              </Text>
            ) : blocked ? (
              <Text style={styles.sub}>After an earlier task</Text>
            ) : null}
          </View>
          <Pressable
            testID={`goal-task-edit-${t.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${t.title}`}
            onPress={() => setTaskEdit(taskEdit?.id === t.id ? null : { id: t.id, title: t.title })}
          >
            <Text style={styles.linkText}>Edit</Text>
          </Pressable>
          {!done ? (
            <Pressable
              testID={`goal-task-wait-${t.id}`}
              accessibilityRole="button"
              onPress={() =>
                waiting
                  ? void act('wait', () => setTaskWait(t.id, '', 0))
                  : setWaitFor({ taskId: t.id, who: '' })
              }
            >
              <Text style={styles.linkText}>{waiting ? 'Got it' : 'Waiting…'}</Text>
            </Pressable>
          ) : null}
        </View>
        {waitFor?.taskId === t.id ? (
          <View style={styles.waitEditor}>
            <TextInput
              value={waitFor.who}
              onChangeText={(who) => setWaitFor({ taskId: t.id, who })}
              placeholder="Who, e.g. Mike"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              testID="goal-wait-who"
              autoFocus
            />
            <View style={styles.chips}>
              {WAIT_CHOICES.map((c) => (
                <Pressable
                  key={c.days}
                  style={[styles.chip, waitFor.who.trim() === '' && styles.disabled]}
                  disabled={waitFor.who.trim() === ''}
                  testID={`goal-wait-${c.days}`}
                  accessibilityRole="button"
                  onPress={() => {
                    const who = waitFor.who;
                    setWaitFor(null);
                    void act('wait', () => setTaskWait(t.id, who, c.days));
                  }}
                >
                  <Text style={styles.chipText}>{c.label}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => setWaitFor(null)} accessibilityRole="button">
                <Text style={styles.linkText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {taskEdit?.id === t.id ? (
          <View style={styles.waitEditor} testID={`goal-task-editor-${t.id}`}>
            <TextInput
              value={taskEdit.title}
              onChangeText={(title) => setTaskEdit({ id: t.id, title })}
              style={styles.input}
              testID="goal-task-title"
              returnKeyType="done"
              onSubmitEditing={() => {
                const title = taskEdit.title;
                void act('rename', () => renameTask(t.id, title));
              }}
            />
            <View style={styles.chips}>
              <Pressable
                style={styles.chip}
                testID="goal-task-title-save"
                accessibilityRole="button"
                onPress={() => {
                  const title = taskEdit.title;
                  void act('rename', () => renameTask(t.id, title));
                }}
              >
                <Text style={styles.chipText}>Save name</Text>
              </Pressable>
              <Pressable
                style={styles.chip}
                testID="goal-task-drop"
                accessibilityRole="button"
                onPress={() => {
                  setTaskEdit(null);
                  void act('drop', () => dropTask(t.id));
                }}
              >
                <Text style={styles.chipText}>Drop task</Text>
              </Pressable>
            </View>
            {phases.some(({ phase: p }) => p.status !== 'done' && p.id !== t.phaseId) ? (
              <>
                <Text style={styles.sub}>Move to phase</Text>
                <View style={styles.chips}>
                  {phases.map(({ phase: p }, i) =>
                    p.status === 'done' ? null : (
                      <Pressable
                        key={p.id}
                        style={[styles.chip, t.phaseId === p.id && styles.chipOn]}
                        testID={`goal-task-phase-${i}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: t.phaseId === p.id }}
                        onPress={() => void act('move', () => moveTaskToPhase(t.id, p.id))}
                      >
                        <Text style={[styles.chipText, t.phaseId === p.id && styles.chipTextOn]}>
                          {i + 1}. {p.title}
                        </Text>
                      </Pressable>
                    ),
                  )}
                </View>
              </>
            ) : null}
            {allTasks.some((o) => o.id !== t.id && o.status === 'open') ? (
              <>
                <Text style={styles.sub}>Do this after</Text>
                <View style={styles.chips}>
                  {allTasks
                    .filter(
                      (o) => o.id !== t.id && (o.status === 'open' || t.blockedBy.includes(o.id)),
                    )
                    .map((o, i) => {
                      const on = t.blockedBy.includes(o.id);
                      return (
                        <Pressable
                          key={o.id}
                          style={[styles.chip, on && styles.chipOn]}
                          testID={`goal-task-after-${i}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: on }}
                          onPress={() =>
                            void act('order', () =>
                              setTaskOrder(
                                t.id,
                                on ? t.blockedBy.filter((x) => x !== o.id) : [...t.blockedBy, o.id],
                              ),
                            )
                          }
                        >
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.title}</Text>
                        </Pressable>
                      );
                    })}
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="goal-screen"
    >
      <Text style={styles.title}>{goal.title}</Text>

      <View style={styles.card}>
        <TextInput
          value={details.title}
          onChangeText={(title) => setDetails((d) => ({ ...d, title }))}
          placeholder="The goal"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          testID="goal-title"
          maxLength={200}
          accessibilityLabel="Goal name"
        />
        <TextInput
          value={details.notes}
          onChangeText={(notes) => setDetails((d) => ({ ...d, notes }))}
          placeholder="Notes for the plan: why, how often"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          testID="goal-notes"
          maxLength={500}
          multiline
          accessibilityLabel="Goal notes"
        />
        <View style={styles.fieldRow}>
          <Text style={[styles.body, styles.flex]}>Reach it by</Text>
          <TextInput
            value={details.target}
            onChangeText={(target) => setDetails((d) => ({ ...d, target }))}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.textMuted}
            style={styles.smallInput}
            testID="goal-target"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
          />
        </View>
        <View style={styles.fieldRow}>
          <Text style={[styles.body, styles.flex]}>Budget ({goal.currency})</Text>
          <TextInput
            value={details.budget}
            onChangeText={(budget) => setDetails((d) => ({ ...d, budget }))}
            placeholder="None"
            placeholderTextColor={colors.textMuted}
            style={styles.smallInput}
            testID="goal-budget"
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            maxLength={14}
          />
        </View>
        <Pressable
          style={styles.secondary}
          onPress={saveDetails}
          testID="goal-details-save"
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Save</Text>
        </Pressable>
      </View>

      {late !== null ? (
        <View style={styles.lateCard} testID="goal-late">
          <Text style={styles.lateTitle}>
            {late.phase.title} is {plural(late.days, 'day', 'days')} late
          </Text>
          <Text style={styles.lateBody}>
            Moving the dates shifts {plural(late.moves.length, 'phase', 'phases')}
            {goal.targetAt !== null
              ? ` and moves your date to ${shortDate(shiftCalendarDays(goal.targetAt, late.days))}`
              : ''}
            .
          </Text>
          <Pressable
            style={styles.primary}
            testID="goal-late-move"
            accessibilityRole="button"
            onPress={() =>
              void act('move', async () => {
                // An open phase editor holds the old date; saving it would undo this.
                setPhaseEdit(null);
                const days = await moveLateDates(goal.id);
                setMessage(`Moved by ${plural(days, 'day', 'days')}.`);
              })
            }
          >
            <Text style={styles.primaryText}>
              Move later dates by {plural(late.days, 'day', 'days')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {goal.draft !== null ? (
        <View style={styles.card} testID="goal-draft">
          <Text style={styles.eyebrow}>DRAFTED PLAN</Text>
          <Text style={styles.sub}>Nothing starts until you accept it.</Text>
          {goal.draft.phases.map((p, i) => (
            <View key={`${i}-${p.title}`} style={styles.draftPhase}>
              <Text style={styles.bodyStrong}>
                {i + 1}. {p.title}
                {p.targetAt !== null ? ` · by ${shortDate(p.targetAt)}` : ''}
              </Text>
              {p.notes !== '' ? <Text style={styles.sub}>{p.notes}</Text> : null}
              {p.tasks.map((t, j) => (
                <Text key={`${j}-${t.title}`} style={styles.sub}>
                  • {t.title}
                </Text>
              ))}
            </View>
          ))}
          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.primary, styles.flex]}
              testID="goal-draft-accept"
              accessibilityRole="button"
              onPress={() =>
                void act('accept', async () => {
                  if (!(await acceptGoalDraft(goal.id))) setError('This goal already has a plan.');
                })
              }
            >
              <Text style={styles.primaryText}>Accept plan</Text>
            </Pressable>
            <Pressable
              style={[styles.secondary, styles.flex]}
              testID="goal-draft-discard"
              accessibilityRole="button"
              onPress={() => void act('discard', () => discardGoalDraft(goal.id))}
            >
              <Text style={styles.secondaryText}>Discard</Text>
            </Pressable>
          </View>
        </View>
      ) : phases.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.body}>No plan yet.</Text>
          <Text style={styles.sub}>
            Dina can draft the phases for you to edit, or you can add them yourself below.
          </Text>
          <Pressable
            style={styles.primary}
            testID="goal-draft-make"
            accessibilityRole="button"
            disabled={busy !== ''}
            onPress={() =>
              void act('draft', async () => {
                if (!(await draftPlanForGoal(goal.id))) {
                  setError(
                    "Dina couldn't reach the AI to draft a plan. Add the phases yourself, or try again later.",
                  );
                }
              })
            }
          >
            {busy === 'draft' ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryText}>Draft a plan</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {phases.length > 0 ? <Text style={styles.eyebrow}>PHASES</Text> : null}
      {phases.map(({ phase, tasks }, i) => {
        const open = tasks.filter((t) => t.status === 'open').length;
        const doneN = tasks.length - open;
        return (
          <View
            key={phase.id}
            style={[styles.card, phase.status === 'done' && styles.dim]}
            testID={`goal-phase-${i}`}
          >
            <View style={styles.fieldRow}>
              <View style={styles.flex}>
                <Text style={styles.bodyStrong}>
                  {i + 1}. {phase.title}
                </Text>
                <Text style={styles.sub}>
                  {phase.status === 'active' ? 'Now' : phase.status === 'done' ? 'Done' : 'Later'}
                  {phase.targetAt !== null ? ` · by ${shortDate(phase.targetAt)}` : ''}
                  {tasks.length > 0 ? ` · ${doneN} of ${tasks.length} done` : ''}
                </Text>
              </View>
              <Pressable
                testID={`goal-phase-edit-${i}`}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${phase.title}`}
                onPress={() =>
                  setPhaseEdit(
                    phaseEdit?.id === phase.id
                      ? null
                      : {
                          id: phase.id,
                          title: phase.title,
                          target: ymd(phase.targetAt),
                          confirmDelete: false,
                        },
                  )
                }
              >
                <Text style={styles.linkText}>Edit</Text>
              </Pressable>
              {phase.status === 'active' ? (
                <Pressable
                  testID={`goal-phase-done-${i}`}
                  accessibilityRole="button"
                  onPress={() => {
                    if (open > 0) {
                      setFinishing(phase.id);
                      return;
                    }
                    void act('phase', async () => {
                      const next = await finishGoalPhase(phase.id);
                      if (next !== null) setMessage(`${next.title} has started.`);
                    });
                  }}
                >
                  <Text style={styles.linkText}>Phase done</Text>
                </Pressable>
              ) : phase.status === 'upcoming' ? (
                <Pressable
                  testID={`goal-phase-start-${i}`}
                  accessibilityRole="button"
                  onPress={() => void act('phase', () => startGoalPhase(phase.id))}
                >
                  <Text style={styles.linkText}>Start now</Text>
                </Pressable>
              ) : null}
            </View>
            {finishing === phase.id ? (
              <View style={styles.waitEditor} testID={`goal-phase-finish-${i}`}>
                <Text style={styles.sub}>
                  {plural(open, 'task is', 'tasks are')} still open.{' '}
                  {phases.slice(i + 1).some((p) => p.phase.status !== 'done') ||
                  phases.slice(0, i).some((p) => p.phase.status !== 'done')
                    ? 'They move to the next phase.'
                    : 'They stay on the goal, under no phase.'}
                </Text>
                <View style={styles.chips}>
                  <Pressable
                    style={styles.chip}
                    testID={`goal-phase-finish-yes-${i}`}
                    accessibilityRole="button"
                    onPress={() => {
                      setFinishing('');
                      void act('phase', async () => {
                        const next = await finishGoalPhase(phase.id);
                        if (next !== null) setMessage(`${next.title} has started.`);
                      });
                    }}
                  >
                    <Text style={styles.chipText}>Finish the phase</Text>
                  </Pressable>
                  <Pressable onPress={() => setFinishing('')} accessibilityRole="button">
                    <Text style={styles.linkText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            {phaseEdit?.id === phase.id ? (
              <View style={styles.phaseEditor} testID={`goal-phase-editor-${i}`}>
                <TextInput
                  value={phaseEdit.title}
                  onChangeText={(title) => setPhaseEdit({ ...phaseEdit, title })}
                  style={styles.input}
                  testID="goal-phase-title"
                  returnKeyType="done"
                  onSubmitEditing={savePhaseEdit}
                />
                <TextInput
                  value={phaseEdit.target}
                  onChangeText={(target) => setPhaseEdit({ ...phaseEdit, target })}
                  placeholder="End by YYYY-MM-DD (optional)"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  testID="goal-phase-date"
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  returnKeyType="done"
                  onSubmitEditing={savePhaseEdit}
                />
                <View style={styles.chips}>
                  <Pressable
                    style={styles.chip}
                    testID="goal-phase-save"
                    accessibilityRole="button"
                    onPress={savePhaseEdit}
                  >
                    <Text style={styles.chipText}>Save</Text>
                  </Pressable>
                  {i > 0 ? (
                    <Pressable
                      style={styles.chip}
                      testID="goal-phase-up"
                      accessibilityRole="button"
                      onPress={() => void act('phase', () => moveGoalPhase(phase.id, 'up'))}
                    >
                      <Text style={styles.chipText}>Move up</Text>
                    </Pressable>
                  ) : null}
                  {i < phases.length - 1 ? (
                    <Pressable
                      style={styles.chip}
                      testID="goal-phase-down"
                      accessibilityRole="button"
                      onPress={() => void act('phase', () => moveGoalPhase(phase.id, 'down'))}
                    >
                      <Text style={styles.chipText}>Move down</Text>
                    </Pressable>
                  ) : null}
                  {phase.status === 'done' ? (
                    <Pressable
                      style={styles.chip}
                      testID="goal-phase-reopen"
                      accessibilityRole="button"
                      onPress={() => {
                        setPhaseEdit(null);
                        void act('phase', () => reopenGoalPhase(phase.id));
                      }}
                    >
                      <Text style={styles.chipText}>Not done yet</Text>
                    </Pressable>
                  ) : null}
                  {phaseEdit.confirmDelete ? (
                    <Pressable
                      style={styles.chip}
                      testID="goal-phase-delete-yes"
                      accessibilityRole="button"
                      onPress={() => {
                        setPhaseEdit(null);
                        void act('phase', () => deleteGoalPhase(phase.id));
                      }}
                    >
                      <Text style={styles.deleteText}>Yes, delete the phase</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={styles.chip}
                      testID="goal-phase-delete"
                      accessibilityRole="button"
                      onPress={() => setPhaseEdit({ ...phaseEdit, confirmDelete: true })}
                    >
                      <Text style={styles.chipText}>Delete</Text>
                    </Pressable>
                  )}
                </View>
                {phaseEdit.confirmDelete ? (
                  <Text style={styles.sub}>
                    Its tasks and money stay on the goal, under no phase.
                  </Text>
                ) : null}
              </View>
            ) : null}
            {phase.status !== 'done' ? tasks.map(renderTask) : null}
            {phase.status !== 'done' ? (
              <>
                {phase.status === 'active' && open === 0 ? (
                  <Pressable
                    testID={`goal-phase-suggest-${i}`}
                    accessibilityRole="button"
                    disabled={busy !== ''}
                    onPress={() =>
                      void act('suggest', async () => {
                        const n = await suggestTasksForPhase(phase.id);
                        if (n === 0)
                          setError("Dina couldn't suggest tasks just now. Add them yourself.");
                      })
                    }
                  >
                    <Text style={styles.linkText}>
                      {busy === 'suggest' ? 'Asking…' : 'Suggest tasks for this phase'}
                    </Text>
                  </Pressable>
                ) : null}
                <View style={styles.addRow}>
                  <TextInput
                    value={taskDrafts[phase.id] ?? ''}
                    onChangeText={(v) => setTaskDrafts((d) => ({ ...d, [phase.id]: v }))}
                    placeholder="Add a task"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    testID={`goal-task-input-${i}`}
                    returnKeyType="done"
                    onSubmitEditing={() => submitTask(phase.id)}
                  />
                  <Pressable
                    style={[
                      styles.primarySmall,
                      (taskDrafts[phase.id] ?? '').trim() === '' && styles.disabled,
                    ]}
                    disabled={(taskDrafts[phase.id] ?? '').trim() === ''}
                    testID={`goal-task-add-${i}`}
                    accessibilityRole="button"
                    onPress={() => submitTask(phase.id)}
                  >
                    <Text style={styles.primaryText}>+</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
        );
      })}
      {loose.filter((t) => t.status === 'open').length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>OTHER TASKS FOR THIS GOAL</Text>
          {loose.filter((t) => t.status === 'open').map(renderTask)}
        </View>
      ) : null}

      {goal.draft === null ? (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>ADD A PHASE</Text>
          <TextInput
            value={phaseDraft.title}
            onChangeText={(title) => setPhaseDraft((d) => ({ ...d, title }))}
            placeholder="e.g. Foundation"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            testID="goal-phase-input"
            returnKeyType="done"
            onSubmitEditing={submitPhase}
          />
          <View style={styles.addRow}>
            <TextInput
              value={phaseDraft.target}
              onChangeText={(target) => setPhaseDraft((d) => ({ ...d, target }))}
              placeholder="End by YYYY-MM-DD (optional)"
              placeholderTextColor={colors.textMuted}
              style={[styles.dateInput, styles.flex]}
              testID="goal-phase-target"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              returnKeyType="done"
              onSubmitEditing={submitPhase}
            />
            <Pressable
              style={[styles.primarySmall, phaseDraft.title.trim() === '' && styles.disabled]}
              disabled={phaseDraft.title.trim() === ''}
              testID="goal-phase-add"
              accessibilityRole="button"
              onPress={submitPhase}
            >
              <Text style={styles.primaryText}>Add</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <Text style={styles.eyebrow}>THINGS THAT REPEAT</Text>
      <RoutinesCard
        routines={view.routines}
        goalId={goal.id}
        onAdd={(input) => void act('routine', () => addRoutine(input))}
        onStop={(rid) => void act('routine', () => stopRoutine(rid))}
        onTick={(tid, on) => void act('routine', () => setTaskDone(tid, on))}
      />

      {waits.length > 0 ? (
        <View style={styles.card} testID="goal-waits">
          <Text style={styles.eyebrow}>WAITING ON</Text>
          {waits.map((t) => (
            <Text key={t.id} style={styles.body}>
              {t.waitingOn}: {t.title}
              {t.waitingUntil !== null ? ` · ${shortDate(t.waitingUntil)}` : ''}
            </Text>
          ))}
        </View>
      ) : null}

      <Text style={styles.eyebrow}>MONEY</Text>
      <View style={styles.card} testID="goal-money">
        <View style={styles.moneyGrid}>
          {(
            [
              ['Budget', money.budgetCents],
              ['Paid', money.paidCents],
              ['Open quotes', money.openQuoteCents],
              ['Left', money.leftCents],
            ] as const
          ).map(([label, cents]) => (
            <View key={label} style={styles.moneyCell}>
              <Text style={styles.sub}>{label}</Text>
              <Text
                style={[
                  styles.money,
                  label === 'Left' && cents !== null && cents < 0 && styles.over,
                ]}
              >
                {cents === null ? '—' : formatGoalMoney(cents, goal.currency)}
              </Text>
            </View>
          ))}
        </View>
        {money.leftCents !== null && money.openQuoteCents > 0 ? (
          <Text style={styles.sub}>Left counts every open quote as paid.</Text>
        ) : null}
        {(allCosts ? view.costs : view.costs.slice(-5))
          .slice()
          .reverse()
          .map((c) => (
            <View key={c.id} style={styles.fieldRow}>
              <Text style={[styles.sub, styles.flex]}>
                {c.kind === 'paid' ? 'Paid' : c.settled ? 'Quote, paid' : 'Quote'} · {c.label} ·{' '}
                {formatGoalMoney(c.amountCents, goal.currency)}
                {c.kind === 'quote' && !c.settled && paidToward(c.id) > 0
                  ? ` · ${formatGoalMoney(paidToward(c.id), goal.currency)} paid so far`
                  : ''}
              </Text>
              <Pressable
                testID={`goal-cost-remove-${c.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${c.label}`}
                onPress={() => void act('cost', () => removeGoalCost(c.id))}
              >
                <Text style={styles.linkText}>Remove</Text>
              </Pressable>
            </View>
          ))}
        {view.costs.length > 5 ? (
          <Pressable
            testID="goal-costs-all"
            accessibilityRole="button"
            onPress={() => setAllCosts((v) => !v)}
          >
            <Text style={styles.linkText}>
              {allCosts ? 'Show the last 5' : `Show all ${view.costs.length}`}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.addRow}>
          <TextInput
            value={cost.label}
            onChangeText={(label) => setCost((c) => ({ ...c, label }))}
            placeholder="What for"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            testID="goal-cost-label"
          />
          <TextInput
            value={cost.amount}
            onChangeText={(amount) => setCost((c) => ({ ...c, amount }))}
            placeholder="Amount"
            placeholderTextColor={colors.textMuted}
            style={styles.dateInput}
            testID="goal-cost-amount"
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
          />
        </View>
        <View style={styles.buttonRow}>
          {(['quote', 'paid'] as const).map((k) => (
            <Pressable
              key={k}
              style={[styles.chip, cost.kind === k && styles.chipOn]}
              testID={`goal-cost-kind-${k}`}
              accessibilityRole="button"
              accessibilityState={{ selected: cost.kind === k }}
              onPress={() => setCost((c) => ({ ...c, kind: k, quoteId: '' }))}
            >
              <Text style={[styles.chipText, cost.kind === k && styles.chipTextOn]}>
                {k === 'quote' ? 'Quote' : 'Paid'}
              </Text>
            </Pressable>
          ))}
          <Pressable
            style={[styles.primarySmall, styles.flex]}
            testID="goal-cost-save"
            accessibilityRole="button"
            onPress={() =>
              void act('cost', () => {
                recordGoalCost(
                  goal.id,
                  cost.label,
                  cost.amount,
                  cost.kind,
                  '',
                  Date.now(),
                  cost.quoteId,
                );
                setCost({ label: '', amount: '', kind: cost.kind, quoteId: '' });
              })
            }
          >
            <Text style={styles.primaryText}>Record</Text>
          </Pressable>
        </View>
        {cost.kind === 'paid' && openQuotes.length > 0 ? (
          <>
            <Text style={styles.sub}>Paying toward a quote?</Text>
            <View style={styles.chips}>
              {openQuotes.map((q, i) => (
                <Pressable
                  key={q.id}
                  style={[styles.chip, cost.quoteId === q.id && styles.chipOn]}
                  testID={`goal-cost-quote-${i}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: cost.quoteId === q.id }}
                  onPress={() =>
                    setCost((c) => ({ ...c, quoteId: c.quoteId === q.id ? '' : q.id }))
                  }
                >
                  <Text style={[styles.chipText, cost.quoteId === q.id && styles.chipTextOn]}>
                    {q.label} · {formatGoalMoney(q.amountCents, goal.currency)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <Text style={styles.sub}>Dina keeps track of the money. She never pays anyone.</Text>
      </View>

      {message !== '' ? (
        <Text style={styles.sub} testID="goal-message">
          {message}
        </Text>
      ) : null}
      {error !== '' ? (
        <Text style={styles.error} testID="goal-error">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
  pad: { padding: spacing.md },
  title: { ...textStyles.h2, color: colors.textPrimary },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  dim: { opacity: 0.6 },
  lateCard: {
    backgroundColor: colors.warningBgSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  lateTitle: { ...textStyles.bodyStrong, color: colors.warningTextDeep },
  lateBody: { ...textStyles.bodySmall, color: colors.warningTextDeepest },
  eyebrow: { ...textStyles.eyebrow, letterSpacing: 0.6, marginTop: spacing.sm },
  body: { ...textStyles.body, color: colors.textPrimary },
  bodyStrong: { ...textStyles.bodyStrong, color: colors.textPrimary },
  sub: { ...textStyles.bodySmall, color: colors.textSecondary },
  waitText: { ...textStyles.bodySmall, color: colors.warningTextMid },
  doneText: { color: colors.textMuted, textDecorationLine: 'line-through' },
  flex: { flex: 1 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  draftPhase: { gap: 2 },
  taskBlock: { gap: spacing.xs },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.success, borderColor: colors.success },
  boxTick: { color: colors.white, fontSize: 13, fontWeight: '700' },
  waitEditor: { gap: spacing.xs, paddingLeft: 30 },
  phaseEditor: { gap: spacing.xs },
  deleteText: { ...textStyles.bodySmall, color: colors.error },
  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
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
  addRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    ...textStyles.body,
    flex: 1,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  smallInput: {
    ...textStyles.mono,
    width: 130,
    textAlign: 'center',
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
  },
  dateInput: {
    ...textStyles.body,
    width: 120,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    minHeight: 44,
  },
  moneyGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.sm },
  moneyCell: { width: '50%', gap: 2 },
  money: { ...textStyles.bodyStrong, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  over: { color: colors.error },
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
    alignItems: 'center',
  },
  primaryText: { ...textStyles.bodyStrong, color: colors.white },
  secondary: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  secondaryText: { ...textStyles.bodyStrong, color: colors.textPrimary },
  disabled: { opacity: 0.5 },
  linkText: { ...textStyles.bodySmall, color: colors.accent },
  error: { ...textStyles.bodySmall, color: colors.error },
});
