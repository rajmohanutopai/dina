-- HIGH-08: Add tsvector generated column + GIN index for full-text search.
-- The search_vector column is automatically populated from search_content.
ALTER TABLE attestations ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_attestations_search ON attestations USING GIN (search_vector);
