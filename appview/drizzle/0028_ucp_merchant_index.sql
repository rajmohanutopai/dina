-- The UCP merchant index (docs/UCP_IMPLEMENTATION_PLAN.md §3.15, U5).
--
-- Hand-written to match `src/db/schema/ucp.ts`; keep the two equal.

CREATE TABLE IF NOT EXISTS ucp_merchants (
  origin text PRIMARY KEY,
  state text NOT NULL DEFAULT 'pending',
  reason text,
  version text,
  transport text,
  endpoint text,
  capabilities text[] NOT NULL DEFAULT '{}'::text[],
  name text,
  search_text text NOT NULL DEFAULT '',
  trust_score real,
  recommendation text,
  review_count integer NOT NULL DEFAULT 0,
  trust_checked_at timestamptz,
  etag text,
  rules text,
  failures integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  usable_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ucp_merchants_state_check CHECK (state IN ('pending', 'usable', 'unusable')),
  CONSTRAINT ucp_merchants_transport_check CHECK (transport IS NULL OR transport IN ('mcp', 'rest')),
  CONSTRAINT ucp_merchants_trust_score_check CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 1))
);
CREATE INDEX IF NOT EXISTS ucp_merchants_due_idx ON ucp_merchants (next_check_at);
CREATE INDEX IF NOT EXISTS ucp_merchants_capabilities_idx ON ucp_merchants USING gin (capabilities);
CREATE INDEX IF NOT EXISTS ucp_merchants_search_idx
  ON ucp_merchants USING gin (to_tsvector('simple', coalesce(search_text, '')));
