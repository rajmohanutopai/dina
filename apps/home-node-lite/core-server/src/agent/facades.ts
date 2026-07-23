/**
 * Item 5c — the coding-agent memory-ingress backing (dina_remember).
 *
 * Wires the `/v1/agent/memory` façade to a REAL, provenance-preserving vault
 * write through the item-5b origin seam. The write carries origin
 * `staging_item` (the ingest origin — it may write, never delete) and records
 * the ingesting agent DID as the item `source`, so provenance survives.
 *
 * The other façades (find-service / talk / delegate / peerlens) are wired here
 * as their backing subsystems (AppView search, D2D + phone approval, delegation,
 * PeerLens) are integrated; an un-wired façade simply registers no route.
 */

import {
  storeItem,
  requireAgentPersonaAccess,
  resolvePersonaName,
  type AgentFacadeHandlers,
} from '@dina/core';

const MAX_MEMORY_BYTES = 32 * 1024;

export function createAgentFacades(): AgentFacadeHandlers {
  return {
    // 5c — dina_remember: provenance-preserving ingress.
    memory: (ctx) => {
      const content = typeof ctx.body.content === 'string' ? ctx.body.content.trim() : '';
      if (content === '') {
        return { status: 400, body: { error: 'missing required field: content' } };
      }
      if (content.length > MAX_MEMORY_BYTES) {
        return { status: 413, body: { error: 'content too large' } };
      }
      // Canonicalise the persona ONCE — trim + alias (e.g. ' work ' →
      // 'professional') — so the PEP check and the vault write target the SAME
      // persona. requireAgentPersonaAccess trims internally; if we didn't trim
      // here too, a padded name would gate one persona and write another.
      const rawPersona =
        typeof ctx.body.persona === 'string' && ctx.body.persona.trim() !== ''
          ? ctx.body.persona.trim()
          : 'general';
      const persona = resolvePersonaName(rawPersona);
      const summary =
        typeof ctx.body.summary === 'string' && ctx.body.summary !== ''
          ? ctx.body.summary
          : content.slice(0, 80);

      // CRITICAL (audit finding): the origin seam lets `staging_item` WRITE, but
      // that must NOT let an agent inject into a sensitive/locked persona without
      // the owner's say-so. Run the deterministic persona PEP first: a free
      // persona passes; a sensitive/locked one with no grant raises an idempotent
      // approval card and returns approval_required WITHOUT writing.
      try {
        const decision = requireAgentPersonaAccess({
          agentDID: ctx.agentDid,
          persona,
          mode: 'write',
          scope: 'agent memory ingress', // label only — never the content
          sessionId: ctx.sessionId || null,
        });
        if (decision.kind === 'denied') {
          return { status: 403, body: { error: 'persona_access_denied', reason: decision.reason } };
        }
        if (decision.kind === 'approval_required') {
          return { status: 202, body: { status: 'approval_required', task_id: decision.taskId, persona } };
        }
      } catch (err) {
        // getPersonaTier throws on an unknown persona → clean 400, not a 500.
        return { status: 400, body: { error: `unknown persona: ${persona}` } };
      }
      try {
        // Origin `staging_item` → the seam allows the write (5b); provenance in
        // `source`. Persona PEP above has cleared this persona for this agent.
        const id = storeItem(
          persona,
          {
            type: 'user_memory',
            summary,
            body: content,
            source: `agent:${ctx.agentDid}`,
          },
          'staging_item',
        );
        return { status: 200, body: { id, persona, status: 'stored' } };
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
    },
  };
}
