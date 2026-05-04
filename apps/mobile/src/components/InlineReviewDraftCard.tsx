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

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import {
  readLifecycle,
  type ChatMessage,
  type ReviewDraftLifecycle,
} from '@dina/brain/chat';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';
import { setReviewDraftStatus } from '../trust/review_draft';
import {
  buildAttestationRecord,
  newPublishKeys,
} from '../trust/publish_helpers';
import {
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  SENTIMENT_OPTIONS,
  type WriteFormState,
} from '../trust/write_form_data';
import type { Sentiment } from '@dina/protocol';
import {
  injectAttestation,
  isTestPublishConfigured,
  type InjectAttestationRequest,
} from '../trust/appview_runtime';
import { getBootedNode } from '../hooks/useNodeBootstrap';

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
  if (lc === null || lc.kind !== 'review_draft') return null;

  const status = lc.status;
  if (status === 'drafting') {
    return <DraftingState message={message} lc={lc} />;
  }
  if (status === 'ready' || status === 'publishing') {
    return <ReadyState message={message} lc={lc} />;
  }
  if (status === 'published') {
    return <PublishedState message={message} lc={lc} />;
  }
  if (status === 'discarded') {
    return <DiscardedState message={message} lc={lc} />;
  }
  // failed
  return <FailedState message={message} lc={lc} />;
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
    body.length > BODY_MAX_LENGTH ||
    lc.status === 'publishing';

  const onPublish = useCallback(async () => {
    if (publishDisabled) return;
    if (!isTestPublishConfigured()) {
      setError('Trust publish endpoint is not configured.');
      return;
    }
    const node = getBootedNode();
    if (node === null) {
      setError('Local node is not booted yet.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setReviewDraftStatus(message.threadId, lc.draftId, 'publishing');
    try {
      // Reconstitute a publishable WriteFormState from the lifecycle
      // values + the locally-edited primary fields. Anything the user
      // didn't touch (additional details, price, recommend-for, etc.)
      // flows through unchanged from what the LLM drafted.
      const merged: WriteFormState = {
        ...(initialValues as WriteFormState),
        sentiment,
        headline: headline.trim(),
        body: body.trim(),
      };
      const record = buildAttestationRecord(merged) as InjectAttestationRequest['record'];
      const { rkey, cid } = newPublishKeys();
      const result = await injectAttestation({
        authorDid: node.did,
        rkey,
        cid,
        record,
      });
      setReviewDraftStatus(message.threadId, lc.draftId, 'published', {
        attestation: { uri: result.uri, cid: result.cid },
        values: merged,
        content: `Published your review of ${subjectName}.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Publish failed.';
      setError(msg);
      setReviewDraftStatus(message.threadId, lc.draftId, 'ready', {
        error: msg,
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    publishDisabled,
    message.threadId,
    lc.draftId,
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
      pathname: '/trust/write',
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
        >
          <Text style={styles.secondaryButtonText}>Discard</Text>
        </Pressable>
        <Pressable
          testID="review-draft-edit-in-form"
          onPress={onEditInForm}
          style={styles.secondaryButton}
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

function PublishedState({
  message,
  lc,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
}): React.JSX.Element {
  const subjectName =
    typeof lc.subject.name === 'string' ? lc.subject.name : 'this subject';
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

function FailedState({
  message,
  lc,
}: {
  message: ChatMessage;
  lc: ReviewDraftLifecycle;
}): React.JSX.Element {
  const subjectName =
    typeof lc.subject.name === 'string' ? lc.subject.name : 'this subject';
  return (
    <View style={[styles.card, styles.cardError]} testID="review-draft-card-failed">
      <View style={styles.headerRow}>
        <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
        <Text style={styles.title}>Couldn’t draft a review</Text>
      </View>
      <Text style={styles.subtitle}>
        {lc.error ?? `Open the form to start a fresh review of ${subjectName}.`}
      </Text>
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
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  titleMuted: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textMuted,
    flexShrink: 1,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  fieldBlock: {
    marginTop: spacing.sm,
  },
  label: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
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
  sentimentPillText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
  },
  sentimentPillTextActive: {
    color: colors.bgPrimary,
  },
  headlineInput: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  bodyInput: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
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
  secondaryButtonText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
  },
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
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.bgPrimary,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
    marginTop: spacing.xs,
  },
});
