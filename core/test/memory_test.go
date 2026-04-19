//go:build cgo

package test

import (
	"context"
	"math"
	"os"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// newMemoryTestPool boots a SQLCipher pool with one persona ("general")
// open, ready for Touch/Top/ResolveAlias. Everything teardown-managed
// by t.Cleanup.
func newMemoryTestPool(t *testing.T) *sqlite.Pool {
	t.Helper()
	dir, err := os.MkdirTemp("", "dina-memory-test-*")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	pool := sqlite.NewPool(dir)
	dek := make([]byte, 32)
	if err := pool.Open("general", dek); err != nil {
		t.Fatalf("open persona: %v", err)
	}
	t.Cleanup(func() { pool.Close("general") })
	return pool
}

// ---------------------------------------------------------------------------
// Touch + scoring math
// ---------------------------------------------------------------------------

// Touch on a fresh topic initialises both counters to 1 and stores
// last_update. This is the baseline insert case; everything else
// compounds from here.
func TestMemory_TouchFreshInsert(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	if store == nil {
		t.Fatal("TopicStoreFor returned nil for open persona")
	}
	ctx := context.Background()

	nowUnix := time.Date(2026, 4, 18, 0, 0, 0, 0, time.UTC).Unix()
	err := store.Touch(ctx, port.TouchRequest{
		Topic:        "HDFC FD",
		Kind:         domain.TopicKindEntity,
		NowUnix:      nowUnix,
		SampleItemID: "item-abc",
	})
	if err != nil {
		t.Fatalf("Touch: %v", err)
	}

	got, err := store.Get(ctx, "HDFC FD")
	if err != nil || got == nil {
		t.Fatalf("Get after Touch: err=%v, got=%v", err, got)
	}
	if got.SShort != 1.0 || got.SLong != 1.0 {
		t.Errorf("fresh counters: short=%f long=%f, want both 1.0", got.SShort, got.SLong)
	}
	if got.LastUpdate != nowUnix {
		t.Errorf("last_update=%d, want %d", got.LastUpdate, nowUnix)
	}
	if got.SampleItemID != "item-abc" {
		t.Errorf("sample_item_id=%q, want item-abc", got.SampleItemID)
	}
	if got.Kind != domain.TopicKindEntity {
		t.Errorf("kind=%q, want entity", got.Kind)
	}
}

// Touch with an elapsed gap must decay the existing counters before
// incrementing. Known input → expected output per the formula.
func TestMemory_TouchDecaysThenIncrements(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	ctx := context.Background()

	t0 := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC).Unix()
	if err := store.Touch(ctx, port.TouchRequest{
		Topic:   "daughters school",
		Kind:    domain.TopicKindTheme,
		NowUnix: t0,
	}); err != nil {
		t.Fatalf("first Touch: %v", err)
	}

	// Fast-forward 14 days — exactly one short-tau half-life.
	t1 := t0 + int64(14*86400)
	if err := store.Touch(ctx, port.TouchRequest{
		Topic:   "daughters school",
		Kind:    domain.TopicKindTheme,
		NowUnix: t1,
	}); err != nil {
		t.Fatalf("second Touch: %v", err)
	}

	got, err := store.Get(ctx, "daughters school")
	if err != nil || got == nil {
		t.Fatalf("Get: err=%v got=%v", err, got)
	}

	// Expected after 14-day gap:
	//   s_short = 1.0 * exp(-14/14) + 1 = e^-1 + 1 ≈ 1.3679
	//   s_long  = 1.0 * exp(-14/180) + 1 ≈ 0.9252 + 1 = 1.9252
	wantShort := math.Exp(-1) + 1.0
	wantLong := math.Exp(-14.0/180.0) + 1.0
	if math.Abs(got.SShort-wantShort) > 1e-6 {
		t.Errorf("s_short=%f, want %f", got.SShort, wantShort)
	}
	if math.Abs(got.SLong-wantLong) > 1e-6 {
		t.Errorf("s_long=%f, want %f", got.SLong, wantLong)
	}
}

// ---------------------------------------------------------------------------
// Top ranking
// ---------------------------------------------------------------------------

