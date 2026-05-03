/**
 * Trust Network — subject detail screen (TN-MOB-012 / Plan §8.5).
 *
 * Drilled into from a search-result card or the trust-feed landing.
 * The screen renders:
 *
 *   1. Header card: title, subtitle, score badge (numeric or band),
 *      review count, ring-count summary line.
 *   2. Friends section: reviews from self + contacts (top section —
 *      most-trusted voices).
 *   3. Friends-of-friends section: reviews from 2-hop network.
 *   4. Strangers section: reviews from everyone else.
 *
 * Empty sections are hidden — a subject with reviews from contacts
 * but none from strangers shows just two sections, not three with
 * one empty. Drives the visual signal "this subject's reach into
 * your network is exactly what you see".
 *
 * Render contract — same presentational pattern as the other trust
 * screens (TN-MOB-011/014/015/016/017): the runner subscribes to
 * `com.dina.trust.subjectGet` + the per-attestation enrichment, and
 * passes the resulting `SubjectDetailInput` to this component.
 *
 * Three render states pinned by tests:
 *   1. **Loading** — `data === null` AND `error === null`.
 *   2. **Error** — `error !== null`. Soft error panel + Retry CTA.
 *   3. **Loaded** — header + grouped review sections.
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';

import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { BAND_COLOUR, BAND_LABEL } from '../../src/trust/band_theme';
import { useSubjectDetail } from '../../src/trust/runners/use_subject_detail';
import { trustBandFor, type TrustBand } from '../../src/trust/score_helpers';
import {
  deriveSubjectDetail,
  type SubjectAlternative,
  type SubjectDetailInput,
} from '../../src/trust/subject_detail_data';

import type { SubjectReview } from '../../src/trust/subject_card';


/**
 * How long the screen waits for `data` before surfacing a
 * "couldn't reach the trust network" error. 5s is generous for the
 * AppView round-trip + slow networks, short enough that a stuck UI
 * doesn't feel stuck. The runner that subscribes to AppView resets
 * this implicitly — supplying `data` or `error` props skips the
 * timeout entirely.
 */
const LOAD_BUDGET_MS = 5000;

export interface SubjectDetailScreenProps {
  /**
   * Subject DID. Optional — when omitted the screen reads the URL
   * param via `useLocalSearchParams`. Tests pass it explicitly so the
   * presentational component remains pure under unit-test render.
   */
  subjectId?: string;
  /** Pre-fetched subject detail input. `null` while loading. */
  data?: SubjectDetailInput | null;
  /** Loading-error string. `null` when there's no error. */
  error?: string | null;
  /** Fired when the user taps Retry on the error state. */
  onRetry?: () => void;
  /**
   * Fired when the user taps a reviewer row — drills into reviewer
   * profile. Receives the reviewer's DID (not the display name).
   * Earlier this took the display name and the page handler pushed
   * `params: { did: reviewerName }`, which left the reviewer screen
   * stuck on its loading spinner because the runner's
   * `startsWith('did:')` guard short-circuited.
   */
  onSelectReviewer?: (reviewerDid: string) => void;
  /** Fired when the user taps the "Write a review" CTA. */
  onWriteReview?: (subjectId: string) => void;
  /**
   * Fired when the user taps their OWN review row in any of the
   * three sections. The default handler pushes to the user's own
   * reviewer profile (`/trust/reviewer/[did]`) — that screen has the
   * Edit affordance per row, which is the cleanest path to amend a
   * review without extending `SubjectReview` with all the editable
   * fields. Tests can stub this to assert the routing.
   */
  onPressOwnReview?: () => void;
  /**
   * Fired when the user taps the visible "Edit" pill on their OWN
   * review row. Distinct from `onPressOwnReview` (the row body):
   * the pill deep-links straight into `/trust/write` in edit mode
   * with the original review's fields pre-filled, so the user lands
   * on the editor rather than bouncing through the reviewer-profile
   * intermediate screen. Default handler builds the route from the
   * tapped review's `attestationUri` + sentiment + headline + body.
   * No-op when the review didn't carry an `attestationUri` (e.g. a
   * legacy wire shape without it) — the pill is rendered but inert.
   */
  onPressOwnReviewEdit?: (review: SubjectReview) => void;
  /**
   * Viewer's DID — used to detect self-authored review rows so they
   * suppress the trust band badge ("VERY LOW" red verdict) and show
   * "Your review" instead. Optional: when omitted the screen reads
   * the booted-node DID via `getBootedNode()`. Tests pass it
   * explicitly to verify the band-shame suppression without booting
   * a real node.
   */
  viewerDid?: string;
}

