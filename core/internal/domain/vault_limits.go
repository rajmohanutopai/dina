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
	"kv":            true,
	"contact":       true,
}
