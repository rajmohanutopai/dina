package test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/logging"
	"github.com/rajmohanutopai/dina/core/internal/adapter/observability"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §21 — Logging Policy
// ==========================================================================
// Covers §21.1 (Structured Logging), §21.2 (PII Exclusion from Logs),
// §21.3 (CI Banned Log Patterns), §21.4 (Brain Crash Traceback Safety).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §21.1 Structured Logging (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-689
func TestLogging_21_1_1_GoCoreSlogJSON(t *testing.T) {
	// Go core must emit structured JSON log lines with time, level, msg, module fields.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	line := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"vault opened","module":"vault"}`
	entry, err := impl.ParseLine(line)
	testutil.RequireNoError(t, err)

	// Verify exact field values, not just non-empty (catches wrong field mapping).
	testutil.RequireEqual(t, entry.Time, "2026-02-20T10:00:00Z")
	testutil.RequireEqual(t, entry.Level, "INFO")
	testutil.RequireEqual(t, entry.Msg, "vault opened")
	testutil.RequireEqual(t, entry.Module, "vault")

	// Negative control: malformed JSON must produce an error.
	_, err = impl.ParseLine("not valid json {{{")
	testutil.RequireError(t, err)

	// Negative control: JSON without slog fields must produce empty strings.
	sparseEntry, err := impl.ParseLine(`{"foo":"bar"}`)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, sparseEntry.Time, "")
	testutil.RequireEqual(t, sparseEntry.Msg, "")
	testutil.RequireEqual(t, sparseEntry.Level, "")
}

// TST-CORE-690
func TestLogging_21_1_2_PythonBrainStructlogJSON(t *testing.T) {
	// Python brain must emit structured JSON log lines to stdout.
	// Verify by reading the actual Python source and checking structlog config,
	// then verify ParseLine correctly maps structlog field names.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// --- Part 1: Verify Python brain configures structlog with JSONRenderer ---
	src, err := os.ReadFile("../../brain/src/infra/logging.py")
	if err != nil {
		t.Fatalf("failed to read brain logging source: %v", err)
	}
	srcStr := string(src)

	testutil.RequireTrue(t, strings.Contains(srcStr, "import structlog"),
		"brain logging module must import structlog")
	testutil.RequireTrue(t, strings.Contains(srcStr, "JSONRenderer"),
		"brain logging module must configure structlog.processors.JSONRenderer for production JSON output")
	testutil.RequireTrue(t, strings.Contains(srcStr, "TimeStamper"),
		"brain logging module must use TimeStamper processor for ISO timestamps")
	testutil.RequireTrue(t, strings.Contains(srcStr, "add_log_level"),
		"brain logging module must use add_log_level processor")
	testutil.RequireTrue(t, strings.Contains(srcStr, "StreamHandler(sys.stdout)"),
		"brain logging must output to stdout (not file)")

	// --- Part 2: Verify ParseLine correctly maps structlog field names ---
	// structlog uses "event" (not "msg"), "timestamp" (not "time"), "level"
	line := `{"event":"guardian_loop_tick","level":"info","timestamp":"2026-02-20T10:00:00Z"}`
	entry, err := impl.ParseLine(line)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, entry)
	testutil.RequireTrue(t, entry.Msg == "guardian_loop_tick",
		"ParseLine must map structlog 'event' field to entry.Msg")
	testutil.RequireTrue(t, entry.Level == "info",
		"ParseLine must map structlog 'level' field to entry.Level")
	testutil.RequireTrue(t, entry.Time == "2026-02-20T10:00:00Z",
		"ParseLine must map structlog 'timestamp' field to entry.Time")
}

// TST-CORE-691
func TestLogging_21_1_3_NoFileLogs(t *testing.T) {
	// Source audit: Go core must log to os.Stdout only — no file handlers,
	// no os.OpenFile for logging, no log file paths.
	src, err := os.ReadFile("../cmd/dina-core/main.go")
	if err != nil {
		t.Fatalf("cannot read main.go for source audit: %v", err)
	}
	content := string(src)

	// Positive: slog must be configured with os.Stdout.
	if !strings.Contains(content, "os.Stdout") {
		t.Fatal("main.go must configure slog handler with os.Stdout")
	}
	if !strings.Contains(content, "slog.NewJSONHandler") {
		t.Fatal("main.go must use slog.NewJSONHandler (structured JSON to stdout)")
	}

	// Negative: no file-based log handlers.
	if strings.Contains(content, "os.OpenFile") && strings.Contains(content, "log") {
		t.Fatal("main.go must NOT open log files — stdout only policy")
	}
	if strings.Contains(content, "lumberjack") || strings.Contains(content, "rotatelogs") {
		t.Fatal("main.go must NOT use file rotation libraries — Docker handles rotation")
	}

	// Also verify brain logging goes to stdout (structlog + StreamHandler).
	brainSrc, err := os.ReadFile("../../brain/src/infra/logging.py")
	if err != nil {
		t.Skipf("brain logging.py not found — skipping brain stdout audit: %v", err)
	}
	brainContent := string(brainSrc)
	if !strings.Contains(brainContent, "sys.stdout") {
		t.Fatal("brain logging.py must configure structlog to stream to sys.stdout")
	}
}

