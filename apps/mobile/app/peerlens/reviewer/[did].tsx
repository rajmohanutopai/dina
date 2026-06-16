/**
 * PeerLens — reviewer profile screen (TN-MOB-015 / Plan §8.5).
 *
 * Drilled into from any reviewer entry on the subject card spotlight,
 * the subject-detail reviewer list, the cosig inbox sender line, or
 * the network feed reviewer chip — all of which compose deep links via
 * `src/trust/reviewer_link.ts`. The route key `[did]` is the reviewer's
 * DID; an optional `?namespace=<fragment>` query param lands the screen
 * on the per-namespace stats slice (TN-DB-002).
 *
 * Render contract:
 *   - **Loading** — `profile === null` and `error === null`. Spinner +
 *     "Loading reviewer profile…".
 *   - **Error** — `error !== null`. Soft error with a Retry CTA (the
 *     screen-level wrapper plumbs the retry handler).
 *   - **Loaded** — header card (DID, score, band, namespace if any) +
 *     stats grid (attestations / vouches / endorsements / helpful
 *     ratio) + active-domains chip row + last-active line.
 *
 * Why a presentational shell over the data layer:
 *   - Same separation as TN-MOB-014 / TN-MOB-017 — the runner owns the
 *     xRPC call (`PeerlensQueryClient.getProfile`) + cache + retry
 *     policy; this screen renders whatever data the wrapper passes.
 *   - The same screen renders both root-identity profiles (no
 *     namespace) and per-namespace profile slices (with namespace);
 *     the wrapper decides which xRPC to call.
 *   - Tests pass synthetic `PeerlensProfile` objects — no need to mock
 *     the network layer.
 *
 * The screen is plan §8.5 read-only — no compose / write affordances.
 * "Vouch for this reviewer" / "Report" actions are TN-MOB-013 +
 * TN-MOB-019 surfaces and live in their own screens.
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';

import { FEATURE_NAMES } from '@dina/core';

import { IdentityModal } from '../../../src/components/identity/identity_modal';
import { getBootedNode } from '../../../src/hooks/useNodeBootstrap';
import { BAND_COLOUR, BAND_LABEL } from '../../../src/peerlens/band_theme';
import { shortHandle, truncateDid } from '../../../src/peerlens/handle_display';
import {
  cancelReviewPublishJob,
  dismissReviewPublishReceipt,
  pruneStaleReviewReceipts,
} from '../../../src/peerlens/review_publish_actions';
import {
  deriveReviewerProfileDisplay,
  formatLastActive,
} from '../../../src/peerlens/reviewer_profile_data';
import { useAuthoredAttestations } from '../../../src/peerlens/runners/use_authored_attestations';
import { useReviewerProfile } from '../../../src/peerlens/runners/use_reviewer_profile';
import { useReviewPublishWithReceipts } from '../../../src/peerlens/useReviewPublishOutbox';
import { colors, spacing, radius, textStyles } from '../../../src/theme';

import type { AuthoredAttestationRow } from '../../../src/peerlens/authored_attestations_data';
import type { PeerlensProfile, PublishJob, PublishJobStatus } from '@dina/core';

/**
 * How long the screen waits for `profile` before surfacing a friendly
 * "couldn't reach PeerLens" error. See same constant in
 * `[subjectId].tsx` for the rationale.
 */
const LOAD_BUDGET_MS = 5000;

export interface ReviewerProfileScreenProps {
  /**
   * The reviewer's profile from `com.dinakernel.peerlens.getProfile`. `null`
   * while loading. Defaults to `null` so the screen mounts as a
   * routable Expo Router default export with the loading state
   * showing — the runner that resolves the profile slots in later.
   */
  profile?: PeerlensProfile | null;
  /**
   * Pseudonymous namespace fragment (e.g. `'namespace_2'`) when the
   * deep-link landed on a per-namespace slice. Surfaced under the DID
   * in the header so the user knows which compartment they're seeing.
   * When omitted in production, the URL `?namespace=…` query param is
   * consulted via `useLocalSearchParams`.
   */
  namespace?: string | null;
  /** Loading-error string. `null` when there's no error. */
  error?: string | null;
  /** Fired when the user taps Retry on the error state. */
  onRetry?: () => void;
  /**
   * Reference timestamp for "last active" formatting. Injectable so
   * tests pin exact outputs; production passes `Date.now()`.
   */
  nowMs?: number;
  /**
   * Pre-fetched list of reviews this DID has written. When omitted,
   * the screen runs `useAuthoredAttestations` against the resolved
   * DID. Tests pass an explicit array (or `null` for the loading /
   * unbooted state) to keep the screen presentational.
   */
  authoredRows?: readonly AuthoredAttestationRow[] | null;
  /**
   * Fired when the user taps a review row in the "Reviews written"
   * list. Default implementation drills into `/trust/<subjectId>`.
   */
  onSelectAuthoredSubject?: (subjectId: string) => void;
  /**
   * Fired when the user taps the "Edit" pill on a row that belongs
   * to them. Default implementation pushes `/trust/write` with the
   * row's seed fields as URL params so the WriteScreen lands in
   * edit mode pre-filled. Caller may inject for tests / for screens
   * that want to host the editor inline. The reviewer screen is
   * responsible for only passing `onEdit` through to rows that
   * belong to the booted node — see `isSelf` below.
   */
  onEditAuthored?: (row: AuthoredAttestationRow) => void;
  /**
   * True when the fetch succeeded but the DID has no profile yet (no
   * attestations). Renders the friendly EMPTY state instead of the error
   * panel. Resolved from the runner (`useReviewerProfile().notFound`) in
   * production; tests pass it directly.
   */
  notFound?: boolean;
  /**
   * Whether this profile is the viewer's OWN. When true AND `notFound`, the
   * empty state shows a "Write a review" CTA (the new-user onramp). Defaults to
   * a booted-DID === route-DID comparison.
   */
  isSelf?: boolean;
  /**
   * Fired by the empty-state "Write a review" CTA. Default pushes the review
   * creation screen in CREATE mode (`?createKind=product`) so the "What are you
   * reviewing?" section renders — the kind picker (switchable to place / org /
   * etc.), Name, and the product Identifier field (ASIN / ISBN / SKU). A bare
   * `/peerlens/write` is review-only mode and hides that section, so a new user
   * would have no way to say WHAT they're reviewing.
   */
  onWriteReview?: () => void;
  /**
   * Optimistic pending reviews (own profile) — in-flight + just-published-
   * awaiting-index jobs from the local publish queue, shown as greyed "Pending"
   * rows inline in the list so a fresh publish doesn't read as "no reviews"
   * during the ingest lag. Defaults to the live queue (own profile only); tests
   * pass it directly.
   */
  pendingItems?: readonly PendingReviewItem[];
}


