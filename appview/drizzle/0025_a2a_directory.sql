-- A2A directory (Lane 3, docs/A2A_GATEWAY_ARCHITECTURE.md §8.3).
--
-- Hand-written to match `src/db/schema/a2a.ts`; keep the two equal. The
-- integration suite reads and writes these tables through that schema, so
-- a column declared there and missing here fails the suite.

CREATE TABLE IF NOT EXISTS a2a_cards (
  did text PRIMARY KEY,
  presence text NOT NULL,
  repo_rev text NOT NULL,
  last_operation text NOT NULL,
  last_event_hash text NOT NULL,
  -- The spool row and Jetstream time of the last transition applied.
  last_spool_id bigint,
  last_event_time_us bigint,
  cid text,
  record_json text,
  card_json text,
  card_hash text,
  signature_state text NOT NULL,
  endpoint text,
  protocol_version text,
  skill_ids text[] NOT NULL DEFAULT '{}'::text[],
  skill_keys text[] NOT NULL DEFAULT '{}'::text[],
  display_name text,
  description text,
  search_text text,
  freshness_epoch bigint,
  publisher_epoch bigint,
  publisher_instance text,
  indexed_at timestamptz,
  verified_at timestamptz,
  unavailable boolean NOT NULL DEFAULT false,
  unavailable_reason text,
  evidence_json jsonb,
  account_active boolean NOT NULL DEFAULT true,
  proved_generation integer NOT NULL,
  needs_revalidation boolean NOT NULL DEFAULT false,
  revalidate_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT a2a_cards_presence_check CHECK (presence IN ('present', 'deleted')),
  CONSTRAINT a2a_cards_operation_check CHECK (last_operation IN ('create', 'update', 'delete')),
  CONSTRAINT a2a_cards_signature_check CHECK (signature_state IN ('verified', 'invalid', 'none'))
);

CREATE INDEX IF NOT EXISTS a2a_cards_skill_keys_idx ON a2a_cards USING gin (skill_keys);
CREATE INDEX IF NOT EXISTS a2a_cards_skill_ids_idx ON a2a_cards USING gin (skill_ids);
CREATE INDEX IF NOT EXISTS a2a_cards_revalidation_idx ON a2a_cards (did) WHERE needs_revalidation;
-- Text relevance (searchAgents `q`): the same expression the query uses.
CREATE INDEX IF NOT EXISTS a2a_cards_search_idx
  ON a2a_cards USING gin (to_tsvector('simple', coalesce(search_text, '')));

-- Account status of DIDs the directory knows (a card row or a spool row),
-- from account events, ordered by Jetstream time. A card is withheld while
-- its account's latest status after the card's commit is inactive.
CREATE TABLE IF NOT EXISTS a2a_account_status (
  did text PRIMARY KEY,
  active boolean NOT NULL,
  time_us bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS a2a_card_takedowns (
  did text PRIMARY KEY,
  taken_down_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  audit_log_id bigint REFERENCES admin_audit_log(id)
);

CREATE TABLE IF NOT EXISTS a2a_event_spool (
  id bigserial PRIMARY KEY,
  did text NOT NULL,
  collection text NOT NULL,
  rkey text NOT NULL,
  repo_rev text NOT NULL,
  operation text NOT NULL,
  event_hash text NOT NULL,
  -- JSON text: jsonb refuses \u0000, and a card event is never dropped.
  payload text NOT NULL,
  time_us bigint NOT NULL,
  observed_gap_generation integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  outcome text,
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  not_before timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT a2a_event_spool_operation_check CHECK (operation IN ('create', 'update', 'delete')),
  CONSTRAINT a2a_event_spool_status_check CHECK (status IN ('pending', 'done'))
);

CREATE UNIQUE INDEX IF NOT EXISTS a2a_event_spool_identity_idx
  ON a2a_event_spool (did, collection, rkey, repo_rev, operation, event_hash);
CREATE INDEX IF NOT EXISTS a2a_event_spool_pending_idx
  ON a2a_event_spool (did, repo_rev, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS a2a_directory_state (
  id integer PRIMARY KEY,
  phase text NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  gap_generation integer NOT NULL DEFAULT 0,
  drain_watermark bigint,
  -- When the consumer was last connected with nothing waiting (microseconds):
  -- a quiet stream loses nothing while live, so gaps are measured from here.
  last_live_us bigint,
  reconciliation_required boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT a2a_directory_state_singleton CHECK (id = 1),
  CONSTRAINT a2a_directory_state_phase_check CHECK (phase IN ('disabled', 'draining', 'ready'))
);

INSERT INTO a2a_directory_state (id, phase) VALUES (1, 'disabled') ON CONFLICT (id) DO NOTHING;