export default function SubjectDetailScreen(
  props: SubjectDetailScreenProps = {},
): React.ReactElement {
  // Hooks must be called unconditionally per the Rules of Hooks. The
  // route param is only consulted when the caller didn't supply
  // `subjectId` explicitly (production path); tests always pass it
  // and the param value is ignored.
  const params = useLocalSearchParams<{ subjectId?: string | string[] }>();
  const paramSubjectId = Array.isArray(params.subjectId)
    ? params.subjectId[0]
    : params.subjectId;
  const router = useRouter();
  // Local state lets the screen surface a graceful "couldn't reach the
  // trust network" error after the load-budget elapses, rather than
  // spinning forever. When the caller supplies `data` or `error`
  // explicitly (controlled mode — tests + a future runner), the timeout
  // is skipped because `props.data !== undefined` short-circuits the
  // effect.
  const [autoError, setAutoError] = React.useState<string | null>(null);
  const [retryNonce, setRetryNonce] = React.useState(0);
  const subjectId = props.subjectId ?? paramSubjectId ?? '';
  // TN-V2-RANK-012 — viewer region for the region pill. Keystore-
  // resident; never sent over the wire (Loyalty Law). The hook is
  // safe to call before unlock — `profile` is null until hydration
  // completes, which means the region pill is silently null too.
  const { profile: viewerProfile } = useViewerPreferences();
  // Auto-runner: fetch subject detail from AppView when no controlled
  // props are supplied. The viewer DID drives reviewer-bucket grouping
  // server-side, so we read it from the booted node. Without a node
  // (e.g. pre-unlock or first-render before bootstrap completes) the
  // runner stays inert and the auto-timeout fallback fires instead.
  const isControlled = props.data !== undefined || props.error !== undefined;
  const viewerDid = getBootedNode()?.did ?? '';
  const runnerEngaged = !isControlled && subjectId !== '' && viewerDid !== '';
  const auto = useSubjectDetail({
    subjectId,
    viewerDid,
    enabled: runnerEngaged,
    retryNonce,
  });
  // Refetch on every focus so a freshly-published or freshly-revoked
  // attestation is reflected when the user navigates back to this
  // subject. The runner's own dep array is keyed on subjectId+viewerDid,
  // both of which stay stable across focus events.
  useFocusEffect(
    React.useCallback(() => {
      if (!runnerEngaged) return;
      setAutoError(null);
      setRetryNonce((n) => n + 1);
    }, [runnerEngaged]),
  );
  const {
    data = auto.data,
    error = runnerEngaged ? auto.error : autoError,
    onRetry = () => {
      setAutoError(null);
      setRetryNonce((n) => n + 1);
    },
    onSelectReviewer = (reviewerDid: string) => {
      // The path param is the reviewer's DID — not the display name.
      // expo-router URL-encodes the colons in `did:plc:…`; the screen
      // decodes via `safelyDecode` before handing off to the runner.
      router.push({
        pathname: '/trust/reviewer/[did]',
        params: { did: reviewerDid },
      });
    },
    onWriteReview = (id: string) => {
      // Pass the resolved subject ref alongside `subjectId` so the
      // write screen can show the subject name in its header AND
      // reconstruct a SubjectRef that resolves to the same `subject_id`
      // server-side — otherwise the inject path mints a new subject.
      const writeParams: Record<string, string> = { subjectId: id };
      if (data?.title) writeParams.subjectName = data.title;
      if (data?.subjectKind) writeParams.subjectKind = data.subjectKind;
      if (data?.subjectIdentifier)
        writeParams.subjectIdentifier = data.subjectIdentifier;
      if (data?.subjectDid) writeParams.subjectDid = data.subjectDid;
      router.push({ pathname: '/trust/write', params: writeParams });
    },
    onPressOwnReview = () => {
      // Row-body tap drops the user on their own reviewer profile
      // (where the full authored-reviews list lives). The Edit pill
      // bypasses this and goes straight to the editor — see
      // `onPressOwnReviewEdit` below.
      if (viewerDid === '') return;
      router.push({
        pathname: '/trust/reviewer/[did]',
        params: { did: viewerDid },
      });
    },
    onPressOwnReviewEdit = (review: SubjectReview) => {
      // Build the same `editingUri`-led params shape the reviewer
      // profile screen uses (see `onEditAuthored` in
      // `trust/reviewer/[did].tsx`) so both Edit affordances land on
      // the SAME pre-filled form. We need the subject context too —
      // SubjectRef has to reconstruct to the same hash on republish
      // or the publish path mints a new subject row.
      if (!review.attestationUri) return;
      const params: Record<string, string> = {
        subjectId,
        editingUri: review.attestationUri,
        editingCosigCount: '0',
        editingHeadline: review.headline,
        editingBody: review.body ?? '',
      };
      if (review.sentiment) params.editingSentiment = review.sentiment;
      if (data?.title) params.subjectName = data.title;
      if (data?.subjectKind) params.subjectKind = data.subjectKind;
      if (data?.subjectIdentifier)
        params.subjectIdentifier = data.subjectIdentifier;
      if (data?.subjectDid) params.subjectDid = data.subjectDid;
      router.push({ pathname: '/trust/write', params });
    },
    viewerDid: viewerDidProp = viewerDid,
  } = props;

  // Auto-timeout: only meaningful when the runner can't engage (no
  // viewerDid, e.g. the node hasn't booted yet). When the runner is
  // engaged, its `error` is authoritative and this fallback stays
  // silent. See useSubjectDetail for the runner-side error path.
  React.useEffect(() => {
    if (props.data !== undefined || props.error !== undefined) return;
    if (subjectId === '') return;
    if (runnerEngaged) return;
    const id = setTimeout(() => {
      setAutoError("Couldn't reach the trust network. Check your connection and try again.");
    }, LOAD_BUDGET_MS);
    return () => clearTimeout(id);
  }, [subjectId, retryNonce, props.data, props.error, runnerEngaged]);

  if (error !== null) {
    return (
      <View style={styles.container} testID="subject-detail-error">
        <View style={styles.panel}>
          <Ionicons name="alert-circle-outline" size={36} color={colors.error} />
          <Text style={styles.panelTitle}>Couldn&apos;t load this subject</Text>
          <Text style={styles.panelBody}>{error}</Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [styles.retryBtn, pressed && styles.retryBtnPressed]}
              testID="subject-detail-retry"
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

  if (data === null) {
    return (
      <View style={styles.container} testID="subject-detail-loading">
        <View style={styles.panel}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading subject…</Text>
        </View>
      </View>
    );
  }

  // TN-V2-RANK-011 + RANK-012 — feed the chip derivation viewer
  // state. `viewerRegion` drives the region pill; `nowMs` is the
  // recency-badge clock. Region is keystore-resident (Loyalty Law);
  // it never reaches the network, only the local lens.
  const detail = deriveSubjectDetail(data, {
    viewerRegion: viewerProfile?.region,
    // Pin self-authored "stranger" rows back into the friends bucket
    // when the wire bucketing missed. The same belt-and-braces guard
    // already lives in `ReviewRow` for the band-suppression UI; this
    // wires the data-layer counterpart so the section split + the
    // header's `ringCounts` agree with the row visual.
    viewerDid: viewerDidProp !== '' ? viewerDidProp : null,
  });
  const { header } = detail;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="subject-detail-screen"
    >
      {/* ─── Header card ─────────────────────────────────────────── */}
      <View style={styles.headerCard}>
        <Text style={styles.title} numberOfLines={2}>
          {header.title}
        </Text>
        {header.subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {header.subtitle}
          </Text>
        )}
        {/* TN-V2-RANK-015 — flag-warning banner. Renders above the
            chip row because it's the load-bearing exclusion signal
            (more critical than even the region pill: "your contacts
            flagged this brand" outweighs "you can't get this here").
            Visually distinct (warning colour + alert icon) so it
            reads as a SAFETY CTA, not just another descriptor.
            Banner-or-nothing posture: silent when count is zero so
            non-flagged subjects don't get reassurance theatre. */}
        {header.flagWarning && (
          <View style={styles.flagWarningBanner} testID="subject-detail-flag-warning">
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.flagWarningText} numberOfLines={2}>
              {header.flagWarning.text}
            </Text>
          </View>
        )}
        {/* TN-V2-P1-004 + RANK-011/012/013: context chips mirror the
            card surface. Same warning-then-descriptor order: region
            pill + recency first (load-bearing exclusion + freshness
            signals), then host + language + location + price.
            Larger here than on the card because the detail header
            has more vertical space — same chip semantics, same
            gating. */}
        {(header.regionPill ||
          header.recency ||
          header.host ||
          header.language ||
          header.location ||
          header.priceTier) && (
          <View style={styles.contextChips} testID="subject-detail-context">
            {header.regionPill && (
              <View
                style={[styles.contextChip, styles.warningChip]}
                testID="subject-detail-region"
              >
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {header.regionPill}
                </Text>
              </View>
            )}
            {header.recency && (
              <View
                style={[styles.contextChip, styles.warningChip]}
                testID="subject-detail-recency"
              >
                <Ionicons name="time-outline" size={12} color={colors.textMuted} />
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {header.recency}
                </Text>
              </View>
            )}
            {header.host && (
              <View style={styles.contextChip} testID="subject-detail-host">
                <Ionicons name="globe-outline" size={12} color={colors.textMuted} />
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {header.host}
                </Text>
              </View>
            )}
            {header.language && (
              <View style={styles.contextChip} testID="subject-detail-language">
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {header.language}
                </Text>
              </View>
            )}
            {header.location && (
              <View style={styles.contextChip} testID="subject-detail-location">
                <Ionicons name="location-outline" size={12} color={colors.textMuted} />
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {header.location}
                </Text>
              </View>
            )}
            {header.priceTier && (
              <View style={styles.contextChip} testID="subject-detail-price">
                <Text style={styles.contextChipText} numberOfLines={1}>
                  {header.priceTier}
                </Text>
              </View>
            )}
          </View>
        )}
        <View style={styles.headerRow}>
          <View
            style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[header.score.band] }]}
            testID={`subject-detail-band-${header.score.band}`}
          >
            <Text style={styles.scoreText}>
              {header.showNumericScore ? header.score.label : BAND_LABEL[header.score.band]}
            </Text>
          </View>
          <Text style={styles.reviewCount}>
            {header.reviewCount} {header.reviewCount === 1 ? 'review' : 'reviews'}
          </Text>
        </View>
        <Text style={styles.ringSummary} testID="subject-detail-ring-summary">
          {header.ringCounts.friends} from your network · {header.ringCounts.fof} from
          friends-of-friends · {header.ringCounts.strangers} from strangers
        </Text>
      </View>

      {onWriteReview && (
        <Pressable
          onPress={() => onWriteReview(subjectId)}
          style={({ pressed }) => [
            styles.writeBtn,
            pressed && styles.writeBtnPressed,
          ]}
          testID="subject-detail-write-cta"
          accessibilityRole="button"
          accessibilityLabel="Write a review"
        >
          <Ionicons name="create-outline" size={18} color={colors.bgSecondary} />
          <Text style={styles.writeBtnLabel}>Write a review</Text>
        </Pressable>
      )}

      {/* ─── Reviews grouped by ring ─────────────────────────────── */}
      <ReviewSection
        title="Your network"
        subtitle="Reviews from contacts and yourself"
        reviews={detail.friendsReviews}
        emptyHint={null}
        testIdPrefix="friends"
        onSelectReviewer={onSelectReviewer}
        onPressOwnReview={onPressOwnReview}
        onPressOwnReviewEdit={onPressOwnReviewEdit}
        viewerDid={viewerDidProp}
      />
      <ReviewSection
        title="Friends of friends"
        subtitle={null}
        reviews={detail.fofReviews}
        emptyHint={null}
        testIdPrefix="fof"
        onSelectReviewer={onSelectReviewer}
        onPressOwnReview={onPressOwnReview}
        onPressOwnReviewEdit={onPressOwnReviewEdit}
        viewerDid={viewerDidProp}
      />
      <ReviewSection
        title="Strangers"
        subtitle={null}
        reviews={detail.strangerReviews}
        emptyHint={
          detail.friendsReviews.length === 0 &&
          detail.fofReviews.length === 0 &&
          detail.strangerReviews.length === 0
            ? 'No reviews yet — be the first.'
            : null
        }
        testIdPrefix="strangers"
        onSelectReviewer={onSelectReviewer}
        onPressOwnReview={onPressOwnReview}
        onPressOwnReviewEdit={onPressOwnReviewEdit}
        viewerDid={viewerDidProp}
      />
      {/* TN-V2-RANK-014 — alternatives strip below the reviews. The
          strip's existence signals "if this subject doesn't fit you,
          here are 3 trusted alternatives in the same category". Hide
          entirely when empty (no candidates / pre-server xRPC) so
          the user doesn't see a header with no content. */}
      {detail.alternatives.length > 0 && (
        <AlternativesStrip
          alternatives={detail.alternatives}
          onSelectAlternative={(altId) =>
            router.push({ pathname: '/trust/[subjectId]', params: { subjectId: altId } })
          }
        />
      )}
    </ScrollView>
  );
}

