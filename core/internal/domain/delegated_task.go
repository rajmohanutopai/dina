package domain

// DelegatedTaskStatus represents the lifecycle state of a delegated task.
type DelegatedTaskStatus string

const (
	DelegatedCreated         DelegatedTaskStatus = "created"
	DelegatedPendingApproval DelegatedTaskStatus = "pending_approval"
	DelegatedQueued          DelegatedTaskStatus = "queued"
	DelegatedClaimed         DelegatedTaskStatus = "claimed"
	DelegatedRunning         DelegatedTaskStatus = "running"
	DelegatedCompleted       DelegatedTaskStatus = "completed"
	DelegatedFailed          DelegatedTaskStatus = "failed"
	DelegatedCancelled       DelegatedTaskStatus = "cancelled"
	DelegatedExpired         DelegatedTaskStatus = "expired"
)

// DelegatedTask represents a task delegated to an external agent runtime.
// Runner-agnostic: Core does not know which runner (OpenClaw, Hermes, etc.) executes.
type DelegatedTask struct {
	ID              string              `json:"id"`
	ProposalID      string              `json:"proposal_id"`
	SessionName     string              `json:"session_name"`     // set by Core inside Claim ("task-" + id)
	Description     string              `json:"description"`
	Origin          string              `json:"origin"`           // "telegram", "admin", "cli", "api"
	Status          DelegatedTaskStatus `json:"status"`
	AgentDID        string              `json:"agent_did"`        // who claimed it
	LeaseExpiresAt  int64               `json:"lease_expires_at"`
	RunID           string              `json:"run_id"`           // runner-assigned execution id
	RequestedRunner string              `json:"requested_runner"` // what the caller asked for: "openclaw", "hermes", "auto"
	AssignedRunner  string              `json:"assigned_runner"`  // what the daemon actually used
	IdempotencyKey  string              `json:"idempotency_key"`
	ResultSummary   string              `json:"result_summary"`
	ProgressNote    string              `json:"progress_note"`
	Error           string              `json:"error"`
	CreatedAt       int64               `json:"created_at"`
	UpdatedAt       int64               `json:"updated_at"`
}
