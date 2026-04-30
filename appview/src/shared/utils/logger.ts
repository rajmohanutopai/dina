import pino from 'pino'

/**
 * AppView logger (TN-OBS-003 / Plan §13.8).
 *
 * **Structured JSON output**. In production (NODE_ENV=production) pino
 * emits one JSON object per line to stdout — directly ingestable by
 * Loki / Datadog / Cloud Logging without a parser. In dev mode the
 * `pino/file` transport pipes the same JSON to stdout for tooling
 * compatibility; pino-pretty is a separate dev convenience that
 * operators run as a tail filter, not baked into the producer.
 *
 * **Field redaction**. Defense-in-depth for sensitive fields a future
 * caller might pass into a log object. Pino's `redact.paths` uses the
 * fast-path string matcher (compiled at startup); each path is checked
 * against every log object's properties at near-zero per-message cost.
 * Wildcards (`*`) cover the common patterns:
 *
 *   - `*.password` / `*.passwd` — defensive
 *   - `*.token` / `*.accessToken` / `*.refreshToken` — auth tokens
 *   - `*.authorization` / `*.cookie` — HTTP header values if a
 *     request object is ever logged whole
 *   - `headers.authorization` / `headers.cookie` — same, when the
 *     log object is `{ headers: req.headers }` flat
 *   - `*.privateKey` / `*.secret` / `*.apiKey` — credentials
 *   - `*.text_value` — `appview_config.text_value` could legitimately
 *     hold a secret in a future flag (e.g. a webhook URL); redact by
 *     default and let the audit logger explicitly opt in if needed
 *
 * Redacted fields are replaced with the literal string `[REDACTED]` —
 * distinct from `null` / `undefined` so log readers can tell "we had
 * a value but redacted it" vs "the field was absent".
 *
 * **What is NOT redacted**:
 *   - DIDs (e.g. `did:plc:abc...`) — public identifiers, intentional
 *     log content for tracing trust-network operations
 *   - AT-URIs — public references
 *   - Subject IDs — derived from public records
 *   - Method names / collection names — public API surface
 *   - Error messages / stack traces — needed for debugging; if a
 *     specific error message includes sensitive data, the call site
 *     must log only metadata (per CLAUDE.md "PII never in logs")
 *   - IP addresses — currently not logged anywhere; if added (e.g. an
 *     audit log of admin actions), the call site should make the
 *     decision per-jurisdiction rather than blanket-redacting them
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined,
  redact: {
    paths: [
      '*.password',
      '*.passwd',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.authorization',
      '*.cookie',
      'headers.authorization',
      'headers.cookie',
      '*.privateKey',
      '*.secret',
      '*.apiKey',
      '*.text_value',
    ],
    censor: '[REDACTED]',
  },
})

export type Logger = typeof logger
