-- Live listings (docs/REAL_LIFE_FIXES.md §14).
--
-- Hand-written to match `src/db/schema/service-liveness.ts` and the new
-- `services.repo_rev` column; keep them equal.

ALTER TABLE services ADD COLUMN IF NOT EXISTS repo_rev text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_operator_presence (
  did text PRIMARY KEY,
  last_seen_us bigint,
  credited_us bigint,
  presence_capable boolean NOT NULL DEFAULT false,
  presence_present boolean NOT NULL DEFAULT false,
  presence_complete boolean NOT NULL DEFAULT false,
  listings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  presence_rev text,
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_operator_presence_last_seen_idx ON service_operator_presence (last_seen_us);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_deletions (
  uri text PRIMARY KEY,
  did text NOT NULL,
  deleted_rev text NOT NULL,
  at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_deletions_at_idx ON service_deletions (at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_account_status (
  did text PRIMARY KEY,
  active boolean NOT NULL,
  status text,
  time_us bigint NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_blind_intervals (
  id serial PRIMARY KEY,
  start_us bigint NOT NULL,
  end_us bigint,
  reason text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_blind_intervals_open_idx ON service_blind_intervals (end_us);
--> statement-breakpoint
-- Everything before tracking began is blind time: every existing listing
-- starts at age zero. An operator may move this row's end earlier on a test
-- AppView (§14.7 step 4).
INSERT INTO service_blind_intervals (start_us, end_us, reason)
SELECT 0, (extract(epoch FROM now()) * 1000000)::bigint, 'pre_tracking'
WHERE NOT EXISTS (SELECT 1 FROM service_blind_intervals WHERE reason = 'pre_tracking');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_reconcile_jobs (
  did text PRIMARY KEY,
  reason text NOT NULL,
  presence_rev_at_queue text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  queued_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_reconcile_jobs_due_idx ON service_reconcile_jobs (next_attempt_at);
--> statement-breakpoint
-- Events received per hour across every subscribed collection: the upstream
-- signal that confirms a health drop (§14.4 C). Kept 8 days.
CREATE TABLE IF NOT EXISTS ingest_hourly_events (
  hour_start_us bigint PRIMARY KEY,
  events bigint NOT NULL DEFAULT 0
);
