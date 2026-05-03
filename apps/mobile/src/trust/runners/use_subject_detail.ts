/**
 * Subject detail runner — wraps `com.dina.trust.subjectGet` for the
 * subject detail screen. Returns `{ data, error, isLoading }` for the
 * screen to consume; tests pass `enabled: false` to keep the screen
 * presentational.
 *
 * Maps the AppView reviewer-roster shape (contacts / extended /
 * strangers groups) into the flat `SubjectReview[]` the screen's
 * `deriveSubjectDetail` expects. The transform stamps each reviewer's
 * ring (`contact` / `fof` / `stranger`) so the screen's bucketing pass
 * can pull them apart again — keeping the network-position info that
 * AppView already determined.
 */

import { useEffect, useState } from 'react';
import {
  subjectGet,
  type SubjectGetReviewer,
  type SubjectGetResponse,
} from '../appview_runtime';
import { displayName } from '../handle_display';
import type { SubjectDetailInput } from '../subject_detail_data';
import type { SubjectReview } from '../subject_card';

export interface SubjectDetailState {
  data: SubjectDetailInput | null;
  error: string | null;
  isLoading: boolean;
}

export interface UseSubjectDetailOptions {
  subjectId: string;
  viewerDid: string;
  enabled: boolean;
  retryNonce?: number;
}

export function useSubjectDetail(
  opts: UseSubjectDetailOptions,
): SubjectDetailState {
  const { subjectId, viewerDid, enabled, retryNonce = 0 } = opts;
  const [state, setState] = useState<SubjectDetailState>({
    data: null,
    error: null,
    isLoading: false,
  });

  useEffect(() => {
    if (!enabled) return;
    if (!subjectId || !viewerDid) return;
    let cancelled = false;
    setState({ data: null, error: null, isLoading: true });
    subjectGet(subjectId, viewerDid)
      .then((response) => {
        if (cancelled) return;
        const data = mapToInput(response);
        setState({ data, error: null, isLoading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : "Couldn't load this subject.";
        setState({ data: null, error: msg, isLoading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [subjectId, viewerDid, enabled, retryNonce]);

  return state;
}

// ─── Mapper ───────────────────────────────────────────────────────────────

function mapToInput(response: SubjectGetResponse): SubjectDetailInput {
  const subject = response.subject;
  const title = subject?.name ?? subject?.did ?? 'Unknown subject';

  const reviews: SubjectReview[] = [];
  // `self` is optional on the wire shape — older AppView builds that
  // didn't expose this group still serialize a response without it,
  // so default to `[]` rather than crashing on `.length` access.
  const selfReviews = response.reviewers.self ?? [];
  for (const r of selfReviews) reviews.push(toReview(r, 'self'));
  for (const r of response.reviewers.contacts) reviews.push(toReview(r, 'contact'));
  for (const r of response.reviewers.extended) reviews.push(toReview(r, 'fof'));
  for (const r of response.reviewers.strangers) reviews.push(toReview(r, 'stranger'));

  // The first identifier (when present) is what the subject-resolver
  // hashed alongside type + name to mint `subject_id`. Pass it through
  // so the write CTA can reconstruct a SubjectRef that resolves to the
  // SAME subject_id — otherwise a new attestation would mint a
  // different subject row.
  const firstIdentifier =
    Array.isArray(subject?.identifiers) && subject.identifiers.length > 0
      ? readIdentifierField(subject.identifiers[0])
      : undefined;

  return {
    title,
    category: undefined,
    subjectTrustScore: response.score,
    reviewCount: response.reviewCount,
    reviews,
    subjectKind: subject?.type,
    subjectDid: subject?.did,
    subjectIdentifier: firstIdentifier,
  };
}

/**
 * Pull the `id` (or `value`) field from a subject identifier blob. The
 * AppView serializes identifiers as `[{ id: "M3" }]` for products and
 * `[{ value: "..." }]` for some other kinds — read whichever is
 * present.
 */
function readIdentifierField(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  if (typeof obj.value === 'string' && obj.value.length > 0) return obj.value;
  return undefined;
}

function toReview(
  r: SubjectGetReviewer,
  ring: SubjectReview['ring'],
): SubjectReview {
  return {
    ring,
    // Self rows don't drill (the user is on their own profile a
    // faster way), so we deliberately drop the DID. Every other row
    // carries the wire DID through to the screen so the tap handler
    // has the proper identifier to push to /trust/reviewer/[did].
    reviewerDid: ring === 'self' ? null : r.did,
    // Self reviews carry the user's own DID on the wire — surface it as
    // "You" so the detail screen reads "Your review" rather than
    // staring back at the viewer's full DID. Other rings prefer the
    // resolved handle (e.g. `alice.pds.dinakernel.com`) when AppView
    // has backfilled it from PLC `alsoKnownAs`; otherwise we fall
    // back to a truncated DID so the user sees something readable
    // instead of a 30-char wall. The screen treats
    // `reviewerTrustScore: null` as "no band badge" — for self that's
    // the right call (showing your own trust band next to your review
    // is noise, not signal).
    reviewerTrustScore: ring === 'self' ? null : r.trustScore,
    reviewerName:
      ring === 'self' ? 'You' : displayName(r.handle, r.did),
    headline: splitWireText(r.attestation.text).headline,
    createdAtMs: Date.parse(r.attestation.createdAt) || Date.now(),
    attestationUri: r.attestation.uri,
    body: splitWireText(r.attestation.text).body,
    sentiment: r.attestation.sentiment,
  };
}

/**
 * Split AppView's combined `text` field (`${headline}\n\n${body}`)
 * back into its original parts. Mirrors the splitter used by the
 * reviewer-profile path (`authored_attestations_data.ts`) so
 * Edit-mode pre-fill is consistent regardless of which surface
 * launched the editor.
 */
function splitWireText(raw: string | null): { headline: string; body: string } {
  if (raw === null) return { headline: '', body: '' };
  const idx = raw.indexOf('\n\n');
  if (idx === -1) return { headline: raw, body: '' };
  return { headline: raw.slice(0, idx), body: raw.slice(idx + 2) };
}
