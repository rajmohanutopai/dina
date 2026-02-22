package domain

// PIIEntity represents a detected PII occurrence in text.
type PIIEntity struct {
	Type  string // EMAIL, PHONE, SSN, CREDIT_CARD, etc.
	Value string // original value
	Start int    // byte offset of start
	End   int    // byte offset of end
}

// ScrubResult holds the output of a PII scrub operation.
type ScrubResult struct {
	Scrubbed string      // text with PII replaced by tokens
	Entities []PIIEntity // detected entities
}
