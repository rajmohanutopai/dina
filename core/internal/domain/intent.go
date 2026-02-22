package domain

// Intent represents an agent's declared action for gatekeeper evaluation.
type Intent struct {
	AgentDID    string
	Action      string
	Target      string
	PersonaID   string
	TrustLevel  string
	Constraints map[string]bool
}

// Decision is the gatekeeper's response to an intent.
type Decision struct {
	Allowed bool
	Reason  string
	Audit   bool
}
