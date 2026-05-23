-- Author DID redactions (GDPR-shaped right-to-be-forgotten).
--
-- When a user demands their DID be erased, we can't safely hard-
-- delete attestations.author_did everywhere — scoring aggregates
-- would corrupt + attestation URIs depend on the DID. Instead,
-- read paths that surface author identity LEFT JOIN against this
-- table and substitute a sentinel.
--
-- Schema-only placeholder for launch. The application-side join +
-- substitution is wired when the redaction flow ships.
--
-- `audit_log_id` references `admin_audit_log.id` (BIGSERIAL) with a
-- FK constraint so the redaction can be traced to the operator
-- decision that fired it. Nullable to permit emergency / scripted
-- redactions outside the normal admin surface; expected to be set
-- in steady state.

CREATE TABLE IF NOT EXISTS "did_redactions" (
  "did" text PRIMARY KEY,
  "redacted_at" timestamp NOT NULL DEFAULT NOW(),
  "reason" text,
  "audit_log_id" bigint REFERENCES "admin_audit_log"("id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "did_redactions_redacted_at_idx" ON "did_redactions" ("redacted_at");
