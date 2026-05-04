/**
 * Per-service authorization matrix.
 *
 * Maps (path, caller_type) → allowed/denied. Matches the server's
 * auth middleware exactly.
 *
 * Caller types:
 *   brain:     vault/query, vault/store, staging/*, pii/scrub, vault/kv, memory/*
 *   admin:     persona/unlock, persona/lock, devices, export, pair, approvals
 *   connector: staging/ingest only
 *   device:    all read endpoints (query, list), approvals
 *   agent:     vault/query (via session grant), staging/ingest
 *
 * Paths are matched by prefix: "/v1/staging" matches "/v1/staging/ingest",
 * "/v1/staging/claim", etc.
 *
 * Source: core/internal/middleware/authz.go, ARCHITECTURE.md Section 18.4
 */

export type CallerType = 'brain' | 'admin' | 'connector' | 'device' | 'agent';

/**
 * Authorization rules: each entry maps a path prefix to the set of
 * caller types allowed to access it.
 *
 * More specific paths are listed first. The first matching prefix wins.
 */
const AUTHZ_RULES: Array<{ prefix: string; allowed: Set<CallerType> }> = [
  // Vault — Brain reads/writes, device reads, agent reads (via grant)
  { prefix: '/v1/vault/store/batch', allowed: new Set(['brain']) },
  { prefix: '/v1/vault/store', allowed: new Set(['brain']) },
  { prefix: '/v1/vault/query', allowed: new Set(['brain', 'device', 'agent']) },
  { prefix: '/v1/vault/item/', allowed: new Set(['brain', 'device']) },
  { prefix: '/v1/vault/kv/', allowed: new Set(['brain', 'device']) },

  // Staging — Brain full access, connector ingest only
  { prefix: '/v1/staging/ingest', allowed: new Set(['brain', 'connector']) },
  { prefix: '/v1/staging/claim', allowed: new Set(['brain']) },
  { prefix: '/v1/staging/resolve', allowed: new Set(['brain']) },
  { prefix: '/v1/staging/fail', allowed: new Set(['brain']) },
  { prefix: '/v1/staging/extend-lease', allowed: new Set(['brain']) },

  // Persona management — Admin only
  { prefix: '/v1/persona/unlock', allowed: new Set(['admin']) },
  { prefix: '/v1/persona/lock', allowed: new Set(['admin']) },
  { prefix: '/v1/personas', allowed: new Set(['admin', 'brain', 'device']) },

  // Identity — Admin + Brain (read)
  { prefix: '/v1/did', allowed: new Set(['admin', 'brain']) },

  // Devices — Admin only
  { prefix: '/v1/devices', allowed: new Set(['admin']) },

  // Device pairing — Admin generates the code; `/v1/pair/complete`
  // is explicitly `auth: 'public'` on the route itself (the code
  // itself is the credential), so we only list the admin-gated
  // initiate endpoint here.
  { prefix: '/v1/pair/initiate', allowed: new Set(['admin']) },

  // Export/Import — Admin only
  { prefix: '/v1/export', allowed: new Set(['admin']) },
  { prefix: '/v1/import', allowed: new Set(['admin']) },

  // Approvals — Admin + Device (user approves from UI)
  { prefix: '/v1/approvals', allowed: new Set(['admin', 'device']) },

  // PII — Brain
  { prefix: '/v1/pii/', allowed: new Set(['brain']) },

  // Working Memory — Brain (touch on ingest, read ToC on reasoning).
  // §5.5 design doc: narrow prefix, read-only ToC + POST-touch for ingest.
  // Source: Go adminEndpointChecker.allowedForBrain (auth.go).
  { prefix: '/v1/memory/', allowed: new Set(['brain']) },

  // Audit — Admin + Brain
  { prefix: '/v1/audit/', allowed: new Set(['admin', 'brain']) },

  // Contacts — Admin + Brain
  { prefix: '/v1/contacts', allowed: new Set(['admin', 'brain']) },

  // Reminders — Admin + Brain + Device (both singular and plural paths)
  { prefix: '/v1/reminder', allowed: new Set(['admin', 'brain', 'device']) },
  { prefix: '/v1/reminders', allowed: new Set(['admin', 'brain', 'device']) },

  // Notify — Brain
  { prefix: '/v1/notify', allowed: new Set(['brain']) },

  // D2D messaging — Brain
  { prefix: '/v1/msg/', allowed: new Set(['brain']) },

  // Service discovery + workflow (Bus Driver scenario) — Brain owns publish
  // flow + orchestrates queries; Admin can read/write config from the UI.
  { prefix: '/v1/service/', allowed: new Set(['brain', 'admin']) },

  // Workflow-task lifecycle — Brain owns the surface; Admin reads for
  // diagnostics + approves from the app UI. Paired dina-agent devices
  // (role='agent') additionally claim + heartbeat + progress + complete
  // + fail delegation tasks via the /v1/workflow/tasks/ sub-tree. More
  // specific prefix listed first so agent rule wins for task endpoints.
  { prefix: '/v1/workflow/tasks/', allowed: new Set(['brain', 'admin', 'agent']) },
  { prefix: '/v1/workflow/', allowed: new Set(['brain', 'admin']) },

  // Session lifecycle — paired dina-agent opens a session before
  // claiming a delegation task (vault scoping) and ends it after
  // completion. Brain + Admin orchestrate session lifecycle from the
  // app side.
  { prefix: '/v1/session/', allowed: new Set(['brain', 'admin', 'agent']) },

  // Agent intent validation — `dina validate` from OpenClaw + sample
  // agents. Wire-compatible with Go Core: paired agents POST
  // /v1/agent/validate (the submit endpoint) and poll
  // /v1/intent/proposals/:id/status (the status endpoint). Brain +
  // Admin + Device may also probe (chat orchestrator surfaces
  // proposals; admin UI inspects them).
  { prefix: '/v1/agent/', allowed: new Set(['brain', 'admin', 'device', 'agent']) },
  { prefix: '/v1/intent/', allowed: new Set(['brain', 'admin', 'device', 'agent']) },

  // User-facing API — Device (app UI) + Admin
  { prefix: '/api/v1/ask', allowed: new Set(['device', 'admin', 'brain']) },
  { prefix: '/api/v1/remember', allowed: new Set(['device', 'admin', 'brain']) },

  // Health check — everyone
  { prefix: '/healthz', allowed: new Set(['brain', 'admin', 'connector', 'device', 'agent']) },
];

