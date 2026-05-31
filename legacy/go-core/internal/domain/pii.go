package domain

// PIIEntity represents a detected PII occurrence in text.
type PIIEntity struct {
	Type  string `json:"type"`  // EMAIL, PHONE, SSN, CREDIT_CARD, etc.
	Value string `json:"value"` // original value
	Start int    `json:"start"` // byte offset of start
	End   int    `json:"end"`   // byte offset of end
}

// ScrubResult holds the output of a PII scrub operation.
type ScrubResult struct {
	Scrubbed string      `json:"scrubbed"` // text with PII replaced by tokens
	Entities []PIIEntity `json:"entities"` // detected entities
}
