/**
 * Agent-intent summary — pure renderer for agent-review prompts.
 *
 * When `agent_gateway.decide()` returns `{action: 'review'}`, the
 * UI needs a scannable human summary: "Agent X wants to <verb>
 * <what> to <persona>. Reason: <risk>." This primitive produces
 * that summary.
 *
 * **Pure** — no IO. Designed to feed `review_queue.enqueue`'s
 * `summary` field + to render review prompts / push notifications.
 *
 * **Two outputs**:
 *
 *   - `short` — single-line for list views + push titles
 *     (title-cased, <80 chars).
 *   - `long`  — multi-line for the approval screen (risk +
 *     rationale + target + label).
 *
 * **Graceful on missing data** — any missing field renders as "an
 * unknown agent" / "an unknown resource" rather than blanks.
 *
 * **Deterministic** — same input → same output. No clock, no RNG.
 */

import type { AgentIntent, AgentRisk } from './agent_gateway';

export interface AgentIntentSummary {
  short: string;
  long: string;
  /** Machine-readable echo of the core fields for logging. */
  fields: {
    agentDid: string;
    agentName: string | null;
    risk: AgentRisk;
    personaName: string;
    op: AgentIntent['op'];
    label: string | null;
  };
}

export interface SummaryOptions {
  /** Known agent display name, when available. */
  agentName?: string;
  /** Optional rationale string (why the gateway wants review). */
  rationale?: string;
  /** Max length of the `short` line. Default 80. */
  maxShortChars?: number;
}

const RISK_VERBS: Readonly<Record<AgentRisk, string>> = {
  read: 'read',
  send: 'send',
  pay: 'pay via',
  share: 'share with',
  delete: 'delete from',
  execute: 'run code against',
};

const OP_TARGETS: Readonly<Record<AgentIntent['op'], string>> = {
  read: 'data in',
  write: 'items into',
  share: 'data from',
  export: 'a full export of',
};

export const DEFAULT_MAX_SHORT_CHARS = 80;

/**
 * Produce a review-prompt summary from an agent intent + optional context.
 */
export function summariseAgentIntent(
  intent: AgentIntent,
  opts: SummaryOptions = {},
): AgentIntentSummary {
  validate(intent);
  const agentName = opts.agentName?.trim() || null;
  const agentLabel =
    agentName && agentName !== '' ? agentName : shortenDid(intent.agentDid);

  const riskVerb = RISK_VERBS[intent.risk];
  const opTarget = OP_TARGETS[intent.op];
  const label = intent.label?.trim() || null;
  const rationale = opts.rationale?.trim() || null;

  const shortCore =
    `${titleCase(agentLabel)} wants to ${riskVerb} ${opTarget} "${intent.persona.name}"`;
  const short = truncate(shortCore, opts.maxShortChars ?? DEFAULT_MAX_SHORT_CHARS);

  const longLines: string[] = [
    `Agent: ${agentLabel} (${intent.agentDid})`,
    `Risk: ${intent.risk.toUpperCase()} — ${riskVerb} ${opTarget} "${intent.persona.name}"`,
    `Persona tier: ${intent.persona.tier}${intent.persona.open ? ' (open)' : ' (closed)'}`,
  ];
  if (label) longLines.push(`What: ${label}`);
  if (rationale) longLines.push(`Why review: ${rationale}`);
  const long = longLines.join('\n');

  return {
    short,
    long,
    fields: {
      agentDid: intent.agentDid,
      agentName,
      risk: intent.risk,
      personaName: intent.persona.name,
      op: intent.op,
      label,
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(intent: AgentIntent): void {
  if (!intent || typeof intent !== 'object') {
    throw new TypeError('summariseAgentIntent: intent required');
  }
  if (typeof intent.agentDid !== 'string' || !intent.agentDid.startsWith('did:')) {
    throw new TypeError('summariseAgentIntent: agentDid must be a DID');
  }
  if (!intent.persona || typeof intent.persona.name !== 'string' || intent.persona.name === '') {
    throw new TypeError('summariseAgentIntent: persona.name required');
  }
  if (!(intent.risk in RISK_VERBS)) {
    throw new TypeError(`summariseAgentIntent: unknown risk "${String(intent.risk)}"`);
  }
  if (!(intent.op in OP_TARGETS)) {
    throw new TypeError(`summariseAgentIntent: unknown op "${String(intent.op)}"`);
  }
}

function shortenDid(did: string): string {
  // `did:plc:alonso12345` → `did:plc:alonso…`. Preserves enough to
  // recognise; truncates the tail.
  if (did.length <= 20) return did;
  return `${did.slice(0, 18)}…`;
}

function titleCase(text: string): string {
  const first = text.charAt(0).toUpperCase();
  return `${first}${text.slice(1)}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
