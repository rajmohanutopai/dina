/**
 * Nudge templater — pure display-text builder.
 *
 * `nudge_assembler.ts` (task 5.39) decides WHEN + WHY to nudge. This
 * primitive decides HOW to render the nudge as user-facing text.
 *
 * Input shape mirrors what a guardian-loop outcome carries:
 *
 *   - `priority`  — Silence-First tier; drives the lead token.
 *   - `topic`     — what the nudge is about (plain text or label).
 *   - `subject`   — who the nudge concerns (`self` / contact / generic).
 *   - `action`    — suggested next step (plain imperative).
 *   - `context`   — optional short context phrase.
 *   - `deepLink`  — optional `DeepLinkPayload` attribution.
 *
 * **Pure** — no IO, no template-engine deps. Output is a plain
 * string; callers render into Markdown / plaintext / MarkdownV2 with
 * their own escape layer.
 *
 * **Lead glyph per priority** (single-line headline):
 *
 *   - `fiduciary`  → `🚨`
 *   - `solicited`  → `🔔`
 *   - `engagement` → `·`
 *
 * Glyphs overridable via `glyphOverrides`. Setting to empty string
 * produces text-only output (SMS / voice).
 *
 * **Subject rendering**:
 *
 *   - self       → "you"
 *   - contact    → the contact display name (caller supplies)
 *   - group      → "your family" (override via label)
 *   - unknown    → omitted
 *
 * **Template pattern** (pieces auto-skipped when missing):
 *
 *   "<glyph> <subject>: <topic> — <action> [<context>] [(<attribution>)]"
 *
 * **Length cap** on the final string with ellipsis. Default 280.
 * Callers that need longer truncate externally.
 */

import type { NotifyPriority } from './priority';
import type { DeepLinkPayload } from './deep_link_builder';

export type NudgeSubject =
  | { kind: 'self' }
  | { kind: 'contact'; name: string }
  | { kind: 'group'; label?: string }
  | { kind: 'unknown' };

export interface NudgeInput {
  priority: NotifyPriority;
  topic: string;
  action: string;
  subject?: NudgeSubject;
  context?: string;
  deepLink?: DeepLinkPayload;
}

export interface NudgeTemplateOptions {
  /** Max output length. Default 280. */
  maxChars?: number;
  /** Glyph override per priority. */
  glyphOverrides?: Partial<Record<NotifyPriority, string>>;
  /** Group subject fallback. Default "your family". */
  groupLabel?: string;
  /** When true, include the deepLink's URL inline. Default false (attribution only). */
  includeLinkUrl?: boolean;
}

export const DEFAULT_MAX_CHARS = 280;

const DEFAULT_GLYPHS: Record<NotifyPriority, string> = {
  fiduciary: '🚨',
  solicited: '🔔',
  engagement: '·',
};

const DEFAULT_GROUP_LABEL = 'your family';

export class NudgeTemplateError extends Error {
  constructor(
    public readonly code: 'invalid_priority' | 'empty_topic' | 'empty_action',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'NudgeTemplateError';
  }
}

/**
 * Produce a display-ready single-line nudge. Pure.
 */
export function renderNudge(
  input: NudgeInput,
  opts: NudgeTemplateOptions = {},
): string {
  validate(input);
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const glyph =
    opts.glyphOverrides?.[input.priority] ?? DEFAULT_GLYPHS[input.priority];
  const groupLabel = opts.groupLabel ?? DEFAULT_GROUP_LABEL;

  const subjectText = renderSubject(input.subject, groupLabel);
  const topic = input.topic.trim();
  const action = input.action.trim();
  const context = input.context?.trim() ?? '';
  const attribution = input.deepLink ? renderAttribution(input.deepLink, opts.includeLinkUrl === true) : '';

  const headline = subjectText ? `${subjectText}: ${topic}` : topic;
  let core = `${headline} — ${action}`;
  if (context !== '') core += ` ${context}`;
  if (attribution !== '') core += ` ${attribution}`;
  const leading = glyph ? `${glyph} ` : '';
  const full = `${leading}${core}`.trim();
  return truncate(full, maxChars);
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(input: NudgeInput): void {
  if (!input || typeof input !== 'object') {
    throw new NudgeTemplateError('empty_topic', 'input required');
  }
  if (
    input.priority !== 'fiduciary' &&
    input.priority !== 'solicited' &&
    input.priority !== 'engagement'
  ) {
    throw new NudgeTemplateError('invalid_priority', `unknown priority "${String(input.priority)}"`);
  }
  if (typeof input.topic !== 'string' || input.topic.trim() === '') {
    throw new NudgeTemplateError('empty_topic', 'topic required');
  }
  if (typeof input.action !== 'string' || input.action.trim() === '') {
    throw new NudgeTemplateError('empty_action', 'action required');
  }
}

function renderSubject(
  subject: NudgeSubject | undefined,
  groupLabel: string,
): string {
  if (!subject) return '';
  switch (subject.kind) {
    case 'self':    return 'you';
    case 'contact': return subject.name.trim() || '';
    case 'group':   return subject.label?.trim() || groupLabel;
    case 'unknown': return '';
  }
}

function renderAttribution(link: DeepLinkPayload, includeUrl: boolean): string {
  const bits: string[] = [];
  if (link.author) bits.push(link.author);
  bits.push(link.publisher);
  if (link.publishedAtIso) bits.push(link.publishedAtIso.slice(0, 10));
  const label = bits.join(', ');
  return includeUrl ? `(${label} — ${link.url})` : `(${label})`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
