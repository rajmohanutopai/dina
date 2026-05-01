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

import { colors, fonts, spacing, radius } from '../../src/theme';
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
  SENTIMENT_OPTIONS,
  CONFIDENCE_OPTIONS,
  SUBJECT_KIND_OPTIONS,
  SUBJECT_KIND_HINT,
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  type WriteFormState,
  type WriteFormError,
  type WriteSubjectState,
  type SubjectKind,
} from '../../src/trust/write_form_data';
import {
  injectAttestation,
  isTestPublishConfigured,
  type SubjectRefBody,
} from '../../src/trust/appview_runtime';
import { getBootedNode } from '../../src/hooks/useNodeBootstrap';

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
  } = props;

  const [state, setState] = React.useState<WriteFormState>(initial);
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
  show: boolean = true,
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
