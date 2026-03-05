package domain

// TokenType distinguishes authenticated caller classes at the type level.
type TokenType string

const (
	TokenBrain   TokenType = "brain"
	TokenClient  TokenType = "client"
	TokenUnknown TokenType = "unknown"
)

// AccessAction represents an operation a token holder may request.
type AccessAction string

const (
	ActionRead    AccessAction = "read"
	ActionWrite   AccessAction = "write"
	ActionDelete  AccessAction = "delete"
	ActionAdmin   AccessAction = "admin"
	ActionUnlock  AccessAction = "unlock"
	ActionExport  AccessAction = "export"
)

// RateLimitResult holds the outcome of a rate limit check.
type RateLimitResult struct {
	Allowed   bool
	Remaining int
	ResetAt   int64
}