/**
 * Check if a path matches a prefix with boundary safety.
 *
 * Matches Go's `hasPathPrefix`: the path must either equal the prefix
 * exactly, or the character at the prefix boundary must be '/'.
 * This prevents `/v1/vault/storefoo` from matching `/v1/vault/store`.
 *
 * Source: Go core/internal/middleware/auth.go hasPathPrefix()
 */
function hasPathPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  // Exact match
  if (path.length === prefix.length) return true;
  // Prefix already ends with '/' — any continuation is fine
  if (prefix.endsWith('/')) return true;
  // Character at boundary must be '/'
  return path[prefix.length] === '/';
}

/**
 * Check if a caller type is authorized for an endpoint.
 *
 * Uses boundary-safe prefix matching to prevent `/v1/vault/storefoo`
 * from matching the `/v1/vault/store` rule. The path must either
 * equal the prefix exactly or continue with a `/` separator.
 *
 * @param callerType - The authenticated caller's type
 * @param method - HTTP method (unused currently — all methods share the same rule per path)
 * @param path - URL path (e.g., "/v1/vault/query")
 * @returns true if authorized
 */
export function isAuthorized(callerType: CallerType, method: string, path: string): boolean {
  for (const rule of AUTHZ_RULES) {
    if (hasPathPrefix(path, rule.prefix)) {
      return rule.allowed.has(callerType);
    }
  }
  // Unknown path — deny by default (fail-closed)
  return false;
}

/**
 * Get the full authorization matrix as a lookup table.
 * Maps path prefix → list of allowed caller types.
 */
export function getAuthorizationMatrix(): Record<string, CallerType[]> {
  const matrix: Record<string, CallerType[]> = {};
  for (const rule of AUTHZ_RULES) {
    matrix[rule.prefix] = Array.from(rule.allowed);
  }
  return matrix;
}
