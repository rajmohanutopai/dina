/**
 * Cosig recipient-accept data layer (TN-MOB-042).
 *
 * Per plan §10:
 *
 *   > Action choice "Endorse" emits `trust.cosig.accept` — the
 *   > recipient publishes a `com.dina.trust.endorsement` record
 *   > then sends the D2D `trust.cosig.accept` carrying the
 *   > endorsement's AT-URI + CID back to the requester.
 *
 * The decline half is in `cosig_action.ts` (TN-MOB-043). Endorse
 * was deliberately split out because it has a two-phase shape:
 *
 *   1. **Build endorsement record** — the lexicon body the recipient
 *      will publish to their PDS. Pure data; no I/O.
 *   2. **(Network: publish to PDS)** — yields `endorsementUri` +
 *      `endorsementCid`. Lives in the screen layer / `pds_publish`.
 *      This module never imports the network primitive.
 *   3. **Build accept frame** — the D2D `trust.cosig.accept` body
 *      ready for envelope wrapping. Carries the URI+CID from step 2.
 *      Pure data; sender-side validation via
 *      `@dina/protocol`'s `validateCosigAccept`.
 *
 * Bundling the two builders together would conflate two different
 * control flows — keeping them as separate exported functions lets
 * the screen orchestrate the network call between them without this
 * module needing to know about transports.
 *
 * **Mapping cosig-request → endorsement record**:
 *   - `subject` = the attestation author's DID. The recipient is
 *     endorsing the AUTHOR of the original review (Sancho), not the
 *     subject of the review (the chair). The cosignature footer
 *     reads "Co-signed by <recipient>" on the AUTHOR's attestation.
 *   - `skill` = the attestation's category (e.g. "office_furniture").
 *     This makes the endorsement skill-scoped — Alonso endorses
 *     Sancho's expertise on office furniture, NOT his expertise in
 *     general. The endorsement handler indexes `skill` for trust-
 *     edge `domain` (`appview/src/ingester/handlers/endorsement.ts`).
 *   - `endorsementType` = `'cosignature'`. Distinct from
 *     `'worked-together'` (which AppView weights at 0.8); cosig
 *     endorsements carry a different semantic and weighted at the
 *     default 0.4 today. The semantic literal is exposed as a
 *     constant so AppView can recognise it without a typo dance.
 *   - `relationship` = optional ("worked together", "neighbor",
 *     etc.) — the recipient's prose describing their connection.
 *   - `text` = optional free-form note ("can confirm this chair
 *     hurt my back too").
 *   - `namespace` = optional — the pseudonymous namespace fragment
 *     the recipient is operating under, if any. Symmetric with
 *     attestations + endorsements (TN-DB-012). When absent, the
 *     endorsement is published under the root identity.
 *   - `createdAt` = ISO from `nowMs`.
 *
 * Pure functions. No state, no I/O. The screen wires:
 *
 *     const record = buildCosigEndorsement({...});
 *     const { uri, cid } = await publishEndorsementToPDS(record);
 *     const accept = buildCosigAcceptFrame({requestId, uri, cid, nowMs});
 *     await sendD2D(senderDid, accept);
 */

import {
  COSIG_ACCEPT_TYPE,
  validateCosigAccept,
  type CosigAccept,
} from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Endorsement record body for `com.dina.trust.endorsement`. Mirrors
 * the protocol `Endorsement` type with all the cosig-specific
 * defaults applied. The result is ready to hand to a PDS publish
 * primitive — type-shape exactly matches AppView's `endorsementSchema`.
 */
export interface CosigEndorsementRecord {
  readonly subject: string;
  readonly skill: string;
  readonly endorsementType: string;
  readonly relationship?: string;
  readonly text?: string;
  readonly namespace?: string;
  readonly createdAt: string;
}

export interface BuildCosigEndorsementInput {
  /** Attestation author DID — `Endorsement.subject`. */
  readonly attestationAuthorDid: string;
  /**
   * Attestation category — used as `Endorsement.skill`. Maps the
   * cosignature trust signal into the skill domain of the original
   * review (so AppView's trust-edge `domain` indexing routes
   * correctly). Caps at 200 chars per the lexicon — caller should
   * pre-validate but this builder enforces.
   */
  readonly attestationCategory: string;
  /** Optional free-form prose ("can confirm" / "from my own use"). */
  readonly text?: string;
  /** Optional relationship descriptor ("co-worker", "neighbor"). */
  readonly relationship?: string;
  /**
   * Pseudonymous namespace fragment (no leading `#`). When omitted,
   * the endorsement publishes under the recipient's root identity.
   */
  readonly namespace?: string;
  /** Wall-clock — injectable for deterministic tests. */
  readonly nowMs: number;
}