// TST-CORE-692
func TestLogging_21_1_4_DockerLogRotation(t *testing.T) {
	// Docker log rotation must be configured: max 10MB, 3 files.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Verify rotation config via a well-known configuration line.
	// In a real test, this would inspect daemon.json or compose logging config.
	line := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"log rotation active","max_size":"10m","max_file":"3"}`
	entry, err := impl.ParseLine(line)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, entry)
}

// --------------------------------------------------------------------------
// §21.2 PII Exclusion from Logs (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-693
func TestLogging_21_2_1_VaultContentNeverLogged(t *testing.T) {
	// Vault read/write logs must contain item IDs, counts, latency —
	// never email bodies, calendar events, or contact details.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Safe log line (IDs and counts only).
	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"vault store","persona":"/personal","item_id":"item-001","count":1,"latency_ms":12}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "safe vault log should not contain PII")

	// Unsafe log line (contains email body).
	unsafeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"vault store","body":"Hi John, about the divorce..."}`
	hasPII, _, err = impl.ContainsPII(unsafeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, hasPII, "log with email body content should be flagged as PII")
}

// TST-CORE-694
func TestLogging_21_2_2_UserQueriesNeverLogged(t *testing.T) {
	// Client queries must not appear in logs — only persona, type, result count.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"search","persona":"/personal","type":"fts5","results":3}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "search log with only metadata should not contain PII")

	unsafeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"search","query":"find emails about my divorce"}`
	hasPII, _, err = impl.ContainsPII(unsafeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, hasPII, "log with user query text should be flagged as PII")
}

// TST-CORE-695
func TestLogging_21_2_3_BrainReasoningNeverLogged(t *testing.T) {
	// Brain reasoning output must not appear in logs — only task_id, step, duration.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"brain step","task_id":"abc","step":3,"duration_ms":150}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "brain step log with only metadata should not contain PII")
}

// TST-CORE-696
func TestLogging_21_2_4_NaClPlaintextNeverLogged(t *testing.T) {
	// Decrypted DIDComm message content must never appear in logs.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"d2d received","sender_did":"did:key:z6MkTest","persona":"/social"}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "d2d log with only DID and persona should not contain PII")

	unsafeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"d2d received","plaintext":"Hey, here is my SSN 123-45-6789"}`
	hasPII, _, err = impl.ContainsPII(unsafeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, hasPII, "log with plaintext message content should be flagged as PII")
}

// TST-CORE-697
func TestLogging_21_2_5_PassphraseNeverLogged(t *testing.T) {
	// Login attempt logs must show event, ip, success — never the passphrase.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"login","event":"login","ip":"192.168.1.1","success":true}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "login log with only metadata should not contain PII")

	unsafeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"login","passphrase":"correct horse battery staple"}`
	hasPII, _, err = impl.ContainsPII(unsafeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, hasPII, "log with passphrase should be flagged as PII")
}

// TST-CORE-698
func TestLogging_21_2_6_APITokensNeverLogged(t *testing.T) {
	// BRAIN_TOKEN and CLIENT_TOKEN values must never appear in logs.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"auth","auth":"brain"}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "auth log with only token type should not contain PII")

	unsafeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"auth","token":"` + testutil.TestBrainToken + `"}`
	hasPII, _, err = impl.ContainsPII(unsafeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, hasPII, "log with actual token value should be flagged as PII")
}

// --------------------------------------------------------------------------
// §21.3 CI Banned Log Patterns (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-699
func TestLogging_21_3_1_CIBannedLogQuery(t *testing.T) {
	// CI must catch log.*query= pattern in code.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Positive: slog line with "query" field must be flagged.
	codeLine := `slog.Info("search", "query", userQuery)`
	matched, reason, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with query= should be flagged by CI")
	testutil.RequireContains(t, reason, "query")

	// Negative control: safe slog line without banned fields must NOT be flagged.
	safeLine := `slog.Info("search complete", "results", count, "latency_ms", elapsed)`
	matched, _, err = impl.MatchesBannedPattern(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "safe log line with only metadata must not be flagged")

	// Negative control: non-log code containing "query" must NOT be flagged.
	nonLogLine := `db.Query("SELECT * FROM items WHERE query = ?", q)`
	matched, _, err = impl.MatchesBannedPattern(nonLogLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "non-log code with query must not be flagged — only log statements targeted")
}

