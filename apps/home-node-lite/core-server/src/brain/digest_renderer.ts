/**
 * Digest renderer — turns a `Digest` from `digest_assembler.ts` into
 * human-readable output.
 *
 * The assembler produces structure; this renderer produces text. Two
 * output modes:
 *
 *   - `markdown` — CommonMark with `##` section headings + bulleted
 *     items. Suitable for CLI + Telegram (MarkdownV2-safe caller escape
 *     still required).
 *   - `plaintext` — no formatting markers; pure text for SMS / minimal
 *     UIs.
 *
 * **Rendering order** (matches Silence-First priority):
 *
 *   1. Headline (when present).
 *   2. Fiduciary bucket (🚨 / FIDUCIARY header).
 *   3. Solicited bucket.
 *   4. Engagement bucket.
 *   5. Topics (one line, comma-separated).
 *   6. Contacts (one line, comma-separated).
 *
 * Each item renders as `- <title>` (+ optional `(<date>)` when `at` is
 * present and `showDates: true`). Body line follows as a separate
 * bullet when non-empty + `showBodies: true`.
 *
 * **Empty buckets** are omitted entirely — the renderer never emits
 * "Fiduciary: (no items)". The Silence-First principle: say less.
 *
 * **Overflow hint** shown when `bucket.overflow > 0`: e.g. "… and 3
 * more engagement items".
 *
 * **Pure** — no IO, deterministic.
 */

import type { Digest, DigestBucket, DigestItem } from './digest_assembler';

export type DigestRenderMode = 'markdown' | 'plaintext';

export interface DigestRenderOptions {
  mode?: DigestRenderMode;
  /** Include ISO date after title when `item.at` > 0. Default true. */
  showDates?: boolean;
  /** Include item.body on its own line when non-empty. Default true. */
  showBodies?: boolean;
  /** Max chars per body line before ellipsis. Default 200. */
  maxBodyChars?: number;
  /** Override bucket header labels. */
  labels?: Partial<Record<'fiduciary' | 'solicited' | 'engagement' | 'topics' | 'contacts', string>>;
}

export const DEFAULT_MAX_BODY_CHARS = 200;

const DEFAULT_LABELS = {
  fiduciary: '🚨 Fiduciary',
  solicited: 'Solicited',
  engagement: 'Engagement',
  topics: 'Topics',
  contacts: 'Contacts',
};

/**
 * Render a digest into a single string. Pure.
 */
export function renderDigest(
  digest: Digest,
  opts: DigestRenderOptions = {},
): string {
  if (!digest || typeof digest !== 'object') {
    throw new TypeError('renderDigest: digest required');
  }
  const mode: DigestRenderMode = opts.mode ?? 'markdown';
  const showDates = opts.showDates ?? true;
  const showBodies = opts.showBodies ?? true;
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const labels = { ...DEFAULT_LABELS, ...(opts.labels ?? {}) };

  const parts: string[] = [];

  if (digest.headline) {
    parts.push(
      mode === 'markdown' ? `# ${digest.headline}` : digest.headline,
    );
  }

  for (const key of ['fiduciary', 'solicited', 'engagement'] as const) {
    const bucket = digest.buckets[key];
    const rendered = renderBucket(bucket, {
      heading: labels[key],
      mode,
      showDates,
      showBodies,
      maxBody,
    });
    if (rendered !== '') parts.push(rendered);
  }

  if (digest.topics.length > 0) {
    const topicsText = digest.topics.map((t) => t.label).join(', ');
    parts.push(
      mode === 'markdown'
        ? `## ${labels.topics}\n${topicsText}`
        : `${labels.topics}: ${topicsText}`,
    );
  }

  if (digest.contacts.length > 0) {
    const contactsText = digest.contacts
      .map((c) => (c.note ? `${c.name} (${c.note})` : c.name))
      .join(', ');
    parts.push(
      mode === 'markdown'
        ? `## ${labels.contacts}\n${contactsText}`
        : `${labels.contacts}: ${contactsText}`,
    );
  }

  return parts.join('\n\n');
}

// ── Internals ──────────────────────────────────────────────────────────

interface BucketRenderOptions {
  heading: string;
  mode: DigestRenderMode;
  showDates: boolean;
  showBodies: boolean;
  maxBody: number;
}

function renderBucket(
  bucket: DigestBucket,
  opts: BucketRenderOptions,
): string {
  if (bucket.items.length === 0 && bucket.overflow === 0) return '';
  const lines: string[] = [];
  lines.push(opts.mode === 'markdown' ? `## ${opts.heading}` : `${opts.heading}:`);
  for (const item of bucket.items) {
    lines.push(renderItem(item, opts));
  }
  if (bucket.overflow > 0) {
    lines.push(
      opts.mode === 'markdown'
        ? `- … and ${bucket.overflow} more`
        : `… and ${bucket.overflow} more`,
    );
  }
  return lines.join('\n');
}

function renderItem(item: DigestItem, opts: BucketRenderOptions): string {
  const date = opts.showDates && Number.isFinite(item.at) && item.at > 0
    ? ` (${new Date(item.at * 1000).toISOString().slice(0, 10)})`
    : '';
  const title = `- ${item.title}${date}`;
  if (!opts.showBodies || !item.body) return title;
  const body = truncate(item.body.trim(), opts.maxBody);
  if (body === '') return title;
  return `${title}\n  ${body}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
