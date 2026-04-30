/**
 * Trust Network — compose / edit attestation flow (TN-MOB-013 / Plan §8.6).
 *
 * Captures the fields needed to publish a `com.dina.trust.attestation`:
 *   - subject (already known — passed in by the caller)
 *   - sentiment (positive / neutral / negative)
 *   - headline (≤ 140 chars per Plan §8.5)
 *   - optional body (≤ 4000 chars)
 *   - confidence (certain / high / moderate / speculative)
 *
 * The screen is presentational — it captures form state, validates
 * via `validateWriteForm`, and on submit fires `onPublish(state)`.
 * The runner that assembles the actual atproto record + handles
 * outbox queueing (TN-MOB-007) wraps this component.
 *
 * **Edit mode**: when `editing.originalUri` is present, the screen
 * reads `editing.cosigCount` and surfaces the cosignature-release
 * warning via `deriveEditWarning` BEFORE the publish callback fires
 * (Plan §8.6 row 19 — "edit = delete + republish breaks endorsements").
 * The screen renders the warning inline — the actual warning modal
 * is a host concern (the screen exposes `editWarning` so the runner
 * can render its own dialog if it wants).
 *
 * Three render states pinned by tests:
 *   1. **Compose** — fresh form for a new review.
 *   2. **Edit (no cosig)** — same form pre-filled with existing
 *      values, no warning.
 *   3. **Edit (with cosig)** — same form, but Publish CTA shows a
 *      warning chip + the screen exposes `editWarning` for the
 *      caller to render its own modal.
 *
 * The submitting / error states ride on top: `isSubmitting=true`
 * disables the form; `submitError` renders inline above Publish.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';

import { colors, fonts, spacing, radius } from '../../src/theme';
import {
  emptyWriteFormState,
  validateWriteForm,
  describeWriteFormError,
  SENTIMENT_OPTIONS,
  CONFIDENCE_OPTIONS,
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  type WriteFormState,
  type WriteFormError,
} from '../../src/trust/write_form_data';
import { deriveEditWarning, type EditWarning } from '../../src/trust/edit_flow';

import type { Sentiment, Confidence } from '@dina/protocol';

const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
};

const SENTIMENT_ICON: Record<Sentiment, 'thumbs-up' | 'remove' | 'thumbs-down'> = {
  positive: 'thumbs-up',
  neutral: 'remove',
  negative: 'thumbs-down',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  certain: 'Certain',
  high: 'High',
  moderate: 'Moderate',
  speculative: 'Speculative',
};

export interface WriteScreenEditContext {
  /** AT-URI of the original record being edited. */
  readonly originalUri: string;
  /** Cosignature count on the original — drives the warning. */
  readonly cosigCount: number;
}

export interface WriteScreenProps {
  /** Subject the review targets — title shown in the header for context. */
  subjectTitle: string;
  /** Initial form values. Defaults to `emptyWriteFormState()` for compose. */
  initial?: WriteFormState;
  /** When set, the screen runs in edit mode + may surface the cosig warning. */
  editing?: WriteScreenEditContext;
  /** Whether a publish call is in flight. Disables the form. */
  isSubmitting?: boolean;
  /** Inline error from the last publish attempt. `null` to clear. */
  submitError?: string | null;
  /** Fired when the user taps Publish on a valid form. */
  onPublish?: (state: WriteFormState) => void;
  /** Fired when the user taps Cancel — caller pops the screen. */
  onCancel?: () => void;
}

