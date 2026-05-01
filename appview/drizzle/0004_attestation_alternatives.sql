-- TN-V2-REV-005 — alternatives the reviewer also tried.
--
-- Adds `alternatives_json jsonb` to `attestations`. Stores the wire
-- `alternatives: SubjectRef[]` field as JSONB — same column shape as
-- the other JSONB-of-array fields (`evidence_json`, `mentions_json`,
-- `related_attestations_json`). Empty arrays are collapsed to NULL on
-- the ingest path.
--
-- No index. The access pattern is "hydrate alternatives on the
-- detail-page read path" — the alternatives belong to a single
-- attestation row that's already keyed by URI. Reverse lookups
-- ("which attestations mention this subject as an alternative")
-- aren't a V2 surface; if they become one, a dedicated edge table
-- (cf. `mention_edges`) is the right shape, not a GIN over JSONB.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "alternatives_json" jsonb;