// Fresh recent mention outranks an old high-count topic on s_short but
// not necessarily on total salience — s_long dominates for topics with
// long history. Verifies the scoring coefficients produce the intended
// "working memory" behaviour from §5 of the design.
func TestMemory_TopRanking(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	ctx := context.Background()

	// Daughter: 20 mentions spread across a year (simulated by looping).
	daughterStart := time.Date(2025, 4, 18, 0, 0, 0, 0, time.UTC).Unix()
	for i := 0; i < 20; i++ {
		ts := daughterStart + int64(i*15*86400) // one mention every 15 days
		if err := store.Touch(ctx, port.TouchRequest{
			Topic:   "daughter",
			Kind:    domain.TopicKindEntity,
			NowUnix: ts,
		}); err != nil {
			t.Fatalf("daughter Touch %d: %v", i, err)
		}
	}

	// Transient trip: 5 mentions last week.
	nowUnix := time.Date(2026, 4, 18, 0, 0, 0, 0, time.UTC).Unix()
	tripStart := nowUnix - int64(7*86400)
	for i := 0; i < 5; i++ {
		ts := tripStart + int64(i*86400)
		if err := store.Touch(ctx, port.TouchRequest{
			Topic:   "Tokyo trip",
			Kind:    domain.TopicKindEntity,
			NowUnix: ts,
		}); err != nil {
			t.Fatalf("trip Touch %d: %v", i, err)
		}
	}

	// Dormant topic: two mentions a year ago, nothing since.
	dormantStart := nowUnix - int64(365*86400)
	for i := 0; i < 2; i++ {
		ts := dormantStart + int64(i*86400)
		if err := store.Touch(ctx, port.TouchRequest{
			Topic:   "2024 course",
			Kind:    domain.TopicKindTheme,
			NowUnix: ts,
		}); err != nil {
			t.Fatalf("dormant Touch %d: %v", i, err)
		}
	}

	top, err := store.Top(ctx, 10, nowUnix)
	if err != nil {
		t.Fatalf("Top: %v", err)
	}
	if len(top) != 3 {
		t.Fatalf("Top returned %d, want 3: %+v", len(top), top)
	}

	// Expect Tokyo trip (high s_short recent burst) and daughter (strong
	// s_long anchor) both above "2024 course" (decayed to near-zero on
	// both counters).
	lastIdx := -1
	for i, tp := range top {
		if tp.Topic == "2024 course" {
			lastIdx = i
		}
	}
	if lastIdx != 2 {
		t.Errorf("dormant topic should be last, got position %d in %+v", lastIdx, top)
	}
}

// Top with a limit smaller than the topic count returns only the highest-
// scored entries, preserving descending order.
func TestMemory_TopHonoursLimit(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	ctx := context.Background()
	nowUnix := time.Date(2026, 4, 18, 0, 0, 0, 0, time.UTC).Unix()

	for i, name := range []string{"alpha", "beta", "gamma", "delta", "epsilon"} {
		// Give earlier names more mentions so they rank higher.
		count := 5 - i
		for j := 0; j < count; j++ {
			ts := nowUnix - int64(j*86400)
			if err := store.Touch(ctx, port.TouchRequest{
				Topic:   name,
				Kind:    domain.TopicKindEntity,
				NowUnix: ts,
			}); err != nil {
				t.Fatalf("Touch %s: %v", name, err)
			}
		}
	}

	top, err := store.Top(ctx, 3, nowUnix)
	if err != nil {
		t.Fatalf("Top: %v", err)
	}
	if len(top) != 3 {
		t.Fatalf("limit=3 but got %d entries", len(top))
	}
	if top[0].Topic != "alpha" || top[1].Topic != "beta" || top[2].Topic != "gamma" {
		t.Errorf("unexpected ranking: %s > %s > %s (want alpha beta gamma)",
			top[0].Topic, top[1].Topic, top[2].Topic)
	}
}

// ---------------------------------------------------------------------------
// Alias canonicalisation
// ---------------------------------------------------------------------------

// ResolveAlias returns the variant itself when there's no mapping —
// first sight of a new topic makes it its own canonical.
func TestMemory_AliasUnknownReturnsInput(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	ctx := context.Background()

	got, err := store.ResolveAlias(ctx, "dentist appointment")
	if err != nil {
		t.Fatalf("ResolveAlias: %v", err)
	}
	if got != "dentist appointment" {
		t.Errorf("unknown variant: got %q, want passthrough", got)
	}
}

