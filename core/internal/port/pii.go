package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// PIIScrubber detects and replaces PII in text.
// Tier 1: regex-based (core, Go). Tier 2: spaCy NER (brain, Python).
type PIIScrubber interface {
	Scrub(ctx context.Context, text string) (*domain.ScrubResult, error)
}

// PIIDeSanitizer reverses PII scrubbing using the entity map.
type PIIDeSanitizer interface {
	DeSanitize(scrubbed string, entities []domain.PIIEntity) (string, error)
}
