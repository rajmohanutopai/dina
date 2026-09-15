-- D4 — imported review provenance (RESEARCHER_KERNEL_ARCHITECTURE §5.D).
--
-- NULL `source_feed` is the normal case and means testimony: a peer wrote the
-- record into their own repo. A non-NULL value means the row came from a
-- registered per-market review feed, and the scorer treats it as a rating
-- input that carries no trust — it never moves a DID's PeerLens score and
-- never counts toward a subject's confidence.
--
-- Hand-written to match `src/db/schema/attestations.ts` and
-- `src/db/schema/subject-scores.ts`. This repo has no `drizzle-kit generate`
-- step, so a column declared in TypeScript and missing here is a column that
-- 500s in production while every unit test passes.

ALTER TABLE attestations ADD COLUMN IF NOT EXISTS source_feed text;
ALTER TABLE attestations ADD COLUMN IF NOT EXISTS source_json jsonb;

CREATE INDEX IF NOT EXISTS attestations_source_feed_idx
  ON attestations (source_feed)
  WHERE source_feed IS NOT NULL;

-- A subject's counts split by where its reviews came from. `review_count`
-- keeps its existing meaning (everything shown); these two say how much of it
-- anyone can be reached about.
ALTER TABLE subject_scores ADD COLUMN IF NOT EXISTS peer_review_count integer NOT NULL DEFAULT 0;
ALTER TABLE subject_scores ADD COLUMN IF NOT EXISTS imported_review_count integer NOT NULL DEFAULT 0;