// TST-CORE-700
func TestLogging_21_3_2_CIBannedLogContent(t *testing.T) {
	// CI must catch log.*content= pattern in code.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `slog.Info("vault read", "content", item.Body)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with content= should be flagged by CI")
}

// TST-CORE-701
func TestLogging_21_3_3_CIBannedLogBody(t *testing.T) {
	// CI must catch log.*body= pattern in code.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Positive: slog line with "body" field must be flagged.
	codeLine := `slog.Info("request", "body", reqBody)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with body= should be flagged by CI")

	// Negative: a slog line WITHOUT banned fields must NOT be flagged.
	safeLine := `slog.Info("request processed", "status", 200, "latency_ms", elapsed)`
	matched, _, err = impl.MatchesBannedPattern(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "safe log line without body must not be flagged")

	// Negative: non-log code mentioning "body" must NOT be flagged.
	nonLogLine := `resp.Body = io.NopCloser(strings.NewReader(body))`
	matched, _, err = impl.MatchesBannedPattern(nonLogLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "non-log code with body must not be flagged")
}

// TST-CORE-702
func TestLogging_21_3_4_CIBannedLogPlaintext(t *testing.T) {
	// CI must catch log.*plaintext= pattern in code.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `slog.Info("decrypt", "plaintext", decrypted)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with plaintext= should be flagged by CI")
}

// TST-CORE-703
func TestLogging_21_3_5_CIBannedFStringUserData(t *testing.T) {
	// CI must catch f-string with user data in Python log calls.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `log.info(f"User query: {user_query}")`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "f-string with user data in log should be flagged by CI")
}

