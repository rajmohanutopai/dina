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
import { useLocalSearchParams, useRouter } from 'expo-router';
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

import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { colors, fonts, spacing, radius } from '../../src/theme';
import {
  injectAttestation,
  isTestPublishConfigured,
  type SubjectRefBody,
} from '../../src/trust/appview_runtime';
import { deriveEditWarning, type EditWarning } from '../../src/trust/edit_flow';
import {
  enqueueLocal,
  type AttestationDraftBody,
} from '../../src/trust/outbox_store';
import {
  emptyWriteFormState,
  emptyWriteFormStateWithSubject,
  validateWriteForm,
  describeWriteFormError,
  serializeFormToV2Extras,
  SENTIMENT_OPTIONS,
  CONFIDENCE_OPTIONS,
  SUBJECT_KIND_OPTIONS,
  SUBJECT_KIND_HINT,
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  LAST_USED_BUCKETS,
  LAST_USED_BUCKET_LABEL,
  MAX_USE_CASES,
  MAX_REVIEW_ALTERNATIVES,
  MAX_COMPLIANCE,
  MAX_ACCESSIBILITY,
  MAX_COMPAT,
  MAX_RECOMMEND_FOR,
  MAX_AVAILABILITY_REGIONS,
  MAX_AVAILABILITY_SOLD_AT,
  USE_CASE_LABEL,
  REVIEWER_EXPERIENCE_OPTIONS,
  REVIEWER_EXPERIENCE_LABEL,
  REVIEWER_EXPERIENCE_HINT,
  COMPLIANCE_VOCABULARY,
  COMPLIANCE_LABEL,
  ACCESSIBILITY_VOCABULARY,
  ACCESSIBILITY_LABEL,
  COMPAT_VOCABULARY,
  COMPAT_LABEL,
  SEASONAL_MONTH_LABEL,
  addReviewAlternative,
  removeReviewAlternative,
  toggleUseCase,
  toggleTagInVocabulary,
  toggleSeasonalMonth,
  addCountryCode,
  addHostname,
  removeAtIndex,
  useCasesForCategory,
  type LastUsedBucket,
  type ReviewAlternative,
  type ReviewerExperience,
  type WriteFormState,
  type WriteFormError,
  type WriteSubjectState,
  type SubjectKind,
} from '../../src/trust/write_form_data';

import type { Sentiment, Confidence } from '@dina/protocol';

/**
 * Generate a client-side draft id. Crypto-grade randomness isn't
 * required (the outbox enforces uniqueness via `duplicate_client_id`
 * rejection); a timestamp + short random suffix is enough to keep
 * drafts distinct across rapid re-taps.
 */
function generateClientId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Map the form's per-kind subject inputs into the `SubjectRef` shape
 * AppView expects. Empty fields are dropped — AppView's subject
 * resolver hashes the canonical (`type`, `did`/`uri`/`identifier`,
 * `name`) tuple, so emitting empty strings would mint a different
 * `subject_id` than callers who supply the same fields.
 */
function subjectStateToRef(s: WriteSubjectState): SubjectRefBody {
  const out: SubjectRefBody = { type: s.kind };
  if (s.name.trim().length > 0) out.name = s.name.trim();
  if (s.did.trim().length > 0) out.did = s.did.trim();
  if (s.uri.trim().length > 0) out.uri = s.uri.trim();
  if (s.identifier.trim().length > 0) out.identifier = s.identifier.trim();
  return out;
}

/**
 * Reconstruct a SubjectRef from URL params carried over from the
 * subject-detail screen. Mirrors `subjectStateToRef`'s shape so the
 * AppView subject resolver hashes the same canonical tuple and lands
 * on the SAME `subject_id` — otherwise a review for "Tesla Model 3"
 * launched from its detail page would mint a new subject instead of
 * attaching to the existing one.
 */
function buildSubjectRefFromParams(
  kind: SubjectKind,
  name: string,
  identifier: string | undefined,
  did: string | undefined,
): SubjectRefBody {
  const out: SubjectRefBody = { type: kind };
  if (name.trim().length > 0) out.name = name.trim();
  if (identifier !== undefined && identifier.trim().length > 0)
    out.identifier = identifier.trim();
  if (did !== undefined && did.trim().length > 0) out.did = did.trim();
  return out;
}

/**
 * Reasonable default category per subject kind. AppView indexes free-
 * text categories (no closed taxonomy enforced server-side); we pick
 * a sensible top-level slug so the subject card's subtitle renders
 * something meaningful by default. Users can change category in a
 * future advanced-fields surface.
 */
function categoryFor(kind: SubjectKind): string {
  switch (kind) {
    case 'product':
      return 'commerce/product';
    case 'place':
      return 'place/general';
    case 'organization':
      return 'organization/general';
    case 'content':
      return 'content/web';
    case 'did':
      return 'identity/person';
    case 'dataset':
      return 'content/dataset';
    case 'claim':
      return 'claim/general';
  }
}

/**
 * Compose the attestation `text` field from the headline + body. The
 * headline is the front-of-card lede; body is optional context. We
 * concatenate with a paragraph break so AppView's FTS index covers
 * both — single-field stays simple, future schema can split if the
 * scoring pipeline benefits from headline-vs-body weighting.
 */
function composeText(headline: string, body: string): string {
  const h = headline.trim();
  const b = body.trim();
  if (h.length === 0 && b.length === 0) return '';
  if (h.length === 0) return b;
  if (b.length === 0) return h;
  return `${h}\n\n${b}`;
}

const SUBJECT_KIND_LABEL: Record<SubjectKind, string> = {
  product: 'Product',
  place: 'Place',
  organization: 'Organization',
  content: 'Content',
  did: 'Person/DID',
  dataset: 'Dataset',
  claim: 'Claim',
};

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
  /**
   * Subject the review targets — title shown in the header for
   * context. Optional default makes the screen routable as an Expo
   * Router default export when no runner has resolved the subject yet
   * (the user lands here from the unrouted-tab path or a direct
   * deep link with no subject context).
   */
  subjectTitle?: string;
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
  /**
   * **TN-V2-REV-008.** Search hook for the alternatives picker —
   * called as the user types in the picker's query input. The
   * caller (a runner) wraps the actual search xRPC; the screen
   * stays unaware of network details. Optional: when omitted, the
   * picker's input + results list still render but searching is a
   * no-op (the user can't add results, only see "search not
   * available" hint).
   */
  searchAlternatives?: (query: string) => Promise<readonly ReviewAlternative[]>;
}

