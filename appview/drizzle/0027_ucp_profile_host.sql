-- The UCP profile host (docs/UCP_IMPLEMENTATION_PLAN.md §3.5).
--
-- Hand-written to match `src/db/schema/ucp.ts`; keep the two equal.

CREATE TABLE IF NOT EXISTS ucp_profile_labels (
  label text PRIMARY KEY,
  did text NOT NULL,
  revision bigint NOT NULL,
  -- The whole LabelState as JSON text (not jsonb: the served bytes come back exact).
  state_json text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
