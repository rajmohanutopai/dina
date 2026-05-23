-- DB-level CHECK constraints on peerlens tables. Lexicon validators
-- enforce these at the ingest layer; this catches direct SQL writes
-- (admin tooling, ops scripts, scripted backfills) so the table can't
-- accumulate invalid rows behind the lexicon's back.
--
-- Mirrors the services-side 0017 stance: pre-launch tables are
-- expected to be clean, so a straight ADD CONSTRAINT (no NOT VALID
-- + VALIDATE two-step, no DO $$ EXCEPTION wrapper). If reality
-- disagrees with the lexicon's invariants, the migration fails loud
-- — that's the signal we want. Re-runs are guarded by drizzle's
-- `__drizzle_migrations` ledger, so intra-file idempotency isn't
-- needed.
--
-- See also: schema-side `check()` declarations in
-- `db/schema/attestations.ts` and `db/schema/subject-scores.ts`
-- (keeps `drizzle-kit generate` in sync with the DB).

-- sentiment is a closed enum at the lexicon. The column is
-- text-typed for ingest flexibility; this CHECK pins the same
-- shape at the storage layer.
ALTER TABLE "attestations"
  ADD CONSTRAINT "attestations_sentiment_enum"
  CHECK ("sentiment" IN ('positive', 'neutral', 'negative'));
--> statement-breakpoint

-- confidence is optional; when present it's a closed enum.
ALTER TABLE "attestations"
  ADD CONSTRAINT "attestations_confidence_enum"
  CHECK ("confidence" IS NULL OR "confidence" IN ('certain', 'high', 'moderate', 'speculative'));
--> statement-breakpoint

-- Reviewer-declared price range (TN-V2-META-002): when both bounds
-- are present, high must be ≥ low. Either bound alone (half-open
-- range) and both-NULL ("no price declared") are valid.
ALTER TABLE "attestations"
  ADD CONSTRAINT "attestations_price_range_ordered"
  CHECK (
    "price_low_e7" IS NULL
    OR "price_high_e7" IS NULL
    OR "price_high_e7" >= "price_low_e7"
  );
--> statement-breakpoint

-- weighted_score is a [0, 1] PeerLens rating (NULL = unscored). The
-- band lookup in `subject-get.ts` already gates on the range, but
-- this CHECK keeps the storage layer truthful even if a scorer
-- job writes an out-of-range value (e.g. a bad formula refactor).
ALTER TABLE "subject_scores"
  ADD CONSTRAINT "subject_scores_weighted_score_range"
  CHECK ("weighted_score" IS NULL OR ("weighted_score" BETWEEN 0 AND 1));
