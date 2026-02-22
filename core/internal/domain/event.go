package domain

// TaskEvent represents an event sent to the brain for processing.
type TaskEvent struct {
	TaskID  string
	Type    string // "process", "reason"
	Payload map[string]interface{}
}

// ReasonResult holds the brain's response to a complex query.
type ReasonResult struct {
	Answer  string
	Sources []string
	Tier    int // 1 = interrupt, 2 = notify, 3 = silent queue
}

// VaultEventType classifies vault state transitions.
type VaultEventType string

const (
	VaultUnlocked     VaultEventType = "unlocked"
	VaultLocked       VaultEventType = "locked"
	VaultPersonaOpen  VaultEventType = "persona_opened"
	VaultPersonaClose VaultEventType = "persona_closed"
)

// VaultEvent is emitted when vault state changes (observer pattern).
type VaultEvent struct {
	Type    VaultEventType
	Persona PersonaName
}
