/**
 * `InlineReviewDraftCard` — chat-thread inline renderer for a `'dina'`
 * message tagged with `metadata.lifecycle.kind === 'review_draft'`.
 *
 * The card is posted by `startReviewDraft` (mobile) when the user types
 * "/ask write a review of <X>". States morph:
 *   - drafting   → spinner + "Drafting…" line
 *   - ready      → editable sentiment / headline / body + Publish /
 *                  Edit-in-form / Discard
 *   - publishing → buttons disabled, spinner on Publish
 *   - published  → receipt with "View" deep-link
 *   - discarded  → faded, "Draft discarded"
 *   - failed     → "Couldn't draft" + Edit-in-form (start fresh)
 *
 * **Loyalty Law.** The card never auto-publishes. Editing happens
 * locally; Publish is an explicit user action. Anything beyond the
 * three primary fields (sentiment / headline / body) is editable in
 * the full WriteScreen via "Edit in form".
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  readLifecycle,
  type ChatMessage,
  type ReviewDraftLifecycle,
} from '@dina/brain/chat';
import { type PublishJob } from '@dina/core';

import { describePublishErrorCode } from '../peerlens/classify_publish_error';
import {
  buildAttestationRecord,
  newPublishKeys,
} from '../peerlens/publish_helpers';
import { setReviewDraftStatus } from '../peerlens/review_draft';
import { type AttestationDraftBody } from '../peerlens/review_draft_body';
import { cancelReviewPublishJob, retryReviewPublishJob } from '../peerlens/review_publish_actions';
import { submitReviewFromUI } from '../peerlens/submit_review_ui';
import { useReviewPublishJob } from '../peerlens/useReviewPublishJob';
import {
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  SENTIMENT_OPTIONS,
  type WriteFormState,
} from '../peerlens/write_form_data';
import { colors, radius, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

import type { Sentiment } from '@dina/protocol';


export interface InlineReviewDraftCardProps {
  message: ChatMessage;
}

const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
};

const SENTIMENT_ICON: Record<Sentiment, keyof typeof Ionicons.glyphMap> = {
  positive: 'thumbs-up',
  neutral: 'remove-outline',
  negative: 'thumbs-down',
};

export function InlineReviewDraftCard({
  message,
}: InlineReviewDraftCardProps): React.JSX.Element | null {
  const lc = readLifecycle(message);
  const draftId = lc !== null && lc.kind === 'review_draft' ? lc.draftId : undefined;
  // The durable publish JOB is the source of truth for every POST-submit state
  // (queued / publishing / failed / published). The chat-message lifecycle only
  // owns the PRE-submit phase (drafting / ready) + the discarded terminal.
  const job = useReviewPublishJob(message.threadId, draftId);
  if (lc === null || lc.kind !== 'review_draft') return null;

  if (lc.status === 'drafting') return <DraftingState message={message} lc={lc} />;
  if (job !== null) return <JobState message={message} lc={lc} job={job} />;
  // `failed` WITHOUT a job is a DRAFTING failure (the LLM couldn't draft) — there
  // was never a publish to retry. Checked after the job branch so a publish
  // failure (which always has a job) still routes to <JobState>. Surfaces
  // lc.error instead of silently dropping it into an empty editable ReadyState.
  if (lc.status === 'failed') return <DraftFailedState message={message} lc={lc} />;
  if (lc.status === 'discarded') return <DiscardedState message={message} lc={lc} />;
  // ready (or a cancelled job that reverted) → editable draft
  return <ReadyState message={message} lc={lc} />;
}

// ─── States ────────────────────────────────────────────────────────────

function DraftingState({
  message,
  lc,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
}): React.JSX.Element {
  const subjectName =
    typeof lc.subject.name === 'string' ? lc.subject.name : 'this subject';
  return (
    <View style={styles.card} testID="review-draft-card-drafting">
      <View style={styles.headerRow}>
        <ActivityIndicator color={colors.textMuted} size="small" />
        <Text style={styles.title}>Drafting a review…</Text>
      </View>
      <Text style={styles.subtitle}>Subject: {subjectName}</Text>
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

function ReadyState({
  message,
  lc,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
}): React.JSX.Element {
  const router = useRouter();
  const initialValues = (lc.values ?? {}) as Partial<WriteFormState>;
  const subjectName =
    typeof lc.subject.name === 'string' ? lc.subject.name : 'subject';

  // Local edit state — mirrors the lifecycle values but lets the user
  // tweak fields before publishing without round-tripping each
  // keystroke through `updateReviewDraftLifecycle`. On Publish we read
  // from this local state.
  const [sentiment, setSentiment] = useState<Sentiment | null>(
    initialValues.sentiment ?? null,
  );
  const [headline, setHeadline] = useState<string>(initialValues.headline ?? '');
  const [body, setBody] = useState<string>(initialValues.body ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publishDisabled =
    submitting ||
    sentiment === null ||
    headline.trim().length === 0 ||
    headline.length > HEADLINE_MAX_LENGTH ||
    body.length > BODY_MAX_LENGTH;

  const onPublish = useCallback(async () => {
    if (publishDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      // Reconstitute a publishable WriteFormState from the lifecycle values +
      // the locally-edited primary fields. Anything the user didn't touch flows
      // through unchanged from what the LLM drafted.
      const merged: WriteFormState = {
        ...(initialValues as WriteFormState),
        sentiment,
        headline: headline.trim(),
        body: body.trim(),
      };
      // Persist the merged edits onto the lifecycle BEFORE handing off to the
      // durable job. Once a job exists the card flips to <JobState>; if the user
      // later cancels/dismisses it, the card reverts to ReadyState and must show
      // THESE edits — not the original LLM draft (lc.values was otherwise never
      // updated with the inline edits, so they'd be silently lost).
      setReviewDraftStatus(message.threadId, lc.draftId, 'ready', { values: merged });
      const record = buildAttestationRecord(merged) as Record<string, unknown>;
      const { rkey } = newPublishKeys();
      const draft: AttestationDraftBody = {
        sentiment: sentiment ?? 'neutral', // non-null here: publishDisabled gates sentiment === null
        headline: merged.headline,
        body: merged.body,
        confidence: merged.confidence ?? 'moderate', // form seeds 'moderate'; default defensively
        subjectTitle: subjectName,
        subjectId: typeof lc.subject.identifier === 'string' ? lc.subject.identifier : undefined,
      };
      // ONE entrypoint (same as the full form): creates the durable job + runs
      // an inline attempt. On published/queued a job now exists, so the card
      // re-renders to <JobState> via the projection hook — no lifecycle patch.
      // Only the no-job gates surface an inline error here.
      const outcome = await submitReviewFromUI({
        rkey,
        record,
        draft,
        threadId: message.threadId,
        draftId: lc.draftId,
      });
      if (outcome.kind === 'no_credentials') {
        setError(describePublishErrorCode('no_credentials'));
      } else if (outcome.kind === 'cap_exceeded') {
        setError('Your outbox is full. Dismiss some queued reviews and try again.');
      } else if (outcome.kind === 'demo_scope') {
        setError("Publishing isn’t available in the demo. Switch to your own space to publish.");
      } else if (outcome.kind === 'error') {
        setError(outcome.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publish failed.');
    } finally {
      setSubmitting(false);
    }
  }, [
    publishDisabled,
    message.threadId,
    lc.draftId,
    lc.subject,
    initialValues,
    sentiment,
    headline,
    body,
    subjectName,
  ]);

  const onEditInForm = useCallback(() => {
    // Stash the in-progress edits onto the lifecycle so the form picks
    // them up on focus. The form already supports `initial` prop, but
    // routing through expo-router can't carry an object — we rely on
    // the lifecycle values being patched first, then deep-link to a
    // dedicated draft route. For now: just persist the local edits
    // back so a future "open form" path can read them.
    const merged: WriteFormState = {
      ...(initialValues as WriteFormState),
      sentiment,
      headline: headline.trim(),
      body: body.trim(),
    };
    setReviewDraftStatus(message.threadId, lc.draftId, 'ready', {
      values: merged,
    });
    // Navigate to the write form prefilled. Pass the draftId via query
    // so the form can pull the lifecycle on mount.
    router.push({
      pathname: '/peerlens/write',
      params: { draftId: lc.draftId, threadId: message.threadId },
    });
  }, [
    router,
    message.threadId,
    lc.draftId,
    initialValues,
    sentiment,
    headline,
    body,
  ]);

  const onDiscard = useCallback(() => {
    setReviewDraftStatus(message.threadId, lc.draftId, 'discarded', {
      content: `Discarded the draft of ${subjectName}.`,
    });
  }, [message.threadId, lc.draftId, subjectName]);

  return (
    <View style={styles.card} testID="review-draft-card-ready">
      <View style={styles.headerRow}>
        <Ionicons name="sparkles-outline" size={18} color={colors.textPrimary} />
        <Text style={styles.title} numberOfLines={1}>
          Review · {subjectName}
        </Text>
      </View>

      {/* Sentiment row */}
      <View style={styles.fieldBlock}>
        <Text style={styles.label}>Sentiment</Text>
        <View style={styles.sentimentRow}>
          {SENTIMENT_OPTIONS.map((s) => {
            const active = sentiment === s;
            return (
              <Pressable
                key={s}
                testID={`review-draft-sentiment-${s}`}
                onPress={() => setSentiment(s)}
                style={[styles.sentimentPill, active && styles.sentimentPillActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Ionicons
                  name={SENTIMENT_ICON[s]}
                  size={14}
                  color={active ? colors.bgPrimary : colors.textPrimary}
                />
                <Text
                  style={[
                    styles.sentimentPillText,
                    active && styles.sentimentPillTextActive,
                  ]}
                >
                  {SENTIMENT_LABEL[s]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Headline */}
      <View style={styles.fieldBlock}>
        <Text style={styles.label}>Headline</Text>
        <TextInput
          testID="review-draft-headline"
          value={headline}
          onChangeText={setHeadline}
          maxLength={HEADLINE_MAX_LENGTH}
          placeholder="One short line"
          placeholderTextColor={colors.textMuted}
          style={styles.headlineInput}
        />
      </View>

      {/* Body */}
      <View style={styles.fieldBlock}>
        <Text style={styles.label}>Body</Text>
        <TextInput
          testID="review-draft-body"
          value={body}
          onChangeText={setBody}
          maxLength={BODY_MAX_LENGTH}
          placeholder="Add detail, evidence, or caveats"
          placeholderTextColor={colors.textMuted}
          multiline
          style={styles.bodyInput}
        />
      </View>

      {error !== null && <Text style={styles.errorText}>{error}</Text>}

      {/* Actions row */}
      <View style={styles.actionRow}>
        <Pressable
          testID="review-draft-discard"
          onPress={onDiscard}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Discard</Text>
        </Pressable>
        <Pressable
          testID="review-draft-edit-in-form"
          onPress={onEditInForm}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Edit in form</Text>
        </Pressable>
        <Pressable
          testID="review-draft-publish"
          onPress={onPublish}
          disabled={publishDisabled}
          style={[
            styles.primaryButton,
            publishDisabled && styles.primaryButtonDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Publish"
          accessibilityState={{ disabled: publishDisabled }}
        >
          {submitting ? (
            <ActivityIndicator color={colors.bgPrimary} size="small" />
          ) : (
            <>
              <Ionicons name="paper-plane-outline" size={14} color={colors.bgPrimary} />
              <Text style={styles.primaryButtonText}>Publish</Text>
            </>
          )}
        </Pressable>
      </View>

      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

/**
 * Post-submit projection of the durable publish job. Renders queued /
 * publishing / failed / published off the job row — the card owns NO post-submit
 * status of its own. Cancel/dismiss deletes the job (the card reverts to its
 * editable draft); Try again retries a dead-letter.
 */
function JobState({
  message,
  lc,
  job,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
  job: PublishJob;
}): React.JSX.Element {
  const router = useRouter();
  const subjectName = typeof lc.subject.name === 'string' ? lc.subject.name : 'this subject';

  if (job.status === 'publishing') {
    return (
      <View style={styles.card} testID="review-draft-card-publishing">
        <View style={styles.headerRow}>
          <ActivityIndicator color={colors.textMuted} size="small" />
          <Text style={styles.title}>Publishing…</Text>
        </View>
        <Text style={styles.subtitle}>{subjectName}</Text>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  if (job.status === 'published') {
    return (
      <View style={styles.card} testID="review-draft-card-published">
        <View style={styles.headerRow}>
          <Ionicons name="checkmark-circle" size={18} color={colors.success ?? colors.accent} />
          <Text style={styles.title}>Published your review</Text>
        </View>
        <Text style={styles.subtitle}>{subjectName}</Text>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  if (job.status === 'queued') {
    return (
      <View style={styles.card} testID="review-draft-card-queued">
        <View style={styles.headerRow}>
          <Ionicons name="time-outline" size={18} color={colors.textMuted} />
          <Text style={styles.title}>Queued to publish</Text>
        </View>
        <Text style={styles.subtitle}>Will publish {subjectName} when you’re back online.</Text>
        <View style={styles.actionRow}>
          <Pressable
            testID="review-draft-view-outbox"
            onPress={() => router.push('/peerlens/outbox')}
            style={styles.secondaryButton}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryButtonText}>View pending reviews</Text>
          </Pressable>
          <Pressable
            testID="review-draft-cancel"
            onPress={() => cancelReviewPublishJob(job.jobId)}
            style={styles.secondaryButton}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
        </View>
        <MessageTimestamp timestamp={message.timestamp} />
      </View>
    );
  }

  // failed (transient exhausted or permanent)
  return (
    <View style={[styles.card, styles.cardError]} testID="review-draft-card-failed">
      <View style={styles.headerRow}>
        <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
        <Text style={styles.title}>Couldn’t publish</Text>
      </View>
      <Text style={styles.subtitle}>
        {job.lastErrorCode !== null
          ? describePublishErrorCode(job.lastErrorCode)
          : `Couldn’t publish ${subjectName}.`}
      </Text>
      <View style={styles.actionRow}>
        <Pressable
          testID="review-draft-retry"
          onPress={() => void retryReviewPublishJob(job.jobId)}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Try again</Text>
        </Pressable>
        <Pressable
          testID="review-draft-dismiss"
          onPress={() => cancelReviewPublishJob(job.jobId)}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Dismiss</Text>
        </Pressable>
      </View>
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

function DiscardedState({
  message,
  lc,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
}): React.JSX.Element {
  const subjectName =
    typeof lc.subject.name === 'string' ? lc.subject.name : 'this subject';
  return (
    <View style={[styles.card, styles.cardMuted]} testID="review-draft-card-discarded">
      <View style={styles.headerRow}>
        <Ionicons name="close-circle-outline" size={18} color={colors.textMuted} />
        <Text style={styles.titleMuted}>Discarded the draft of {subjectName}</Text>
      </View>
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

/**
 * Drafting failed: the LLM couldn't produce a draft, so there's no `values` to
 * edit and never a publish job to retry. Surfaces `lc.error` and offers a fresh
 * start in the full write form (rather than the empty editable ReadyState, which
 * would silently drop the error).
 */
function DraftFailedState({
  message,
  lc,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
}): React.JSX.Element {
  const router = useRouter();
  const subjectName =
    typeof lc.subject.name === 'string' ? lc.subject.name : 'this subject';
  const onWriteInForm = useCallback(() => {
    // No drafted values to recover, but we DO know the subject — open the form in
    // create-mode SEEDED with the subject (kind + name) so the user can actually
    // publish. WriteScreen skips its chat-draft seed (lc.values is null on a
    // drafting failure) and its createKind path picks these up; without them it
    // would fall back to an empty form with subject:null and block on "Pick a
    // subject" with no picker. We don't reset the lifecycle: the card stays on
    // this failure until a real publish job exists (which then wins via JobState).
    const subj = lc.subject as { kind?: unknown; name?: unknown };
    router.push({
      pathname: '/peerlens/write',
      params: {
        draftId: lc.draftId,
        threadId: message.threadId,
        ...(typeof subj.kind === 'string' ? { createKind: subj.kind } : {}),
        ...(typeof subj.name === 'string' ? { initialName: subj.name } : {}),
      },
    });
  }, [router, message.threadId, lc.draftId, lc.subject]);
  const onDiscard = useCallback(() => {
    // The user doesn't want to recover the failed draft — move it to the
    // `discarded` terminal so the card doesn't stay stuck in the thread.
    setReviewDraftStatus(message.threadId, lc.draftId, 'discarded', {
      content: `Discarded the draft of ${subjectName}.`,
    });
  }, [message.threadId, lc.draftId, subjectName]);
  return (
    <View style={[styles.card, styles.cardError]} testID="review-draft-card-draft-failed">
      <View style={styles.headerRow}>
        <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
        <Text style={styles.title}>Couldn’t draft this review</Text>
      </View>
      <Text style={styles.subtitle}>
        {typeof lc.error === 'string' && lc.error.length > 0
          ? lc.error
          : `Something went wrong drafting ${subjectName}.`}
      </Text>
      <View style={styles.actionRow}>
        <Pressable
          testID="review-draft-write-in-form"
          onPress={onWriteInForm}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Write in form</Text>
        </Pressable>
        <Pressable
          testID="review-draft-draft-failed-discard"
          onPress={onDiscard}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Discard</Text>
        </Pressable>
      </View>
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  cardMuted: {
    backgroundColor: colors.bgTertiary,
  },
  cardError: {
    borderColor: colors.error,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  title: {
    ...textStyles.bodyStrong,
    flexShrink: 1,
  },
  titleMuted: {
    ...textStyles.body,
    color: colors.textMuted,
    flexShrink: 1,
  },
  subtitle: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
  },
  fieldBlock: {
    marginTop: spacing.sm,
  },
  label: {
    ...textStyles.label,
    marginBottom: spacing.xs,
    letterSpacing: 0.4,
  },
  sentimentRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  sentimentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sentimentPillActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  sentimentPillText: textStyles.bodySmall,
  sentimentPillTextActive: {
    color: colors.bgPrimary,
  },
  headlineInput: {
    ...textStyles.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  bodyInput: {
    ...textStyles.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 64,
    textAlignVertical: 'top',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  secondaryButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: textStyles.bodySmall,
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    marginLeft: 'auto',
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    ...textStyles.bodySmallStrong,
    color: colors.bgPrimary,
  },
  errorText: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.xs,
  },
});
