package domain

// Person represents a canonical person entity in the person memory layer.
// Separate from contacts — not every remembered person is a contact.
type Person struct {
	PersonID         string           `json:"person_id"`
	CanonicalName    string           `json:"canonical_name,omitempty"`
	ContactDID       string           `json:"contact_did,omitempty"`
	RelationshipHint string           `json:"relationship_hint,omitempty"`
	Status           string           `json:"status"`       // suggested, confirmed
	CreatedFrom      string           `json:"created_from"` // llm, manual, imported
	CreatedAt        int64            `json:"created_at"`
	UpdatedAt        int64            `json:"updated_at"`
	Surfaces         []PersonSurface  `json:"surfaces,omitempty"`
}

// PersonSurface maps a surface form (name, role phrase, nickname) to a person.
type PersonSurface struct {
	ID                int64  `json:"id"`
	PersonID          string `json:"person_id"`
	Surface           string `json:"surface"`
	NormalizedSurface string `json:"normalized_surface"`
	SurfaceType       string `json:"surface_type"`       // name, role_phrase, nickname, alias
	Status            string `json:"status"`              // suggested, confirmed, rejected
	Confidence        string `json:"confidence"`          // high, medium, low
	SourceItemID      string `json:"source_item_id,omitempty"`
	SourceExcerpt     string `json:"source_excerpt,omitempty"`
	ExtractorVersion  string `json:"extractor_version"`
	CreatedFrom       string `json:"created_from"`       // llm, manual, imported
	CreatedAt         int64  `json:"created_at"`
	UpdatedAt         int64  `json:"updated_at"`
}

// Person status values.
const (
	PersonStatusSuggested = "suggested"
	PersonStatusConfirmed = "confirmed"
)

// Person surface status values.
const (
	SurfaceStatusSuggested = "suggested"
	SurfaceStatusConfirmed = "confirmed"
	SurfaceStatusRejected  = "rejected"
)

// ValidPersonConfidence are the accepted categorical confidence values for person surfaces.
var ValidPersonConfidence = map[string]bool{
	"high": true, "medium": true, "low": true,
}

// Valid surface types.
var ValidSurfaceTypes = map[string]bool{
	"name": true, "role_phrase": true, "nickname": true, "alias": true,
}

// Valid person created_from values.
var ValidPersonCreatedFrom = map[string]bool{
	"llm": true, "manual": true, "imported": true,
}

// ExtractionResult is the atomic write unit for person link extraction.
// One source item produces one ExtractionResult with potentially multiple
// person links, each with multiple surfaces.
type ExtractionResult struct {
	SourceItemID     string               `json:"source_item_id"`
	ExtractorVersion string               `json:"extractor_version"`
	Results          []ExtractionPersonLink `json:"results"`
}

// ExtractionPersonLink is one person learned from a source item.
type ExtractionPersonLink struct {
	CanonicalName    string                    `json:"canonical_name"`
	RelationshipHint string                    `json:"relationship_hint,omitempty"`
	Surfaces         []ExtractionSurfaceEntry  `json:"surfaces"`
	SourceExcerpt    string                    `json:"source_excerpt,omitempty"`
}

// ExtractionSurfaceEntry is one surface form in an extraction result.
type ExtractionSurfaceEntry struct {
	Surface     string `json:"surface"`
	SurfaceType string `json:"surface_type"`
	Confidence  string `json:"confidence"` // high, medium, low
}
