/**
 * Outbound skill bindings (design §5.5): what the owner says about one skill
 * of one pinned remote card before Dina may call it.
 *
 * A binding is keyed `(remote_agent_id, card_hash, skill)`, so a changed card
 * voids it. It names an action class (never `payment`), the `credential_ref`
 * the call uses (`'none'`-kind refs included, design §5.3), and optionally a
 * result schema. A pinned result schema may use only the keywords Core's
 * validator enforces (`pinnedSchemaProblems(…, 'pinned_runtime')`): a
 * constraint that would be silently ignored is a constraint the owner thinks
 * protects them and does not, so such a schema is refused at binding time. A
 * schema identical to the default result envelope IS the default, and is
 * stored as no schema.
 */

import { DEFAULT_RESULT_SCHEMA_HASH, LOWER_HEX_64, canonicalize, isPlainObject } from '@dina/a2a';
import { pinnedSchemaProblems } from '@dina/protocol';

import { isAssignableOutboundClass, type InboundActionClass } from './action_registry';
import { sha256HexOfText } from './digest';

export const MAX_RESULT_SCHEMA_BYTES = 64 * 1024;

export interface SkillBindingInput {
  remoteAgentId: string;
  cardHash: string;
  /** The remote `AgentSkill.id`, verbatim. */
  skill: string;
  actionClass: string;
  credentialRef: string;
  resultSchema?: unknown;
}

export interface ValidSkillBinding {
  remoteAgentId: string;
  cardHash: string;
  skill: string;
  actionClass: InboundActionClass;
  credentialRef: string;
  resultSchema?: Record<string, unknown>;
}

export type SkillBindingCheck =
  | { ok: true; binding: ValidSkillBinding }
  | { ok: false; reason: string };

/** Printable, bounded identifiers: no control characters, no surrounding space. */
function isPlainId(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
  if (value.trim() !== value) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return true;
}

export function validateSkillBinding(input: SkillBindingInput): SkillBindingCheck {
  if (!isPlainId(input.remoteAgentId, 128)) return { ok: false, reason: 'remote_agent_id_invalid' };
  if (!LOWER_HEX_64.test(input.cardHash)) return { ok: false, reason: 'card_hash_invalid' };
  if (!isPlainId(input.skill, 256)) return { ok: false, reason: 'skill_invalid' };
  if (input.actionClass === 'payment') return { ok: false, reason: 'payment_unassignable' };
  if (!isAssignableOutboundClass(input.actionClass))
    return { ok: false, reason: 'action_class_invalid' };
  if (!isPlainId(input.credentialRef, 128)) return { ok: false, reason: 'credential_ref_invalid' };
  const binding: ValidSkillBinding = {
    remoteAgentId: input.remoteAgentId,
    cardHash: input.cardHash,
    skill: input.skill,
    actionClass: input.actionClass,
    credentialRef: input.credentialRef,
  };
  if (input.resultSchema !== undefined) {
    if (!isPlainObject(input.resultSchema))
      return { ok: false, reason: 'result_schema_not_object' };
    let text: string;
    try {
      text = canonicalize(input.resultSchema);
    } catch {
      return { ok: false, reason: 'result_schema_not_json' };
    }
    if (new TextEncoder().encode(text).length > MAX_RESULT_SCHEMA_BYTES) {
      return { ok: false, reason: 'result_schema_too_large' };
    }
    if (sha256HexOfText(text) === DEFAULT_RESULT_SCHEMA_HASH) return { ok: true, binding };
    const problems = pinnedSchemaProblems(input.resultSchema, 'pinned_runtime');
    const firstProblem = problems[0];
    if (firstProblem !== undefined) {
      return { ok: false, reason: `result_schema_unsupported:${firstProblem.path}` };
    }
    binding.resultSchema = input.resultSchema;
  }
  return { ok: true, binding };
}