// Exact-match alias lookup is tier 1.
func TestMemory_AliasExactMatch(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	ctx := context.Background()

	if err := store.PutAlias(ctx, "tax filing", "tax planning"); err != nil {
		t.Fatalf("PutAlias: %v", err)
	}
	got, err := store.ResolveAlias(ctx, "tax filing")
	if err != nil {
		t.Fatalf("ResolveAlias: %v", err)
	}
	if got != "tax planning" {
		t.Errorf("exact match: got %q, want tax planning", got)
	}
}

// Stem-based canonicalisation: "tax planning" finds existing canonical
// "tax plan" via the stemLite normaliser.
func TestMemory_AliasStemMatch(t *testing.T) {
	pool := newMemoryTestPool(t)
	store := pool.TopicStoreFor("general")
	ctx := context.Background()

	// Pre-seed the canonical by touching it once.
	nowUnix := time.Now().Unix()
	if err := store.Touch(ctx, port.TouchRequest{
		Topic:   "tax plan",
		Kind:    domain.TopicKindTheme,
		NowUnix: nowUnix,
	}); err != nil {
		t.Fatalf("seed Touch: %v", err)
	}

	// "tax planning" stems to "tax plan" → should resolve to the seeded
	// canonical.
	got, err := store.ResolveAlias(ctx, "tax planning")
	if err != nil {
		t.Fatalf("ResolveAlias: %v", err)
	}
	if got != "tax plan" {
		t.Errorf("stem match: got %q, want tax plan", got)
	}
}

// ---------------------------------------------------------------------------
// Live capability propagation
// ---------------------------------------------------------------------------

// Note: a previous test (TestMemory_LiveCapabilityPersists) locked
// the live_capability + live_provider_did columns being round-tripped
// through Touch. Those fields were retired — capability bindings now
// live on contacts via preferred_for. The columns remain in the
// schema as dead storage (SQLite 3.33 lacks DROP COLUMN) but are
// neither read nor written. Coverage for the replacement path lives
// in brain/tests/test_preference_extractor.py and
// core/test/contact_preferred_for_test.go.

// ---------------------------------------------------------------------------
// Cross-persona ToC merge (MemoryService)
// ---------------------------------------------------------------------------

// MemoryService.Toc walks every persona the provider exposes and
// returns a single ranked list. Locked personas (provider returns nil)
// are silently skipped.
func TestMemoryService_MergesAcrossPersonas(t *testing.T) {
	pool := newMemoryTestPool(t)
	// Open a second persona so we can distribute topics across them.
	if err := pool.Open("health", make([]byte, 32)); err != nil {
		t.Fatalf("open health: %v", err)
	}
	t.Cleanup(func() { pool.Close("health") })

	ctx := context.Background()
	nowUnix := time.Now().Unix()

	// general persona: one high-salience topic.
	genStore := pool.TopicStoreFor("general")
	for i := 0; i < 10; i++ {
		if err := genStore.Touch(ctx, port.TouchRequest{
			Topic:   "daughters school",
			Kind:    domain.TopicKindTheme,
			NowUnix: nowUnix - int64(i*86400),
		}); err != nil {
			t.Fatalf("general Touch: %v", err)
		}
	}

	// health persona: another topic.
	hStore := pool.TopicStoreFor("health")
	for i := 0; i < 5; i++ {
		if err := hStore.Touch(ctx, port.TouchRequest{
			Topic:   "knee pain",
			Kind:    domain.TopicKindTheme,
			NowUnix: nowUnix - int64(i*86400),
		}); err != nil {
			t.Fatalf("health Touch: %v", err)
		}
	}

	mem := service.NewMemoryService(pool, memoryTestClock{now: time.Unix(nowUnix, 0)})
	entries, err := mem.Toc(ctx, []string{"general", "health", "financial_locked"}, 10)
	if err != nil {
		t.Fatalf("Toc: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries (locked persona skipped), got %d: %+v", len(entries), entries)
	}
	// Both entries present, ranked by salience.
	personas := []string{entries[0].Persona, entries[1].Persona}
	have := map[string]bool{}
	for _, p := range personas {
		have[p] = true
	}
	if !have["general"] || !have["health"] {
		t.Errorf("missing persona in merged ToC: %+v", entries)
	}
}

// memoryTestClock — tiny port.Clock for deterministic test timing.
type memoryTestClock struct{ now time.Time }

func (c memoryTestClock) Now() time.Time                            { return c.now }
func (c memoryTestClock) After(d time.Duration) <-chan time.Time    { return time.After(d) }
func (c memoryTestClock) NewTicker(d time.Duration) *time.Ticker    { return time.NewTicker(d) }