export default function WriteScreen(props: WriteScreenProps): React.ReactElement {
  const {
    subjectTitle,
    initial = emptyWriteFormState(),
    editing = undefined,
    isSubmitting = false,
    submitError = null,
    onPublish,
    onCancel,
  } = props;

  const [state, setState] = React.useState<WriteFormState>(initial);
  const validation = React.useMemo(() => validateWriteForm(state), [state]);
  const editWarning = React.useMemo<EditWarning | null>(
    () => (editing ? deriveEditWarning(editing.cosigCount) : null),
    [editing],
  );

  const updateSentiment = (s: Sentiment): void =>
    setState((prev) => ({ ...prev, sentiment: prev.sentiment === s ? null : s }));
  const updateConfidence = (c: Confidence): void =>
    setState((prev) => ({ ...prev, confidence: prev.confidence === c ? null : c }));
  const updateHeadline = (text: string): void =>
    setState((prev) => ({ ...prev, headline: text }));
  const updateBody = (text: string): void => setState((prev) => ({ ...prev, body: text }));

  const handlePublish = (): void => {
    if (!validation.canPublish || isSubmitting || !onPublish) return;
    onPublish(state);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="write-screen"
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {editing ? 'Edit review' : 'Write a review'}
        </Text>
        <Text style={styles.headerSubtitle} numberOfLines={1}>
          About: <Text style={styles.headerSubject}>{subjectTitle}</Text>
        </Text>
      </View>

      {editWarning && (
        <View style={styles.warningPanel} testID="write-edit-warning">
          <Ionicons name="warning" size={18} color={colors.warning} />
          <View style={styles.warningBody}>
            <Text style={styles.warningTitle}>{editWarning.title}</Text>
            <Text style={styles.warningText}>{editWarning.body}</Text>
          </View>
        </View>
      )}

      {/* ─── Sentiment ───────────────────────────────────────────── */}
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Sentiment</Text>
        <View style={styles.sentimentRow}>
          {SENTIMENT_OPTIONS.map((s) => (
            <Pressable
              key={s}
              onPress={() => !isSubmitting && updateSentiment(s)}
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.sentimentBtn,
                state.sentiment === s && styles.sentimentBtnActive,
                pressed && !isSubmitting && styles.sentimentBtnPressed,
              ]}
              testID={`write-sentiment-${s}`}
              accessibilityRole="button"
              accessibilityLabel={SENTIMENT_LABEL[s]}
              accessibilityState={{ selected: state.sentiment === s, disabled: isSubmitting }}
            >
              <Ionicons
                name={SENTIMENT_ICON[s]}
                size={16}
                color={state.sentiment === s ? colors.bgSecondary : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sentimentLabel,
                  state.sentiment === s && styles.sentimentLabelActive,
                ]}
              >
                {SENTIMENT_LABEL[s]}
              </Text>
            </Pressable>
          ))}
        </View>
        {fieldError(validation.errors, ['sentiment_required'])}
      </View>

      {/* ─── Headline ────────────────────────────────────────────── */}
      <View style={styles.field}>
        <View style={styles.fieldHeader}>
          <Text style={styles.fieldLabel}>Headline</Text>
          <Text
            style={[
              styles.charCount,
              validation.headlineLength > HEADLINE_MAX_LENGTH && styles.charCountOverflow,
            ]}
          >
            {validation.headlineLength} / {HEADLINE_MAX_LENGTH}
          </Text>
        </View>
        <TextInput
          value={state.headline}
          onChangeText={updateHeadline}
          editable={!isSubmitting}
          placeholder="A short summary of your review"
          placeholderTextColor={colors.textMuted}
          style={[styles.input, styles.headlineInput]}
          maxLength={HEADLINE_MAX_LENGTH * 2 /* allow over-typing so user sees the warning */}
          testID="write-headline-input"
          accessibilityLabel="Headline"
        />
        {fieldError(validation.errors, ['headline_empty', 'headline_too_long'])}
      </View>

      {/* ─── Body ────────────────────────────────────────────────── */}
      <View style={styles.field}>
        <View style={styles.fieldHeader}>
          <Text style={styles.fieldLabel}>Body (optional)</Text>
          <Text
            style={[
              styles.charCount,
              validation.bodyLength > BODY_MAX_LENGTH && styles.charCountOverflow,
            ]}
          >
            {validation.bodyLength} / {BODY_MAX_LENGTH}
          </Text>
        </View>
        <TextInput
          value={state.body}
          onChangeText={updateBody}
          editable={!isSubmitting}
          placeholder="Add detail, evidence, or caveats"
          placeholderTextColor={colors.textMuted}
          style={[styles.input, styles.bodyInput]}
          multiline
          textAlignVertical="top"
          testID="write-body-input"
          accessibilityLabel="Body"
        />
        {fieldError(validation.errors, ['body_too_long'])}
      </View>

      {/* ─── Confidence ──────────────────────────────────────────── */}
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Confidence</Text>
        <View style={styles.confidenceRow}>
          {CONFIDENCE_OPTIONS.map((c) => (
            <Pressable
              key={c}
              onPress={() => !isSubmitting && updateConfidence(c)}
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.confidenceBtn,
                state.confidence === c && styles.confidenceBtnActive,
                pressed && !isSubmitting && styles.confidenceBtnPressed,
              ]}
              testID={`write-confidence-${c}`}
              accessibilityRole="button"
              accessibilityLabel={CONFIDENCE_LABEL[c]}
              accessibilityState={{ selected: state.confidence === c, disabled: isSubmitting }}
            >
              <Text
                style={[
                  styles.confidenceLabel,
                  state.confidence === c && styles.confidenceLabelActive,
                ]}
              >
                {CONFIDENCE_LABEL[c]}
              </Text>
            </Pressable>
          ))}
        </View>
        {fieldError(validation.errors, ['confidence_required'])}
      </View>

      {/* ─── Submit error ────────────────────────────────────────── */}
      {submitError !== null && (
        <View style={styles.submitErrorPanel} testID="write-submit-error">
          <Ionicons name="alert-circle" size={16} color={colors.error} />
          <Text style={styles.submitErrorText}>{submitError}</Text>
        </View>
      )}

      {/* ─── Actions ─────────────────────────────────────────────── */}
      <View style={styles.actionRow}>
        {onCancel && (
          <Pressable
            onPress={onCancel}
            disabled={isSubmitting}
            style={({ pressed }) => [
              styles.cancelBtn,
              pressed && !isSubmitting && styles.cancelBtnPressed,
            ]}
            testID="write-cancel"
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            accessibilityState={{ disabled: isSubmitting }}
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        )}
        <Pressable
          onPress={handlePublish}
          disabled={!validation.canPublish || isSubmitting}
          style={({ pressed }) => [
            styles.publishBtn,
            (!validation.canPublish || isSubmitting) && styles.publishBtnDisabled,
            pressed && validation.canPublish && !isSubmitting && styles.publishBtnPressed,
          ]}
          testID="write-publish"
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Publish edit' : 'Publish'}
          accessibilityState={{
            disabled: !validation.canPublish || isSubmitting,
            busy: isSubmitting,
          }}
        >
          {isSubmitting ? (
            <ActivityIndicator color={colors.bgSecondary} />
          ) : (
            <>
              <Ionicons name="paper-plane" size={16} color={colors.bgSecondary} />
              <Text style={styles.publishLabel}>{editing ? 'Publish edit' : 'Publish'}</Text>
            </>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * Render an inline error message under a field, but only for errors
 * relevant to that field. Returns null when no relevant error is
 * present so the layout stays tight.
 */
function fieldError(
  allErrors: ReadonlyArray<WriteFormError>,
  watch: ReadonlyArray<WriteFormError>,
): React.ReactElement | null {
  const relevant = allErrors.find((e) => watch.includes(e));
  if (!relevant) return null;
  return (
    <Text style={styles.fieldError} testID={`write-error-${relevant}`}>
      {describeWriteFormError(relevant)}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  header: { gap: spacing.xs },
  headerTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.textPrimary,
  },
  headerSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
  },
  headerSubject: {
    fontFamily: fonts.sansMedium,
    color: colors.textPrimary,
  },
  warningPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
  },
  warningBody: { flex: 1, gap: spacing.xs },
  warningTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.textPrimary,
  },
  warningText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  field: { gap: spacing.sm },
  fieldHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  fieldLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  fieldError: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.error,
    marginTop: spacing.xs,
  },
  charCount: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  charCountOverflow: { color: colors.error },
  sentimentRow: { flexDirection: 'row', gap: spacing.sm },
  sentimentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: 44,
    gap: spacing.xs,
  },
  sentimentBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  sentimentBtnPressed: { backgroundColor: colors.bgTertiary },
  sentimentLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  sentimentLabelActive: { color: colors.bgSecondary },
  input: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
    minHeight: 44,
  },
  headlineInput: {},
  bodyInput: { minHeight: 120 },
  confidenceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  confidenceBtn: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  confidenceBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  confidenceBtnPressed: { backgroundColor: colors.bgTertiary },
  confidenceLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  confidenceLabelActive: { color: colors.bgSecondary },
  submitErrorPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.error,
  },
  submitErrorText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cancelBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: 48,
    justifyContent: 'center',
  },
  cancelBtnPressed: { backgroundColor: colors.bgTertiary },
  cancelLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textSecondary,
  },
  publishBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: spacing.sm,
    minHeight: 48,
  },
  publishBtnDisabled: { backgroundColor: colors.textMuted },
  publishBtnPressed: { backgroundColor: colors.accentHover },
  publishLabel: {
    fontFamily: fonts.headingBold,
    fontSize: 15,
    color: colors.bgSecondary,
  },
});
