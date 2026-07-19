/**
 * Minimal agentic remember-runtime stub for staging-drain / scheduler
 * tests.
 *
 * Dina is LLM-driven: the staging drain REQUIRES a `rememberRuntime`
 * (there is no keyword/non-LLM fallback — it throws without one). Tests
 * that exercise the drain or scheduler but don't care about real LLM
 * behaviour inject this stub. It "routes" every item to `primary` and
 * emits no other side effects (no reminders / people / preferences), so
 * the drain proceeds to enrich + resolve exactly as it would in
 * production once the agentic loop has run.
 *
 * Shape matches `@dina/brain`'s `RememberTurnResult` structurally; the
 * harness deliberately avoids importing brain types to stay dependency-
 * light (the call site type-checks assignability).
 */
export function makeStubRememberRuntime(
  primary = 'general',
  secondary: string[] = [],
): {
  run: () => Promise<{
    sideEffects: {
      routes: { primary: string; secondary: string[] }[];
      reminders: never[];
      people: never[];
      preferences: never[];
    };
    text: string;
    toolNames: string[];
  }>;
} {
  return {
    async run() {
      return {
        sideEffects: {
          routes: [{ primary, secondary }],
          reminders: [],
          people: [],
          preferences: [],
        },
        text: '',
        toolNames: [],
      };
    },
  };
}
