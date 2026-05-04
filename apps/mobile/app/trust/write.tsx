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
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
} from 'react-native';

import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { colors, fonts, spacing, radius } from '../../src/theme';
import {
  injectAttestation,
  isTestPublishConfigured,
  type SubjectRefBody,
} from '../../src/trust/appview_runtime';
import { SubjectAnchorView } from '../../src/trust/components/subject_anchor_view';
import { useComposeContext } from '../../src/trust/runners/use_compose_context';
import { listPersonas, isPersonaOpen } from '@dina/core';
import { deriveEditWarning, type EditWarning } from '../../src/trust/edit_flow';
import { findMessageByDraftId, readLifecycle } from '@dina/brain/chat';
import { setReviewDraftStatus } from '../../src/trust/review_draft';
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
  addReviewAlternative,
  removeReviewAlternative,
  toggleUseCase,
  toggleTagInVocabulary,
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
  /**
   * Compose-context (Dina prefill) gate. Defaults to `true` in
   * production. Tests pass `false` to keep the screen pure (no vault
   * read, no inferred prefill). The runner's own `enabled` flag
   * mirrors this — see `useComposeContext`.
   */
  composeContextEnabled?: boolean;
  /**
   * Test-only LLM injection. Production omits this and the runner
   * resolves the user's BYOK provider on its own. Tests pass a stub
   * `LLMProvider` (or `null` to simulate "no provider configured")
   * so the prefill path can be exercised without the keychain.
   */
  composeLLMProvider?: import('@dina/brain/llm').LLMProvider | null;
  /**
   * Test-only override for the persona list the prefill runner
   * searches. Production reads from `listPersonas()` + `isPersonaOpen`
   * (every currently-open persona). Tests pass a fixed list because
   * the persona service in jsdom returns empty (no Core boot).
   */
  composePersonas?: readonly string[];
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
    /**
     * Edit-mode params (TN-MOB-013 follow-up). When `editingUri` is
     * present the screen flips into edit mode: header copy switches
     * to "Edit review", the publish CTA reads "Publish edit", and
     * the cosignature-release warning surfaces if `editingCosigCount`
     * is > 0. Pre-fill params (sentiment, headline, body, confidence)
     * are picked up by `defaultInitial` below — none are required;
     * any missing field falls back to its empty/null default.
     */
    editingUri?: string | string[];
    editingCosigCount?: string | string[];
    editingSentiment?: string | string[];
    editingConfidence?: string | string[];
    editingHeadline?: string | string[];
    editingBody?: string | string[];
    /**
     * Chat-driven review-draft handoff. When the user taps
     * "Edit in form" on an `InlineReviewDraftCard`, the card pushes
     * `/trust/write?draftId=…&threadId=…` so the form can pull the
     * lifecycle from the brain thread store and seed every field
     * (sentiment, headline, body, plus any V2 extras the LLM drafted).
     * Without this, the form opened blank and the user lost the
     * card's progress (the bug this branch was added for).
     */
    draftId?: string | string[];
    threadId?: string | string[];
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
  // Edit-mode params. `editingUri` is the gate — without it none of
  // the other edit fields apply.
  const paramEditingUri = readParam(params.editingUri);
  const paramEditingCosigCountRaw = readParam(params.editingCosigCount);
  const paramEditingSentimentRaw = readParam(params.editingSentiment);
  const paramEditingConfidenceRaw = readParam(params.editingConfidence);
  const paramEditingHeadline = readParam(params.editingHeadline);
  const paramEditingBody = readParam(params.editingBody);
  const paramEditingSentiment: Sentiment | null =
    paramEditingSentimentRaw === 'positive' ||
    paramEditingSentimentRaw === 'neutral' ||
    paramEditingSentimentRaw === 'negative'
      ? paramEditingSentimentRaw
      : null;
  const paramEditingConfidence: Confidence | null =
    paramEditingConfidenceRaw === 'certain' ||
    paramEditingConfidenceRaw === 'high' ||
    paramEditingConfidenceRaw === 'moderate' ||
    paramEditingConfidenceRaw === 'speculative'
      ? paramEditingConfidenceRaw
      : null;
  // Cosig count parses leniently — anything non-numeric falls back to
  // 0, which suppresses the warning. Better to under-warn than crash
  // on a bad URL.
  const paramEditingCosigCount: number = (() => {
    if (paramEditingCosigCountRaw === undefined) return 0;
    const n = Number.parseInt(paramEditingCosigCountRaw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();
  const paramDraftId = readParam(params.draftId);
  const paramThreadId = readParam(params.threadId);
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
      // Chat-draft handoff wins over everything: the user typed
      // "/ask write a review of <X>", got an inline draft card with
      // LLM-drafted fields, then tapped "Edit in form". Pull the
      // lifecycle's `values` blob and use it verbatim — sentiment,
      // headline, body, AND any V2 extras (use_cases, last_used,
      // etc.) the inferer drafted. Falls through to the next branch
      // when the draft isn't found (stale link, app restart, thread
      // reset) so the form still opens, just blank.
      if (
        paramDraftId !== undefined &&
        paramDraftId.length > 0 &&
        paramThreadId !== undefined &&
        paramThreadId.length > 0
      ) {
        const msg = findMessageByDraftId(paramThreadId, paramDraftId);
        if (msg !== null) {
          const lc = readLifecycle(msg);
          if (lc !== null && lc.kind === 'review_draft' && lc.values !== null) {
            const draftValues = lc.values as Partial<WriteFormState>;
            return {
              ...emptyWriteFormState(),
              ...draftValues,
            };
          }
        }
      }
      // Edit mode wins over both review-mode and create-mode: when
      // we have a record to edit, every other URL-driven branch is
      // background context, and the form should land pre-filled
      // from the existing record. The user is editing a review
      // OF a known subject, so describe-mode never applies.
      if (paramEditingUri !== undefined && paramEditingUri.length > 0) {
        return {
          ...emptyWriteFormState(),
          sentiment: paramEditingSentiment,
          confidence: paramEditingConfidence,
          headline: paramEditingHeadline ?? '',
          body: paramEditingBody ?? '',
        };
      }
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
    [
      paramSubjectId,
      createKind,
      paramInitialName,
      paramEditingUri,
      paramEditingSentiment,
      paramEditingConfidence,
      paramEditingHeadline,
      paramEditingBody,
      paramDraftId,
      paramThreadId,
    ],
  );
  // Edit context is derived from the same params. Memoised so the
  // useFocusEffect dep array stays stable across renders that don't
  // change the editing record.
  const defaultEditing = React.useMemo<WriteScreenEditContext | undefined>(
    () => {
      if (paramEditingUri === undefined || paramEditingUri.length === 0) {
        return undefined;
      }
      return {
        originalUri: paramEditingUri,
        cosigCount: paramEditingCosigCount,
      };
    },
    [paramEditingUri, paramEditingCosigCount],
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
    editing = defaultEditing,
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
          const cidPlaceholder = `bafyreim${Date.now().toString(36)}`;
          const result = await injectAttestation({
            authorDid: node.did,
            rkey,
            cid: cidPlaceholder,
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
          // Chat-draft handoff: if the form was opened from an inline
          // draft card, flip its lifecycle to `published` so the card
          // collapses to the receipt instead of leaving a stale
          // editable card in the chat thread. Also redirect the user
          // back to chat (the place they came from) instead of
          // popping into trust home — the form was pushed onto the
          // trust stack from a different tab, so plain back() ends
          // up at trust home.
          if (
            paramDraftId !== undefined &&
            paramDraftId.length > 0 &&
            paramThreadId !== undefined &&
            paramThreadId.length > 0
          ) {
            setReviewDraftStatus(paramThreadId, paramDraftId, 'published', {
              attestation: { uri: result.uri, cid: result.cid },
              values: formState,
              content: `Published your review of ${formState.subject?.name ?? subjectTitle}.`,
            });
            router.replace('/');
            return;
          }
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
      // Chat-draft handoff: the form was pushed inside the trust
      // stack but the user came from the chat tab. A plain
      // `router.back()` pops to trust home — wrong destination. Send
      // them home to chat where their draft card still lives.
      if (
        paramDraftId !== undefined &&
        paramDraftId.length > 0 &&
        paramThreadId !== undefined &&
        paramThreadId.length > 0
      ) {
        router.replace('/');
        return;
      }
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
  // Reset on screen focus — Expo Router caches mounted screens so a
  // user who navigates away mid-compose (back to Trust, then "Write a
  // review" again) would otherwise see their stale draft. The reset
  // mirrors the user's expectation that landing on /trust/write is a
  // *fresh* form. Skipped in edit mode (`editing` set) — that path
  // intentionally seeds the form from the existing record. Skipped in
  // controlled-mode (test-supplied `initial`) so render tests stay
  // deterministic. Tracked via a ref so the FIRST focus (mount) is a
  // no-op — the initial useState already handles that.
  const hasFocusedOnceRef = React.useRef(false);
  useFocusEffect(
    React.useCallback(() => {
      if (props.initial !== undefined || editing !== undefined) return;
      if (!hasFocusedOnceRef.current) {
        hasFocusedOnceRef.current = true;
        return;
      }
      setState(defaultInitial);
      setLocalError(null);
      setShowErrors(false);
    }, [defaultInitial, props.initial, editing]),
  );

  // Stack header title flips between "Write a review" and "Edit
  // review". `<Stack.Screen>` is rendered inline so it overrides the
  // layout's static `options={{ title: 'Write a review' }}` reactively
  // — `useNavigation().setOptions()` doesn't reliably win against
  // a layout-defined option (the layout re-applies on focus, racing
  // with the route's effect). The inline JSX form is the canonical
  // expo-router pattern for runtime header overrides.
  const headerTitle = editing ? 'Edit review' : 'Write a review'
  const validation = React.useMemo(() => validateWriteForm(state), [state]);
  const editWarning = React.useMemo<EditWarning | null>(
    () => (editing ? deriveEditWarning(editing.cosigCount) : null),
    [editing],
  );

  // ── Compose-context: Dina pre-fills advanced fields from vault ─────────
  // Heuristic-on-mobile inferer over the keystore-resident vault.
  // Loyalty Law-clean — no network, no leak. The runner reads vault
  // items relevant to the subject, scans for use-case vocabulary
  // tokens + computes the freshest-item recency bucket. When the
  // brain-server's LLM wiring matures, this hook gets swapped for an
  // HTTP call to /api/v1/compose/context — same return shape.
  //
  // `prefilledFields` tracks which advanced fields hold Dina's
  // suggestion (vs the user's typed value). Mutators clear the entry
  // for their field on user touch — ✨ chip marker disappears as soon
  // as the user takes ownership of the value.
  //
  // Persona is hardcoded to 'general' for V1 — mobile doesn't yet
  // surface an "active persona" selector for the trust write surface.
  // When that lands, thread the active persona through here.
  // Subject name source priority for compose-context:
  //   1. URL param (deep-linked from subject detail / reviewer screen)
  //   2. Form-state subject (user typed in describe-mode)
  //   3. `subjectTitle` prop, ONLY when not the default `'New review'`
  //      string (which means "compose without subject context" — no
  //      meaningful vault search target).
  const composeSubjectName =
    paramSubjectName !== undefined && paramSubjectName.length > 0
      ? paramSubjectName
      : state.subject?.name ??
        (props.subjectTitle !== undefined && props.subjectTitle !== 'New review'
          ? props.subjectTitle
          : null);
  const composeCategory =
    paramSubjectKind !== null
      ? categoryFor(paramSubjectKind)
      : state.subject?.kind != null
        ? categoryFor(state.subject.kind)
        : null;
  // Enumerate every currently-open persona for the prefill search.
  // Inside the mobile app the user IS the principal, so Dina is
  // entitled to read across whatever compartments the user has
  // unlocked (closed compartments stay sealed by the absent DEK —
  // the persona wall is enforced cryptographically, not by this
  // list). The closed-vocab inferer + visible ✨ markers + explicit
  // Publish step keep the user in control of what reaches the wire.
  // Memoised on the unlock-revision so the runner's stable-key dep
  // doesn't churn every render.
  const composePersonasFromProp = props.composePersonas;
  const composePersonas = React.useMemo(
    () =>
      composePersonasFromProp !== undefined
        ? [...composePersonasFromProp]
        : listPersonas().filter((p) => isPersonaOpen(p.name)).map((p) => p.name),
    // listPersonas / isPersonaOpen are sync reads from in-memory
    // module state; we'd need a subscription to react to unlocks
    // mid-form. The form re-mounts on navigation though, so the
    // typical flow (open form → see prefill from-then-open personas)
    // is already covered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composePersonasFromProp],
  );
  const composeCtx = useComposeContext({
    subjectName: composeSubjectName,
    persona: composePersonas,
    category: composeCategory,
    enabled: props.composeContextEnabled ?? true,
    llmProvider: props.composeLLMProvider,
  });
  const [prefilledFields, setPrefilledFields] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Merge inferred values into form state — only for fields that are
  // currently empty AND haven't already been prefilled (i.e. don't
  // re-prefill after the user cleared a value, and don't clobber an
  // explicit `initial` prop or already-typed value). One-shot per
  // form open via `mergedRef`.
  //
  // Decision is computed OUTSIDE the setState callback (which may run
  // later under React batching) so `setPrefilledFields` synchronises
  // correctly with the value merge — otherwise the prefill markers
  // would be empty even when values landed.
  const mergedRef = React.useRef(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- state intentionally NOT in deps; mergedRef gates re-fire
  React.useEffect(() => {
    if (composeCtx.result === null) return;
    if (mergedRef.current) return; // one-shot per form open
    const result = composeCtx.result;
    const newPrefilled = new Set<string>();
    if (
      result.values.use_cases !== undefined &&
      result.values.use_cases.length > 0 &&
      state.useCases.length === 0
    ) {
      newPrefilled.add('use_cases');
    }
    if (
      result.values.last_used_bucket !== undefined &&
      state.lastUsedBucket === null
    ) {
      newPrefilled.add('last_used_bucket');
    }
    if (newPrefilled.size === 0) {
      mergedRef.current = true;
      return;
    }
    setState((prev) => {
      const next = { ...prev };
      if (newPrefilled.has('use_cases') && result.values.use_cases !== undefined) {
        next.useCases = [...result.values.use_cases];
      }
      if (
        newPrefilled.has('last_used_bucket') &&
        result.values.last_used_bucket !== undefined
      ) {
        next.lastUsedBucket = result.values.last_used_bucket;
      }
      return next;
    });
    setPrefilledFields(newPrefilled);
    mergedRef.current = true;
  }, [composeCtx.result]);

  /**
   * Drop a field from the prefilled set when the user takes ownership.
   * Wraps every advanced-field mutator below.
   */
  const clearPrefilled = (fieldId: string): void => {
    setPrefilledFields((prev) => {
      if (!prev.has(fieldId)) return prev;
      const next = new Set(prev);
      next.delete(fieldId);
      return next;
    });
  };

  const updateSentiment = (s: Sentiment): void =>
    setState((prev) => ({ ...prev, sentiment: prev.sentiment === s ? null : s }));
  const updateHeadline = (text: string): void =>
    setState((prev) => ({ ...prev, headline: text }));
  const updateBody = (text: string): void => setState((prev) => ({ ...prev, body: text }));
  // TN-V2-REV-007 — last-used bucket: tap-to-toggle. Tapping the
  // currently-selected bucket clears the field, returning the form
  // to "user did not pick".
  const updateLastUsedBucket = (b: LastUsedBucket): void => {
    setState((prev) => ({
      ...prev,
      lastUsedBucket: prev.lastUsedBucket === b ? null : b,
    }));
    clearPrefilled('last_used_bucket');
  };
  // TN-V2-REV-006 — use-case tags: tap-to-toggle multi-select with
  // cap. The mutator delegates to the pure `toggleUseCase` helper so
  // the cap + closed-vocabulary discipline live in the data layer,
  // not the screen.
  const toggleUseCaseTag = (tag: string, vocabulary: readonly string[]): void => {
    setState((prev) => ({
      ...prev,
      useCases: toggleUseCase(prev.useCases, tag, vocabulary),
    }));
    clearPrefilled('use_cases');
  };
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
  // Wizard step. Step 1 is the required gate (sentiment + headline);
  // Steps 2 + 3 are optional and can be skipped — Publish is shown on
  // every step. We keep the field categorisation in the JSX rather
  // than driving it from a config table because the rendering logic
  // for each section is heterogeneous (chip rows / text inputs / tag
  // grids / search-and-pick) and a config-driven approach would add
  // more complexity than it removes for three steps.
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  // Step 1 is the publish gate. Pull the canPublish check out so the
  // step-nav logic and the Publish CTA share one source of truth.
  const step1Ready =
    state.sentiment !== null &&
    state.headline.trim().length > 0 &&
    state.headline.length <= HEADLINE_MAX_LENGTH &&
    state.body.length <= BODY_MAX_LENGTH;
  const goNext = (): void => {
    if (step === 1) setStep(2);
    else if (step === 2) setStep(3);
  };
  const goBack = (): void => {
    if (step === 3) setStep(2);
    else if (step === 2) setStep(1);
  };
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

  // Chat-draft handoff: we were pushed onto the trust stack from a
  // different tab (chat). The Stack header's default back arrow
  // would pop to trust home, not chat. Override `headerLeft` to send
  // the user back where they came from — same destination Cancel
  // and post-publish use.
  const fromChatDraft =
    paramDraftId !== undefined &&
    paramDraftId.length > 0 &&
    paramThreadId !== undefined &&
    paramThreadId.length > 0;
  const stackOptions = fromChatDraft
    ? {
        title: headerTitle,
        headerLeft: () => (
          <Pressable
            onPress={() => router.replace('/')}
            accessibilityRole="button"
            accessibilityLabel="Back to chat"
            hitSlop={8}
            style={{ paddingHorizontal: spacing.sm }}
          >
            <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
          </Pressable>
        ),
      }
    : { title: headerTitle };

  return (
    <>
      <Stack.Screen options={stackOptions} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        testID="write-screen"
        keyboardShouldPersistTaps="handled"
      >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {headerTitle}
        </Text>
      </View>

      {/* (Top stepper removed: Step 1 is now the canonical surface and
          the "Add additional data" pill below the Body field opens the
          modal-style wizard for Steps 2+3. Publish stays on Step 1.) */}

      {/* Subject anchor card: visible when the form has subject
          context — either edit mode, deep-linked compose with
          ?subjectName=..., or an explicit `subjectTitle` prop. The
          fallback default is the literal "New review" string used by
          the compose-without-subject flow; suppressing on that
          string keeps the anchor hidden until the user picks a kind. */}
      {subjectTitle !== 'New review' && (
        <SubjectAnchorView
          title={subjectTitle}
          kind={paramSubjectKind}
          category={paramSubjectKind !== null ? categoryFor(paramSubjectKind) : null}
        />
      )}

      {editWarning && (
        <View style={styles.warningPanel} testID="write-edit-warning">
          <Ionicons name="warning" size={18} color={colors.warning} />
          <View style={styles.warningBody}>
            <Text style={styles.warningTitle}>{editWarning.title}</Text>
            <Text style={styles.warningText}>{editWarning.body}</Text>
          </View>
        </View>
      )}

      {/* ─── STEP 1: Verdict ─────────────────────────────────────────
          Subject + Sentiment + Headline + Body. Sentiment + Headline
          are the publish gate; Body is optional. Step 2/3 are only
          reachable AFTER Step 1 validates. */}
      {step === 1 && (
        <>
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

      {/* Confidence used to be a required pill row here. We dropped
          the surface — casual reviewers don't think in
          speculative/moderate/high/certain ladders and the field was
          only consumed by the AppView search filter `minConfidence`
          (not by any trust-score weight). The form now seeds
          `confidence: 'moderate'` so the wire record still carries
          a value; edit mode keeps the original confidence via the
          `editingConfidence` URL param, so amending an old review
          doesn't silently downgrade it. */}

      {/* ─── Prefill banner (Step 1 only) ────────────────────────────
          When Dina prefilled fields from the user's vault, show a
          subtle banner so the user knows the deeper steps are worth
          the tap. Silent when nothing prefilled — Silence First. */}
      {prefilledFields.size > 0 && (
        <View style={styles.prefillBanner} testID="write-prefill-banner">
          <Text style={styles.prefillBannerText}>
            {`✨ Dina prefilled ${prefilledFields.size} field${
              prefilledFields.size === 1 ? '' : 's'
            } in additional details from your vault.`}
          </Text>
        </View>
      )}

      {/* "Add additional data" pill — opens the wizard modal for
          Steps 2 + 3 (Your experience + Recommendations). The pill
          is the ONLY entry point to the optional fields; without
          tapping it the user just publishes the verdict. Phrased
          neutrally so users feel no pressure to engage. */}
      <Pressable
        onPress={() => !isSubmitting && setStep(2)}
        disabled={isSubmitting}
        style={({ pressed }) => [
          styles.additionalDataPill,
          pressed && !isSubmitting && styles.additionalDataPillPressed,
        ]}
        testID="write-additional-data-pill"
        accessibilityRole="button"
        accessibilityLabel="Add additional details"
        accessibilityState={{ disabled: isSubmitting }}
      >
        <Ionicons name="add-circle-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.additionalDataPillLabel}>Add additional details (optional)</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </Pressable>
        </>
      )}

      {/* ─── Modal wizard for Steps 2 + 3 (Your experience +
          Recommendations) ──────────────────────────────────────────
          Renders as a full-page modal pop-over the form. Form state
          lives in the parent component, so the modal just shows a
          different view of the same state — closing it preserves
          everything. The modal's own action row carries Back / Next
          / Done navigation; Publish stays on the main form behind
          the modal so users always know how to commit. */}
      <Modal
        visible={step !== 1}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setStep(1)}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.modalContent}
          testID="write-additional-data-modal"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Additional details</Text>
            <Pressable
              onPress={() => setStep(1)}
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.modalCloseBtn,
                pressed && !isSubmitting && styles.modalCloseBtnPressed,
              ]}
              testID="write-additional-data-close"
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={20} color={colors.textPrimary} />
            </Pressable>
          </View>

          {/* In-modal stepper — 2 dots for the two sub-steps. */}
          <View style={styles.stepperRow} testID="write-stepper">
            {([2, 3] as const).map((n) => {
              const labels = { 2: 'Your experience', 3: 'Recommendations' };
              const isActive = step === n;
              return (
                <Pressable
                  key={n}
                  onPress={() => setStep(n)}
                  disabled={isSubmitting}
                  style={({ pressed }) => [
                    styles.stepperDotWrap,
                    pressed && !isSubmitting && styles.stepperDotWrapPressed,
                  ]}
                  testID={`write-stepper-${n}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Step: ${labels[n]}`}
                  accessibilityState={{ selected: isActive }}
                >
                  <View
                    style={[
                      styles.stepperDot,
                      isActive && styles.stepperDotActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stepperDotText,
                        isActive && styles.stepperDotTextActive,
                      ]}
                    >
                      {n - 1}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.stepperLabel,
                      isActive && styles.stepperLabelActive,
                    ]}
                  >
                    {labels[n]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

      {/* ─── STEP 2: Your experience ─────────────────────────────────
          What YOU did — use-cases you put it through, when you last
          touched it, your expertise tier, what you paid. All optional
          (a user can publish from Step 1 alone). */}
      {step === 2 && (
        <View testID="write-step-2">
          {/* TN-V2-REV-006 — use-case picker. Per-category
              vocabulary (resolves from `state.subject?.kind`, falling
              back to a generic list for the subjectId-based form
              path). Multi-select capped at MAX_USE_CASES = 3. When at
              the cap, unselected tags grey out so the user
              understands why further taps are no-ops. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              {prefilledFields.has('use_cases') ? '✨ ' : ''}What do you use this for?
            </Text>
            <Text style={styles.kindHint}>
              {prefilledFields.has('use_cases')
                ? `Dina noted these from your vault. Tap to change.`
                : `Optional — pick up to ${MAX_USE_CASES}. Helps other readers find reviews from people with the same use-case.`}
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
            <Text style={styles.fieldLabel}>
              {prefilledFields.has('last_used_bucket') ? '✨ ' : ''}Last used
            </Text>
            <Text style={styles.kindHint}>
              {prefilledFields.has('last_used_bucket')
                ? `Dina inferred this from when you last mentioned it. Tap a different bucket to change.`
                : `When did you last interact with this? Optional — helps readers judge how fresh your review still is.`}
            </Text>
            {/* Vertical row list — single-select with checkmark.
                Replaces the chip pill row. Single-select fields read
                more clearly as a stacked list of options than as a
                wrapping pill grid (the user explicitly noted the chip
                wrap looked cramped); this also visually distinguishes
                single-select fields from the multi-select chip rows
                elsewhere on the form. */}
            <View style={styles.rowList} testID="write-last-used-rowlist">
              {LAST_USED_BUCKETS.map((bucket, idx) => {
                const isSelected = state.lastUsedBucket === bucket;
                const isLast = idx === LAST_USED_BUCKETS.length - 1;
                return (
                  <Pressable
                    key={bucket}
                    onPress={() => !isSubmitting && updateLastUsedBucket(bucket)}
                    disabled={isSubmitting}
                    style={({ pressed }) => [
                      styles.rowListRow,
                      !isLast && styles.rowListRowDivider,
                      pressed && !isSubmitting && styles.rowListRowPressed,
                    ]}
                    testID={`write-last-used-${bucket}`}
                    accessibilityRole="button"
                    accessibilityLabel={LAST_USED_BUCKET_LABEL[bucket]}
                    accessibilityState={{
                      selected: isSelected,
                      disabled: isSubmitting,
                    }}
                  >
                    <Text style={styles.rowListLabel}>
                      {LAST_USED_BUCKET_LABEL[bucket]}
                    </Text>
                    {isSelected && (
                      <Ionicons
                        name="checkmark"
                        size={18}
                        color={colors.accent}
                      />
                    )}
                  </Pressable>
                );
              })}
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

          {/* TN-V2-REV-002 — reviewer experience tier. Three-option
              segmented control (single-select, tap-active-to-clear).
              Replaces the previous chip row: with a small fixed
              option count, a segmented control reads as a single
              decision rather than a pill grid. */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>How experienced are you with this?</Text>
            <Text style={styles.kindHint}>
              Optional — readers can prefer reviews from your tier when
              filtering.
            </Text>
            <View style={styles.segmentedControl} testID="write-experience-row">
              {REVIEWER_EXPERIENCE_OPTIONS.map((level, idx) => {
                const selected = state.reviewerExperience === level;
                const isFirst = idx === 0;
                const isLast = idx === REVIEWER_EXPERIENCE_OPTIONS.length - 1;
                return (
                  <Pressable
                    key={level}
                    onPress={() => !isSubmitting && updateReviewerExperience(level)}
                    disabled={isSubmitting}
                    style={({ pressed }) => [
                      styles.segmentedSegment,
                      isFirst && styles.segmentedSegmentFirst,
                      isLast && styles.segmentedSegmentLast,
                      selected && styles.segmentedSegmentActive,
                      pressed && !isSubmitting && !selected && styles.segmentedSegmentPressed,
                    ]}
                    testID={`write-experience-${level}`}
                    accessibilityRole="button"
                    accessibilityLabel={REVIEWER_EXPERIENCE_LABEL[level]}
                    accessibilityHint={REVIEWER_EXPERIENCE_HINT[level]}
                    accessibilityState={{ selected, disabled: isSubmitting }}
                  >
                    <Text
                      style={[
                        styles.segmentedLabel,
                        selected && styles.segmentedLabelActive,
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
        </View>
      )}

      {/* ─── STEP 3: Recommendations ─────────────────────────────────
          What you'd recommend / warn about, plus observable subject
          facts (compliance, accessibility, compat). Optional. */}
      {step === 3 && (
        <View testID="write-step-3">
          {/* TN-V2-REV-004 — recommendFor / notRecommendFor. Same
              vocabulary as useCases (per-category). Two parallel
              chip grids; cap 5 each. Front-loaded in Step 3 because
              "would you recommend it?" is the strongest summary
              signal a reader can pull from the review. */}
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

          {/* Availability (regions / shipsTo / soldAt) and schedule
              (leadDays / seasonal) used to live here. They're
              subject-owner facts, not opinion — they belong on a
              future "Add subject" surface. */}
        </View>
      )}

          {/* Modal action row — Back / Next / Done. Mirrors the
              wizard's internal-step cadence: Step 2 has Next (to
              Step 3), Step 3 has only Done. Back appears on Step 3.
              Publish stays on the main form (behind the modal); the
              user closes the wizard with Done and publishes from
              the verdict screen. */}
          <View style={styles.actionRow}>
            {step === 3 && (
              <Pressable
                onPress={goBack}
                disabled={isSubmitting}
                style={({ pressed }) => [
                  styles.cancelBtn,
                  pressed && !isSubmitting && styles.cancelBtnPressed,
                ]}
                testID="write-back"
                accessibilityRole="button"
                accessibilityLabel="Back"
                accessibilityState={{ disabled: isSubmitting }}
              >
                <Ionicons name="chevron-back" size={14} color={colors.textPrimary} />
                <Text style={styles.cancelLabel}>Back</Text>
              </Pressable>
            )}
            {step === 2 ? (
              <Pressable
                onPress={goNext}
                disabled={isSubmitting}
                style={({ pressed }) => [
                  styles.nextBtn,
                  isSubmitting && styles.publishBtnDisabled,
                  pressed && !isSubmitting && styles.nextBtnPressed,
                ]}
                testID="write-next"
                accessibilityRole="button"
                accessibilityLabel="Next"
                accessibilityState={{ disabled: isSubmitting }}
              >
                <Text style={styles.nextLabel}>Next</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textPrimary} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => setStep(1)}
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.modalDoneBtn,
                pressed && !isSubmitting && styles.modalDoneBtnPressed,
              ]}
              testID="write-additional-data-done"
              accessibilityRole="button"
              accessibilityLabel="Done"
              accessibilityState={{ disabled: isSubmitting }}
            >
              <Text style={styles.modalDoneLabel}>Done</Text>
            </Pressable>
          </View>
        </ScrollView>
      </Modal>

      {/* ─── Submit error ────────────────────────────────────────── */}
      {submitError !== null && (
        <View style={styles.submitErrorPanel} testID="write-submit-error">
          <Ionicons name="alert-circle" size={16} color={colors.error} />
          <Text style={styles.submitErrorText}>{submitError}</Text>
        </View>
      )}

      {/* ─── Main action row: Cancel | Publish ─────────────────────
          The wizard for additional details lives behind the
          "Add additional data" pill above; it does NOT bubble
          Back/Next buttons up to the main row. Publish is always
          visible here so a user who only filled the verdict can
          ship without opening the wizard. */}
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
    </>
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
  // Each form field is a card surface with breathing room — gives
  // visual separation between sections so labels don't collide with
  // the previous section's controls (the chip-grid wrap previously
  // ran "Kids" right up against the next section's "Last used"
  // header). The outer ScrollView's `gap` keeps cards apart.
  field: {
    gap: spacing.sm,
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
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
  // ─── Wizard stepper (top of form) ─────────────────────────────────
  stepperRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  stepperDotWrap: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  stepperDotWrapPressed: { opacity: 0.6 },
  stepperDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bgCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperDotActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  stepperDotComplete: {
    backgroundColor: colors.bgTertiary,
  },
  stepperDotText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  stepperDotTextActive: { color: colors.bgSecondary },
  stepperLabel: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
  },
  stepperLabelActive: { color: colors.textPrimary },
  // "Add additional details (optional)" pill — opens the wizard
  // modal. Styled as a card-row with a subtle plus icon to read as
  // optional/secondary action, not a primary CTA.
  additionalDataPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  additionalDataPillPressed: { backgroundColor: colors.bgTertiary },
  additionalDataPillLabel: {
    flex: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textSecondary,
  },
  // Modal scaffolding for the wizard.
  modalContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
  },
  modalTitle: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.textPrimary,
  },
  modalCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseBtnPressed: { backgroundColor: colors.bgTertiary },
  modalDoneBtn: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  modalDoneBtnPressed: { backgroundColor: colors.accentHover },
  modalDoneLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  // Subtle banner under Step 1 nudging the user toward Step 2 when
  // Dina prefilled fields. Small + muted — Silence First.
  prefillBanner: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  prefillBannerText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
  },
  // Wizard "Next" button — shares the cancel/back footprint but
  // accentuated slightly so it reads as the forward action.
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    minHeight: 44,
  },
  nextBtnPressed: { backgroundColor: colors.bgTertiary },
  nextLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
  },
  // ─── Row list (single-select with checkmark) ─────────────────────
  // Used by the Last used picker. iOS-style rows: full-width
  // Pressable, label on the left, checkmark on the right when
  // selected. Hairline divider between rows; the outer card shell
  // (styles.field) provides the card chrome.
  rowList: {
    marginTop: spacing.xs,
  },
  rowListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    minHeight: 40,
  },
  rowListRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowListRowPressed: { backgroundColor: colors.bgTertiary },
  rowListLabel: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
  },
  // ─── Segmented control (single-select, ≤5 options) ───────────────
  // Used by the Reviewer experience picker. Single horizontal pill
  // with N segments; the active segment gets the accent background
  // and white label, others stay neutral. Bookend segments get
  // rounded outer corners; middle segments stay square so they
  // visually merge.
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: colors.bgCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.full,
    overflow: 'hidden',
    marginTop: spacing.xs,
    minHeight: 40,
  },
  segmentedSegment: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  segmentedSegmentFirst: { borderLeftWidth: 0 },
  segmentedSegmentLast: {},
  segmentedSegmentActive: {
    backgroundColor: colors.accent,
  },
  segmentedSegmentPressed: { backgroundColor: colors.bgTertiary },
  segmentedLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  segmentedLabelActive: { color: colors.bgSecondary },
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
