package domain

// MaxVaultItemSize is the maximum allowed size for a vault item body (10 MiB).
const MaxVaultItemSize = 10 * 1024 * 1024

// ValidVaultItemTypes lists the accepted vault_items.type values.
var ValidVaultItemTypes = map[string]bool{
	"email":         true,
	"message":       true,
	"event":         true,
	"note":          true,
	"photo":         true,
	"email_draft":   true,
	"cart_handover": true,
	"contact_card":  true,
	"document":      true,
	"bookmark":      true,
	"voice_memo":    true,
	"kv":            true,
	"contact":       true,
	// Personal context types (stored by Brain sync engine / user profile)
	"health_context":  true,
	"work_context":    true,
	"finance_context": true,
	"family_context":  true,
	// Medical records (clinical documents, prescriptions, provider notes)
	"medical_record": true,
	"medical_note":   true,
	// Relationship context (stored by nudge assembler / user notes)
	"relationship_note": true,
	// Decision records (Dina used Trust Network + vault context to recommend)
	"purchase_decision": true,
	"trust_review":      true,
	// Trust Network attestation records (stored by AppView sync / trust queries)
	"trust_attestation": true,
}

// ValidSenderTrust lists accepted sender_trust values.
var ValidSenderTrust = map[string]bool{
	"self": true, "contact_ring1": true, "contact_ring2": true,
	"unknown": true, "marketing": true, "": true,
}

// ValidSourceType lists accepted source_type values.
var ValidSourceType = map[string]bool{
	"self": true, "contact": true, "service": true,
	"unknown": true, "marketing": true, "": true,
}

// ValidConfidence lists accepted confidence values.
var ValidConfidence = map[string]bool{
	"high": true, "medium": true, "low": true, "unverified": true, "": true,
}

// ValidRetrievalPolicy lists accepted retrieval_policy values.
var ValidRetrievalPolicy = map[string]bool{
	"normal": true, "caveated": true, "quarantine": true, "briefing_only": true, "": true,
}

// SearchableRetrievalPolicies are the policies included in default searches.
// Quarantine and briefing_only are excluded unless explicitly requested.
var SearchableRetrievalPolicies = []string{"normal", "caveated"}

// ValidEnrichmentStatus lists accepted enrichment_status values.
var ValidEnrichmentStatus = map[string]bool{
	"pending": true, "processing": true, "ready": true, "failed": true, "": true,
}
