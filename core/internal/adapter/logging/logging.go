// Package logging implements log auditing and PII exclusion enforcement.
package logging

import (
	"encoding/json"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time interface check.
var _ port.LogAuditor = (*LogAuditor)(nil)

// LogEntry holds a structured log line.
type LogEntry = domain.LogEntry

// LogAuditor implements port.LogAuditor — log auditing and PII exclusion enforcement.
type LogAuditor struct{}

// NewLogAuditor returns a new LogAuditor.
func NewLogAuditor() *LogAuditor {
	return &LogAuditor{}
}

// ParseLine parses a structured JSON log line.
func (a *LogAuditor) ParseLine(line string) (*LogEntry, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil, err
	}

	entry := &LogEntry{
		Fields: make(map[string]string),
	}

	// Extract standard fields, checking for both Go slog and Python structlog formats.
	if v, ok := raw["time"]; ok {
		entry.Time = toString(v)
	} else if v, ok := raw["timestamp"]; ok {
		entry.Time = toString(v)
	}

	if v, ok := raw["level"]; ok {
		entry.Level = toString(v)
	}

	if v, ok := raw["msg"]; ok {
		entry.Msg = toString(v)
	} else if v, ok := raw["event"]; ok {
		entry.Msg = toString(v)
	}

	if v, ok := raw["module"]; ok {
		entry.Module = toString(v)
	}

	// Remaining fields.
	for k, v := range raw {
		switch k {
		case "time", "timestamp", "level", "msg", "event", "module":
			continue
		default:
			entry.Fields[k] = toString(v)
		}
	}

	return entry, nil
}

// ContainsPII checks whether a log line contains PII.
func (a *LogAuditor) ContainsPII(line string) (bool, string, error) {
	lower := strings.ToLower(line)

	// Check for sensitive field names in log output.
	piiIndicators := []struct {
		pattern string
		reason  string
	}{
		{`"body"`, "contains body field"},
		{`"plaintext"`, "contains plaintext field"},
		{`"passphrase"`, "contains passphrase field"},
		{`"query"`, "contains query field with user data"},
		{`"content"`, "contains content field"},
		{`"token":"`, "contains raw token value"},
	}

	for _, ind := range piiIndicators {
		if strings.Contains(line, ind.pattern) {
			// Parse as JSON to verify the field actually has a value.
			var raw map[string]interface{}
			if err := json.Unmarshal([]byte(line), &raw); err == nil {
				// Check that the field has substantial content (not just metadata).
				for _, key := range []string{"body", "plaintext", "passphrase", "content"} {
					if v, ok := raw[key]; ok {
						val := toString(v)
						if len(val) > 0 {
							return true, ind.reason, nil
						}
					}
				}
				// Check for raw token values (64+ hex chars).
				if v, ok := raw["token"]; ok {
					val := toString(v)
					if len(val) >= 32 {
						return true, "contains raw token value", nil
					}
				}
				// Check for user query text.
				if v, ok := raw["query"]; ok {
					val := toString(v)
					if len(val) > 0 && strings.Contains(lower, "search") || strings.Contains(lower, "find") || strings.Contains(lower, "my") {
						return true, "contains user query text", nil
					}
					// Check if query field has natural language (spaces).
					if len(val) > 0 && strings.Contains(val, " ") {
						return true, "contains user query text", nil
					}
				}
			}
		}
	}

	// Check for PII patterns (SSN, email in message content).
	if strings.Contains(line, "SSN") && containsDigitPattern(line) {
		return true, "contains SSN pattern", nil
	}

	return false, "", nil
}

// MatchesBannedPattern checks a code line against CI banned log patterns.
func (a *LogAuditor) MatchesBannedPattern(codeLine string) (bool, string, error) {
	// Banned patterns for CI enforcement.
	bannedPatterns := []struct {
		pattern string
		reason  string
	}{
		{`"query"`, "log contains query= field"},
		{`"content"`, "log contains content= field"},
		{`"body"`, "log contains body= field"},
		{`"plaintext"`, "log contains plaintext= field"},
		{`f"`, "f-string with potential user data"},
	}

	for _, bp := range bannedPatterns {
		if strings.Contains(codeLine, bp.pattern) {
			// Verify it is a log statement context.
			lower := strings.ToLower(codeLine)
			isLogStatement := strings.Contains(lower, "slog.") ||
				strings.Contains(lower, "log.") ||
				strings.Contains(lower, "logger.")
			if isLogStatement {
				return true, bp.reason, nil
			}
		}
	}

	return false, "", nil
}

// SanitizeCrash returns a one-liner suitable for stdout from a full traceback.
func (a *LogAuditor) SanitizeCrash(traceback string) string {
	lines := strings.Split(traceback, "\n")
	if len(lines) == 0 {
		return ""
	}

	// Extract the last line (the exception type + message).
	lastLine := strings.TrimSpace(lines[len(lines)-1])
	if lastLine == "" && len(lines) > 1 {
		lastLine = strings.TrimSpace(lines[len(lines)-2])
	}

	// Extract the FIRST line number from "File ..., line NNN" (outermost call frame).
	lineNum := ""
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if strings.HasPrefix(trimmed, "File ") && lineNum == "" {
			idx := strings.Index(trimmed, "line ")
			if idx >= 0 {
				rest := trimmed[idx+5:]
				num := ""
				for _, c := range rest {
					if c >= '0' && c <= '9' {
						num += string(c)
					} else {
						break
					}
				}
				if num != "" {
					lineNum = num
				}
			}
		}
	}

	// Construct sanitized one-liner: "ExceptionType at line NNN".
	exType := lastLine
	colonIdx := strings.Index(lastLine, ":")
	if colonIdx > 0 {
		exType = lastLine[:colonIdx]
	}

	if lineNum != "" {
		return exType + " at line " + lineNum + ": " + lastLine
	}
	return lastLine
}

func toString(v interface{}) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	case float64:
		if val == float64(int(val)) {
			return strings.TrimRight(strings.TrimRight(
				strings.Replace(
					strings.Replace(
						strings.Replace(
							formatFloat(val), ".000000", "", 1,
						), ".00000", "", 1,
					), ".0000", "", 1,
				), "0"), ".")
		}
		return formatFloat(val)
	case bool:
		if val {
			return "true"
		}
		return "false"
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func formatFloat(f float64) string {
	// Simple float formatting without fmt.
	i := int64(f)
	if f == float64(i) {
		return intToString(i)
	}
	return intToString(i) + ".0" // simplified
}

func intToString(i int64) string {
	if i == 0 {
		return "0"
	}
	neg := false
	if i < 0 {
		neg = true
		i = -i
	}
	digits := []byte{}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}

func containsDigitPattern(s string) bool {
	// Check for patterns like NNN-NN-NNNN (SSN).
	for i := 0; i < len(s)-10; i++ {
		if s[i] >= '0' && s[i] <= '9' &&
			s[i+1] >= '0' && s[i+1] <= '9' &&
			s[i+2] >= '0' && s[i+2] <= '9' &&
			s[i+3] == '-' &&
			s[i+4] >= '0' && s[i+4] <= '9' &&
			s[i+5] >= '0' && s[i+5] <= '9' &&
			s[i+6] == '-' {
			return true
		}
	}
	return false
}
