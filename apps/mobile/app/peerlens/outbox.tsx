/**
 * PeerLens — Outbox. A pure projection of the durable publish jobs
 * (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md §6/§8): in-flight reviews (queued +
 * publishing) and any that need attention (failed), for the booted identity.
 *
 * The screen owns NO publish state — it reads `useReviewPublishOutbox()` and
 * drives the SAME durable state machine the inline chat card does:
 *   - Cancel (queued) / Dismiss (failed) → `cancelReviewPublishJob` (deletes the job)
 *   - Try again (failed) → `retryReviewPublishJob` (reset + drain now)
 * It drains on mount + foreground (uncontrolled mode) so queued reviews publish
 * on reconnect without further taps. Tests pass `jobs` to render a fixed set.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, AppState } from 'react-native';

import { type PublishJob } from '@dina/core';

import { describePublishErrorCode } from '../../src/peerlens/classify_publish_error';
import { cancelReviewPublishJob, retryReviewPublishJob } from '../../src/peerlens/review_publish_actions';
import { drainReviewPublishNow } from '../../src/peerlens/review_publish_autodrain';
import { useReviewPublishOutbox } from '../../src/peerlens/useReviewPublishOutbox';
import { colors, spacing, radius, textStyles } from '../../src/theme';

export interface OutboxScreenProps {
  /** Controlled rows for tests. Omit in production to read the live projection. */
  jobs?: readonly PublishJob[];
}

/** Headline to show for a job, parsed from its stored draft body. */
function draftHeadline(job: PublishJob): string {
  try {
    const d = JSON.parse(job.draftJSON) as { headline?: unknown; subjectTitle?: unknown };
    if (typeof d.headline === 'string' && d.headline.length > 0) return d.headline;
    if (typeof d.subjectTitle === 'string' && d.subjectTitle.length > 0) return d.subjectTitle;
  } catch {
    /* fall through */
  }
  return 'Review';
}

export default function OutboxScreen(props: OutboxScreenProps = {}): React.JSX.Element {
  const live = useReviewPublishOutbox();
  const controlled = props.jobs !== undefined;
  const rows = props.jobs ?? live;

  // Drain on mount + foreground — only in the live (uncontrolled) screen.
  React.useEffect(() => {
    if (controlled) return;
    void drainReviewPublishNow();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void drainReviewPublishNow();
    });
    return () => sub.remove();
  }, [controlled]);

  const inFlight = rows.filter((r) => r.status === 'queued' || r.status === 'publishing');
  const failures = rows.filter((r) => r.status === 'failed');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="outbox-screen">
      <View style={styles.header}>
        <Text style={styles.subtitle}>
          Reviews waiting to publish, plus any that didn&apos;t go through.
        </Text>
      </View>

      {inFlight.length > 0 && (
        <View style={styles.inFlightBanner} testID="outbox-inflight-banner">
          <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.inFlightText}>
            {inFlight.length} {inFlight.length === 1 ? 'review' : 'reviews'} in flight. Will publish
            when you&apos;re back online.
          </Text>
        </View>
      )}

      {rows.length === 0 ? (
        <View style={styles.empty} testID="outbox-empty">
          <Ionicons name="paper-plane-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Nothing in your outbox</Text>
          <Text style={styles.emptyBody}>
            Reviews you publish appear here while they&apos;re being delivered.
          </Text>
        </View>
      ) : (
        <>
          {inFlight.length > 0 && (
            <View style={styles.list} testID="outbox-inflight-list">
              {inFlight.map((job) => (
                <InFlightRow key={job.jobId} job={job} />
              ))}
            </View>
          )}
          {failures.length === 0 ? (
            <View style={styles.empty} testID="outbox-no-failures">
              <Ionicons name="checkmark-circle-outline" size={36} color={colors.success} />
              <Text style={styles.emptyTitle}>All caught up</Text>
              <Text style={styles.emptyBody}>
                No stuck or rejected reviews. We&apos;ll let you know if anything needs attention.
              </Text>
            </View>
          ) : (
            <View style={styles.list} testID="outbox-failures-list">
              {failures.map((job) => (
                <FailureRow key={job.jobId} job={job} />
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/** Queued or publishing. Publishing is on the wire — only queued can be cancelled. */
function InFlightRow({ job }: { job: PublishJob }): React.JSX.Element {
  const publishing = job.status === 'publishing';
  return (
    <View style={styles.row} testID={`outbox-row-${job.status}`}>
      <Ionicons
        name={publishing ? 'paper-plane-outline' : 'time-outline'}
        size={18}
        color={colors.textSecondary}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {draftHeadline(job)}
        </Text>
        <Text style={styles.rowMeta}>{publishing ? 'Publishing…' : 'Queued'}</Text>
      </View>
      {!publishing && (
        <Pressable
          testID={`outbox-cancel-${job.jobId}`}
          onPress={() => cancelReviewPublishJob(job.jobId)}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel="Cancel queued review"
        >
          <Text style={styles.actionText}>Cancel</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A failed (transient-exhausted or permanent) job: Try again + Dismiss. */
function FailureRow({ job }: { job: PublishJob }): React.JSX.Element {
  return (
    <View style={[styles.row, styles.rowError]} testID="outbox-row-failed">
      <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {draftHeadline(job)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={2}>
          {job.lastErrorCode !== null ? describePublishErrorCode(job.lastErrorCode) : "Couldn't publish."}
        </Text>
      </View>
      <Pressable
        testID={`outbox-retry-${job.jobId}`}
        onPress={() => void retryReviewPublishJob(job.jobId)}
        style={styles.action}
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Text style={styles.actionText}>Try again</Text>
      </Pressable>
      <Pressable
        testID={`outbox-dismiss-${job.jobId}`}
        onPress={() => cancelReviewPublishJob(job.jobId)}
        style={styles.action}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <Text style={styles.actionTextMuted}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, gap: spacing.sm },
  header: { marginBottom: spacing.xs },
  subtitle: { ...textStyles.bodySmall, color: colors.textMuted },
  inFlightBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  inFlightText: { ...textStyles.bodySmall, color: colors.textSecondary, flexShrink: 1 },
  empty: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
  emptyTitle: { ...textStyles.bodyStrong },
  emptyBody: { ...textStyles.bodySmall, color: colors.textMuted, textAlign: 'center' },
  list: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  rowError: { borderColor: colors.error },
  rowBody: { flex: 1 },
  rowTitle: { ...textStyles.body },
  rowMeta: { ...textStyles.bodySmall, color: colors.textMuted },
  action: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  actionText: { ...textStyles.bodySmall, color: colors.accent },
  actionTextMuted: { ...textStyles.bodySmall, color: colors.textMuted },
});
