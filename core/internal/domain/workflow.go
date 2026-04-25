package domain

// WorkflowTaskState represents the lifecycle state of a workflow task.
type WorkflowTaskState string

const (
	WFCreated         WorkflowTaskState = "created"
	WFPending         WorkflowTaskState = "pending"
	WFQueued          WorkflowTaskState = "queued"
	WFClaimed         WorkflowTaskState = "claimed"
	WFRunning         WorkflowTaskState = "running"
	WFAwaiting        WorkflowTaskState = "awaiting"
	WFPendingApproval WorkflowTaskState = "pending_approval"
	WFScheduled       WorkflowTaskState = "scheduled"
	WFCompleted       WorkflowTaskState = "completed"
	WFFailed          WorkflowTaskState = "failed"
	WFCancelled       WorkflowTaskState = "cancelled"
	WFRecorded        WorkflowTaskState = "recorded"
)

// WorkflowTaskKind classifies the type of work.
type WorkflowTaskKind string

const (
	WFKindDelegation   WorkflowTaskKind = "delegation"
	WFKindApproval     WorkflowTaskKind = "approval"
	WFKindServiceQuery WorkflowTaskKind = "service_query"
	WFKindTimer        WorkflowTaskKind = "timer"
	WFKindWatch        WorkflowTaskKind = "watch"
	WFKindGeneric      WorkflowTaskKind = "generic"
)

// WorkflowTaskPriority classifies urgency.
type WorkflowTaskPriority string

const (
	WFPriorityUserBlocking WorkflowTaskPriority = "user_blocking"
	WFPriorityNormal       WorkflowTaskPriority = "normal"
	WFPriorityBackground   WorkflowTaskPriority = "background"
)

// WorkflowTask is the single durable work-item model.
// Replaces DelegatedTask. JSON uses "status" (not "state") for wire compatibility.
type WorkflowTask struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	// PayloadType is an indexed, strongly-typed discriminator for the
	// contents of Payload. Set at create time so queries like "find all
	// service_query_execution tasks" can be an index lookup instead of a
	// fragile substring match against the JSON blob.
	PayloadType     string `json:"payload_type,omitempty"`
	Status          string `json:"status"`          // wire field = "status" for backward compat
	CorrelationID   string `json:"correlation_id,omitempty"`
	ParentID        string `json:"parent_id,omitempty"`
	ProposalID      string `json:"proposal_id,omitempty"`
	Priority        string `json:"priority"`
	Description     string `json:"description"`
	Payload         string `json:"payload"`          // JSON blob
	Result          string `json:"result,omitempty"` // JSON blob
	ResultSummary   string `json:"result_summary"`
	Policy          string `json:"policy"`           // JSON blob
	Error           string `json:"error,omitempty"`
	RequestedRunner string `json:"requested_runner,omitempty"`
	AssignedRunner  string `json:"assigned_runner,omitempty"`
	AgentDID        string `json:"agent_did,omitempty"`
	RunID           string `json:"run_id,omitempty"`
	ProgressNote    string `json:"progress_note,omitempty"`
	LeaseExpiresAt  int64  `json:"lease_expires_at,omitempty"`
	Origin          string `json:"origin,omitempty"`
	SessionName     string `json:"session_name,omitempty"`
	IdempotencyKey  string `json:"idempotency_key,omitempty"`
	ExpiresAt       int64  `json:"expires_at,omitempty"`
	NextRunAt       int64  `json:"next_run_at,omitempty"`
	Recurrence      string `json:"recurrence,omitempty"`
	InternalStash   string `json:"-"` // not serialized — internal recovery data
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
}

// WorkflowEvent is an audit/delivery record for a workflow task.
type WorkflowEvent struct {
	EventID          int64  `json:"event_id"`
	TaskID           string `json:"task_id"`
	At               int64  `json:"at"`
	EventKind        string `json:"event_kind"`
	NeedsDelivery    bool   `json:"needs_delivery"`
	DeliveryAttempts int    `json:"delivery_attempts"`
	NextDeliveryAt   int64  `json:"next_delivery_at,omitempty"`
	DeliveringUntil  int64  `json:"delivering_until,omitempty"`
	DeliveredAt      int64  `json:"delivered_at,omitempty"`
	AcknowledgedAt   int64  `json:"acknowledged_at,omitempty"`
	DeliveryFailed   bool   `json:"delivery_failed"`
	Details          string `json:"details"`
}

// ValidTransitions defines legal state transitions.
// Key = from state, values = allowed to states.
var ValidTransitions = map[WorkflowTaskState][]WorkflowTaskState{
	WFCreated:         {WFPending, WFQueued, WFPendingApproval, WFRunning, WFCompleted, WFFailed, WFCancelled},
	WFPending:         {WFRunning, WFQueued, WFCancelled},
	WFQueued:          {WFClaimed, WFRunning, WFCancelled},
	WFClaimed:         {WFRunning, WFFailed, WFCancelled},
	WFRunning:         {WFAwaiting, WFCompleted, WFFailed, WFCancelled},
	WFAwaiting:        {WFRunning, WFCompleted, WFFailed, WFCancelled},
	WFPendingApproval: {WFPending, WFQueued, WFFailed, WFCancelled},
	WFScheduled:       {WFPending, WFRunning, WFCancelled},
	WFCompleted:       {WFRecorded},
	WFFailed:          {WFScheduled, WFQueued, WFRecorded, WFCancelled},
}

// IsValidTransition checks if a state transition is legal.
func IsValidTransition(from, to WorkflowTaskState) bool {
	allowed, ok := ValidTransitions[from]
	if !ok {
		return false
	}
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}

// IsTerminal returns true if the state is a terminal state.
func IsTerminal(state WorkflowTaskState) bool {
	switch state {
	case WFCompleted, WFFailed, WFCancelled, WFRecorded:
		return true
	}
	return false
}

// AllowedOrigins for the origin CHECK constraint.
//
// 'dinamobile' is the mobile app channel — the human typing into iOS/Android
// reaches Core through msgbox (no public IP). It carries the same user-driven
// privilege as 'telegram' / 'admin' — see handler.validUserOrigins.
var AllowedOrigins = []string{"", "telegram", "api", "d2d", "admin", "system", "cli", "dinamobile"}
