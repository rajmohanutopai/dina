// Package pii implements Tier 1 regex-based PII detection and redaction.
package pii

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// Compile-time checks.
var _ port.PIIScrubber = (*Scrubber)(nil)
var _ port.PIIDeSanitizer = (*DeSanitizer)(nil)

// Scrubber implements port.PIIScrubber — Tier 1 regex PII detection.
type Scrubber struct {
	patterns []piiPattern
}

type piiPattern struct {
	name string
	re   *regexp.Regexp
}

type piiMatch struct {
	ptype string
	start int
	end   int
	value string
}

// NewScrubber returns a new PII scrubber with default patterns.
func NewScrubber() *Scrubber {
	s := &Scrubber{}
	// Order matters: more specific patterns first to prevent partial matches.
	s.patterns = []piiPattern{
		// 16 consecutive digits (bank account) before credit card to avoid overlap.
		{"BANK_ACCT", regexp.MustCompile(`\b\d{16}\b`)},
		// Credit card: 4×4 digits with required separators (dashes or spaces).
		{"CREDIT_CARD", regexp.MustCompile(`\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b`)},
		{"SSN", regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`)},
		// IPv4 address.
		{"IP", regexp.MustCompile(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`)},
		{"EMAIL", regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`)},
		// International phone: +CC followed by digits and separators.
		{"PHONE", regexp.MustCompile(`\+\d{1,3}[\s.-]\d[\d\s.-]{6,12}\d`)},
		// US/domestic phone: optional +1, then 10 digits in 3-3-4 groups.
		{"PHONE", regexp.MustCompile(`\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b`)},
		{"AADHAAR", regexp.MustCompile(`\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b`)},
	}
	return s
}

// Scrub replaces PII with numbered tokens and returns a ScrubResult.
func (s *Scrubber) Scrub(_ context.Context, text string) (*domain.ScrubResult, error) {
	if text == "" {
		return &domain.ScrubResult{Scrubbed: "", Entities: nil}, nil
	}

	var matches []piiMatch
	for _, p := range s.patterns {
		locs := p.re.FindAllStringIndex(text, -1)
		for _, loc := range locs {
			matches = append(matches, piiMatch{
				ptype: p.name,
				start: loc[0],
				end:   loc[1],
				value: text[loc[0]:loc[1]],
			})
		}
	}

	if len(matches) == 0 {
		return &domain.ScrubResult{Scrubbed: text, Entities: nil}, nil
	}

	sortMatches(matches)
	filtered := removeOverlaps(matches)

	var entities []domain.PIIEntity
	typeCounts := make(map[string]int)
	var result strings.Builder
	lastEnd := 0

	for _, m := range filtered {
		result.WriteString(text[lastEnd:m.start])

		typeCounts[m.ptype]++
		token := fmt.Sprintf("[%s_%d]", m.ptype, typeCounts[m.ptype])
		result.WriteString(token)

		entities = append(entities, domain.PIIEntity{
			Type:  m.ptype,
			Value: m.value,
			Start: m.start,
			End:   m.end,
		})

		lastEnd = m.end
	}
	result.WriteString(text[lastEnd:])

	return &domain.ScrubResult{
		Scrubbed: result.String(),
		Entities: entities,
	}, nil
}

// AddPattern registers a custom PII pattern.
func (s *Scrubber) AddPattern(name, pattern string) error {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("pii: invalid pattern %q: %w", pattern, err)
	}
	s.patterns = append(s.patterns, piiPattern{name, re})
	return nil
}

func sortMatches(matches []piiMatch) {
	for i := 1; i < len(matches); i++ {
		key := matches[i]
		j := i - 1
		for j >= 0 && (matches[j].start > key.start ||
			(matches[j].start == key.start && (matches[j].end-matches[j].start) < (key.end-key.start))) {
			matches[j+1] = matches[j]
			j--
		}
		matches[j+1] = key
	}
}

func removeOverlaps(matches []piiMatch) []piiMatch {
	if len(matches) == 0 {
		return nil
	}
	result := []piiMatch{matches[0]}
	for i := 1; i < len(matches); i++ {
		last := result[len(result)-1]
		if matches[i].start >= last.end {
			result = append(result, matches[i])
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// DeSanitizer (Section 5)
// ---------------------------------------------------------------------------

// DeSanitizer restores PII tokens (e.g. [EMAIL_1]) back to original values.
type DeSanitizer struct{}

// NewDeSanitizer creates a new DeSanitizer.
func NewDeSanitizer() *DeSanitizer {
	return &DeSanitizer{}
}

// DeSanitize replaces [TYPE_N] tokens in scrubbed text with the original PII
// values from the entities list. Each entity's Type and position in
// the per-type sequence determine which token it replaces.
func (d *DeSanitizer) DeSanitize(scrubbed string, entities []domain.PIIEntity) (string, error) {
	if len(entities) == 0 {
		return scrubbed, nil
	}

	// Build a map of token → original value.
	// Tokens are numbered per-type: [EMAIL_1], [EMAIL_2], [PHONE_1], etc.
	typeCounts := make(map[string]int)
	tokenMap := make(map[string]string)
	for _, e := range entities {
		typeCounts[e.Type]++
		token := fmt.Sprintf("[%s_%d]", e.Type, typeCounts[e.Type])
		tokenMap[token] = e.Value
	}

	// Replace all tokens in the scrubbed text.
	result := scrubbed
	for token, original := range tokenMap {
		result = replaceAll(result, token, original)
	}

	return result, nil
}

// replaceAll replaces all occurrences of old with new in s.
func replaceAll(s, old, new string) string {
	if old == "" || old == new {
		return s
	}
	var b strings.Builder
	for {
		idx := indexOf(s, old)
		if idx < 0 {
			b.WriteString(s)
			break
		}
		b.WriteString(s[:idx])
		b.WriteString(new)
		s = s[idx+len(old):]
	}
	return b.String()
}

// indexOf returns the index of the first occurrence of substr in s, or -1.
func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
