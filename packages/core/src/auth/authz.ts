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
 *   agent:     vault/query (via session grant), staging/ingest, api/ask (with session)
 *
 * Paths are matched by prefix: "/v1/staging" matches "/v1/staging/ingest",
 * "/v1/staging/claim", etc.
 *
 * Source: core/internal/middleware/authz.go, ARCHITECTURE.md Section 18.4
 */

export type CallerType = 'brain' | 'admin' | 'connector' | 'device' | 'agent' | 'plugin';

/**
 * Authorization rules: each entry maps a path prefix to the set of
 * caller types allowed to access it.
 *
 * More specific paths are listed first. The first matching prefix wins.
 */
/**
 * A rule matches when the path has `prefix` (boundary-safe) AND — when
 * `suffix` is present — ends with that suffix. Suffix rules exist for
 * the plugin P0 matrix (PLUGIN_ARCHITECTURE.md §9.0): the six allowed
 * verbs live at `/v1/workflow/tasks/:id/<verb>`, which pure prefix
 * matching cannot carve out of the wider tasks sub-tree. Suffix rules
 * are listed BEFORE their generic prefix so first-match-wins keeps the
 * plugin surface minimal: claim / heartbeat / progress / complete /
 * fail / healthz — nothing else, in any phase (ingest + notify are P3
 * handler-gated additions, not present here yet).
 */