export interface BuildCosigAcceptFrameInput {
  readonly requestId: string;
  /** Result of publishing the endorsement record — full AT-URI. */
  readonly endorsementUri: string;
  /** Result of publishing the endorsement record — record CID. */
  readonly endorsementCid: string;
  /** Wall-clock — injectable for deterministic tests. */
  readonly nowMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * The `endorsementType` literal carried on a cosignature
 * endorsement. Exposed as a constant so AppView (or any future
 * cosig-recogniser) can match it without a typo dance.
 *
 * Distinct from `'worked-together'` (the AppView trust-edge handler
 * weights that at 0.8); cosig today gets the default 0.4 weight.
 * Future TN-SCORE-* work may differentiate.
 */
export const COSIG_ENDORSEMENT_TYPE = 'cosignature' as const;

/**
 * Bound the lexicon's open-ended free-text fields at exactly the
 * caps `record-validator.ts` enforces. Pinned by test so a future
 * lexicon change makes this builder fail loudly rather than silently
 * over-/under-cap the wire shape.
 */
export const MAX_SKILL_LEN = 200;
export const MAX_TEXT_LEN = 2000;
export const MAX_RELATIONSHIP_LEN = 200;
export const MAX_NAMESPACE_LEN = 255;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the `com.dina.trust.endorsement` record body for a cosig
 * accept. Pure data; the caller is responsible for publishing it
 * via the PDS primitive.
 *
 * Throws on:
 *   - Missing / non-string `attestationAuthorDid`.
 *   - Empty / whitespace `attestationCategory`.
 *   - Over-cap `text` / `relationship` / `namespace` / `skill`.
 *   - Non-finite `nowMs`.
 *
 * Trims whitespace from `text`, `relationship`, `namespace`, `skill`
 * BEFORE the cap check so a 2001-char trimmed value doesn't slip
 * through on a 2002-char untrimmed input.
 */
export function buildCosigEndorsement(
  input: BuildCosigEndorsementInput,
): CosigEndorsementRecord {
  if (typeof input.attestationAuthorDid !== 'string' || input.attestationAuthorDid.length === 0) {
    throw new Error('buildCosigEndorsement: attestationAuthorDid must be a non-empty string');
  }
  if (typeof input.nowMs !== 'number' || !Number.isFinite(input.nowMs)) {
    throw new Error('buildCosigEndorsement: nowMs must be a finite number');
  }

  const skill = trimRequired(input.attestationCategory, MAX_SKILL_LEN, 'attestationCategory');

  const record: { -readonly [K in keyof CosigEndorsementRecord]: CosigEndorsementRecord[K] } = {
    subject: input.attestationAuthorDid,
    skill,
    endorsementType: COSIG_ENDORSEMENT_TYPE,
    createdAt: new Date(input.nowMs).toISOString(),
  };

  // Optional fields: whitespace-only input means "user left the
  // field blank" — we OMIT rather than throw, so the screen can
  // bind the field to a TextInput without pre-trimming. Over-cap
  // values DO throw — the user typed something real and we
  // shouldn't silently drop a 2001-char note.
  const relationship = trimOptional(
    input.relationship,
    MAX_RELATIONSHIP_LEN,
    'relationship',
  );
  if (relationship !== undefined) record.relationship = relationship;

  const text = trimOptional(input.text, MAX_TEXT_LEN, 'text');
  if (text !== undefined) record.text = text;

  const namespace = trimOptional(input.namespace, MAX_NAMESPACE_LEN, 'namespace');
  if (namespace !== undefined) record.namespace = namespace;

  return Object.freeze(record);
}

/**
 * Build the `trust.cosig.accept` D2D body. Sender-side validation
 * via the protocol's authoritative `validateCosigAccept` — sender
 * and recipient share one rule set, and a malformed frame surfaces
 * synchronously here rather than asynchronously after a network
 * round-trip.
 *
 * Throws on:
 *   - Empty / non-string `requestId`.
 *   - Empty / non-string `endorsementUri` or `endorsementCid`.
 *   - Non-finite `nowMs`.
 *   - Any `validateCosigAccept` error (length caps, type literal,
 *     ISO `createdAt` shape).
 */
export function buildCosigAcceptFrame(
  input: BuildCosigAcceptFrameInput,
): CosigAccept {
  if (typeof input.nowMs !== 'number' || !Number.isFinite(input.nowMs)) {
    throw new Error('buildCosigAcceptFrame: nowMs must be a finite number');
  }
  const createdAt = new Date(input.nowMs).toISOString();

  const frame: CosigAccept = {
    type: COSIG_ACCEPT_TYPE,
    requestId: input.requestId,
    endorsementUri: input.endorsementUri,
    endorsementCid: input.endorsementCid,
    createdAt,
  };

  const errors = validateCosigAccept(frame);
  if (errors.length > 0) {
    throw new Error(`buildCosigAcceptFrame: invalid frame — ${errors.join('; ')}`);
  }
  return Object.freeze(frame);
}

// ─── Internal ─────────────────────────────────────────────────────────────

/** Required field: throws on empty / over-cap. */
function trimRequired(value: unknown, maxLen: number, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`buildCosigEndorsement: ${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`buildCosigEndorsement: ${fieldName} must be non-empty after trim`);
  }
  if (trimmed.length > maxLen) {
    throw new Error(
      `buildCosigEndorsement: ${fieldName} exceeds max length ${maxLen} (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

/**
 * Optional field: returns `undefined` for absent / whitespace-only
 * input (so the screen can bind it to a TextInput without
 * pre-trimming); throws on over-cap (the user typed something real,
 * silently dropping a 2001-char note would lose data); throws on
 * non-string (defensive — caller bug).
 */
function trimOptional(
  value: unknown,
  maxLen: number,
  fieldName: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`buildCosigEndorsement: ${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined; // omit silently
  if (trimmed.length > maxLen) {
    throw new Error(
      `buildCosigEndorsement: ${fieldName} exceeds max length ${maxLen} (got ${trimmed.length})`,
    );
  }
  return trimmed;
}