export default function WriteScreen(props: WriteScreenProps = {}): React.ReactElement {
  // Hooks unconditional. Production path reads `subjectId` from the
  // route's query params; tests pass form state directly so the
  // params are ignored.
  const router = useRouter();
  const params = useLocalSearchParams<{
    subjectId?: string | string[];
    subjectName?: string | string[];
    subjectKind?: string | string[];
    subjectIdentifier?: string | string[];
    subjectDid?: string | string[];
    createKind?: string | string[];
    initialName?: string | string[];
  }>();
  const readParam = (raw: string | string[] | undefined): string | undefined =>
    Array.isArray(raw) ? raw[0] : raw;
  const paramSubjectId = readParam(params.subjectId);
  const paramSubjectName = readParam(params.subjectName);
  const paramSubjectIdentifier = readParam(params.subjectIdentifier);
  const paramSubjectDid = readParam(params.subjectDid);
  const paramSubjectKindRaw = readParam(params.subjectKind);
  const paramSubjectKind: SubjectKind | null =
    paramSubjectKindRaw !== undefined &&
    SUBJECT_KIND_OPTIONS.includes(paramSubjectKindRaw as SubjectKind)
      ? (paramSubjectKindRaw as SubjectKind)
      : null;
  const paramInitialName = readParam(params.initialName);
  // `?createKind=product|place|organization|content|did|dataset|claim`
  // flips the form into "describe a new subject" mode. Without this
  // signal the form stays review-only — backwards compatible with the
  // existing Write-CTA flow that arrives with a `subjectId`. The
  // unknown-kind fallback drops the user back into review mode rather
  // than crashing on a typo.
  const rawCreateKind = Array.isArray(params.createKind)
    ? params.createKind[0]
    : params.createKind;
  const createKind: SubjectKind | null =
    rawCreateKind !== undefined &&
    SUBJECT_KIND_OPTIONS.includes(rawCreateKind as SubjectKind)
      ? (rawCreateKind as SubjectKind)
      : null;
  // Local error state is populated by the default `onPublish` when the
  // outbox enqueue is rejected. The screen renders it via the existing
  // `submitError` panel.
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [localSubmitting, setLocalSubmitting] = React.useState(false);
  // Hide validation errors ("Choose a sentiment", "A headline is
  // required", etc.) until the user attempts to publish. Showing red
  // errors on a fresh form before the user has touched anything reads
  // as the form scolding them on arrival. Flips true on first publish
  // attempt and stays true so the user sees real-time feedback after
  // their first submit.
  const [showErrors, setShowErrors] = React.useState(false);
  // Form mode resolution from URL params, in priority order:
  //   1. paramSubjectId set → review-mode (subject is already known).
  //      Forces `state.subject = null` so the describe-section is
  //      hidden — without this, prior describe-mode state persists and
  //      the user could accidentally mint a new subject by editing the
  //      kind/name fields when they came from a "Write a review" CTA
  //      on a known subject.
  //   2. createKind set → describe-mode with that kind (and optional
  //      `?initialName=` pre-fill from the search empty-state CTA).
  //   3. neither → review-only with no subject. Empty form.
  const defaultInitial = React.useMemo(
    () => {
      if (paramSubjectId !== undefined && paramSubjectId.length > 0) {
        return emptyWriteFormState();
      }
      if (createKind !== null) {
        const base = emptyWriteFormStateWithSubject(createKind);
        if (paramInitialName !== undefined && paramInitialName.length > 0 && base.subject) {
          return { ...base, subject: { ...base.subject, name: paramInitialName } };
        }
        return base;
      }
      return emptyWriteFormState();
    },
    [paramSubjectId, createKind, paramInitialName],
  );
  // Title shown in the header — defaults to the subject name when the
  // form was launched from subject detail (?subjectName=...). Without a
  // subject context the screen is "compose a new review" and "New
  // review" is the most honest label.
  const defaultSubjectTitle =
    paramSubjectName !== undefined && paramSubjectName.length > 0
      ? paramSubjectName
      : 'New review';
  const {
    subjectTitle = defaultSubjectTitle,
    initial = defaultInitial,
    editing = undefined,
    isSubmitting = localSubmitting,
    submitError = localError,
    onPublish = async (formState: WriteFormState) => {
      setLocalError(null);
      // Sentiment + confidence are validated non-null by `validateWriteForm`
      // before this callback fires (see `handlePublish` guard below); the
      // non-null assertions are safe under that contract.
      if (formState.sentiment === null || formState.confidence === null) return;

      // Test-publish path: when `EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN`
      // is bundled, mobile bypasses the local outbox + stub-PDS and
      // POSTs directly to AppView's test-inject endpoint. Lets us
      // round-trip create→read→delete end-to-end without standing up
      // PDS auth. Production publish (real Jetstream pipeline) is
      // TN-MOB-022 — distinct from this dev shortcut.
      const node = getBootedNode();
      // Two ways the form has enough context to publish:
      //   A) describe-mode (state.subject set) — user filled the
      //      "What are you reviewing?" fields.
      //   B) review-mode with existing subject — caller deep-linked
      //      with subjectId + the SubjectRef it resolved to (kind,
      //      name, identifier). We reconstruct the same ref so the
      //      AppView resolver hashes back to the SAME subject_id.
      const subjectRef: SubjectRefBody | null =
        formState.subject != null
          ? subjectStateToRef(formState.subject)
          : paramSubjectKind !== null && paramSubjectName !== undefined
            ? buildSubjectRefFromParams(
                paramSubjectKind,
                paramSubjectName,
                paramSubjectIdentifier,
                paramSubjectDid,
              )
            : null;
      const subjectKindForCategory: SubjectKind | null =
        formState.subject?.kind ?? paramSubjectKind ?? null;
      if (
        isTestPublishConfigured() &&
        node !== null &&
        subjectRef !== null &&
        subjectKindForCategory !== null
      ) {
        try {
          setLocalSubmitting(true);
          const rkey = `mob-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          // V2 wire-field extras (TN-V2-MOBILE-WIRE) — useCases,
          // lastUsedMs, reviewerExperience, alternatives, compliance,
          // accessibility, compat, price, availability, schedule.
          // Every field optional; only ones the reviewer populated
          // travel to AppView so the empty-array → NULL collapse on
          // the server stays cheap. The serializer is `null`-safe and
          // returns `{}` for an unfilled form, so a `{ ...record,
          // ...v2Extras }` spread is a no-op when nothing is set.
          const v2Extras = serializeFormToV2Extras(formState);
          await injectAttestation({
            authorDid: node.did,
            rkey,
            cid: `bafyreim${Date.now().toString(36)}`,
            record: {
              subject: subjectRef,
              category: categoryFor(subjectKindForCategory),
              sentiment: formState.sentiment,
              confidence: formState.confidence,
              text: composeText(formState.headline, formState.body),
              tags: formState.body.length > 0 ? [] : undefined,
              createdAt: new Date().toISOString(),
              ...v2Extras,
            },
          });
          if (router.canGoBack()) router.back();
          else router.replace('/trust');
          return;
        } catch (err) {
          setLocalError(
            err instanceof Error
              ? err.message
              : "Couldn't publish to the trust network.",
          );
          return;
        } finally {
          setLocalSubmitting(false);
        }
      }

      // Legacy local-outbox path — kept for the existing review-only
      // flow (subjectId in URL, no subject describe-fields) and as a
      // fallback when test-publish isn't configured.
      const draft: AttestationDraftBody = {
        sentiment: formState.sentiment,
        headline: formState.headline,
        body: formState.body,
        confidence: formState.confidence,
        subjectTitle,
        subjectId: paramSubjectId,
      };
      const result = enqueueLocal(draft, generateClientId());
      if (!result.ok) {
        setLocalError(
          result.reason === 'cap_exceeded'
            ? "Your outbox is full. Dismiss some queued drafts and try again."
            : "Couldn't queue this draft. Please try again.",
        );
        return;
      }
      if (router.canGoBack()) router.back();
      else router.replace('/trust/outbox');
    },
    onCancel = () => {
      if (router.canGoBack()) router.back();
    },
    searchAlternatives,
  } = props;

  // Merge incoming `initial` over an empty form so legacy callers
  // (controlled-mode tests, edit-mode payloads from older runners,
  // any caller pre-V2-fields) that pass a partial WriteFormState
  // shape still work. Defends the validator + render path from
  // `state.priceLow.trim()`-style undefined access without forcing
  // every call site to spread `emptyWriteFormState()` first.
  const [state, setState] = React.useState<WriteFormState>(() => ({
    ...emptyWriteFormState(),
    ...initial,
  }));
  // Reset the form when `defaultInitial` changes — Expo Router does
  // NOT remount the screen when the user navigates to /trust/write
  // again with different `?createKind=…` / `?subjectId=…` params, so
  // a `useState(initial)` left to its own devices keeps the prior
  // form state. Without this effect a user who navigated through
  // describe-mode → subject-detail → Write-a-review-CTA would see the
  // prior describe-mode "What are you reviewing?" section leak in
  // alongside the "About: Tesla Model 3" header. Skip when the caller
  // supplies `initial` explicitly (controlled-mode tests).
  // We track the previous `defaultInitial` reference and only reset
  // when it actually changes — defaultInitial is memoised on the URL
  // params, so a stable nav doesn't trip this.
  const lastInitialRef = React.useRef(defaultInitial);
  React.useEffect(() => {
    if (props.initial !== undefined) return;
    if (lastInitialRef.current === defaultInitial) return;
    lastInitialRef.current = defaultInitial;
    setState(defaultInitial);
    setLocalError(null);
    setShowErrors(false);
  }, [defaultInitial, props.initial]);
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
  // TN-V2-REV-007 — last-used bucket: tap-to-toggle. Tapping the
  // currently-selected bucket clears the field, returning the form
  // to "user did not pick".
  const updateLastUsedBucket = (b: LastUsedBucket): void =>
    setState((prev) => ({
      ...prev,
      lastUsedBucket: prev.lastUsedBucket === b ? null : b,
    }));
  // TN-V2-REV-006 — use-case tags: tap-to-toggle multi-select with
  // cap. The mutator delegates to the pure `toggleUseCase` helper so
  // the cap + closed-vocabulary discipline live in the data layer,
  // not the screen.
  const toggleUseCaseTag = (tag: string, vocabulary: readonly string[]): void =>
    setState((prev) => ({
      ...prev,
      useCases: toggleUseCase(prev.useCases, tag, vocabulary),
    }));
  // TN-V2-REV-008 — alternatives mutators. Cap + dedup discipline
  // lives in the pure helpers; screen just dispatches.
  const addAlternative = (entry: ReviewAlternative): void =>
    setState((prev) => ({
      ...prev,
      alternatives: addReviewAlternative(prev.alternatives, entry),
    }));
  const removeAlternativeAt = (index: number): void =>
    setState((prev) => ({
      ...prev,
      alternatives: removeReviewAlternative(prev.alternatives, index),
    }));

  // ── V2 mutators (TN-V2-MOBILE-WIRE) ─────────────────────────────────────
  // All single-field setters keep the cap + closed-vocab discipline in the
  // pure helpers; the screen just dispatches.
  const updateReviewerExperience = (level: ReviewerExperience): void =>
    setState((prev) => ({
      ...prev,
      // Tap-to-toggle: tapping the active level clears it.
      reviewerExperience: prev.reviewerExperience === level ? null : level,
    }));
  const updatePriceLow = (text: string): void =>
    setState((prev) => ({ ...prev, priceLow: text }));
  const updatePriceHigh = (text: string): void =>
    setState((prev) => ({ ...prev, priceHigh: text }));
  const updatePriceCurrency = (text: string): void =>
    // Uppercase + trim on the way in — matches `normaliseCurrency` so
    // the input visibly reflects what will land on the wire.
    setState((prev) => ({
      ...prev,
      priceCurrency: text.toUpperCase().slice(0, 3),
    }));
  const toggleComplianceTag = (tag: string): void =>
    setState((prev) => ({
      ...prev,
      compliance: toggleTagInVocabulary(prev.compliance, tag, COMPLIANCE_VOCABULARY, MAX_COMPLIANCE),
    }));
  const toggleAccessibilityTag = (tag: string): void =>
    setState((prev) => ({
      ...prev,
      accessibility: toggleTagInVocabulary(
        prev.accessibility,
        tag,
        ACCESSIBILITY_VOCABULARY,
        MAX_ACCESSIBILITY,
      ),
    }));
  const toggleCompatTag = (tag: string): void =>
    setState((prev) => ({
      ...prev,
      compat: toggleTagInVocabulary(prev.compat, tag, COMPAT_VOCABULARY, MAX_COMPAT),
    }));
  const toggleRecommendForTag = (tag: string, vocabulary: readonly string[]): void =>
    setState((prev) => ({
      ...prev,
      recommendFor: toggleTagInVocabulary(
        prev.recommendFor,
        tag,
        vocabulary,
        MAX_RECOMMEND_FOR,
      ),
    }));
  const toggleNotRecommendForTag = (tag: string, vocabulary: readonly string[]): void =>
    setState((prev) => ({
      ...prev,
      notRecommendFor: toggleTagInVocabulary(
        prev.notRecommendFor,
        tag,
        vocabulary,
        MAX_RECOMMEND_FOR,
      ),
    }));
  const addRegion = (raw: string): void =>
    setState((prev) => ({
      ...prev,
      availabilityRegions: addCountryCode(prev.availabilityRegions, raw, MAX_AVAILABILITY_REGIONS),
    }));
  const removeRegionAt = (idx: number): void =>
    setState((prev) => ({
      ...prev,
      availabilityRegions: removeAtIndex(prev.availabilityRegions, idx),
    }));
  const addShipsTo = (raw: string): void =>
    setState((prev) => ({
      ...prev,
      availabilityShipsTo: addCountryCode(prev.availabilityShipsTo, raw, MAX_AVAILABILITY_REGIONS),
    }));
  const removeShipsToAt = (idx: number): void =>
    setState((prev) => ({
      ...prev,
      availabilityShipsTo: removeAtIndex(prev.availabilityShipsTo, idx),
    }));
  const addSoldAt = (raw: string): void =>
    setState((prev) => ({
      ...prev,
      availabilitySoldAt: addHostname(prev.availabilitySoldAt, raw, MAX_AVAILABILITY_SOLD_AT),
    }));
  const removeSoldAtAt = (idx: number): void =>
    setState((prev) => ({
      ...prev,
      availabilitySoldAt: removeAtIndex(prev.availabilitySoldAt, idx),
    }));
  const updateScheduleLeadDays = (text: string): void =>
    // Strip non-digit characters as the user types — keeps the form
    // self-correcting for a numeric field even on platforms where
    // keyboardType='numeric' is advisory.
    setState((prev) => ({
      ...prev,
      scheduleLeadDays: text.replace(/[^\d]/g, ''),
    }));
  const toggleScheduleMonth = (month: number): void =>
    setState((prev) => ({
      ...prev,
      scheduleSeasonal: toggleSeasonalMonth(prev.scheduleSeasonal, month),
    }));

  // Local UI state for the country-code / hostname adders. The chip-
  // list shape needs an in-progress text buffer; rather than promote
  // these into WriteFormState (where they'd serialise into the wire
  // record), keep them as screen-local refs.
  const [regionDraft, setRegionDraft] = React.useState('');
  const [shipsToDraft, setShipsToDraft] = React.useState('');
  const [soldAtDraft, setSoldAtDraft] = React.useState('');
  // Local UI state for the alternative search input.
  const [altQuery, setAltQuery] = React.useState('');
  const [altResults, setAltResults] = React.useState<readonly ReviewAlternative[]>([]);
  const [altSearching, setAltSearching] = React.useState(false);
  const [altSearchError, setAltSearchError] = React.useState<string | null>(null);
  // Stale-response guard: a fast typist can race the search callback.
  // Without this, the LAST-RESOLVED response wins, which on a slow
  // network could leave the user staring at results for an old query.
  // We track the latest query in a ref and discard responses that no
  // longer match. Caller-side debouncing is still recommended but
  // this is the safety net.
  const altQueryRef = React.useRef('');
  const performAltSearch = async (q: string): Promise<void> => {
    const query = q.trim();
    altQueryRef.current = query;
    if (query.length === 0 || searchAlternatives === undefined) {
      setAltResults([]);
      setAltSearchError(null);
      setAltSearching(false);
      return;
    }
    setAltSearching(true);
    setAltSearchError(null);
    try {
      const results = await searchAlternatives(query);
      // Stale-response guard: bail if the query has changed since
      // this request fired. The newer request's resolution will
      // overwrite the visible state.
      if (altQueryRef.current !== query) return;
      setAltResults(results.slice(0, 10));
    } catch (err) {
      if (altQueryRef.current !== query) return; // stale error, discard
      setAltSearchError(
        err instanceof Error ? err.message : 'Search failed. Try again.',
      );
      setAltResults([]);
    } finally {
      if (altQueryRef.current === query) setAltSearching(false);
    }
  };
  // TN-V2-REV-007 — Advanced section open/close state. Local-only;
  // not part of WriteFormState because it's pure UI (does not
  // affect publish payload). Reset on every render of the form (no
  // persistence across navigations) — matches user expectation that
  // collapsed-by-default advanced sections start collapsed.
  const [advancedExpanded, setAdvancedExpanded] = React.useState(false);
  // Subject mutators — only meaningful when `state.subject !== null`
  // (the form is in "describe a new subject" mode).
  const updateSubjectKind = (kind: SubjectKind): void =>
    setState((prev) =>
      prev.subject == null
        ? prev
        : { ...prev, subject: { ...prev.subject, kind } },
    );
  const updateSubjectField = (
    field: 'name' | 'did' | 'uri' | 'identifier',
    value: string,
  ): void =>
    setState((prev) =>
      prev.subject == null
        ? prev
        : { ...prev, subject: { ...prev.subject, [field]: value } },
    );

  const handlePublish = (): void => {
    // Reveal validation errors on every publish attempt (including
    // failed ones). On the first attempt this flips the form from a
    // friendly fresh state into a "show me what's missing" state.
    setShowErrors(true);
    if (!validation.canPublish || isSubmitting) return;
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

      {/* ─── Subject (only when we're creating a new one) ─────────── */}
      {state.subject != null && (
        <View style={styles.field} testID="write-subject-section">
          <Text style={styles.fieldLabel}>What are you reviewing?</Text>
          <View style={styles.kindRow}>
            {SUBJECT_KIND_OPTIONS.map((k) => (
              <Pressable
                key={k}
                onPress={() => !isSubmitting && updateSubjectKind(k)}
                disabled={isSubmitting}
                style={({ pressed }) => [
                  styles.kindBtn,
                  state.subject?.kind === k && styles.kindBtnActive,
                  pressed && !isSubmitting && styles.kindBtnPressed,
                ]}
                testID={`write-subject-kind-${k}`}
                accessibilityRole="button"
                accessibilityLabel={SUBJECT_KIND_LABEL[k]}
                accessibilityState={{ selected: state.subject?.kind === k }}
              >
                <Text
                  style={[
                    styles.kindLabel,
                    state.subject?.kind === k && styles.kindLabelActive,
                  ]}
                >
                  {SUBJECT_KIND_LABEL[k]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.kindHint}>
            {SUBJECT_KIND_HINT[state.subject.kind]}
          </Text>

          {/* Name — required for every kind */}
          <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>Name</Text>
          <TextInput
            value={state.subject.name}
            onChangeText={(t) => updateSubjectField('name', t)}
            editable={!isSubmitting}
            placeholder="What is it called?"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            testID="write-subject-name-input"
          />
          {fieldError(
            validation.errors,
            ['subject_name_required', 'subject_name_too_long'],
            showErrors,
          )}

          {/* DID — for did + organization kinds */}
          {(state.subject.kind === 'did' ||
            state.subject.kind === 'organization') && (
            <>
              <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>
                {state.subject.kind === 'did' ? 'DID' : 'DID (optional)'}
              </Text>
              <TextInput
                value={state.subject.did}
                onChangeText={(t) => updateSubjectField('did', t)}
                editable={!isSubmitting}
                placeholder="did:plc:… or did:web:…"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                testID="write-subject-did-input"
              />
              {fieldError(
                validation.errors,
                ['subject_did_required', 'subject_did_invalid'],
                showErrors,
              )}
            </>
          )}

          {/* URI — for content + dataset kinds */}
          {(state.subject.kind === 'content' ||
            state.subject.kind === 'dataset') && (
            <>
              <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>
                {state.subject.kind === 'content' ? 'URL' : 'Dataset URI'}
              </Text>
              <TextInput
                value={state.subject.uri}
                onChangeText={(t) => updateSubjectField('uri', t)}
                editable={!isSubmitting}
                placeholder={
                  state.subject.kind === 'content'
                    ? 'https://… (article, video, podcast)'
                    : 'https://… or at://…'
                }
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                testID="write-subject-uri-input"
              />
              {fieldError(
                validation.errors,
                ['subject_uri_required', 'subject_uri_invalid'],
                showErrors,
              )}
            </>
          )}

          {/* Identifier — for product / place / claim kinds */}
          {(state.subject.kind === 'product' ||
            state.subject.kind === 'place' ||
            state.subject.kind === 'claim') && (
            <>
              <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>
                Identifier (optional)
              </Text>
              <TextInput
                value={state.subject.identifier}
                onChangeText={(t) => updateSubjectField('identifier', t)}
                editable={!isSubmitting}
                placeholder={
                  state.subject.kind === 'product'
                    ? 'ASIN, ISBN, SKU, model #'
                    : state.subject.kind === 'place'
                      ? 'Address or place ID'
                      : 'Source URL, citation, or claim ID'
                }
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                testID="write-subject-identifier-input"
              />
              {fieldError(
                validation.errors,
                ['subject_identifier_too_long'],
                showErrors,
              )}
            </>
          )}
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
        {fieldError(validation.errors, ['sentiment_required'], showErrors)}
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
        {fieldError(
          validation.errors,
          ['headline_empty', 'headline_too_long'],
          // Length-cap errors should always show — they happen because
          // the user typed too much, so we already know they've
          // touched the field. The "headline_empty" error is gated by
          // showErrors via the `relevant` lookup.
          showErrors || validation.headlineLength > HEADLINE_MAX_LENGTH,
        )}
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
        {fieldError(
          validation.errors,
          ['body_too_long'],
          // Same logic: a length error implies user typed → always show.
          showErrors || validation.bodyLength > BODY_MAX_LENGTH,
        )}
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
        {fieldError(validation.errors, ['confidence_required'], showErrors)}
      </View>

      {/* ─── TN-V2-REV-007: Advanced (collapsed by default) ─────────
          Casual reviewers don't see this. Power users tap "Advanced"
          to surface the last-used picker (and any future advanced
          fields — REV-006 useCase, REV-008 alternatives — will land
          here too). Collapse-by-default keeps the form tidy; the
          toggle is a wide pressable so it's discoverable without
          stealing visual weight from the required fields above. */}
      <Pressable
        onPress={() => !isSubmitting && setAdvancedExpanded((open) => !open)}
        disabled={isSubmitting}
        style={({ pressed }) => [
          styles.advancedToggle,
          pressed && !isSubmitting && styles.advancedTogglePressed,
        ]}
        testID="write-advanced-toggle"
        accessibilityRole="button"
        accessibilityLabel={
          advancedExpanded ? 'Hide advanced fields' : 'Show advanced fields'
        }
        accessibilityState={{ expanded: advancedExpanded, disabled: isSubmitting }}
      >
        <Ionicons
          name={advancedExpanded ? 'chevron-down' : 'chevron-forward'}
          size={14}
          color={colors.textMuted}
        />
        <Text style={styles.advancedToggleLabel}>Advanced</Text>
      </Pressable>
      {advancedExpanded && (
        <View testID="write-advanced-section">
          {/* TN-V2-REV-006 — use-case picker. Per-category
              vocabulary (resolves from `state.subject?.kind`, falling
              back to a generic list for the subjectId-based form
              path). Multi-select capped at MAX_USE_CASES = 3. When at
              the cap, unselected tags grey out so the user
              understands why further taps are no-ops. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>What do you use this for?</Text>
            <Text style={styles.kindHint}>
              Optional — pick up to {MAX_USE_CASES}. Helps other readers
              find reviews from people with the same use-case.
            </Text>
            {(() => {
              // IIFE keeps the vocabulary derivation co-located with
              // the picker JSX without adding a top-level local that
              // re-renders unrelated branches.
              const vocabularyCategory =
                state.subject != null ? categoryFor(state.subject.kind) : null;
              const vocabulary = useCasesForCategory(vocabularyCategory);
              const atCap = state.useCases.length >= MAX_USE_CASES;
              return (
                <View style={styles.useCaseRow} testID="write-use-case-row">
                  {vocabulary.map((tag) => {
                    const selected = state.useCases.includes(tag);
                    const disabled = isSubmitting || (atCap && !selected);
                    return (
                      <Pressable
                        key={tag}
                        onPress={() => !disabled && toggleUseCaseTag(tag, vocabulary)}
                        disabled={disabled}
                        style={({ pressed }) => [
                          styles.useCaseBtn,
                          selected && styles.useCaseBtnActive,
                          disabled && !selected && styles.useCaseBtnDisabled,
                          pressed && !disabled && styles.useCaseBtnPressed,
                        ]}
                        testID={`write-use-case-${tag}`}
                        accessibilityRole="button"
                        accessibilityLabel={USE_CASE_LABEL[tag] ?? tag}
                        accessibilityState={{ selected, disabled }}
                      >
                        <Text
                          style={[
                            styles.useCaseLabel,
                            selected && styles.useCaseLabelActive,
                            disabled && !selected && styles.useCaseLabelDisabled,
                          ]}
                        >
                          {USE_CASE_LABEL[tag] ?? tag}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              );
            })()}
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Last used</Text>
            <Text style={styles.kindHint}>
              When did you last interact with this? Optional — helps readers
              judge how fresh your review still is.
            </Text>
            <View style={styles.lastUsedRow}>
              {LAST_USED_BUCKETS.map((bucket) => (
                <Pressable
                  key={bucket}
                  onPress={() => !isSubmitting && updateLastUsedBucket(bucket)}
                  disabled={isSubmitting}
                  style={({ pressed }) => [
                    styles.lastUsedBtn,
                    state.lastUsedBucket === bucket && styles.lastUsedBtnActive,
                    pressed && !isSubmitting && styles.lastUsedBtnPressed,
                  ]}
                  testID={`write-last-used-${bucket}`}
                  accessibilityRole="button"
                  accessibilityLabel={LAST_USED_BUCKET_LABEL[bucket]}
                  accessibilityState={{
                    selected: state.lastUsedBucket === bucket,
                    disabled: isSubmitting,
                  }}
                >
                  <Text
                    style={[
                      styles.lastUsedLabel,
                      state.lastUsedBucket === bucket && styles.lastUsedLabelActive,
                    ]}
                  >
                    {LAST_USED_BUCKET_LABEL[bucket]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          {/* TN-V2-REV-008 — alternatives picker. The reviewer can
              add up to MAX_REVIEW_ALTERNATIVES = 5 "I also tried"
              entries via search. Renders three layers:
                1. Currently-added chips (each with a remove X).
                2. Search input (debounced search via the
                   `searchAlternatives` callback prop).
                3. Search results (compact rows; tap to add).
              When the search prop is omitted (e.g. tests not wiring
              a search runner) the input + results stay silent. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Other things you tried</Text>
            <Text style={styles.kindHint}>
              Optional — add up to {MAX_REVIEW_ALTERNATIVES} subjects you
              also considered. Helps readers compare.
            </Text>
            {state.alternatives.length > 0 && (
              <View style={styles.altChipRow} testID="write-alt-chips">
                {state.alternatives.map((alt, idx) => (
                  <View
                    key={`${alt.kind}:${alt.subjectId ?? alt.name}`}
                    style={styles.altChip}
                    testID={`write-alt-chip-${idx}`}
                  >
                    <Text style={styles.altChipLabel} numberOfLines={1}>
                      {alt.name}
                    </Text>
                    <Pressable
                      onPress={() => !isSubmitting && removeAlternativeAt(idx)}
                      disabled={isSubmitting}
                      style={styles.altChipRemove}
                      testID={`write-alt-remove-${idx}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${alt.name}`}
                    >
                      <Ionicons name="close" size={14} color={colors.textMuted} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
            {state.alternatives.length < MAX_REVIEW_ALTERNATIVES && (
              <View style={styles.altSearchBlock}>
                <TextInput
                  style={styles.altSearchInput}
                  placeholder="Search…"
                  placeholderTextColor={colors.textMuted}
                  value={altQuery}
                  onChangeText={(text) => {
                    setAltQuery(text);
                    void performAltSearch(text);
                  }}
                  editable={!isSubmitting}
                  testID="write-alt-search-input"
                  accessibilityLabel="Search for alternatives"
                />
                {altSearching && (
                  <View style={styles.altSearchHint} testID="write-alt-search-loading">
                    <ActivityIndicator size="small" color={colors.textMuted} />
                    <Text style={styles.altSearchHintText}>Searching…</Text>
                  </View>
                )}
                {altSearchError !== null && (
                  <Text style={styles.altSearchError} testID="write-alt-search-error">
                    {altSearchError}
                  </Text>
                )}
                {altResults.length > 0 && (
                  <View style={styles.altResultsList} testID="write-alt-results">
                    {altResults.map((alt) => {
                      // Disable rows already in the alternatives list
                      // (avoids duplicate-add taps that would no-op).
                      const alreadyAdded = state.alternatives.some((a) =>
                        a.subjectId !== undefined && alt.subjectId !== undefined
                          ? a.subjectId === alt.subjectId
                          : a.kind === alt.kind &&
                            a.name.trim().toLowerCase() === alt.name.trim().toLowerCase(),
                      );
                      const rowKey = `${alt.kind}:${alt.subjectId ?? alt.name}`;
                      return (
                        <Pressable
                          key={rowKey}
                          onPress={() => {
                            if (isSubmitting || alreadyAdded) return;
                            addAlternative(alt);
                            setAltQuery('');
                            setAltResults([]);
                          }}
                          disabled={isSubmitting || alreadyAdded}
                          style={({ pressed }) => [
                            styles.altResultRow,
                            alreadyAdded && styles.altResultRowDisabled,
                            pressed && !alreadyAdded && styles.altResultRowPressed,
                          ]}
                          testID={`write-alt-result-${alt.subjectId ?? alt.name}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Add ${alt.name}`}
                          accessibilityState={{ disabled: alreadyAdded }}
                        >
                          <Text style={styles.altResultName} numberOfLines={1}>
                            {alt.name}
                          </Text>
                          {alreadyAdded && (
                            <Text style={styles.altResultMeta}>Added</Text>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            )}
            {state.alternatives.length >= MAX_REVIEW_ALTERNATIVES && (
              <Text style={styles.altCapHint} testID="write-alt-cap-hint">
                Up to {MAX_REVIEW_ALTERNATIVES}. Remove one to add another.
              </Text>
            )}
          </View>

          {/* TN-V2-REV-002 — reviewer experience tier. Single-pick
              chip row (tap-to-toggle: tapping the active level
              clears it). Surfaces the same way sentiment + confidence
              do — pill row above. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>How experienced are you with this?</Text>
            <Text style={styles.kindHint}>
              Optional — readers can prefer reviews from your tier when
              filtering.
            </Text>
            <View style={styles.lastUsedRow} testID="write-experience-row">
              {REVIEWER_EXPERIENCE_OPTIONS.map((level) => {
                const selected = state.reviewerExperience === level;
                return (
                  <Pressable
                    key={level}
                    onPress={() => !isSubmitting && updateReviewerExperience(level)}
                    disabled={isSubmitting}
                    style={({ pressed }) => [
                      styles.lastUsedBtn,
                      selected && styles.lastUsedBtnActive,
                      pressed && !isSubmitting && styles.lastUsedBtnPressed,
                    ]}
                    testID={`write-experience-${level}`}
                    accessibilityRole="button"
                    accessibilityLabel={REVIEWER_EXPERIENCE_LABEL[level]}
                    accessibilityHint={REVIEWER_EXPERIENCE_HINT[level]}
                    accessibilityState={{ selected, disabled: isSubmitting }}
                  >
                    <Text
                      style={[
                        styles.lastUsedLabel,
                        selected && styles.lastUsedLabelActive,
                      ]}
                    >
                      {REVIEWER_EXPERIENCE_LABEL[level]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* TN-V2-META-002 — price. Three text inputs: low, optional
              high (range), and currency. When low is empty the entire
              price block is unset → wire record omits `price`. When
              low is set + high is empty, point price (low_e7 ==
              high_e7). When both set, range. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Price</Text>
            <Text style={styles.kindHint}>
              Optional — what you paid (or saw advertised). Helps power
              price-range filtering.
            </Text>
            <View style={styles.priceRow}>
              <TextInput
                style={styles.priceInput}
                placeholder="29.99"
                placeholderTextColor={colors.textMuted}
                value={state.priceLow}
                onChangeText={updatePriceLow}
                editable={!isSubmitting}
                keyboardType="decimal-pad"
                testID="write-price-low"
                accessibilityLabel="Lower price"
              />
              <Text style={styles.priceSeparator}>to</Text>
              <TextInput
                style={styles.priceInput}
                placeholder="(optional)"
                placeholderTextColor={colors.textMuted}
                value={state.priceHigh}
                onChangeText={updatePriceHigh}
                editable={!isSubmitting}
                keyboardType="decimal-pad"
                testID="write-price-high"
                accessibilityLabel="Upper price (optional)"
              />
              <TextInput
                style={styles.priceCurrencyInput}
                placeholder="USD"
                placeholderTextColor={colors.textMuted}
                value={state.priceCurrency}
                onChangeText={updatePriceCurrency}
                editable={!isSubmitting}
                autoCapitalize="characters"
                maxLength={3}
                testID="write-price-currency"
                accessibilityLabel="Currency code"
              />
            </View>
            {showErrors &&
              fieldError(validation.errors, [
                'price_low_invalid',
                'price_high_invalid',
                'price_high_below_low',
                'price_currency_invalid',
              ])}
          </View>

          {/* TN-V2-META-005 — compliance. Closed-vocab chip grid.
              Same UX shape as REV-006 useCases (per-cap grey-out for
              over-cap unselected entries). */}
          {renderTagGrid({
            label: 'Compliance',
            hint: `Optional — pick up to ${MAX_COMPLIANCE} that apply (halal, vegan, gluten-free, …).`,
            vocabulary: COMPLIANCE_VOCABULARY,
            labelMap: COMPLIANCE_LABEL,
            selected: state.compliance,
            cap: MAX_COMPLIANCE,
            disabled: isSubmitting,
            onToggle: toggleComplianceTag,
            testIDPrefix: 'write-compliance',
          })}

          {/* TN-V2-META-006 — accessibility. */}
          {renderTagGrid({
            label: 'Accessibility',
            hint: `Optional — pick up to ${MAX_ACCESSIBILITY} (wheelchair, captions, screen-reader, …).`,
            vocabulary: ACCESSIBILITY_VOCABULARY,
            labelMap: ACCESSIBILITY_LABEL,
            selected: state.accessibility,
            cap: MAX_ACCESSIBILITY,
            disabled: isSubmitting,
            onToggle: toggleAccessibilityTag,
            testIDPrefix: 'write-accessibility',
          })}

          {/* TN-V2-META-003 — compatibility. Cap 15 (devices stack
              compat surfaces). */}
          {renderTagGrid({
            label: 'Compatibility',
            hint: `Optional — pick up to ${MAX_COMPAT} (iOS, USB-C, Bluetooth 5, …).`,
            vocabulary: COMPAT_VOCABULARY,
            labelMap: COMPAT_LABEL,
            selected: state.compat,
            cap: MAX_COMPAT,
            disabled: isSubmitting,
            onToggle: toggleCompatTag,
            testIDPrefix: 'write-compat',
          })}

          {/* TN-V2-REV-004 — recommendFor / notRecommendFor. Same
              vocabulary as useCases (per-category). Two parallel
              chip grids; cap 5 each. */}
          {(() => {
            const vocabularyCategory =
              state.subject != null ? categoryFor(state.subject.kind) : null;
            const vocabulary = useCasesForCategory(vocabularyCategory);
            return (
              <>
                {renderTagGrid({
                  label: 'Recommend for',
                  hint: `Optional — up to ${MAX_RECOMMEND_FOR} use-cases you endorse.`,
                  vocabulary,
                  labelMap: USE_CASE_LABEL,
                  selected: state.recommendFor,
                  cap: MAX_RECOMMEND_FOR,
                  disabled: isSubmitting,
                  onToggle: (tag) => toggleRecommendForTag(tag, vocabulary),
                  testIDPrefix: 'write-recommend-for',
                })}
                {renderTagGrid({
                  label: 'Not recommended for',
                  hint: `Optional — up to ${MAX_RECOMMEND_FOR} use-cases you'd warn against.`,
                  vocabulary,
                  labelMap: USE_CASE_LABEL,
                  selected: state.notRecommendFor,
                  cap: MAX_RECOMMEND_FOR,
                  disabled: isSubmitting,
                  onToggle: (tag) => toggleNotRecommendForTag(tag, vocabulary),
                  testIDPrefix: 'write-not-recommend-for',
                })}
              </>
            );
          })()}

          {/* TN-V2-META-001 — availability. Three chip-lists: regions
              (alpha-2 country codes), shipsTo (alpha-2), soldAt
              (hostnames). Each has its own text-input adder with the
              shape gate built into the helper (`addCountryCode` +
              `addHostname`); invalid entries silently drop so the
              user gets immediate feedback by seeing nothing get
              added. */}
          {renderChipListAdder({
            label: 'Available in (countries)',
            hint: `Optional — ISO codes (US, GB, DE, …). Up to ${MAX_AVAILABILITY_REGIONS}.`,
            placeholder: 'US',
            entries: state.availabilityRegions,
            cap: MAX_AVAILABILITY_REGIONS,
            disabled: isSubmitting,
            draft: regionDraft,
            setDraft: setRegionDraft,
            onAdd: (raw) => {
              addRegion(raw);
            },
            onRemoveAt: removeRegionAt,
            testIDPrefix: 'write-region',
            inputProps: { autoCapitalize: 'characters', maxLength: 2 },
          })}
          {renderChipListAdder({
            label: 'Ships to (countries)',
            hint: `Optional — ISO codes the seller ships to.`,
            placeholder: 'US',
            entries: state.availabilityShipsTo,
            cap: MAX_AVAILABILITY_REGIONS,
            disabled: isSubmitting,
            draft: shipsToDraft,
            setDraft: setShipsToDraft,
            onAdd: (raw) => {
              addShipsTo(raw);
            },
            onRemoveAt: removeShipsToAt,
            testIDPrefix: 'write-shipsto',
            inputProps: { autoCapitalize: 'characters', maxLength: 2 },
          })}
          {renderChipListAdder({
            label: 'Sold at (retailers)',
            hint: `Optional — hostnames (amazon.com, walmart.com, …). Up to ${MAX_AVAILABILITY_SOLD_AT}.`,
            placeholder: 'amazon.com',
            entries: state.availabilitySoldAt,
            cap: MAX_AVAILABILITY_SOLD_AT,
            disabled: isSubmitting,
            draft: soldAtDraft,
            setDraft: setSoldAtDraft,
            onAdd: (raw) => {
              addSoldAt(raw);
            },
            onRemoveAt: removeSoldAtAt,
            testIDPrefix: 'write-soldat',
            inputProps: { autoCapitalize: 'none' },
          })}

          {/* TN-V2-META-004 — schedule (lead days + seasonal months).
              Per-day open/close hours intentionally omitted — META-010
              JSON-LD parser auto-fills hours server-side; a per-day
              picker would be a much heavier UX commitment. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Booking lead time</Text>
            <Text style={styles.kindHint}>
              Optional — days of advance booking required (0 for walk-ins,
              14 for a doctor, 365 for a wedding venue).
            </Text>
            <TextInput
              style={styles.priceCurrencyInput}
              placeholder="0"
              placeholderTextColor={colors.textMuted}
              value={state.scheduleLeadDays}
              onChangeText={updateScheduleLeadDays}
              editable={!isSubmitting}
              keyboardType="number-pad"
              maxLength={3}
              testID="write-lead-days"
              accessibilityLabel="Booking lead time in days"
            />
            {showErrors &&
              fieldError(validation.errors, ['schedule_lead_days_invalid'])}
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Seasonal months</Text>
            <Text style={styles.kindHint}>
              Optional — months the venue operates. Leave empty for
              year-round.
            </Text>
            <View style={styles.useCaseRow} testID="write-seasonal-row">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
                const selected = state.scheduleSeasonal.includes(month);
                return (
                  <Pressable
                    key={month}
                    onPress={() => !isSubmitting && toggleScheduleMonth(month)}
                    disabled={isSubmitting}
                    style={({ pressed }) => [
                      styles.useCaseBtn,
                      selected && styles.useCaseBtnActive,
                      pressed && !isSubmitting && styles.useCaseBtnPressed,
                    ]}
                    testID={`write-seasonal-${month}`}
                    accessibilityRole="button"
                    accessibilityLabel={SEASONAL_MONTH_LABEL[month]}
                    accessibilityState={{
                      selected,
                      disabled: isSubmitting,
                    }}
                  >
                    <Text
                      style={[
                        styles.useCaseLabel,
                        selected && styles.useCaseLabelActive,
                      ]}
                    >
                      {SEASONAL_MONTH_LABEL[month]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      )}

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
  allErrors: readonly WriteFormError[],
  watch: readonly WriteFormError[],
  show = true,
): React.ReactElement | null {
  if (!show) return null;
  const relevant = allErrors.find((e) => watch.includes(e));
  if (!relevant) return null;
  return (
    <Text style={styles.fieldError} testID={`write-error-${relevant}`}>
      {describeWriteFormError(relevant)}
    </Text>
  );
}

/**
 * Closed-vocab tag grid renderer (TN-V2-META-005/006/003 + REV-004).
 * Each tag is a Pressable; selected tags get the active style; over-cap
 * unselected tags grey out so the user sees why further taps are no-ops.
 *
 * Mirrors the REV-006 useCases picker UX so the Advanced section stays
 * visually coherent across all six closed-vocab fields.
 */
function renderTagGrid(props: {
  label: string;
  hint: string;
  vocabulary: readonly string[];
  labelMap: Readonly<Record<string, string>>;
  selected: readonly string[];
  cap: number;
  disabled: boolean;
  onToggle: (tag: string) => void;
  testIDPrefix: string;
}): React.ReactElement {
  const atCap = props.selected.length >= props.cap;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <Text style={styles.kindHint}>{props.hint}</Text>
      <View style={styles.useCaseRow} testID={`${props.testIDPrefix}-row`}>
        {props.vocabulary.map((tag) => {
          const selected = props.selected.includes(tag);
          const disabled = props.disabled || (atCap && !selected);
          return (
            <Pressable
              key={tag}
              onPress={() => !disabled && props.onToggle(tag)}
              disabled={disabled}
              style={({ pressed }) => [
                styles.useCaseBtn,
                selected && styles.useCaseBtnActive,
                disabled && !selected && styles.useCaseBtnDisabled,
                pressed && !disabled && styles.useCaseBtnPressed,
              ]}
              testID={`${props.testIDPrefix}-${tag}`}
              accessibilityRole="button"
              accessibilityLabel={props.labelMap[tag] ?? tag}
              accessibilityState={{ selected, disabled }}
            >
              <Text
                style={[
                  styles.useCaseLabel,
                  selected && styles.useCaseLabelActive,
                  disabled && !selected && styles.useCaseLabelDisabled,
                ]}
              >
                {props.labelMap[tag] ?? tag}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Free-form chip-list adder (TN-V2-META-001 availability fields). One
 * text input + an Add button + the chip list. Invalid entries silently
 * drop (the helper validates shape) — the user notices because no chip
 * appears, which is gentler than a popup error for short shape-rules.
 */
function renderChipListAdder(props: {
  label: string;
  hint: string;
  placeholder: string;
  entries: readonly string[];
  cap: number;
  disabled: boolean;
  draft: string;
  setDraft: (text: string) => void;
  onAdd: (raw: string) => void;
  onRemoveAt: (idx: number) => void;
  testIDPrefix: string;
  inputProps?: { autoCapitalize?: 'none' | 'characters'; maxLength?: number };
}): React.ReactElement {
  const atCap = props.entries.length >= props.cap;
  const submit = (): void => {
    if (props.draft.trim().length === 0) return;
    props.onAdd(props.draft);
    props.setDraft('');
  };
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <Text style={styles.kindHint}>{props.hint}</Text>
      {props.entries.length > 0 && (
        <View style={styles.altChipRow} testID={`${props.testIDPrefix}-chips`}>
          {props.entries.map((entry, idx) => (
            <View
              key={`${entry}-${idx}`}
              style={styles.altChip}
              testID={`${props.testIDPrefix}-chip-${idx}`}
            >
              <Text style={styles.altChipLabel} numberOfLines={1}>
                {entry}
              </Text>
              <Pressable
                onPress={() => !props.disabled && props.onRemoveAt(idx)}
                disabled={props.disabled}
                style={styles.altChipRemove}
                testID={`${props.testIDPrefix}-remove-${idx}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${entry}`}
              >
                <Ionicons name="close" size={14} color={colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {!atCap && (
        <View style={styles.chipAdderRow}>
          <TextInput
            style={[styles.altSearchInput, styles.chipAdderInput]}
            placeholder={props.placeholder}
            placeholderTextColor={colors.textMuted}
            value={props.draft}
            onChangeText={props.setDraft}
            onSubmitEditing={submit}
            editable={!props.disabled}
            autoCapitalize={props.inputProps?.autoCapitalize ?? 'none'}
            maxLength={props.inputProps?.maxLength}
            testID={`${props.testIDPrefix}-input`}
            accessibilityLabel={props.label}
          />
          <Pressable
            onPress={submit}
            disabled={props.disabled || props.draft.trim().length === 0}
            style={({ pressed }) => [
              styles.chipAddBtn,
              (props.disabled || props.draft.trim().length === 0) &&
                styles.chipAddBtnDisabled,
              pressed &&
                !props.disabled &&
                props.draft.trim().length > 0 &&
                styles.chipAddBtnPressed,
            ]}
            testID={`${props.testIDPrefix}-add`}
            accessibilityRole="button"
            accessibilityLabel={`Add ${props.label}`}
          >
            <Ionicons name="add" size={16} color={colors.bgSecondary} />
          </Pressable>
        </View>
      )}
      {atCap && (
        <Text style={styles.altCapHint} testID={`${props.testIDPrefix}-cap`}>
          Up to {props.cap}. Remove one to add another.
        </Text>
      )}
    </View>
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
  kindRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  kindBtn: {
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: 36,
    justifyContent: 'center',
  },
  kindBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  kindBtnPressed: { backgroundColor: colors.bgTertiary },
  kindLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  kindLabelActive: { color: colors.bgSecondary },
  kindHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
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
  // TN-V2-REV-007 — collapsible "Advanced" toggle. Sits below
  // Confidence; styled small + muted so casual reviewers' eyes pass
  // over it. The chevron flips with `expanded` state for an
  // affordance cue.
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  advancedTogglePressed: { opacity: 0.6 },
  advancedToggleLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textMuted,
  },
  // TN-V2-REV-007 — last-used picker. Pill-row layout matches the
  // confidence picker but at slightly smaller scale to read as
  // optional (the required fields above stay visually dominant).
  lastUsedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  lastUsedBtn: {
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
  },
  lastUsedBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  lastUsedBtnPressed: { backgroundColor: colors.bgTertiary },
  lastUsedLabel: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
  },
  lastUsedLabelActive: { color: colors.bgSecondary },
  // TN-V2-REV-006 — use-case picker. Same pill-row aesthetic as the
  // last-used row, but the disabled-when-at-cap state visually greys
  // out unselected pills so the user understands why further taps
  // don't add a fourth tag.
  useCaseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  useCaseBtn: {
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
  },
  useCaseBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  useCaseBtnDisabled: { opacity: 0.4 },
  useCaseBtnPressed: { backgroundColor: colors.bgTertiary },
  useCaseLabel: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
  },
  useCaseLabelActive: { color: colors.bgSecondary },
  useCaseLabelDisabled: { color: colors.textMuted },
  // TN-V2-REV-008 — alternatives picker layout.
  altChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  altChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgTertiary,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: 4,
    borderRadius: radius.full,
    maxWidth: '100%',
  },
  altChipLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  altChipRemove: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  altSearchBlock: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  altSearchInput: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
  },
  altSearchHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  altSearchHintText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  altSearchError: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.error,
    paddingHorizontal: spacing.xs,
  },
  altResultsList: {
    gap: 4,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
  },
  altResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 36,
  },
  altResultRowPressed: { backgroundColor: colors.bgTertiary },
  altResultRowDisabled: { opacity: 0.5 },
  altResultName: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  altResultMeta: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
  },
  altCapHint: {
    marginTop: spacing.sm,
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  // ── V2 styles (TN-V2-MOBILE-WIRE) ──────────────────────────────────────
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  priceInput: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
  },
  priceCurrencyInput: {
    width: 72,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  priceSeparator: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  chipAdderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chipAdderInput: {
    flex: 1,
  },
  chipAddBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 44,
  },
  chipAddBtnDisabled: { backgroundColor: colors.textMuted },
  chipAddBtnPressed: { backgroundColor: colors.accentHover },
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
