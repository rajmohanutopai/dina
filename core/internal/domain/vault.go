package domain

// VaultItem represents an item stored in a persona's SQLCipher vault.
// Tests use testutil.VaultItem directly; this type is for internal domain logic.
type VaultItem struct {
	ID         string    `json:"id,omitempty"`
	Type       string    `json:"type"`
	Source     string    `json:"source"`
	SourceID   string    `json:"source_id"`
	ContactDID string    `json:"contact_did"`
	Summary    string    `json:"summary"`
	BodyText   string    `json:"body_text"`
	Timestamp  int64     `json:"timestamp"`
	IngestedAt int64     `json:"ingested_at"`
	Metadata   string    `json:"metadata"`                // JSON blob
	Embedding  []float32 `json:"embedding,omitempty"`      // 768-dim float32, nil when not computed
	// Source trust & provenance
	Sender          string `json:"sender"`           // who sent/created: email, "user", DID
	SenderTrust     string `json:"sender_trust"`     // self, contact_ring1, contact_ring2, unknown, marketing
	SourceType      string `json:"source_type"`      // self, contact, service, unknown, marketing
	Confidence      string `json:"confidence"`       // high, medium, low, unverified
	RetrievalPolicy string `json:"retrieval_policy"` // normal, caveated, quarantine, briefing_only
	Contradicts     string `json:"contradicts"`      // ID of contradicted item, or empty
	// Tiered content (L0/L1/L2)
	ContentL0         string `json:"content_l0"`         // one-line abstract
	ContentL1         string `json:"content_l1"`         // one-paragraph overview
	EnrichmentStatus  string `json:"enrichment_status"`  // pending, processing, ready, failed
	EnrichmentVersion string `json:"enrichment_version"` // JSON: {"prompt_v":1,"embed_model":"gemma-3n"}
	// Ingestion lineage (from staging pipeline)
	StagingID   string `json:"staging_id,omitempty"`   // ID of the staging_inbox item that produced this
	ConnectorID string `json:"connector_id,omitempty"` // which connector/account ingested this
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
	// Source trust filtering. Default search excludes quarantine + briefing_only.
	// Set IncludeAll=true to return everything regardless of retrieval_policy.
	IncludeAll      bool   // override: return all policies
	RetrievalPolicy string // filter to a specific policy (e.g. "quarantine")
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
