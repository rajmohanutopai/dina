-- Moderator takedown columns on attestations. Distinct from
-- `is_revoked` (author retracted their own attestation) — takedown is
-- an operator action against ToS / abuse / legal. The attestation row
-- stays so the audit trail is intact, but read APIs filter it out of
-- active reviewer rosters + scoring.
--
-- The companion `admin_audit_log` row carries the actor + timestamp
-- + full context; the inline columns let read queries cheaply
-- exclude takedowns without joining the audit table on every row.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "is_takedown_by_moderator" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "takedown_reason" text;
--> statement-breakpoint
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "takedown_at" timestamp;
--> statement-breakpoint

-- Partial index — takedowns are rare. Partial WHERE keeps the b-tree
-- small while still serving operator queries.
CREATE INDEX IF NOT EXISTS "attestations_takedown_idx"
  ON "attestations" ("takedown_at")
  WHERE "is_takedown_by_moderator" = true;
