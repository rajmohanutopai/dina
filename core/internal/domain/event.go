package domain

// TaskEvent represents an event sent to the brain for processing.
type TaskEvent struct {
	TaskID  string                 `json:"task_id"`
	Type    string                 `json:"type"` // "process", "reason"
	Payload map[string]interface{} `json:"payload"`
}

// ReasonResult holds the brain's response to a complex query.
// When Status is "pending_approval", the request is waiting for persona
// approval and Content is empty. The handler creates a PendingReasonRecord
// and returns 202 to the caller.
type ReasonResult struct {
	Content          string `json:"content"`
	Model            string `json:"model,omitempty"`
	TokensIn         int    `json:"tokens_in,omitempty"`
	TokensOut        int    `json:"tokens_out,omitempty"`
	VaultContextUsed bool   `json:"vault_context_used,omitempty"`
	// Async approval fields — populated only on 202 from Brain
	Status     string `json:"status,omitempty"`
	ApprovalID string `json:"approval_id,omitempty"`
	Persona    string `json:"persona,omitempty"`
	Message    string `json:"message,omitempty"`
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
