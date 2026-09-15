/**
 * RENDERING A PLUGIN'S ANSWER (PLUGIN_ARCHITECTURE.md §15.6, §11).
 *
 * A completed invocation used to reach the owner as `label: value` lines —
 * the untrusted floor, and an honest one, but a floor: a filing's bill
 * number, its validity and its status all read at the same weight, and the
 * one line that should stop a reader looks like a footnote.
 *
 * §15.6 says what replaces it: "Third-party UI is CardSpec only, rendered in
 * untrusted mode." This module is that render, and it lives in Core for the
 * reason §15.13 gives — the safe-rendering rule is policy, and policy
 * duplicated across two clients is policy that diverges. The phone and the
 * web both call this one function; neither decides anything.
 *
 * THREE THINGS MAKE IT SAFE, AND NONE OF THEM IS TRUST.
 *
 *   1. The LAYOUT is the manifest's, pinned in the envelope at enqueue
 *      (`card_snapshot`). The publisher wrote it once, it is signed and
 *      content-addressed, it sits in the presentation hash so a rewrite lands
 *      in the owner's Activity (§14), and the owner saw it at consent. A
 *      runner cannot author a layout per answer.
 *   2. The VALUES are the result's, and the result already passed the pinned
 *      `result_schema` at `/complete`. A slot names a declared field; a field
 *      that is absent or unshowable becomes null and its block is dropped.
 *   3. `validateCardSpec` runs in UNTRUSTED mode, so badges — Dina's own
 *      trust chrome — never survive, and unknown blocks are dropped rather
 *      than passed to a renderer that might guess.
 *
 * AND NO OUTBOUND EXIT. §11 is plain that a plugin result gets "no URLs", so
 * `link` and `media` blocks are dropped here whatever the template says. The
 * sanctioned exit is Dina's own first-party Open-link card (§15), which a
 * plugin cannot mint. This is the render's rule rather than the manifest
 * validator's on purpose: untrusted mode is a property of the surface the
 * answer lands on, and keeping it in one place is what stops the two from
 * drifting apart. `map` stays: it carries no URL — the renderer builds the
 * deep link client-side from structured coordinates — and the destination is
 * a maps app, not a page a publisher chose.
 *
 * AND THE FRAME IS DINA'S. Only `blocks` survive. `sourceLabel`,
 * `generatedAt`, `expiresAt` and `ttlSeconds` render as the card's own
 * footer and staleness chrome — "as of 10:42", a source line — which is a
 * claim about provenance and freshness, and §15.6 says system labels are
 * Dina-owned. A plugin that could write "Official GST record" into that slot
 * would be minting trust UI by another name, exactly what dropping badges
 * exists to prevent.
 *
 * A null answer is not a failure — it means "there is no card here", and the
 * caller falls back to the `label: value` floor, which is still the honest
 * rendering of a capability that declares no template.
 */

import { fillCardTemplate, validateCardSpec, type CardBlock, type CardSpec } from '@dina/protocol';

import { parsePluginEnvelope } from '../workflow/plugin_envelope';

/** Block kinds a plugin's answer may never carry: both are outbound exits (§11). */
const FORBIDDEN_BLOCKS: ReadonlySet<CardBlock['kind']> = new Set<CardBlock['kind']>(['link', 'media']);

/** The slice of a workflow task this render reads. */
export interface PluginResultTask {
  status: string;
  payload: string;
  result?: string | null;
}

/**
 * The card for a completed plugin invocation, or null when there is none to
 * show — no template, an unreadable result, or nothing that survived the
 * untrusted pass.
 */
export function buildPluginResultCard(task: PluginResultTask): CardSpec | null {
  if (task.status !== 'completed') return null;
  const envelope = parsePluginEnvelope(task.payload);
  if (envelope === null) return null;
  const template = envelope.card_snapshot;
  if (template === undefined || template === null) return null;

  let result: unknown;
  try {
    result = JSON.parse(task.result ?? 'null');
  } catch {
    return null;
  }
  // A result that is not an object fills no slots. Every block whose value is
  // a slot then drops, and what is left is the template's literal text — a
  // card of labels with no answers, which is worse than the floor.
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;

  const filled = fillCardTemplate(template, result);
  // Untrusted, said out loud rather than left to the default: badges are
  // Dina-owned and do not survive, unknown blocks are dropped, and a card
  // with nothing left comes back null. A default that flipped one day would
  // otherwise hand a plugin trust chrome without a line of code changing.
  const spec = validateCardSpec(filled, { trusted: false });
  if (spec === null) return null;
  const blocks = spec.blocks.filter((block) => !FORBIDDEN_BLOCKS.has(block.kind));
  if (blocks.length === 0) return null;
  // Blocks only. Everything else on a CardSpec is the frame, and the frame is
  // Dina's — see the module note.
  return { version: 1, blocks };
}
