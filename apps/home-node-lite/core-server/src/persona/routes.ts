/**
 * Task 4.92 — HTTP bindings for persona + passphrase primitives.
 *
 * Wires the in-process primitives from 4.68 (`persona_config`), 4.69
 * (`PassphraseRegistry`), 4.70 (`SessionGrantRegistry`), 4.71
 * (`AutoLockRegistry`), 4.72 (`ApprovalRegistry`) into HTTP endpoints
 * so admin tools + the Brain can orchestrate persona lifecycle.
 *
 *   GET    /v1/personas              — list personas + tier + open state
 *   POST   /v1/personas/:name/unlock — unlock via passphrase or approval
 *   POST   /v1/personas/:name/lock   — lock a sensitive persona
 *
 * **Wire shape**:
 *
 *   GET response:
 *     { personas: [{ name, tier, description?, is_open, auto_locks_at_ms? }, ...] }
 *
 *   Unlock request:
 *     { passphrase?: string }        — for `locked` tier
 *     (body may be empty for `sensitive` tier when caller holds a session grant)
 *
 *   Unlock response (200):
 *     { name, tier, is_open: true, auto_locks_at_ms?: number }
 *
 *   Unlock rejection taxonomy:
 *     400 — malformed body
 *     401 — wrong passphrase (locked tier) / missing passphrase when required
 *     403 — caller doesn't have the required approval/grant
 *     404 — unknown persona
 *     409 — persona already open (non-error signal — callers often just probe)
 *
 *   Lock response (204):
 *     No body on success. 404 on unknown.
 *
 * **Tier-routed unlock behavior** (from CLAUDE.md §Persona Access Tiers):
 *   - `default`    — already open on boot; unlock is idempotent (returns 200 immediately)
 *   - `standard`   — already open on boot; same as default
 *   - `sensitive`  — requires an approval OR a session grant; call order:
 *                    (1) check active approval registry, (2) check session grant
 *   - `locked`     — requires passphrase; verified via `PassphraseRegistry.verify`
 *
 * **Why this plugin** — 4.68–4.72 built the in-process state machines
 * for each primitive; this module provides the HTTP surface they need
 * to be usable from outside the process. ADMIN_GAP.md surfaced this
 * as a follow-on to the 4.84 audit.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4m task 4.92.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PersonaTier } from '@dina/core';

import type { LoadedPersonaConfig, PersonaDefinition } from './persona_config';
import type { PassphraseRegistry } from './passphrase_unlock';
import type { AutoLockRegistry } from './auto_lock';
import type { SessionGrantRegistry } from './session_grants';
import type { ApprovalRegistry } from './approval_registry';

/**
 * Metadata a caller passes to `unlock()` when the tier requires proof.
 * The route extracts each field from its place in the request context —
 * caller identity from `req.agentDid` (auth middleware), approval id
 * from the body.
 */
export interface UnlockProof {
  passphrase?: string;
  approvalId?: string;
  sessionId?: string;
  agentDid?: string;
}

export interface PersonaRoutesOptions {
  /** Loaded persona config (task 4.68). Source of truth for tier + description. */
  personaConfig: LoadedPersonaConfig;
  /** Passphrase verifier (task 4.69) — required for `locked` tier. */
  passphrases?: PassphraseRegistry;
  /** Auto-lock TTL registry (task 4.71) — tracks `is_open` + `auto_locks_at_ms`. */
  autoLock?: AutoLockRegistry;
  /** Session grants (task 4.70) — consulted for `sensitive` tier access. */
  sessionGrants?: SessionGrantRegistry;
  /** Approval registry (task 4.72) — consulted for `sensitive` tier access. */
  approvals?: ApprovalRegistry;
}

type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

export interface PersonaListEntry {
  name: string;
  tier: PersonaTier;
  description?: string;
  is_open: boolean;
  auto_locks_at_ms?: number;
}

