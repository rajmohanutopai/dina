-- Resolver formula version stamped onto each subject row at INSERT
-- time. Lets operators identify which subjects were minted under
-- which formula without re-hashing every stored SubjectRef.
--
-- The resolver currently emits 'v2' (see RESOLVER_VERSION in
-- `appview/src/db/queries/subjects.ts`). If the formula ever evolves
-- (normalization rules, hash input shape), a 'v3' bump can ship
-- side-by-side; this column tells operators which rows the new
-- formula reproduces vs. which need migration.
--
-- Nullable: rows from before this column existed have NULL. Treat
-- absence as "version unknown / pre-v2".

ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "resolver_version" text;