interface AlternativesStripProps {
  readonly alternatives: readonly SubjectAlternative[];
  readonly onSelectAlternative: (subjectId: string) => void;
}

function AlternativesStrip(props: AlternativesStripProps): React.ReactElement {
  const { alternatives, onSelectAlternative } = props;
  return (
    <View style={styles.alternativesStrip} testID="subject-detail-alternatives">
      <Text style={styles.alternativesTitle}>
        {alternatives.length === 1 ? '1 trusted alternative' : `${alternatives.length} trusted alternatives`}
      </Text>
      <View style={styles.alternativesRow}>
        {alternatives.map((alt) => (
          <Pressable
            key={alt.subjectId}
            onPress={() => onSelectAlternative(alt.subjectId)}
            style={({ pressed }) => [
              styles.alternativeCard,
              pressed && styles.alternativeCardPressed,
            ]}
            testID={`subject-detail-alternative-${alt.subjectId}`}
            accessibilityRole="button"
            accessibilityLabel={`${alt.title}, trust ${BAND_LABEL[alt.band]}`}
          >
            {alt.band !== 'unrated' && (
              <View
                style={[styles.alternativeBand, { backgroundColor: BAND_COLOUR[alt.band] }]}
                testID={`subject-detail-alternative-band-${alt.subjectId}`}
              />
            )}
            <Text style={styles.alternativeTitle} numberOfLines={2}>
              {alt.title}
            </Text>
            {alt.category && (
              <Text style={styles.alternativeCategory} numberOfLines={1}>
                {alt.category}
              </Text>
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

interface ReviewSectionProps {
  title: string;
  subtitle: string | null;
  reviews: readonly SubjectReview[];
  /** Hint shown when ALL sections are empty. `null` for the per-section silent-empty case. */
  emptyHint: string | null;
  testIdPrefix: 'friends' | 'fof' | 'strangers';
  onSelectReviewer?: (reviewerDid: string) => void;
  /** Fired when the user taps their own review row. */
  onPressOwnReview?: () => void;
  /** Fired when the user taps the Edit pill on their own review row. */
  onPressOwnReviewEdit?: (review: SubjectReview) => void;
  /** Threaded down so each row can self-detect the viewer's own review. */
  viewerDid?: string;
}

function ReviewSection(props: ReviewSectionProps): React.ReactElement | null {
  const {
    title,
    subtitle,
    reviews,
    emptyHint,
    testIdPrefix,
    onSelectReviewer,
    onPressOwnReview,
    onPressOwnReviewEdit,
    viewerDid,
  } = props;
  if (reviews.length === 0 && emptyHint === null) return null;

  return (
    <View style={styles.section} testID={`subject-detail-section-${testIdPrefix}`}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {reviews.length > 0 && (
          <Text style={styles.sectionCount}>{reviews.length}</Text>
        )}
      </View>
      {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}

      {reviews.length === 0 ? (
        <Text style={styles.emptyHint}>{emptyHint}</Text>
      ) : (
        <View style={styles.reviewList}>
          {reviews.map((review, idx) => (
            <ReviewRow
              key={`${review.reviewerName}-${review.createdAtMs}-${idx}`}
              review={review}
              testID={`subject-detail-review-${testIdPrefix}-${idx}`}
              onPress={onSelectReviewer}
              onPressOwnReview={onPressOwnReview}
              onPressOwnReviewEdit={onPressOwnReviewEdit}
              viewerDid={viewerDid}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface ReviewRowProps {
  review: SubjectReview;
  testID: string;
  onPress?: (reviewerDid: string) => void;
  /**
   * Fired when the user taps their OWN review row. Self rows used to
   * be `accessibilityRole='text'` with no tap action, leaving the
   * user with no way to amend a review from the subject page; this
   * callback opens whatever path the parent screen routes to (default:
   * the user's own reviewer profile).
   */
  onPressOwnReview?: () => void;
  /**
   * Fired when the user taps the visible "Edit" pill on their OWN
   * review row. The pill is its own Pressable nested inside the row;
   * RN's gesture system delivers the tap to the inner Pressable and
   * does NOT also fire the row's `onPress`. Without this split the
   * pill inherited the row's "go to reviewer profile" behaviour, so
   * tapping Edit silently bounced the user to the wrong screen.
   */
  onPressOwnReviewEdit?: (review: SubjectReview) => void;
  /**
   * Viewer's DID. When the row's DID matches, the band badge is
   * suppressed and the row reads "Your review" — same self-detection
   * AppView's `reviewers.self` bucket should produce, but applied
   * mobile-side as a belt-and-braces guard against AppView putting
   * the user's review into `strangers` (which historically rendered
   * a "VERY LOW" red badge against the user's own name).
   */
  viewerDid?: string;
}

function ReviewRow(props: ReviewRowProps): React.ReactElement {
  const {
    review,
    testID,
    onPress,
    onPressOwnReview,
    onPressOwnReviewEdit,
    viewerDid,
  } = props;
  // Use the canonical band derivation rather than hand-coding the
  // threshold ladder — keeps the screen in lockstep with score_helpers
  // when the bands ever change (currently 0.8 / 0.5 / 0.3, but those
  // are tunable in `@dina/protocol`'s `score_bands.ts`).
  const band: TrustBand = trustBandFor(review.reviewerTrustScore);
  // Self-detection: prefer the wire ring, but ALSO treat any row whose
  // DID matches the viewer as self. AppView's `subjectGet` bucketing
  // has been observed putting the viewer's own review into `strangers`
  // (when the viewerDid handshake misses), which used to surface the
  // user's own band ("VERY LOW" red badge) against their own name —
  // exactly the shame mechanic we removed from the self-card on the
  // Trust landing. Belt-and-braces here so the wire-bucketing fix
  // lands later without needing another mobile pass.
  const isSelf =
    review.ring === 'self' ||
    (typeof viewerDid === 'string' &&
      viewerDid.length > 0 &&
      review.reviewerDid === viewerDid);

  // Capture the DID into a local so the closure below sees the
  // narrowed `string` type without an `as` cast.
  const reviewerDid = review.reviewerDid;
  const handlePress = isSelf
    ? onPressOwnReview
    : onPress && reviewerDid !== null
      ? () => onPress(reviewerDid)
      : undefined;
  const isInteractive = handlePress !== undefined;

  // Self-row needs TWO independent tap targets:
  //   - body (name + headline) → reviewer profile (`onPressOwnReview`)
  //   - "Edit" pill            → editor (`onPressOwnReviewEdit`)
  // Earlier we tried nested Pressables. iOS's accessibility system
  // collapsed the inner pill into the parent's accessible button (the
  // outer Pressable's `accessible=true` default merges descendants),
  // and the touch hit-test followed AX — so taps on the pill ran the
  // OUTER handler and bounced the user to the reviewer profile. The
  // structural fix is siblings, not nesting: the row is a plain View;
  // the body and pill are independent Pressables side-by-side.
  if (isSelf) {
    const editEnabled =
      onPressOwnReviewEdit !== undefined && review.attestationUri != null;
    return (
      <View style={styles.reviewRow} testID={testID}>
        <View style={styles.reviewHeader}>
          <Pressable
            onPress={onPressOwnReview}
            style={({ pressed }) => [
              styles.selfBodyTouchable,
              pressed && onPressOwnReview ? styles.selfBodyTouchablePressed : null,
            ]}
            accessibilityRole={onPressOwnReview ? 'button' : 'text'}
            accessibilityLabel="Your review — tap to edit"
            testID={`${testID}-body`}
          >
            <Text style={styles.reviewerName}>Your review</Text>
          </Pressable>
          <Pressable
            onPress={
              editEnabled
                ? () => onPressOwnReviewEdit!(review)
                : undefined
            }
            style={({ pressed }) => [
              styles.editPill,
              pressed && editEnabled ? styles.editPillPressed : null,
            ]}
            testID="subject-detail-self-edit-pill"
            accessibilityRole="button"
            accessibilityLabel="Edit your review"
          >
            <Text style={styles.editPillText}>Edit</Text>
          </Pressable>
        </View>
        <Pressable
          onPress={onPressOwnReview}
          style={({ pressed }) => [
            styles.selfBodyTouchable,
            pressed && onPressOwnReview ? styles.selfBodyTouchablePressed : null,
          ]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Text style={styles.headline} numberOfLines={3}>
            “{review.headline}”
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.reviewRow,
        pressed && isInteractive && styles.reviewRowPressed,
      ]}
      testID={testID}
      accessibilityRole={isInteractive ? 'button' : 'text'}
      accessibilityLabel={`Review by ${review.reviewerName}, trust ${BAND_LABEL[band]}`}
    >
      <View style={styles.reviewHeader}>
        <Text style={styles.reviewerName}>{review.reviewerName}</Text>
        <View style={[styles.miniBand, { backgroundColor: BAND_COLOUR[band] }]}>
          <Text style={styles.miniBandText}>{BAND_LABEL[band]}</Text>
        </View>
      </View>
      <Text style={styles.headline} numberOfLines={3}>
        “{review.headline}”
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  panel: {
    flex: 1,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  panelTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  panelBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  loadingText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.md,
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
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  headerCard: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.textPrimary,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  // TN-V2-P1-004: context chips on the detail header. Slightly larger
  // type than the card chips (12pt vs 10pt) since the detail surface
  // has more vertical space and the chips are still the secondary
  // signal (the score badge dominates).
  contextChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  contextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
  },
  // TN-V2-RANK-011 + RANK-012 — same gentle-friction treatment as
  // on the card surface (hairline border on the muted background).
  warningChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  // TN-V2-RANK-015 — flag-warning banner. Stronger visual treatment
  // than the warning chips above (it's a SAFETY CTA, not a
  // descriptor): warning-tinted background with a hairline border
  // in the warning hue, alert icon left-aligned with the copy. Sits
  // BETWEEN subtitle and chip row so the user can't miss it before
  // their eye drifts to the score badge.
  flagWarningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
  },
  flagWarningText: {
    flex: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  contextChipText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
    letterSpacing: 0.3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  scoreBadge: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minWidth: 56,
    alignItems: 'center',
  },
  scoreText: {
    fontFamily: fonts.headingBold,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  reviewCount: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textSecondary,
  },
  ringSummary: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  writeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: spacing.sm,
    minHeight: 48,
  },
  writeBtnPressed: { backgroundColor: colors.accentHover },
  writeBtnLabel: {
    fontFamily: fonts.headingBold,
    fontSize: 15,
    color: colors.bgSecondary,
  },
  section: { gap: spacing.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
  },
  sectionCount: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textMuted,
  },
  sectionSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  emptyHint: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: spacing.md,
  },
  reviewList: { gap: spacing.sm },
  reviewRow: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  reviewRowPressed: { backgroundColor: colors.bgTertiary },
  // The two halves of a self-row are independent Pressables. The
  // body fills the row but stays visually flat (no card chrome —
  // the outer View owns the border + background). Pressed state
  // only mutates background so the affordance reads.
  selfBodyTouchable: { flex: 1 },
  selfBodyTouchablePressed: { backgroundColor: colors.bgTertiary },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reviewerName: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
  },
  miniBand: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  miniBandText: {
    fontFamily: fonts.headingBold,
    fontSize: 10,
    color: colors.bgSecondary,
  },
  editPill: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  editPillPressed: { backgroundColor: colors.bgTertiary },
  editPillText: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    color: colors.textPrimary,
  },
  headline: {
    fontFamily: fonts.serif,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 19,
  },
  // TN-V2-RANK-014 — alternatives strip below the review list. Lays
  // out as a horizontal row of compact cards with a section header.
  // The cards are sized to fit 3 abreast on a phone (each ~ 1/3 of
  // the screen width minus gutters). On wider screens flex-wrap
  // takes over so the strip degrades gracefully.
  alternativesStrip: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  alternativesTitle: {
    fontFamily: fonts.headingBold,
    fontSize: 14,
    color: colors.textPrimary,
  },
  alternativesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  alternativeCard: {
    flex: 1,
    minWidth: 100,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  alternativeCardPressed: { backgroundColor: colors.bgTertiary },
  alternativeBand: {
    width: 24,
    height: 4,
    borderRadius: radius.sm,
  },
  alternativeTitle: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
    lineHeight: 17,
  },
  alternativeCategory: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
  },
});
