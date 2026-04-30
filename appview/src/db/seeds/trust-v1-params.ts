/**
 * Canonical seed values for `trust_v1_params` (TN-DB-004 / Plan §4.1).
 *
 * **Single source of truth**: the consolidated TN-DB-010 migration, the
 * `dina-admin trust seed-params` CLI, and any test fixture all import
 * this list — never hardcode values inline.
 *
 * Frozen at module load. Ordered intentionally:
 *   1. WEIGHT_*           — reviewer trust formula coefficients
 *   2. N_*_TARGET, *_MIN  — saturation / minimum-sample thresholds
 *   3. *_MAX              — variance ceiling
 *   4. HOT_*_THRESHOLD    — fast-path bounds
 *   5. *_BOOST            — graph-position multipliers
 *
 * Plan §4.1 also mentions `FTS_WEIGHT_NAME='A' / FTS_WEIGHT_HEADLINE='B' /
 * FTS_WEIGHT_BODY='C'` but those are Postgres `setweight()` rank labels,
 * not numeric values — they live with the FTS-trigger work (TN-DB-009),
 * not with the scorer-loop parameter store. See `trust-v1-params.ts`
 * schema docstring.
 *
 * **Adding a parameter**: add a row here, write a UNION-ALL row in the
 * TN-DB-010 migration's idempotent INSERT (`ON CONFLICT (key) DO NOTHING`),
 * and bump the test that pins `TRUST_V1_PARAM_SEEDS.length`.
 */

export interface TrustV1ParamSeed {
  readonly key: string
  /** Value as a plain JS number; Postgres NUMERIC stores it exactly. */
  readonly value: number
  readonly description: string
}

export const TRUST_V1_PARAM_SEEDS: ReadonlyArray<TrustV1ParamSeed> = Object.freeze([
  // ── Reviewer trust formula coefficients (must sum to 1.0) ──────────
  Object.freeze({
    key: 'WEIGHT_VOLUME',
    value: 0.25,
    description: 'Reviewer trust weight: review-volume signal (review_count / N_VOLUME_TARGET, clamped).',
  }),
  Object.freeze({
    key: 'WEIGHT_AGE',
    value: 0.15,
    description: 'Reviewer trust weight: account-age signal (older accounts trusted more, log-scaled).',
  }),
  Object.freeze({
    key: 'WEIGHT_COSIG',
    value: 0.30,
    description: 'Reviewer trust weight: co-signature signal (cosig_count / N_COSIG_TARGET, clamped).',
  }),
  Object.freeze({
    key: 'WEIGHT_CONSISTENCY',
    value: 0.30,
    description: 'Reviewer trust weight: rating-consistency signal (1 - variance/VAR_MAX, clamped).',
  }),
  // ── Saturation / minimum-sample thresholds ─────────────────────────
  Object.freeze({
    key: 'N_VOLUME_TARGET',
    value: 50,
    description: 'Reviews needed before WEIGHT_VOLUME signal saturates at 1.0.',
  }),
  Object.freeze({
    key: 'N_COSIG_TARGET',
    value: 20,
    description: 'Cosignatures needed before WEIGHT_COSIG signal saturates at 1.0.',
  }),
  Object.freeze({
    key: 'N_CONSISTENCY_MIN',
    value: 3,
    description: 'Minimum reviews for WEIGHT_CONSISTENCY to be computed; below this the signal contributes 0.',
  }),
  Object.freeze({
    key: 'VAR_MAX',
    value: 0.25,
    description: 'Variance ceiling for the consistency signal: var ≥ VAR_MAX → consistency = 0.',
  }),
  // ── Fast-path bounds ───────────────────────────────────────────────
  Object.freeze({
    key: 'HOT_SUBJECT_THRESHOLD',
    value: 10000,
    description: 'Subjects with review_count > this threshold use the bounded fast-path scorer (TN-SCORE-008).',
  }),
  // ── Graph-position multipliers ─────────────────────────────────────
  Object.freeze({
    key: 'FRIEND_BOOST',
    value: 1.5,
    description: 'Multiplier applied to 1-hop reviewer signal vs 2-hop / 3+-hop in the network-position weight (Plan §7).',
  }),
])
