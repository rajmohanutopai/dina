-- Trust cache: local neighborhood for ingress gatekeeper
-- Applied as migration to identity.sqlite (one per installation).

CREATE TABLE IF NOT EXISTS trust_cache (
    did              TEXT PRIMARY KEY,
    display_name     TEXT NOT NULL DEFAULT '',
    trust_score      REAL NOT NULL DEFAULT 0.0
        CHECK (trust_score >= 0.0 AND trust_score <= 1.0),
    trust_ring       INTEGER NOT NULL DEFAULT 1
        CHECK (trust_ring IN (1, 2, 3)),
    relationship     TEXT NOT NULL DEFAULT 'unknown'
        CHECK (relationship IN ('contact','frequent','1-hop','2-hop','unknown')),
    source           TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual','appview_sync')),
    last_verified_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    updated_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_trust_cache_score ON trust_cache(trust_score);
CREATE INDEX IF NOT EXISTS idx_trust_cache_ring ON trust_cache(trust_ring);