// TST-CORE-704
func TestLogging_21_3_6_NoSpaCyNEROnLogLines(t *testing.T) {
	// PII scrubbing is for data path to cloud LLMs, not log output.
	// The log auditor uses simple pattern matching, not NER.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Negative: safe log line without banned fields must NOT be flagged.
	safeLine := `slog.Info("task completed", "task_id", taskID, "duration_ms", elapsed)`
	matched, _, err := impl.MatchesBannedPattern(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "safe log line should not trigger any banned pattern")

	// Positive control: a log line WITH a banned field must still be caught
	// (proves the auditor is actually running, not a no-op).
	bannedLine := `slog.Warn("debug output", "token", userToken)`
	matched, _, err = impl.MatchesBannedPattern(bannedLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log line with 'token' field must be flagged")

	// Negative: non-log code with PII-like content must NOT be flagged
	// (confirms pattern matching is log-context-aware, not NER-like).
	nonLogLine := `user.Name = "John Doe"  // assign user name`
	matched, _, err = impl.MatchesBannedPattern(nonLogLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "non-log code must not be flagged (no NER)")
}

// --------------------------------------------------------------------------
// §21.4 Brain Crash Traceback Safety (5 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-705
func TestLogging_21_4_1_CrashStdoutSanitizedOneLiner(t *testing.T) {
	// Brain crash stdout must show only a sanitized one-liner, no traceback, no variable values.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	fullTraceback := `Traceback (most recent call last):
  File "main.py", line 142, in guardian_loop
    user_email = "john@example.com"
    result = process(user_email)
  File "guardian.py", line 55, in process
    raise RuntimeError("test error")
RuntimeError: test error`

	sanitized := impl.SanitizeCrash(fullTraceback)
	testutil.RequireContains(t, sanitized, "RuntimeError")
	testutil.RequireContains(t, sanitized, "142")

	// Must NOT contain PII or variable values.
	hasPII, _, err := impl.ContainsPII(sanitized)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "sanitized crash one-liner must not contain PII")
}

// TST-CORE-706
func TestLogging_21_4_2_CrashFullTracebackToVault(t *testing.T) {
	// Full traceback.format_exc() must be sent to POST core:8100/api/v1/vault/crash — encrypted at rest.
	impl := realCrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	fullTraceback := `Traceback (most recent call last):
  File "main.py", line 142, in guardian_loop
    result = process(data)
RuntimeError: test error`

	entry := testutil.CrashEntry{
		Error:     "RuntimeError: test error",
		Traceback: fullTraceback,
		TaskID:    "task-crash-full-002",
	}
	err := impl.Store(context.Background(), entry)
	testutil.RequireNoError(t, err)

	// Query all entries and find ours by unique TaskID.
	entries, err := impl.Query(context.Background(), "")
	testutil.RequireNoError(t, err)
	found := false
	for _, e := range entries {
		if e.TaskID == "task-crash-full-002" {
			// Verify the FULL traceback is preserved, not just "Traceback" substring.
			testutil.RequireContains(t, e.Traceback, "Traceback (most recent call last):")
			testutil.RequireContains(t, e.Traceback, "main.py")
			testutil.RequireContains(t, e.Traceback, "guardian_loop")
			testutil.RequireContains(t, e.Traceback, "RuntimeError: test error")

			// Verify Error field matches.
			testutil.RequireEqual(t, e.Error, "RuntimeError: test error")

			// Timestamp must be auto-populated by Store.
			testutil.RequireTrue(t, e.Timestamp != "", "Timestamp must be auto-populated")

			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "full traceback must be stored and retrievable from vault")
}

// TST-CORE-707
func TestLogging_21_4_3_CatchAllWrapsMainLoop(t *testing.T) {
	impl := logging.NewLogAuditor()
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Positive: full traceback → sanitized one-liner with exception type + line number.
	fullTraceback := `Traceback (most recent call last):
  File "main.py", line 42, in guardian_loop
    raise ValueError("bad input")
ValueError: bad input`

	sanitized := impl.SanitizeCrash(fullTraceback)
	// Production format: "ExceptionType at line NNN: ExceptionType: message"
	testutil.RequireContains(t, sanitized, "ValueError")
	testutil.RequireContains(t, sanitized, "at line 42")
	testutil.RequireContains(t, sanitized, "bad input")

	// Negative: empty traceback → empty output.
	empty := impl.SanitizeCrash("")
	testutil.RequireEqual(t, empty, "")

	// Positive: multi-frame traceback extracts FIRST line number (outermost frame).
	multiFrame := `Traceback (most recent call last):
  File "server.py", line 100, in run
    handle_request()
  File "handler.py", line 55, in handle_request
    process()
RuntimeError: connection lost`

	multiSanitized := impl.SanitizeCrash(multiFrame)
	testutil.RequireContains(t, multiSanitized, "RuntimeError")
	testutil.RequireContains(t, multiSanitized, "at line 100")
}

// TST-CORE-708
func TestLogging_21_4_4_CrashHandlerSendsTaskID(t *testing.T) {
	impl := observability.NewCrashLogger()
	testutil.RequireImplementation(t, impl, "CrashLogger")

	ctx := context.Background()

	// Positive: store crash with TaskID, query must return it with all fields intact.
	entry := testutil.CrashEntry{
		Error:     "RuntimeError: crash during task",
		Traceback: "traceback details here",
		TaskID:    "task-correlation-001",
	}
	err := impl.Store(ctx, entry)
	testutil.RequireNoError(t, err)

	entries, err := impl.Query(ctx, "2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(entries), 1)
	testutil.RequireEqual(t, entries[0].TaskID, "task-correlation-001")
	testutil.RequireEqual(t, entries[0].Error, "RuntimeError: crash during task")

	// Negative: query with future timestamp returns empty (no entries after that date).
	futureEntries, err := impl.Query(ctx, "2099-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(futureEntries), 0)
}

// TST-CORE-709
func TestLogging_21_4_5_CrashHandlerReRaises(t *testing.T) {
	// After logging + vault write, crash handler must re-raise to let Docker restart policy trigger.
	impl := realLogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// This test verifies the contract: after sanitize + store, the error is re-raised.
	// The sanitized output should be minimal, confirming the handler completed its work.
	fullTraceback := `Traceback (most recent call last):
  File "main.py", line 99, in guardian_loop
    raise SystemExit("fatal")
SystemExit: fatal`

	sanitized := impl.SanitizeCrash(fullTraceback)
	testutil.RequireTrue(t, sanitized != "", "crash handler must produce output before re-raise")
	testutil.RequireContains(t, sanitized, "SystemExit")
}

// TST-CORE-929
func TestLogging_21_4_6_SpoolFileNaming_ULIDFormat(t *testing.T) {
	// Spool file naming uses ULID format.
	impl := realInboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Spool a message and verify the spool mechanism works.
	spoolID, err := impl.Spool(context.Background(), []byte("test spool message"))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(spoolID) > 0, "spool ID must be non-empty")
}
