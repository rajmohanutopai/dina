-- Add `handle` column to `did_profiles` so the AppView can surface
-- the human-readable AT Protocol handle (`alsoKnownAs[0]` minus the
-- `at://` prefix) alongside the raw DID. Populated lazily by the
-- `backfill-handles` scorer job; nullable indefinitely (a DID with
-- no published handle keeps the column NULL).

ALTER TABLE "did_profiles" ADD COLUMN IF NOT EXISTS "handle" text;

-- Sparse index: lookups go through DID (the PK) so handle isn't on a
-- read-hot path. We index only non-null rows so unresolved DIDs
-- don't cost storage. The use case is the operator-side lookup
-- "who has handle alice.pds.dinakernel.com" (admin tools / dedupe);
-- partial-index keeps the cost proportional to populated rows only.
CREATE INDEX IF NOT EXISTS "did_profiles_handle_idx"
  ON "did_profiles" ("handle")
  WHERE "handle" IS NOT NULL;
