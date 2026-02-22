package domain

// VaultItem represents an item stored in a persona's SQLCipher vault.
// Tests use testutil.VaultItem directly; this type is for internal domain logic.
type VaultItem struct {
	ID         string
	Type       string // email, message, event, note, photo
	Source     string
	SourceID   string
	ContactDID string
	Summary    string
	BodyText   string
	Timestamp  int64
	IngestedAt int64
	Metadata   string // JSON blob
}

// SearchMode defines the type of vault search.
type SearchMode string

const (
	SearchFTS5     SearchMode = "fts5"
	SearchSemantic SearchMode = "semantic"
	SearchHybrid   SearchMode = "hybrid"
)

// SearchQuery holds search parameters for vault queries.
type SearchQuery struct {
	Mode           SearchMode
	Query          string
	Embedding      []float32
	Types          []string
	After          int64
	Before         int64
	IncludeContent bool
	Limit          int
	Offset         int
}

// VaultAuditEntry represents a single entry in the append-only audit log.
type VaultAuditEntry struct {
	ID        int64
	Timestamp string
	Persona   string
	Action    string
	Requester string
	QueryType string
	Reason    string
	Metadata  string // JSON blob
	PrevHash  string // hash chain integrity
}

// VaultAuditFilter holds query parameters for audit log searches.
type VaultAuditFilter struct {
	Action    string
	Persona   string
	After     string // ISO 8601
	Before    string // ISO 8601
	Requester string
	Limit     int
}
