package domain

// DelegatedTaskStatus represents the lifecycle state of a delegated task.
type DelegatedTaskStatus string

const (
	DelegatedCreated         DelegatedTaskStatus = "created"
	DelegatedPendingApproval DelegatedTaskStatus = "pending_approval"
	DelegatedQueued          DelegatedTaskStatus = "queued"
	DelegatedClaimed         DelegatedTaskStatus = "claimed"
	DelegatedRunning         DelegatedTaskStatus = "running"   // v1: not used (forward compat)
	DelegatedCompleted       DelegatedTaskStatus = "completed"
	DelegatedFailed          DelegatedTaskStatus = "failed"
	DelegatedCancelled       DelegatedTaskStatus = "cancelled"
	DelegatedExpired         DelegatedTaskStatus = "expired"
)

// DelegatedTask represents a task delegated to an external agent (e.g. OpenClaw).
// Separate from the internal Task queue (dina_tasks) which handles Core↔Brain plumbing.
type DelegatedTask struct {
	ID             string              `json:"id"`
	ProposalID     string              `json:"proposal_id"`
	SessionName    string              `json:"session_name"`    // set by Core inside Claim ("task-" + id)
	Description    string              `json:"description"`
	Origin         string              `json:"origin"`          // "telegram", "admin", "cli", "api"
	Status         DelegatedTaskStatus `json:"status"`
	AgentDID       string              `json:"agent_did"`       // who claimed it
	LeaseExpiresAt int64               `json:"lease_expires_at"`
	RunID          string              `json:"run_id"`          // v1: not used (forward compat)
	IdempotencyKey string              `json:"idempotency_key"`
	ResultSummary  string              `json:"result_summary"`
	ProgressNote   string              `json:"progress_note"`
	Error          string              `json:"error"`
	CreatedAt      int64               `json:"created_at"`
	UpdatedAt      int64               `json:"updated_at"`
}