/** Authored reviews shown before the "View all reviews" expander. */
const AUTHORED_PREVIEW_COUNT = 5;

/** Retention TTL for `published` receipts the dashboard never reconciled (the
 *  user published, then never reopened the profile). 10 min ≫ AppView ingest. */
const RECEIPT_TTL_MS = 10 * 60 * 1000;

/**
 * Optimistic "publishing" labels from the local publish outbox — the reviews
 * the owner just submitted that AppView hasn't ingested/scored yet. Without
 * this, a fresh publish shows "No reviews yet" until AppView catches up, which
 * reads as a failure. Only `queued`/`publishing` jobs (terminal ones are
 * pruned), and only the owner's own (the outbox is the local node's queue).
 */
/**
 * A zeroed profile for the viewer's OWN dashboard when AppView has no profile
 * row yet (brand-new user, or a just-published review not yet scored). Lets the
 * SAME "Your reviews" dashboard render with zeros + the inline "no reviews yet"
 * state + the Write-a-review CTA, instead of a separate empty screen.
 */
function emptySelfProfile(did: string): PeerlensProfile {
  return {
    did,
    overallTrustScore: 0,
    attestationSummary: { total: 0, positive: 0, neutral: 0, negative: 0 },
    vouchCount: 0,
    endorsementCount: 0,
    reviewerStats: {
      totalAttestationsBy: 0,
      corroborationRate: 0,
      evidenceRate: 0,
      helpfulRatio: 0,
    },
    activeDomains: [],
    lastActive: null,
  } as unknown as PeerlensProfile;
}

/** A just-submitted review from the local publish queue, shown inline on the OWN
 *  dashboard as a greyed "Pending" row until AppView indexes it. */
export interface PendingReviewItem {
  jobId: string;
  status: PublishJobStatus;
  /** Headline, else "Review of <subject>", else "Your review". */
  title: string;
  /** The at:// URI once published — for dedup + reconcile against the live list. */
  publishedUri: string | null;
}

/** A short label for a pending row, from the job's draft. */
function pendingLabel(job: PublishJob): string {
  try {
    const d = JSON.parse(job.draftJSON) as { headline?: unknown; subjectTitle?: unknown };
    const headline =
      typeof d.headline === 'string' && d.headline.trim() !== '' ? d.headline.trim() : '';
    if (headline !== '') return headline;
    const subject =
      typeof d.subjectTitle === 'string' && d.subjectTitle.trim() !== '' ? d.subjectTitle.trim() : '';
    return subject !== '' ? `Review of ${subject}` : 'Your review';
  } catch {
    return 'Your review';
  }
}

/**
 * Structured pending rows for the OWN dashboard: queued / publishing / published
 * (the in-flight + just-published-awaiting-index reviews), NEWEST FIRST. The
 * caller dedups `published` rows whose URI is already in the live authored list
 * and reconcile-prunes those receipts.
 */
export function pendingReviewItems(
  jobs: readonly PublishJob[],
  ownDid: string | null,
): PendingReviewItem[] {
  return jobs
    .filter(
      (j) =>
        (j.status === 'queued' || j.status === 'publishing' || j.status === 'published') &&
        (ownDid === null || j.ownerDid === ownDid),
    )
    .map((j) => ({
      jobId: j.jobId,
      status: j.status,
      title: pendingLabel(j),
      publishedUri: j.publishedUri ?? null,
    }))
    .reverse(); // repo returns FIFO (oldest first); show newest pending at top
}

