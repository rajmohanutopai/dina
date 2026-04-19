// Package domain — working-memory types.
//
// See docs/WORKING_MEMORY_DESIGN.md for the design. Topics are the
// salience-ranked handles that feed Dina's Table of Contents (ToC).
package domain

// TopicKind distinguishes entity topics (named proper nouns — people,
// places, organisations) from theme topics (recurring domains or
// common-noun phrases). The classifier prompt uses the kind to pick the
// right routing affordance; entities are typically unambiguous while
// themes may need canonicalisation to merge near-duplicates.
type TopicKind string

const (
	TopicKindEntity TopicKind = "entity"
	TopicKindTheme  TopicKind = "theme"
)

// IsValid reports whether k is one of the defined topic kinds. Used by
// the service layer to reject bad payloads before they reach SQL.
func (k TopicKind) IsValid() bool {
	return k == TopicKindEntity || k == TopicKindTheme
}

// Topic is one row of the per-persona salience index. The persona
// identity is implicit — each persona keeps its own SQLite database, so
// there is no `persona` column here.
//
// Capability bindings used to live here (LiveCapability,
// LiveProviderDID) but have been moved onto the Contact row
// (PreferredFor). Memory stores "what the user has talked about";
// contacts store "who the user goes to for what". AppView remains
// the source of truth for a DID's currently-published capabilities.
// See docs/WORKING_MEMORY_DESIGN.md §6.1.
type Topic struct {
	Topic        string    `json:"topic"`
	Kind         TopicKind `json:"kind"`
	LastUpdate   int64     `json:"last_update"`
	SShort       float64   `json:"s_short"`
	SLong        float64   `json:"s_long"`
	SampleItemID string    `json:"sample_item_id,omitempty"`
}

// TocEntry is what the ToC read endpoint returns — a Topic plus the
// persona it came from (added by the service layer after merging across
// unlocked personas) and its current salience (decay applied at read).
// JSON-serialised as the ToC payload Brain consumes.
type TocEntry struct {
	Persona      string    `json:"persona"`
	Topic        string    `json:"topic"`
	Kind         TopicKind `json:"kind"`
	Salience     float64   `json:"salience"`
	LastUpdate   int64     `json:"last_update"`
	SampleItemID string    `json:"sample_item_id,omitempty"`
}

// TopicAlias maps a surface-form variant to its canonical topic name.
// Lookup happens at extraction time before calling Touch so "tax plan"
// and "tax planning" collapse into a single salience row.
type TopicAlias struct {
	Variant   string `json:"variant"`
	Canonical string `json:"canonical"`
}

// Working-memory scoring constants. These are the EWMA timescales +
// mixing coefficient from §5 of the design doc; tunable once real-usage
// traces exist. Keeping them as package-level constants (not a config
// struct) because the values are load-bearing to the salience math and
// should change only with an accompanying doc update.
const (
	TopicTauShortDays float64 = 14  // "this week/fortnight" timescale
	TopicTauLongDays  float64 = 180 // "this half-year" timescale
	TopicShortMix     float64 = 0.3 // weight on s_short in the final salience
)
