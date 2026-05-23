-- Append-only log of admin / operator actions on AppView data.
-- Every privileged mutation (subject tombstone, attestation takedown,
-- subject merge, DID redaction, etc.) writes a row here BEFORE the
-- mutation lands.
--
-- The inline columns on the mutated rows (e.g. subjects.tombstone_reason,
-- attestations.takedown_reason) carry the operator-facing flag on the
-- read path; this table carries the FULL audit record — who, when,
-- and the action-specific context.

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id" bigserial PRIMARY KEY,
  "actor_did" text NOT NULL,
  "action" text NOT NULL,
  "target_id" text NOT NULL,
  "reason" text,
  "context_json" jsonb,
  "performed_at" timestamp NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "admin_audit_log_target_idx" ON "admin_audit_log" ("target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_actor_idx" ON "admin_audit_log" ("actor_did");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_performed_at_idx" ON "admin_audit_log" ("performed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_action_idx" ON "admin_audit_log" ("action");
