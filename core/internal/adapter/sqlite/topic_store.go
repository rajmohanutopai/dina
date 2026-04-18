//go:build cgo

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

var _ port.TopicStore = (*SQLiteTopicStore)(nil)

// SQLiteTopicStore persists the working-memory salience index for a
// single persona. The persona is identified by the SQLite DB it was
// constructed against; there is no persona column in the table.
type SQLiteTopicStore struct {
	db      *sql.DB
	persona string
}

// NewSQLiteTopicStore returns a topic store backed by the given
// per-persona SQLCipher database. Caller is responsible for holding a
// live DB handle (persona must be unlocked).
func NewSQLiteTopicStore(db *sql.DB, persona string) *SQLiteTopicStore {
	return &SQLiteTopicStore{db: db, persona: persona}
}

// Persona reports which persona this store is bound to — used by the
// reader aggregator when it assembles cross-persona ToC entries.
func (s *SQLiteTopicStore) Persona() string {
	return s.persona
}

// Touch applies EWMA decay to the stored counters, increments both by
// one, and writes back. On first sight of a topic, inserts a fresh row.
// Called once per extracted-topic mention during ingest.
func (s *SQLiteTopicStore) Touch(ctx context.Context, req port.TouchRequest) error {
	if req.Topic == "" {
		return fmt.Errorf("topic_store.Touch: empty topic")
	}
	if !req.Kind.IsValid() {
		return fmt.Errorf("topic_store.Touch: invalid kind %q", req.Kind)
	}
	if req.NowUnix <= 0 {
		return fmt.Errorf("topic_store.Touch: invalid NowUnix %d", req.NowUnix)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("topic_store.Touch: begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Read existing row (if any).
	var (
		lastUpdate int64
		sShort     float64
		sLong      float64
		liveCap    string
		liveDID    string
		sampleID   string
	)
	err = tx.QueryRowContext(ctx,
		`SELECT last_update, s_short, s_long, live_capability, live_provider_did, sample_item_id
		 FROM topic_salience WHERE topic = ?`, req.Topic,
	).Scan(&lastUpdate, &sShort, &sLong, &liveCap, &liveDID, &sampleID)

	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("topic_store.Touch: read: %w", err)
	}

	// Decay existing counters against elapsed time, then increment by 1.
	if err == sql.ErrNoRows {
		sShort = 1.0
		sLong = 1.0
	} else {
		dtDays := float64(req.NowUnix-lastUpdate) / 86400.0
		if dtDays < 0 {
			dtDays = 0 // clock skew — don't amplify
		}
		sShort = sShort*math.Exp(-dtDays/domain.TopicTauShortDays) + 1.0
		sLong = sLong*math.Exp(-dtDays/domain.TopicTauLongDays) + 1.0
	}

	// Merge optional fields: overwrite with new value only when non-empty.
	if req.LiveCapability != "" {
		liveCap = req.LiveCapability
	}
	if req.LiveProviderDID != "" {
		liveDID = req.LiveProviderDID
	}
	if req.SampleItemID != "" {
		sampleID = req.SampleItemID
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO topic_salience
		    (topic, kind, last_update, s_short, s_long,
		     live_capability, live_provider_did, sample_item_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(topic) DO UPDATE SET
		    kind = excluded.kind,
		    last_update = excluded.last_update,
		    s_short = excluded.s_short,
		    s_long = excluded.s_long,
		    live_capability = excluded.live_capability,
		    live_provider_did = excluded.live_provider_did,
		    sample_item_id = excluded.sample_item_id`,
		req.Topic, string(req.Kind), req.NowUnix, sShort, sLong,
		liveCap, liveDID, sampleID,
	)
	if err != nil {
		return fmt.Errorf("topic_store.Touch: upsert: %w", err)
	}
	return tx.Commit()
}

// Top returns topics ranked by decayed salience at nowUnix.
//
// Decay is applied Go-side, not in SQL: SQLCipher v4.4.2 bundles SQLite
// 3.33.0, which predates the math-functions build flag (3.35+). Fetching
// all rows and sorting in Go is fine here — the design caps topics at
// ~500 per persona (§12), well under anything the sort would notice.
//
// To keep this bounded if the cap is ever relaxed, the query uses the
// `idx_topic_salience_long` index to pre-filter on the stored `s_long`
// value (the dominant salience term for non-bursty topics), pulling a
// bounded candidate set rather than the full table.
func (s *SQLiteTopicStore) Top(ctx context.Context, limit int, nowUnix int64) ([]domain.Topic, error) {
	if limit <= 0 {
		return nil, nil
	}

	// Prefilter: pull the top `candidateLimit` by stored s_long. Bursty
	// topics (high s_short, low s_long) may rank above some of these
	// after decay, so the candidate set is deliberately wider than
	// `limit`. 4x limit + 50 gives headroom without unbounded scans.
	candidateLimit := limit*4 + 50

	rows, err := s.db.QueryContext(ctx,
		`SELECT topic, kind, last_update, s_short, s_long,
		        live_capability, live_provider_did, sample_item_id
		 FROM topic_salience
		 ORDER BY s_long DESC, s_short DESC
		 LIMIT ?`,
		candidateLimit,
	)
	if err != nil {
		return nil, fmt.Errorf("topic_store.Top: query: %w", err)
	}
	defer rows.Close()

	var topics []domain.Topic
	var scores []float64
	for rows.Next() {
		var (
			t       domain.Topic
			kindStr string
		)
		if err := rows.Scan(
			&t.Topic, &kindStr, &t.LastUpdate, &t.SShort, &t.SLong,
			&t.LiveCapability, &t.LiveProviderDID, &t.SampleItemID,
		); err != nil {
			return nil, fmt.Errorf("topic_store.Top: scan: %w", err)
		}
		t.Kind = domain.TopicKind(kindStr)
		topics = append(topics, t)
		scores = append(scores, computeSalience(t, nowUnix))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("topic_store.Top: iter: %w", err)
	}

	// Sort both slices together, descending by salience.
	indexes := make([]int, len(topics))
	for i := range indexes {
		indexes[i] = i
	}
	sort.SliceStable(indexes, func(i, j int) bool {
		return scores[indexes[i]] > scores[indexes[j]]
	})

	if limit > len(indexes) {
		limit = len(indexes)
	}
	out := make([]domain.Topic, 0, limit)
	for _, idx := range indexes[:limit] {
		out = append(out, topics[idx])
	}
	return out, nil
}

// computeSalience — see §5 of the design. Go-side because SQLCipher
// v4.4.2 lacks exp() at the SQL layer.
func computeSalience(t domain.Topic, nowUnix int64) float64 {
	dtDays := float64(nowUnix-t.LastUpdate) / 86400.0
	if dtDays < 0 {
		dtDays = 0
	}
	return t.SLong*math.Exp(-dtDays/domain.TopicTauLongDays) +
		domain.TopicShortMix*t.SShort*math.Exp(-dtDays/domain.TopicTauShortDays)
}

// Get returns a single topic by canonical name, nil on miss.
func (s *SQLiteTopicStore) Get(ctx context.Context, topic string) (*domain.Topic, error) {
	var (
		t       domain.Topic
		kindStr string
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT topic, kind, last_update, s_short, s_long,
		        live_capability, live_provider_did, sample_item_id
		 FROM topic_salience WHERE topic = ?`, topic,
	).Scan(
		&t.Topic, &kindStr, &t.LastUpdate, &t.SShort, &t.SLong,
		&t.LiveCapability, &t.LiveProviderDID, &t.SampleItemID,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("topic_store.Get: %w", err)
	}
	t.Kind = domain.TopicKind(kindStr)
	return &t, nil
}

// ResolveAlias returns the canonical form for a variant, falling back
// to the variant itself if no mapping exists. The fallback matters:
// extraction calls ResolveAlias before Touch, so an unknown variant
// gets promoted to its own canonical on first sight.
//
// Matching tiers (§6.2 of the design):
//  1. exact lookup on `variant`
//  2. lowercase + simple-stem lookup
//  3. if neither, return the input unchanged
//
// Embedding-similarity matching is V2 (§13 open question #1).
func (s *SQLiteTopicStore) ResolveAlias(ctx context.Context, variant string) (string, error) {
	if variant == "" {
		return "", nil
	}

	// Tier 1: exact.
	if c, ok, err := s.lookupAlias(ctx, variant); err != nil {
		return "", err
	} else if ok {
		return c, nil
	}

	// Tier 2: lowercase-stemmed. Stemming here is the lightest-possible
	// normalisation — lowercase + trim + strip trailing "s"/"ing" — so
	// "tax Planning" and "tax plans" collapse without pulling in a full
	// stemming library for V1.
	stem := stemLite(variant)
	if stem != variant {
		if c, ok, err := s.lookupAlias(ctx, stem); err != nil {
			return "", err
		} else if ok {
			return c, nil
		}
	}

	// Tier 2b: check if any existing canonical matches the stem.
	// Prevents "tax planning" from creating a new canonical when
	// "tax plan" already exists.
	var canonical string
	err := s.db.QueryRowContext(ctx,
		`SELECT topic FROM topic_salience WHERE topic = ? LIMIT 1`, stem,
	).Scan(&canonical)
	if err == nil {
		// Existing canonical matches the stem — register the alias.
		if stem != variant {
			_ = s.PutAlias(ctx, variant, canonical)
		}
		return canonical, nil
	}
	if err != sql.ErrNoRows {
		return "", fmt.Errorf("topic_store.ResolveAlias: canonical lookup: %w", err)
	}

	// Tier 3: new canonical. Variant becomes its own canonical on next
	// Touch. Don't register an alias row yet — waste of a row when
	// variant == canonical.
	return variant, nil
}

// PutAlias registers a variant → canonical mapping. Idempotent.
func (s *SQLiteTopicStore) PutAlias(ctx context.Context, variant, canonical string) error {
	if variant == "" || canonical == "" {
		return fmt.Errorf("topic_store.PutAlias: empty variant or canonical")
	}
	if variant == canonical {
		return nil // no-op; variant already resolves to itself
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO topic_aliases (variant, canonical) VALUES (?, ?)
		 ON CONFLICT(variant) DO UPDATE SET canonical = excluded.canonical`,
		variant, canonical,
	)
	if err != nil {
		return fmt.Errorf("topic_store.PutAlias: %w", err)
	}
	return nil
}

func (s *SQLiteTopicStore) lookupAlias(ctx context.Context, variant string) (string, bool, error) {
	var canonical string
	err := s.db.QueryRowContext(ctx,
		`SELECT canonical FROM topic_aliases WHERE variant = ? LIMIT 1`, variant,
	).Scan(&canonical)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("lookup alias: %w", err)
	}
	return canonical, true, nil
}

// stemLite is a deliberately minimal normaliser. Lowercase, trim
// whitespace, strip one of a small set of common English suffixes,
// and drop a trailing doubled consonant when one is revealed (so
// "planning" → "plann" → "plan"). Good enough for V1 "tax plan" /
// "tax planning" collapse; wrong for any non-English corpus, which
// is a V2 concern.
func stemLite(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))

	// Tier A: -ing / -ings — strip, then drop doubled consonant.
	for _, suf := range []string{"ings", "ing"} {
		if strings.HasSuffix(s, suf) && len(s) > len(suf)+2 {
			s = s[:len(s)-len(suf)]
			if len(s) >= 2 && s[len(s)-1] == s[len(s)-2] && isConsonant(s[len(s)-1]) {
				s = s[:len(s)-1]
			}
			return s
		}
	}

	// Tier B: -ers / -er / -s — simple strip.
	for _, suf := range []string{"ers", "er", "s"} {
		if strings.HasSuffix(s, suf) && len(s) > len(suf)+2 {
			return s[:len(s)-len(suf)]
		}
	}
	return s
}

func isConsonant(c byte) bool {
	switch c {
	case 'a', 'e', 'i', 'o', 'u', 'y':
		return false
	}
	return c >= 'a' && c <= 'z'
}