const AUTHZ_RULES: {
  prefix: string;
  suffix?: string;
  /** When set, the rule claims only this HTTP method (suffix rules are
   * POST-only verbs; without this, GET /v1/workflow/tasks/complete — a
   * task id literally named "complete" — would match the suffix rule
   * and leak read access to callers the generic rule excludes). */
  method?: string;
  /** When true, the rule matches ONLY the exact path (not a boundary
   * prefix). Audit D1: without this, `/v1/workflow/tasks/claim` as a
   * prefix authorizes a plugin for `/claim/<anything>` too — harmless
   * today (no such route → 404) but a latent over-authorization if a
   * `/claim/*` sub-route is ever added. Exact-match closes it. */
  exact?: boolean;
  allowed: Set<CallerType>;
}[] = [
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

  // People graph — Brain owns the write surface
  // (post-publish extractor in the staging drain).
  { prefix: '/v1/people/', allowed: new Set(['brain']) },

  // Staging inbox — Brain owns remember/connectors drain over signed HTTP.
  { prefix: '/v1/staging/', allowed: new Set(['brain']) },

  // Audit — Admin + Brain
  { prefix: '/v1/audit/', allowed: new Set(['admin', 'brain']) },

  // Owner-private contact-service decision log — OWNER surfaces only, NEVER
  // Brain. This is sensitive social-tier metadata (who was soft-rejected, at
  // what closeness); surfacing it to the Brain/LLM would violate the
  // "owner-private" invariant (CONTACT_SERVICES_ARCHITECTURE.md §2/§10). Listed
  // BEFORE the broader `/v1/contacts` rule so the more-specific prefix wins
  // (first-match iteration). The mobile app reads this log in-process; this
  // route is for owner-authenticated out-of-process / thin clients.
  { prefix: '/v1/contacts/service-decisions', allowed: new Set(['admin', 'device']) },

  // Contacts — Admin + Brain
  { prefix: '/v1/contacts', allowed: new Set(['admin', 'brain']) },

  // Reminders — Admin + Brain + Device (both singular and plural paths)
  { prefix: '/v1/reminder', allowed: new Set(['admin', 'brain', 'device']) },
  { prefix: '/v1/reminders', allowed: new Set(['admin', 'brain', 'device']) },

  // Notify — Brain
  { prefix: '/v1/notify', allowed: new Set(['brain']) },

  // D2D messaging — Brain
  { prefix: '/v1/msg/', allowed: new Set(['brain']) },

  // D2D quarantine review (unknown-sender messages) — owner-private, so
  // Brain (proxying the web SPA) + Admin only; NOT device/agent/connector.
  { prefix: '/v1/d2d/', allowed: new Set(['brain', 'admin']) },

  // Service discovery + workflow (service discovery scenario) — Brain owns publish
  // flow + orchestrates queries; Admin can read/write config from the UI.
  { prefix: '/v1/service/', allowed: new Set(['brain', 'admin']) },

  // Workflow-task lifecycle — Brain owns the surface; Admin reads for
  // diagnostics + approves from the app UI. Paired dina-agent devices
  // (role='agent') additionally claim + heartbeat + progress + complete
  // + fail delegation tasks via the /v1/workflow/tasks/ sub-tree. More
  // specific prefix listed first so agent rule wins for task endpoints.
  // NOTE: prefix authz is path-only and can't carve out the dynamic
  // `/:id/approve` + `/:id/cancel` suffixes, so the OWNER-only restriction
  // on the approve/deny *decision* (an agent must never self-approve its own
  // persona-access grant or intent proposal) is enforced in the route
  // handler — see `ownerDecisionGuard` in server/routes/workflow.ts.
  //
  // Plugin instances (§9.0 P0 matrix): claim + the four per-task verbs
  // ONLY — via the suffix rules below, which sit before the generic
  // sub-tree rule so a plugin caller never reaches create/list/get/
  // approve/cancel/running. In-handler, the six claim-time checks
  // (§9.1) gate WHAT a claim may take; this matrix gates WHERE a
  // plugin may speak at all.
  {
    prefix: '/v1/workflow/tasks/claim',
    method: 'POST',
    exact: true,
    allowed: new Set(['brain', 'admin', 'agent', 'plugin']),
  },
  {
    prefix: '/v1/workflow/tasks/',
    suffix: '/heartbeat',
    method: 'POST',
    allowed: new Set(['brain', 'admin', 'agent', 'plugin']),
  },
  {
    prefix: '/v1/workflow/tasks/',
    suffix: '/progress',
    method: 'POST',
    allowed: new Set(['brain', 'admin', 'agent', 'plugin']),
  },
  {
    prefix: '/v1/workflow/tasks/',
    suffix: '/complete',
    method: 'POST',
    allowed: new Set(['brain', 'admin', 'agent', 'plugin']),
  },
  {
    prefix: '/v1/workflow/tasks/',
    suffix: '/fail',
    method: 'POST',
    allowed: new Set(['brain', 'admin', 'agent', 'plugin']),
  },
  { prefix: '/v1/workflow/tasks/', allowed: new Set(['brain', 'admin', 'agent']) },
  { prefix: '/v1/workflow/', allowed: new Set(['brain', 'admin']) },

  // Session lifecycle — paired dina-agent opens a session before
  // claiming a delegation task (vault scoping) and ends it after
  // completion. Brain + Admin orchestrate session lifecycle from the
  // app side. Device (CLI) callers also create sessions to scope
  // interactive queries — TS Core sessions are currently no-op stubs
  // so there is no vault-grant risk.
  { prefix: '/v1/session/', allowed: new Set(['brain', 'admin', 'agent', 'device']) },

  // Agent intent validation — `dina validate` from OpenClaw + sample
  // agents. Paired agents POST
  // /v1/agent/validate (the submit endpoint) and poll
  // /v1/intent/proposals/:id/status (the status endpoint). Brain +
  // Admin + Device may also probe (chat orchestrator surfaces
  // proposals; admin UI inspects them).
  { prefix: '/v1/agent/', allowed: new Set(['brain', 'admin', 'device', 'agent']) },
  { prefix: '/v1/intent/', allowed: new Set(['brain', 'admin', 'device', 'agent']) },

  // User-facing API — Device (app UI) + Admin + Agent (with session for MT-38)
  { prefix: '/api/v1/ask', allowed: new Set(['device', 'admin', 'brain', 'agent']) },
  { prefix: '/api/v1/remember', allowed: new Set(['device', 'admin', 'brain']) },

  // Health check — everyone
  {
    prefix: '/healthz',
    allowed: new Set(['brain', 'admin', 'connector', 'device', 'agent', 'plugin']),
  },
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
    if (!hasPathPrefix(path, rule.prefix)) continue;
    // An `exact` rule claims ONLY its literal path — a longer path
    // sharing the prefix falls through to later rules.
    if (rule.exact === true && path !== rule.prefix) continue;
    // Suffix/method rules only claim their exact verb shape; a
    // non-match falls through to later (more generic) rules for the
    // same prefix.
    if (rule.suffix !== undefined && !path.endsWith(rule.suffix)) continue;
    if (rule.method !== undefined && rule.method !== method) continue;
    return rule.allowed.has(callerType);
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
    // Suffix/method rules share a prefix with the generic sub-tree rule;
    // composite keys keep the diagnostic view lossless instead of
    // last-write-wins collapsing them.
    const key =
      rule.prefix +
      (rule.suffix !== undefined ? `*${rule.suffix}` : '') +
      (rule.method !== undefined ? ` [${rule.method}]` : '');
    matrix[key] = Array.from(rule.allowed);
  }
  return matrix;
}
