package domain

// Intent represents an agent's declared action for gatekeeper evaluation.
type Intent struct {
	AgentDID    string          `json:"agent_did"`
	Action      string          `json:"action"`
	Target      string          `json:"target"`
	PersonaID   string          `json:"persona_id"`
	TrustLevel  string          `json:"trust_level"`
	Constraints map[string]bool `json:"constraints,omitempty"`
}

// Decision is the gatekeeper's response to an intent.
type Decision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason"`
	Audit   bool   `json:"audit"`
}