export function registerPersonaRoutes(
  app: FastifyAppShape,
  opts: PersonaRoutesOptions,
): void {
  const { personaConfig } = opts;
  if (!personaConfig) {
    throw new Error('registerPersonaRoutes: personaConfig is required');
  }

  // -------------------------------------------------------------------------
  // GET /v1/personas
  //
  // List every persona from the config with its current open/closed
  // state (from AutoLockRegistry if supplied — otherwise assume
  // "open" for default/standard and "closed" for sensitive/locked,
  // which matches boot-time semantics).
  // -------------------------------------------------------------------------

  app.get('/v1/personas', async () => {
    const personas: PersonaListEntry[] = [];
    for (const def of personaConfig.personas.values()) {
      const entry: PersonaListEntry = {
        name: def.name,
        tier: def.tier,
        is_open: computeIsOpen(def, opts),
      };
      if (def.description !== undefined) entry.description = def.description;
      const deadline = opts.autoLock?.deadline(def.name);
      if (deadline !== null && deadline !== undefined) {
        entry.auto_locks_at_ms = deadline;
      }
      personas.push(entry);
    }
    personas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { personas };
  });

  // -------------------------------------------------------------------------
  // POST /v1/personas/:name/unlock
  // -------------------------------------------------------------------------

  app.post('/v1/personas/:name/unlock', async (req, reply) => {
    const params = req.params as { name?: string };
    const name = typeof params.name === 'string' ? params.name : '';
    if (name.length === 0) {
      await reply.code(400).send({ error: 'persona name is required' });
      return;
    }
    const def = personaConfig.personas.get(name);
    if (def === undefined) {
      await reply.code(404).send({ error: `persona "${name}" not found` });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const proof: UnlockProof = {};
    if (typeof body['passphrase'] === 'string') proof.passphrase = body['passphrase'];
    if (typeof body['approval_id'] === 'string') proof.approvalId = body['approval_id'];
    if (typeof body['session_id'] === 'string') proof.sessionId = body['session_id'];
    // `agent_did` would typically be pulled from req.agentDid after auth;
    // accept from body for test ergonomics + when no middleware has set it.
    if (typeof body['agent_did'] === 'string') proof.agentDid = body['agent_did'];

    // Already-open short-circuit. `default` + `standard` are auto-open,
    // and any sensitive persona currently unlocked-in-flight also passes.
    if (computeIsOpen(def, opts)) {
      const entry = buildEntry(def, opts);
      return entry;
    }

    const outcome = await verifyUnlock(def, proof, opts);
    if (!outcome.ok) {
      await reply.code(outcome.status).send({ error: outcome.error });
      return;
    }

    // Mark the persona unlocked via the AutoLockRegistry (if wired).
    // `standard`/`default` don't auto-lock; only `sensitive` is rail-ed
    // through AutoLockRegistry.
    if (def.tier === 'sensitive' || def.tier === 'locked') {
      opts.autoLock?.unlock(def.name);
    }

    return buildEntry(def, opts);
  });

  // -------------------------------------------------------------------------
  // POST /v1/personas/:name/lock
  // -------------------------------------------------------------------------

  app.post('/v1/personas/:name/lock', async (req, reply) => {
    const params = req.params as { name?: string };
    const name = typeof params.name === 'string' ? params.name : '';
    if (name.length === 0) {
      await reply.code(400).send({ error: 'persona name is required' });
      return;
    }
    const def = personaConfig.personas.get(name);
    if (def === undefined) {
      await reply.code(404).send({ error: `persona "${name}" not found` });
      return;
    }
    // `default` + `standard` are auto-open on boot; locking them is a no-op
    // (admin couldn't re-open-without-something anyway).
    if (def.tier !== 'sensitive' && def.tier !== 'locked') {
      await reply
        .code(409)
        .send({ error: `cannot lock ${def.tier}-tier persona` });
      return;
    }
    opts.autoLock?.lock(def.name);
    await reply.code(204).send();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeIsOpen(
  def: PersonaDefinition,
  opts: PersonaRoutesOptions,
): boolean {
  if (def.tier === 'default' || def.tier === 'standard') return true;
  return opts.autoLock?.isUnlocked(def.name) ?? false;
}

function buildEntry(
  def: PersonaDefinition,
  opts: PersonaRoutesOptions,
): PersonaListEntry {
  const entry: PersonaListEntry = {
    name: def.name,
    tier: def.tier,
    is_open: computeIsOpen(def, opts),
  };
  if (def.description !== undefined) entry.description = def.description;
  const deadline = opts.autoLock?.deadline(def.name);
  if (deadline !== null && deadline !== undefined) {
    entry.auto_locks_at_ms = deadline;
  }
  return entry;
}

interface UnlockOutcome {
  ok: boolean;
  status: number;
  error: string;
}

async function verifyUnlock(
  def: PersonaDefinition,
  proof: UnlockProof,
  opts: PersonaRoutesOptions,
): Promise<UnlockOutcome> {
  if (def.tier === 'locked') {
    // Passphrase required.
    if (opts.passphrases === undefined) {
      return {
        ok: false,
        status: 501,
        error: 'passphrase verification not configured',
      };
    }
    if (proof.passphrase === undefined || proof.passphrase.length === 0) {
      return { ok: false, status: 401, error: 'passphrase is required' };
    }
    const ok = await opts.passphrases.verify(def.name, proof.passphrase);
    if (!ok) return { ok: false, status: 401, error: 'invalid passphrase' };
    return { ok: true, status: 200, error: '' };
  }

  if (def.tier === 'sensitive') {
    // Approval OR session grant satisfies.
    if (proof.approvalId !== undefined && opts.approvals !== undefined) {
      const req = opts.approvals.get(proof.approvalId);
      if (req !== undefined && req.status === 'approved' && req.persona === def.name) {
        return { ok: true, status: 200, error: '' };
      }
    }
    if (
      proof.sessionId !== undefined &&
      proof.agentDid !== undefined &&
      opts.sessionGrants !== undefined
    ) {
      const has = opts.sessionGrants.check(proof.agentDid, def.name, 'read');
      if (has) return { ok: true, status: 200, error: '' };
    }
    return {
      ok: false,
      status: 403,
      error: 'sensitive persona requires approval or active session grant',
    };
  }

  // default / standard — already open per computeIsOpen short-circuit above.
  // If we reach here, it's a logic bug.
  return { ok: true, status: 200, error: '' };
}
