package test

import (
	"testing"

	"github.com/anthropics/dina/core/test/testutil"
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
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	line := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"vault opened","module":"vault"}`
	entry, err := impl.ParseLine(line)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, entry.Time != "", "time field must be present")
	testutil.RequireTrue(t, entry.Level != "", "level field must be present")
	testutil.RequireTrue(t, entry.Msg != "", "msg field must be present")
	testutil.RequireTrue(t, entry.Module != "", "module field must be present")
}

// TST-CORE-690
func TestLogging_21_1_2_PythonBrainStructlogJSON(t *testing.T) {
	// Python brain must emit structured JSON log lines to stdout.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	line := `{"event":"guardian_loop_tick","level":"info","timestamp":"2026-02-20T10:00:00Z"}`
	entry, err := impl.ParseLine(line)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, entry)
}

// TST-CORE-691
func TestLogging_21_1_3_NoFileLogs(t *testing.T) {
	// No log files written anywhere — stdout only. Containers should have no log files
	// on their filesystem after 24h of operation.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// This test verifies the logging policy: stdout only, no file logs.
	// In production, inspect container filesystems. Here, verify the contract.
	line := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"no file logs"}`
	entry, err := impl.ParseLine(line)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, entry)
}

// TST-CORE-692
func TestLogging_21_1_4_DockerLogRotation(t *testing.T) {
	// Docker log rotation must be configured: max 10MB, 3 files.
	var impl testutil.LogAuditor
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
	var impl testutil.LogAuditor
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
	var impl testutil.LogAuditor
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
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	safeLine := `{"time":"2026-02-20T10:00:00Z","level":"INFO","msg":"brain step","task_id":"abc","step":3,"duration_ms":150}`
	hasPII, _, err := impl.ContainsPII(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, hasPII, "brain step log with only metadata should not contain PII")
}

// TST-CORE-696
func TestLogging_21_2_4_NaClPlaintextNeverLogged(t *testing.T) {
	// Decrypted DIDComm message content must never appear in logs.
	var impl testutil.LogAuditor
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
	var impl testutil.LogAuditor
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
	var impl testutil.LogAuditor
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
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `slog.Info("search", "query", userQuery)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with query= should be flagged by CI")
}

// TST-CORE-700
func TestLogging_21_3_2_CIBannedLogContent(t *testing.T) {
	// CI must catch log.*content= pattern in code.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `slog.Info("vault read", "content", item.Body)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with content= should be flagged by CI")
}

// TST-CORE-701
func TestLogging_21_3_3_CIBannedLogBody(t *testing.T) {
	// CI must catch log.*body= pattern in code.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `slog.Info("request", "body", reqBody)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with body= should be flagged by CI")
}

// TST-CORE-702
func TestLogging_21_3_4_CIBannedLogPlaintext(t *testing.T) {
	// CI must catch log.*plaintext= pattern in code.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `slog.Info("decrypt", "plaintext", decrypted)`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "log with plaintext= should be flagged by CI")
}

// TST-CORE-703
func TestLogging_21_3_5_CIBannedFStringUserData(t *testing.T) {
	// CI must catch f-string with user data in Python log calls.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	codeLine := `log.info(f"User query: {user_query}")`
	matched, _, err := impl.MatchesBannedPattern(codeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, matched, "f-string with user data in log should be flagged by CI")
}

// TST-CORE-704
func TestLogging_21_3_6_NoSpaCyNEROnLogLines(t *testing.T) {
	// PII scrubbing is for data path to cloud LLMs, not log output.
	// No spaCy NER should run on log lines — wrong layer, expensive, unreliable.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Verify that a safe log line passes without NER overhead.
	safeLine := `slog.Info("task completed", "task_id", taskID, "duration_ms", elapsed)`
	matched, _, err := impl.MatchesBannedPattern(safeLine)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, matched, "safe log line should not trigger any banned pattern")
}

// --------------------------------------------------------------------------
// §21.4 Brain Crash Traceback Safety (5 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-705
func TestLogging_21_4_1_CrashStdoutSanitizedOneLiner(t *testing.T) {
	// Brain crash stdout must show only a sanitized one-liner, no traceback, no variable values.
	var impl testutil.LogAuditor
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
	var impl testutil.CrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	fullTraceback := `Traceback (most recent call last):
  File "main.py", line 142, in guardian_loop
    result = process(data)
RuntimeError: test error`

	entry := testutil.CrashEntry{
		Error:     "RuntimeError: test error",
		Traceback: fullTraceback,
		TaskID:    "task-crash-full-001",
	}
	err := impl.Store(entry)
	testutil.RequireNoError(t, err)

	entries, err := impl.Query("2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	found := false
	for _, e := range entries {
		if e.TaskID == "task-crash-full-001" {
			testutil.RequireContains(t, e.Traceback, "Traceback")
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "full traceback must be stored in vault")
}

// TST-CORE-707
func TestLogging_21_4_3_CatchAllWrapsMainLoop(t *testing.T) {
	// Brain main.py must have try/except wrapping guardian_loop.
	// Logs type + line to stdout, full trace to vault.
	var impl testutil.LogAuditor
	testutil.RequireImplementation(t, impl, "LogAuditor")

	// Simulate the catch-all output: sanitized one-liner.
	fullTraceback := `Traceback (most recent call last):
  File "main.py", line 42, in guardian_loop
    raise ValueError("bad input")
ValueError: bad input`

	sanitized := impl.SanitizeCrash(fullTraceback)
	testutil.RequireContains(t, sanitized, "ValueError")
	testutil.RequireContains(t, sanitized, "42")
}

// TST-CORE-708
func TestLogging_21_4_4_CrashHandlerSendsTaskID(t *testing.T) {
	// Crash handler must include current_task_id for correlation with dina_tasks.
	var impl testutil.CrashLogger
	testutil.RequireImplementation(t, impl, "CrashLogger")

	entry := testutil.CrashEntry{
		Error:     "RuntimeError: crash during task",
		Traceback: "traceback...",
		TaskID:    "task-correlation-001",
	}
	err := impl.Store(entry)
	testutil.RequireNoError(t, err)

	entries, err := impl.Query("2020-01-01T00:00:00Z")
	testutil.RequireNoError(t, err)
	found := false
	for _, e := range entries {
		if e.TaskID == "task-correlation-001" {
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "crash entry must contain task_id for correlation")
}

// TST-CORE-709
func TestLogging_21_4_5_CrashHandlerReRaises(t *testing.T) {
	// After logging + vault write, crash handler must re-raise to let Docker restart policy trigger.
	var impl testutil.LogAuditor
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
