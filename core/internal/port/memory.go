package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// TopicStore is the persistence interface for the per-persona
// salience index. One implementation per persona, selected by the
// service layer from the SQLCipher pool. All methods operate on the
// persona implied by the concrete instance — no persona parameter.
//
// TouchRequest is idempotent under retries: repeated calls with the
// same (topic, kind) correctly compound the EWMA counters against the
// elapsed time since the previous touch.
type TopicStore interface {
	// Touch updates-or-inserts a topic with EWMA decay applied against
	// `now`. The caller already resolved the surface form to its
	// canonical name via ResolveAlias. `liveCapability`,
	// `liveProviderDID`, `sampleItemID` are stored when non-empty and
	// overwrite prior values; pass empty strings to leave unchanged.
	Touch(ctx context.Context, req TouchRequest) error

	// Top returns up to `limit` topics ranked by decayed salience
	// (`s_long + 0.3 * s_short` at `nowUnix`), descending. Used by
	// the ToC render; intent classifier reads the result, reasoning
	// agent doesn't.
	Top(ctx context.Context, limit int, nowUnix int64) ([]domain.Topic, error)

	// Get returns a single topic by canonical name, nil if absent.
	// Primarily for the Salience read path and tests.
	Get(ctx context.Context, topic string) (*domain.Topic, error)

	// ResolveAlias returns the canonical topic name for a surface-form
	// variant, or the variant itself if no mapping exists. The caller
	// uses the result as the key for Touch / Get.
	ResolveAlias(ctx context.Context, variant string) (string, error)

	// PutAlias registers variant → canonical. Used during alias
	// promotion (§6.2 of the design doc).
	PutAlias(ctx context.Context, variant, canonical string) error
}

// TouchRequest is the payload passed to TopicStore.Touch. Defining it
// as a struct keeps the interface stable as we grow optional fields
// (embedding hashes for V2 similarity matching, etc.) without churning
// call sites.
type TouchRequest struct {
	Topic           string
	Kind            domain.TopicKind
	NowUnix         int64
	LiveCapability  string
	LiveProviderDID string
	SampleItemID    string
}

// MemoryReader is the cross-persona read surface used by the HTTP
// handler and the ToC render. Implementations walk a set of unlocked
// persona stores and merge the results.
type MemoryReader interface {
	// Toc returns up to `limit` topics across the named personas,
	// ranked by decayed salience. Locked or absent personas are
	// skipped silently.
	Toc(ctx context.Context, personas []string, limit int) ([]domain.TocEntry, error)
}
