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
	// Relationship context (stored by nudge assembler / user notes)
	"relationship_note": true,
	// Decision records (Dina used Trust Network + vault context to recommend)
	"purchase_decision": true,
	"trust_review":      true,
}
