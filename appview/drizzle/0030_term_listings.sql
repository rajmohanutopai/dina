-- Term listings (docs/SHELF_SPACE_NEGOTIATION.md §6.1).
--
-- Hand-written to match `src/db/schema/term-listings.ts`; keep the two equal.

CREATE TABLE IF NOT EXISTS term_listings (
  uri text PRIMARY KEY,
  seller_did text NOT NULL,
  listing_id text NOT NULL,
  cid text,
  listing_digest text NOT NULL,
  pack_id text NOT NULL,
  schema_major integer NOT NULL,
  resource_ref text NOT NULL,
  kind text NOT NULL,
  region_scheme text NOT NULL,
  region_value text NOT NULL,
  available_from timestamptz NOT NULL,
  available_to timestamptz NOT NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  record_json jsonb NOT NULL,
  repo_rev text,
  indexed_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS term_listings_seller_idx ON term_listings (seller_did);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS term_listings_region_idx ON term_listings (region_scheme, region_value);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS term_listings_available_idx ON term_listings (available_from, available_to);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS term_listings_tags_idx ON term_listings USING gin (tags);
