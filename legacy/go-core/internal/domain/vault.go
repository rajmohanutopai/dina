package domain

import "github.com/rajmohanutopai/dina/core/internal/gen"

// VaultItem is the canonical vault item type, generated from the OpenAPI spec.
// All code uses domain.VaultItem — the alias ensures a single type definition.
type VaultItem = gen.VaultItem

// SearchMode defines the type of vault search.
type SearchMode string

const (
	SearchFTS5     SearchMode = "fts5"
	SearchSemantic SearchMode = "semantic"
	SearchHybrid   SearchMode = "hybrid"
)

// Search limit bounds (DM3). Handlers should use ClampSearchLimit().
const (
	MinSearchLimit     = 1
	MaxSearchLimit     = 100
	DefaultSearchLimit = 50
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
	// Source trust filtering. Default search excludes quarantine + briefing_only.
	// Set IncludeAll=true to return everything regardless of retrieval_policy.
	IncludeAll      bool   // override: return all policies
	RetrievalPolicy string // filter to a specific policy (e.g. "quarantine")
}

// ClampSearchLimit enforces [MinSearchLimit, MaxSearchLimit] bounds on a limit value.
// DM3: Prevents unbounded queries at the domain level.
func ClampSearchLimit(limit int) int {
	if limit <= 0 {
		return DefaultSearchLimit
	}
	if limit > MaxSearchLimit {
		return MaxSearchLimit
	}
	return limit
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