export default function ReviewerProfileScreen(
  props: ReviewerProfileScreenProps = {},
): React.ReactElement {
  // Hooks must run unconditionally (Rules of Hooks). The route param
  // is consulted only as a fallback when the caller didn't supply
  // `namespace`. Tests pass it explicitly and the param is ignored.
  const params = useLocalSearchParams<{
    namespace?: string | string[];
    did?: string | string[];
  }>();
  const paramNamespace = Array.isArray(params.namespace)
    ? params.namespace[0]
    : params.namespace;
  const paramDidRaw = Array.isArray(params.did) ? params.did[0] : params.did;
  // Reviewer links encode the DID (`did:plc:…` → `did%3Aplc%3A…`)
  // because the path segment otherwise contains literal colons. Expo
  // Router returns the encoded form here, but the downstream runner
  // bails on `!did.startsWith('did:')` — without this decode the
  // screen sits on the loading spinner forever (no fetch, no error).
  // `safelyDecode` is defensive against `decodeURIComponent` throwing
  // on malformed input (e.g. a stray `%`).
  const paramDid = paramDidRaw !== undefined ? safelyDecode(paramDidRaw) : undefined;
  // Local state lets the screen exit the loading state with a graceful
  // error after the load budget elapses. Skipped in controlled mode
  // (when caller supplies `profile` / `error` props).
  const [autoError, setAutoError] = React.useState<string | null>(null);
  const [retryNonce, setRetryNonce] = React.useState(0);
  // The authored list previews the latest N; "View all reviews" expands it.
  const [showAllReviews, setShowAllReviews] = React.useState(false);
  // Auto-runner: fetch the profile from AppView when no controlled
  // props are supplied (i.e. production routing — tests pass
  // `profile` or `error` and the runner stays inert).
  const isControlled = props.profile !== undefined || props.error !== undefined;
  const auto = useReviewerProfile({
    did: paramDid ?? '',
    enabled: !isControlled,
    retryNonce,
  });
  // Authored-attestations list. Disabled when the parent supplied
  // `authoredRows` (controlled mode for tests) OR before we know the
  // DID. Same retry nonce as the profile fetch so a focus-refresh
  // re-fetches both.
  const isAuthoredControlled = props.authoredRows !== undefined;
  const authored = useAuthoredAttestations({
    authorDid: paramDid ?? '',
    enabled: !isAuthoredControlled && Boolean(paramDid),
    retryNonce,
  });
  const router = useRouter();
  // Live publish queue INCLUDING `published` receipts — for the optimistic
  // inline "Pending" rows of reviews the owner just submitted that AppView
  // hasn't indexed yet. Called unconditionally (Rules of Hooks); filtered to
  // own + mapped below.
  const liveJobs = useReviewPublishWithReceipts();
  // Refresh on focus so a recently-vouched / recently-revoked
  // attestation moves the reviewer's score the next time the user lands
  // here — the runner's deps are stable on a steady DID otherwise.
  useFocusEffect(
    React.useCallback(() => {
      if (isControlled || !paramDid) return;
      setAutoError(null);
      setRetryNonce((n) => n + 1);
    }, [isControlled, paramDid]),
  );
  // Runner state wins over the legacy auto-timeout: when paramDid is
  // present the runner is engaged and authoritative. The autoError
  // remains only as a courtesy fallback for the no-DID degraded path.
  const runnerEngaged = !isControlled && Boolean(paramDid);
  const {
    profile = auto.profile,
    namespace = paramNamespace ?? null,
    error = runnerEngaged ? auto.error : autoError,
    notFound = runnerEngaged ? auto.notFound : false,
    onRetry = () => {
      setAutoError(null);
      setRetryNonce((n) => n + 1);
    },
    onWriteReview = () =>
      router.push({ pathname: '/peerlens/write', params: { createKind: 'product' } }),
    nowMs = Date.now(),
    authoredRows = authored.rows,
    onSelectAuthoredSubject = (subjectId: string) => {
      router.push({ pathname: '/peerlens/[subjectId]', params: { subjectId } });
    },
    onEditAuthored = (row: AuthoredAttestationRow) => {
      // Default edit handler — push WriteScreen in edit mode with
      // the row's content as URL params. The screen reads
      // `editingUri` to flip into edit mode and uses the rest to
      // seed the form so the user starts from their existing
      // review (not a blank form).
      //
      // We forward the full SubjectRef tuple (kind / name / did /
      // identifier-via-uri) so the publish path's
      // `buildSubjectRefFromParams` reconstructs the SAME
      // `subject_id` hash the original review carried. Without these
      // the publish path bails ("subjectKind null → no SubjectRef")
      // and the edit silently never lands.
      //
      // `editingCosigCount` defaults to 0: the search wire shape
      // doesn't surface cosig counts today, so the edit warning
      // stays silent until the count is fetched. A future runner
      // can resolve and forward the real count via the prop, or we
      // extend SearchAttestationHit to include it.
      const params: Record<string, string> = {
        subjectId: row.subjectId,
        subjectName: row.subjectTitle,
        subjectKind: row.subjectKind,
        editingUri: row.uri,
        editingCosigCount: '0',
        editingSentiment: row.sentiment,
        editingHeadline: row.headline,
        editingBody: row.body,
      };
      if (row.subjectDid !== null) params.subjectDid = row.subjectDid;
      if (row.subjectUri !== null) params.subjectIdentifier = row.subjectUri;
      if (row.confidence !== null) {
        params.editingConfidence = row.confidence;
      }
      router.push({ pathname: '/peerlens/write', params });
    },
  } = props;

  // Optimistic pending reviews for the OWN profile (local queue, not yet in
  // AppView). Controlled override wins (tests); otherwise derive from the live
  // queue only when viewing your own DID.
  const ownDidForPending = getBootedNode()?.did ?? null;
  const isOwnProfile =
    props.isSelf ??
    (ownDidForPending !== null && (profile?.did ?? paramDid ?? '') === ownDidForPending);
  const allPendingItems =
    props.pendingItems ?? (isOwnProfile ? pendingReviewItems(liveJobs, ownDidForPending) : []);
  // The live authored list's URIs — a `published` receipt whose review already
  // appears there is reconciled away (deduped below + reconcile-pruned in an
  // effect): "prune when listed".
  const authoredUris = React.useMemo(
    () => new Set((authoredRows ?? []).map((r) => r.uri)),
    [authoredRows],
  );
  const pendingItems = allPendingItems.filter(
    (p) => p.publishedUri === null || !authoredUris.has(p.publishedUri),
  );

  // Reconcile-prune: once a `published` receipt's review shows in the authored
  // list, delete the local receipt (the live row replaces it). TTL backstop on
  // mount for receipts the user never returned to reconcile.
  React.useEffect(() => {
    for (const p of allPendingItems) {
      if (p.status === 'published' && p.publishedUri !== null && authoredUris.has(p.publishedUri)) {
        dismissReviewPublishReceipt(p.jobId);
      }
    }
  }, [allPendingItems, authoredUris]);
  React.useEffect(() => {
    if (isOwnProfile) pruneStaleReviewReceipts(RECEIPT_TTL_MS);
  }, [isOwnProfile]);

  React.useEffect(() => {
    // Auto-timeout fallback only fires in degraded states the runner
    // can't reach: no paramDid (so the runner stays inert), or the
    // screen is mounted in the rare uncontrolled-WITHOUT-runner path.
    // When the runner has engaged for this DID, profile / error from
    // the runner state are authoritative and this fallback is silent.
    if (props.profile !== undefined || props.error !== undefined) return;
    if (paramDid) return;
    const id = setTimeout(() => {
      setAutoError(`Couldn't reach ${FEATURE_NAMES.peerlens}. Check your connection and try again.`);
    }, LOAD_BUDGET_MS);
    return () => clearTimeout(id);
  }, [paramDid, retryNonce, props.profile, props.error]);

  // IdentityModal visibility — declared up here so the hook count
  // stays constant across the loading/error/loaded branches below.
  // Rules of Hooks: every useState must run on every render or React
  // throws "Rendered more hooks than during the previous render".
  const [identityOpen, setIdentityOpen] = React.useState(false);

  // Per-sentiment counts on this screen describe the DID's *authored*
  // reviews ("how often does this reviewer rate things positively?").
  // The API's `attestationSummary` is the wrong source — it counts
  // reviews ABOUT the DID-as-subject, which on a reviewer profile is
  // always zero unless someone separately reviewed this person.
  //
  // Compute from `authoredRows` once they're loaded with data. The
  // runner initializes `rows` to `[]` before/while fetching, which we
  // can't distinguish from "loaded with zero results" from this scope
  // alone. Compromise: fall back to the API summary whenever the
  // authored list is empty. That keeps the chips meaningful during the
  // initial load AND in the degraded case where the runner is
  // disabled (paramDid unknown, controlled-test mode without an
  // explicit array).
  //
  // Lifted above the loading/error early returns: Rules of Hooks
  // require every hook call to run on every render, so this useMemo
  // can't sit below the `profile === null` short-circuit. We read the
  // attestation summary off the raw profile here (the fallback path),
  // which means we don't depend on `deriveReviewerProfileDisplay` —
  // and we tolerate `profile === null` by returning zeros.
  const authoredCounts = React.useMemo(() => {
    if (Array.isArray(authoredRows) && authoredRows.length > 0) {
      let positive = 0;
      let neutral = 0;
      let negative = 0;
      for (const row of authoredRows) {
        if (row.sentiment === 'positive') positive++;
        else if (row.sentiment === 'negative') negative++;
        else neutral++;
      }
      return { positive, neutral, negative };
    }
    if (profile === null) {
      return { positive: 0, neutral: 0, negative: 0 };
    }
    return {
      positive: profile.attestationSummary.positive,
      neutral: profile.attestationSummary.neutral,
      negative: profile.attestationSummary.negative,
    };
  }, [authoredRows, profile]);

  // Reviews-written count: prefer the displayable row count once
  // they're loaded so the stat agrees with the list and sentiment
  // chips. The API's `reviewerStats.totalAttestationsBy` is unfiltered,
  // but `deriveAuthoredAttestationRows` drops hits with a missing
  // `subjectId` (a row pointing nowhere is worse than no row), so the
  // raw API count can exceed what the user actually sees. Same
  // fall-back pattern as `authoredCounts` above.
  const reviewsWrittenDisplay = React.useMemo<number>(() => {
    if (Array.isArray(authoredRows) && authoredRows.length > 0) {
      return authoredRows.length;
    }
    if (profile === null) return 0;
    return profile.reviewerStats.totalAttestationsBy;
  }, [authoredRows, profile]);

  if (error !== null) {
    return (
      <View style={styles.container} testID="reviewer-profile-error">
        <View style={styles.errorPanel}>
          <Ionicons name="alert-circle-outline" size={36} color={colors.error} />
          <Text style={styles.errorTitle}>Couldn&apos;t load this profile</Text>
          <Text style={styles.errorBody}>{error}</Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [
                styles.retryBtn,
                pressed && styles.retryBtnPressed,
              ]}
              testID="reviewer-profile-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color={colors.bgSecondary} />
              <Text style={styles.retryLabel}>Retry</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  // EMPTY (not an error): the fetch succeeded but the DID has no profile yet
  // (no attestations). A neutral panel — never the red "Couldn't load" + dead
  // Retry. On the viewer's OWN profile, offer the "Write a review" onramp so a
  // new user isn't dead-ended ("how do I create a review?").
  // ANOTHER person with no profile yet → a neutral "no profile" panel. We do
  // NOT short-circuit the viewer's OWN profile: it renders the SAME "Your
  // reviews" dashboard with zeros (synthesized below) + the inline "no reviews
  // yet" + the Write-a-review CTA, so it's one consistent page, not a new one.
  if (notFound && !isOwnProfile) {
    return (
      <View style={styles.container} testID="reviewer-profile-empty">
        <View style={styles.errorPanel}>
          <Ionicons name="document-text-outline" size={36} color={colors.textMuted} />
          <Text style={styles.errorTitle}>No profile yet</Text>
          <Text style={styles.errorBody}>
            No PeerLens profile for this person yet. Once they make or receive attestations, it’ll
            fill in.
          </Text>
        </View>
      </View>
    );
  }

  // Own profile with no AppView profile row yet (new user, or a just-published
  // review not yet scored): synthesize a zero-profile so the dashboard renders
  // instead of a separate empty page. `profile === null && !notFound` is still
  // loading → falls through to the spinner below.
  const effectiveProfile: PeerlensProfile | null =
    profile ??
    (notFound && isOwnProfile ? emptySelfProfile(ownDidForPending ?? paramDid ?? '') : null);

  if (effectiveProfile === null) {
    return (
      <View style={styles.container} testID="reviewer-profile-loading">
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading reviewer profile…</Text>
        </View>
      </View>
    );
  }

  const display = deriveReviewerProfileDisplay(effectiveProfile);
  const lastActive = formatLastActive(display.lastActiveMs, nowMs);
  // Self-profile detection — when the user is looking at their OWN
  // DID, the band badge ("VERY LOW" by default for new accounts) reads
  // as a self-judgement rather than a useful signal. Suppress to a
  // softer "You" pill so the screen feels like a self-dashboard, not a
  // verdict.
  const ownDid = getBootedNode()?.did ?? null;
  const isSelf = ownDid !== null && ownDid === display.did;

  // Default render is the short username. The full handle, full DID,
  // and PLC services are revealed in the IdentityModal when the user
  // taps the header — same affordance every other peer-row gets.
  const shortName =
    display.handle !== null ? shortHandle(display.handle) : null;

  return (
    <>
      {/* Self profile is the "Your reviews" hub; a peer's is "Reviewer". The
          launchpad's "Your review activity" entry should land on a coherent
          header. */}
      <Stack.Screen options={{ title: isSelf ? 'Your reviews' : 'Reviewer' }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        testID="reviewer-profile-screen"
      >
        {/* ─── Header card: identity + score + band ─────────────────── */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <Pressable
            style={styles.headerIdentity}
            onPress={() => setIdentityOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Show full identity for ${shortName ?? display.did}`}
            testID="reviewer-identity-tap"
          >
            {/* Default: short username only — `alice` rather than
                `alice.pds.dinakernel.com`. The full handle, DID, and
                PLC services are exposed in the IdentityModal on tap. */}
            {shortName !== null ? (
              <>
                <Text
                  style={styles.headerHandle}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  accessibilityLabel={`Reviewer ${shortName}`}
                  testID="reviewer-handle"
                >
                  {shortName}
                </Text>
                <Text style={styles.headerHint} testID="reviewer-handle-hint">
                  Tap for full identity
                </Text>
              </>
            ) : (
              // No resolved handle — render a truncated DID + a clarifying
              // hint so the screen doesn't read like raw machine output.
              // The truncation matches every other peer-row in the app
              // (`did:plc:abc1…7890`); the hint explains *why* there's no
              // name (handle not yet backfilled, or this DID never
              // published an `alsoKnownAs[0]`).
              <>
                <Text
                  style={styles.headerDid}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  accessibilityLabel={`Reviewer ${display.did}`}
                  testID="reviewer-handle"
                >
                  {truncateDid(display.did)}
                </Text>
                <Text style={styles.headerHint} testID="reviewer-handle-hint">
                  Anonymous identity. No handle published
                </Text>
              </>
            )}
            {namespace && (
              <Text style={styles.headerNamespace} testID="reviewer-namespace">
                #{namespace}
              </Text>
            )}
          </Pressable>
          {isSelf ? (
            <View
              style={[styles.scoreBadge, styles.selfBadge]}
              testID="reviewer-self-badge"
            >
              <Text style={styles.scoreLabel}>You</Text>
            </View>
          ) : (
            <View
              style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[display.band] }]}
              testID={`reviewer-band-${display.band}`}
            >
              <Text style={styles.scoreLabel}>
                {display.hasNumericScore ? display.scoreLabel : BAND_LABEL[display.band]}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.headerMeta}>
          <Ionicons name="time-outline" size={14} color={colors.textMuted} />
          <Text style={styles.headerMetaText}>Last active {lastActive}</Text>
        </View>
      </View>

      <IdentityModal
        visible={identityOpen}
        onClose={() => setIdentityOpen(false)}
        did={display.did}
        initialHandle={display.handle}
      />

      {/* ─── Stats grid ─────────────────────────────────────────── */}
      <View style={styles.statsGrid} testID="reviewer-stats-grid">
        <StatCell
          label="Reviews written"
          testKey="attestations"
          value={reviewsWrittenDisplay}
        />
        <StatCell label="Vouches" testKey="vouches" value={display.vouchCount} />
        <StatCell
          label="Endorsements"
          testKey="endorsements"
          value={display.endorsementCount}
        />
        <StatCell
          label="Helpful"
          testKey="helpful"
          value={
            display.helpfulRatioDisplay !== null
              ? `${display.helpfulRatioDisplay}%`
              : '—'
          }
        />
        <StatCell
          label="Corroborated"
          testKey="corroborated"
          value={
            display.corroborationRateDisplay !== null
              ? `${display.corroborationRateDisplay}%`
              : '—'
          }
        />
      </View>

      {/* ─── Sentiment breakdown — computed from authored reviews ──
          Counts describe THIS reviewer's authored attestations, not
          reviews about them. See `authoredCounts` above for why. */}
      <View style={styles.sentimentRow} testID="reviewer-sentiment-row">
        <SentimentChip
          label="Positive"
          count={authoredCounts.positive}
          colour={colors.success}
        />
        <SentimentChip
          label="Neutral"
          count={authoredCounts.neutral}
          colour={colors.textMuted}
        />
        <SentimentChip
          label="Negative"
          count={authoredCounts.negative}
          colour={colors.warning}
        />
      </View>

      {/* ─── Active domains chip-row ────────────────────────────── */}
      {display.activeDomains.length > 0 && (
        <View style={styles.section} testID="reviewer-domains-section">
          <Text style={styles.sectionTitle}>Active in</Text>
          <View style={styles.chipRow}>
            {display.activeDomains.map((domain) => (
              <View key={domain} style={styles.chip}>
                <Text style={styles.chipText}>{domain}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ─── Reviews written ────────────────────────────────────────
          Lists the actual attestations this DID has authored. For a PEER the
          section stays hidden during the initial load (`null`) so it doesn't
          flash empty; for the OWN dashboard it always renders (title + the
          persistent Write-a-review CTA), with a "no reviews yet" line once the
          list resolves empty. */}
      {(authoredRows !== null || isSelf) && (
        <View style={styles.section} testID="reviewer-authored-section">
          <Text style={styles.sectionTitle}>
            {isSelf ? 'Reviews you wrote' : 'Reviews written'}
          </Text>
          {/* Persistent "Write a review" CTA on the OWN dashboard — works whether
              the list is empty (new-user onramp) or already has reviews (write
              another), so there's no need for a separate empty page. */}
          {isSelf && (
            <Pressable
              onPress={onWriteReview}
              style={({ pressed }) => [styles.writeReviewBtn, pressed && styles.retryBtnPressed]}
              testID="reviewer-profile-write-cta"
              accessibilityRole="button"
              accessibilityLabel="Write a review"
            >
              <Ionicons name="create-outline" size={16} color={colors.bgSecondary} />
              <Text style={styles.retryLabel}>Write a review</Text>
            </Pressable>
          )}
          {/* Pending (just-submitted) reviews — greyed, clear-only, newest first,
              above the live list. Replaced by the real row once AppView indexes
              them (deduped by URI in `pendingItems`). */}
          {pendingItems.length > 0 && (
            <View style={styles.authoredList} testID="reviewer-pending-list">
              {pendingItems.map((p) => (
                <PendingReviewRowView key={p.jobId} item={p} />
              ))}
            </View>
          )}
          {authoredRows === null ? null : authoredRows.length === 0 ? (
            // Only "no reviews" when there are no pending ones either.
            pendingItems.length === 0 ? (
              <Text style={styles.authoredEmpty} testID="reviewer-authored-empty">
                {isSelf ? "You haven't written any reviews yet." : 'No reviews written yet.'}
              </Text>
            ) : null
          ) : (
            <>
              <View style={styles.authoredList}>
                {/* Preview the latest N (rows arrive recency-sorted); expand on
                    "View all". Avoids an unbounded scroll on the profile when a
                    prolific reviewer has dozens. */}
                {(showAllReviews
                  ? authoredRows
                  : authoredRows.slice(0, AUTHORED_PREVIEW_COUNT)
                ).map((row) => (
                  <AuthoredAttestationRowView
                    key={row.uri}
                    row={row}
                    nowMs={nowMs}
                    onPress={onSelectAuthoredSubject}
                    onEdit={isSelf ? onEditAuthored : undefined}
                  />
                ))}
              </View>
              {!showAllReviews && authoredRows.length > AUTHORED_PREVIEW_COUNT && (
                <ProfileLinkRow
                  label={`View all reviews (${authoredRows.length})`}
                  testID="reviewer-authored-view-all"
                  onPress={() => setShowAllReviews(true)}
                />
              )}
            </>
          )}
        </View>
      )}

      {/* ─── Publishing (SELF only) ──────────────────────────────────
          The owner's profile doubles as their review-publishing hub:
          pending publishes, publish identity, and result preferences
          live here (moved off the Network home). Peers see a read-only
          profile — none of this. ("How Ranked Reviews work" now lives on
          the Network home Reviews card, not here.) */}
      {isSelf && (
        <View style={styles.section} testID="reviewer-publishing-section">
          <Text style={styles.sectionTitle}>Publishing</Text>
          <ProfileLinkRow
            label="Pending reviews"
            testID="reviewer-row-pending-reviews"
            onPress={() => router.push('/peerlens/outbox')}
          />
          <ProfileLinkRow
            label="Publish as"
            testID="reviewer-row-publish-as"
            onPress={() => router.push('/peerlens/namespace')}
          />
          <ProfileLinkRow
            label="Review preferences"
            testID="reviewer-row-review-preferences"
            onPress={() => router.push('/peerlens-preferences')}
          />
        </View>
      )}
    </ScrollView>
    </>
  );
}

/**
 * A greyed, non-interactive "Pending" row for a review still publishing /
 * awaiting AppView index. Clear-only: cancel a `queued` review (don't publish),
 * or dismiss a `published` receipt (already public — drop the local placeholder).
 * A `publishing` row is mid-write → no clear.
 */
function PendingReviewRowView({ item }: { item: PendingReviewItem }): React.JSX.Element {
  const onClear =
    item.status === 'queued'
      ? (): void => {
          cancelReviewPublishJob(item.jobId);
        }
      : item.status === 'published'
        ? (): void => {
            dismissReviewPublishReceipt(item.jobId);
          }
        : null;
  return (
    <View style={styles.pendingRow} testID={`reviewer-pending-row-${item.jobId}`}>
      <View style={styles.pendingRowText}>
        <Text style={styles.pendingTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.pendingTag}>Publishing…</Text>
      </View>
      {onClear !== null && (
        <Pressable
          onPress={onClear}
          hitSlop={8}
          style={({ pressed }) => [styles.pendingClearBtn, pressed && { opacity: 0.6 }]}
          testID={`reviewer-pending-clear-${item.jobId}`}
          accessibilityRole="button"
          accessibilityLabel={item.status === 'queued' ? 'Cancel pending review' : 'Dismiss'}
        >
          <Text style={styles.pendingClearLabel}>
            {item.status === 'queued' ? 'Cancel' : 'Clear'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** A tappable label + chevron row (Publishing / About sections). */
function ProfileLinkRow({
  label,
  testID,
  onPress,
}: {
  label: string;
  testID: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
    >
      <Text style={styles.linkRowLabel}>{label}</Text>
      <Text style={styles.linkRowChevron}>{'›'}</Text>
    </Pressable>
  );
}

interface AuthoredAttestationRowViewProps {
  row: AuthoredAttestationRow;
  nowMs: number;
  onPress?: (subjectId: string) => void;
  /**
   * Per-row edit handler. Reviewer screen passes this only when the
   * row belongs to the booted node ("Reviews you wrote") so the
   * affordance never lands on someone else's review. Omitting the
   * prop hides the Edit pill — that's the negative space test for
   * non-self profiles.
   */
  onEdit?: (row: AuthoredAttestationRow) => void;
}

function AuthoredAttestationRowView(
  props: AuthoredAttestationRowViewProps,
): React.ReactElement {
  const { row, nowMs, onPress, onEdit } = props;
  // When the row exposes an Edit affordance, the outer Pressable
  // drops its `accessibilityRole="button"` + label so iOS
  // VoiceOver doesn't aggregate the row into a single AX element
  // and swallow the inner Edit pill's traits. With the role/label
  // unset, VoiceOver descends into the children and finds the
  // Edit pill as its own focusable element. (Verified via
  // `idb ui describe-all` 2026-05-02 — the inner pill was missing
  // from the AX tree before this change.)
  const showEdit = onEdit !== undefined;
  const sentimentColour =
    row.sentiment === 'positive'
      ? colors.success
      : row.sentiment === 'negative'
      ? colors.warning
      : colors.textMuted;
  const sentimentLabel =
    row.sentiment === 'positive'
      ? 'Positive'
      : row.sentiment === 'negative'
      ? 'Negative'
      : 'Neutral';
  // `createdAtMs <= 0` means the wire shipped a malformed timestamp
  // and the data layer fell back to 0; "long ago" is a more honest
  // label than "60 months ago" (which is what formatLastActive
  // would compute against the unix epoch).
  const relative =
    row.createdAtMs > 0 ? formatLastActive(row.createdAtMs, nowMs) : 'long ago';
  const handlePress = onPress ? () => onPress(row.subjectId) : undefined;
  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.authoredRow,
        pressed && handlePress && styles.authoredRowPressed,
      ]}
      testID={`reviewer-authored-row-${row.uri}`}
      accessibilityRole={showEdit ? undefined : handlePress ? 'button' : 'text'}
      accessibilityLabel={
        showEdit ? undefined : `${sentimentLabel} review of ${row.subjectTitle}`
      }
    >
      <View style={styles.authoredHeader}>
        <Text
          style={styles.authoredTitle}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row.subjectTitle}
        </Text>
        <View
          style={[styles.authoredSentiment, { backgroundColor: sentimentColour }]}
          testID={`reviewer-authored-sentiment-${row.sentiment}`}
        >
          <Text style={styles.authoredSentimentText}>{sentimentLabel}</Text>
        </View>
      </View>
      {row.headline.length > 0 && (
        <Text
          style={styles.authoredHeadline}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          “{row.headline}”
        </Text>
      )}
      <View style={styles.authoredFooter}>
        {row.category !== null && (
          <Text style={styles.authoredCategory} numberOfLines={1}>
            {row.category}
          </Text>
        )}
        <Text style={styles.authoredAge}>{relative}</Text>
        {onEdit !== undefined && (
          <Pressable
            onPress={() => onEdit(row)}
            style={({ pressed }) => [
              styles.authoredEditPill,
              pressed && styles.authoredEditPillPressed,
            ]}
            testID={`reviewer-authored-edit-${row.uri}`}
            accessibilityRole="button"
            accessibilityLabel={`Edit your ${sentimentLabel.toLowerCase()} review of ${row.subjectTitle}`}
            hitSlop={8}
          >
            <Text style={styles.authoredEditPillText}>Edit</Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}


interface StatCellProps {
  label: string;
  /**
   * Stable test/AX hook — independent of the visible label so we can
   * relabel ("Attestations" → "Reviews written") without breaking the
   * test suite or accessibility expectations.
   */
  testKey: string;
  value: number | string;
}

/**
 * `decodeURIComponent` throws on malformed sequences (`%XX` with non-
 * hex). Wrap so a malformed deep link surfaces as the original string
 * (which the runner will then validate via `startsWith('did:')`)
 * rather than an uncaught render error.
 */
function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function StatCell(props: StatCellProps): React.ReactElement {
  return (
    <View style={styles.statCell} testID={`reviewer-stat-${props.testKey}`}>
      <Text style={styles.statValue}>{props.value}</Text>
      <Text style={styles.statLabel}>{props.label}</Text>
    </View>
  );
}

interface SentimentChipProps {
  label: string;
  count: number;
  colour: string;
}

function SentimentChip(props: SentimentChipProps): React.ReactElement {
  return (
    <View
      style={styles.sentimentChip}
      testID={`reviewer-sentiment-${props.label.toLowerCase()}`}
      accessibilityLabel={`${props.count} ${props.label.toLowerCase()}`}
    >
      <View style={[styles.sentimentDot, { backgroundColor: props.colour }]} />
      <Text style={styles.sentimentCount}>{props.count}</Text>
      <Text style={styles.sentimentLabel}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  loading: {
    flex: 1,
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
  },
  loadingText: textStyles.bodySmall,
  errorPanel: {
    flex: 1,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  errorTitle: {
    ...textStyles.h3,
    marginTop: spacing.md,
  },
  errorBody: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    gap: spacing.xs,
    minHeight: 44,
    marginTop: spacing.md,
  },
  retryBtnPressed: { backgroundColor: colors.accentHover },
  retryLabel: {
    ...textStyles.body,
    color: colors.bgSecondary,
  },
  // Dashboard "Write a review" CTA — left-aligned pill in the authored section
  // (not centered like the error/empty Retry).
  writeReviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    gap: spacing.xs,
    minHeight: 44,
    marginBottom: spacing.sm,
  },
  headerCard: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  // Greyed "Pending" review row — visibly inert (muted bg/text), clear-only.
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgTertiary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    opacity: 0.85,
  },
  pendingRowText: { flex: 1, gap: 2 },
  pendingTitle: { ...textStyles.body, color: colors.textSecondary },
  pendingTag: { ...textStyles.eyebrow, color: colors.textMuted },
  pendingClearBtn: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  pendingClearLabel: { ...textStyles.link, color: colors.textSecondary },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerIdentity: { flex: 1, gap: spacing.xs },
  headerDid: textStyles.monoSmall,
  // Primary line when a handle is resolved — readable, sans-serif,
  // sized like a name header rather than the mono small-caps DID.
  headerHandle: textStyles.bodyLargeStrong,
  // Tap-affordance hint below the short username. Tells the user
  // there's more to see (full handle, DID, PLC services) without
  // showing the noise inline.
  headerHint: {
    ...textStyles.tiny,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  headerNamespace: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  scoreBadge: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minWidth: 56,
    alignItems: 'center',
  },
  selfBadge: {
    backgroundColor: colors.textSecondary,
  },
  scoreLabel: {
    ...textStyles.bodyStrong,
    color: colors.bgSecondary,
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  headerMetaText: textStyles.caption,
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statCell: {
    flexBasis: '30%',
    flexGrow: 1,
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    gap: spacing.xs,
  },
  statValue: textStyles.h3,
  statLabel: textStyles.tiny,
  sentimentRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  sentimentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  sentimentDot: { width: 8, height: 8, borderRadius: 4 },
  sentimentCount: textStyles.bodySmallStrong,
  sentimentLabel: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  section: { gap: spacing.sm },
  sectionTitle: textStyles.bodyStrong,
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
  },
  linkRowPressed: { backgroundColor: colors.bgTertiary },
  linkRowLabel: { ...textStyles.body, flexShrink: 1 },
  linkRowChevron: { ...textStyles.body, color: colors.textMuted },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.bgTertiary,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
  },
  chipText: {
    ...textStyles.monoSmall,
    color: colors.textSecondary,
  },
  authoredEmpty: {
    ...textStyles.bodySmall,
    paddingVertical: spacing.md,
  },
  authoredList: { gap: spacing.sm },
  authoredRow: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    gap: spacing.xs,
  },
  authoredRowPressed: { opacity: 0.7 },
  authoredHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  authoredTitle: {
    ...textStyles.body,
    flex: 1,
  },
  authoredSentiment: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  authoredSentimentText: {
    ...textStyles.tiny,
    color: colors.bgSecondary,
  },
  authoredHeadline: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  authoredFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  authoredCategory: {
    ...textStyles.monoSmall,
    flex: 1,
  },
  authoredAge: textStyles.tiny,
  authoredEditPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  authoredEditPillPressed: {
    backgroundColor: colors.bgTertiary,
  },
  authoredEditPillText: {
    ...textStyles.tiny,
    color: colors.textPrimary,
  },
});
