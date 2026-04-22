/**
 * Markdown escaper — reserved-char escaping for the three markdown
 * dialects Brain speaks to.
 *
 *   - `commonmark`       — canonical markdown; most web renderers.
 *   - `markdownV2`       — Telegram's v2 flavour (18 reserved chars).
 *   - `githubFlavored`   — CommonMark + @ mentions + tables; escapes
 *                          `@` and `|` additionally.
 *
 * Output primitives already exist for rendering; callers only pass
 * text they want rendered AS LITERAL (not parsed). Every escape in
 * here is a backslash-prefix (`\X`).
 *
 * **Utilities**:
 *
 *   - `escapeCommonMark(text)`
 *   - `escapeMarkdownV2(text)` — matches telegram_adapter's local
 *     helper, re-exported here for non-Telegram callers.
 *   - `escapeGithubFlavored(text)`
 *   - `escapeForDialect(text, dialect)` — switch-driven.
 *   - `stripMarkdown(text)` — best-effort remove-formatting for
 *     plain-text fallback channels (SMS, voice).
 *
 * **Pure** — zero deps, no state.
 */

export type MarkdownDialect = 'commonmark' | 'markdownV2' | 'githubFlavored';

const COMMONMARK_RE = /([\\`*_{}\[\]()#+\-.!>|])/g;
const MARKDOWN_V2_RE = /([_*\[\]()~`>#+\-=|{}.!])/g;
const GFM_EXTRA_RE = /([\\`*_{}\[\]()#+\-.!>|@])/g;

/**
 * Escape markdown reserved chars per the specified dialect.
 */
export function escapeForDialect(text: string, dialect: MarkdownDialect): string {
  if (typeof text !== 'string') {
    throw new TypeError('escapeForDialect: text must be a string');
  }
  switch (dialect) {
    case 'commonmark':     return text.replace(COMMONMARK_RE, '\\$1');
    case 'markdownV2':     return text.replace(MARKDOWN_V2_RE, '\\$1');
    case 'githubFlavored': return text.replace(GFM_EXTRA_RE, '\\$1');
    default:
      // Exhaustive switch on the union; this path is unreachable with
      // a well-typed caller but guards against runtime injection.
      throw new TypeError(`escapeForDialect: unknown dialect "${String(dialect)}"`);
  }
}

export function escapeCommonMark(text: string): string {
  return escapeForDialect(text, 'commonmark');
}

export function escapeMarkdownV2(text: string): string {
  return escapeForDialect(text, 'markdownV2');
}

export function escapeGithubFlavored(text: string): string {
  return escapeForDialect(text, 'githubFlavored');
}

/**
 * Strip common markdown formatting so the result reads cleanly in
 * plaintext channels. Best-effort: removes `**bold**`, `_italic_`,
 * `` `code` ``, `[link](url)`, heading markers, list markers, and
 * quote markers. Preserves the actual text content.
 */
export function stripMarkdown(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('stripMarkdown: text must be a string');
  }
  let out = text;
  // Images BEFORE links — the leading `!` would otherwise survive the
  // link-rewrite. Image syntax `![alt](url)` → `alt`.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  // Links: [label](url) → label.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Code spans.
  out = out.replace(/`([^`]+)`/g, '$1');
  // Bold + italic wrappers. Handle the multi-char forms first.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/_([^_]+)_/g, '$1');
  // Strikethrough.
  out = out.replace(/~~([^~]+)~~/g, '$1');
  // Leading heading markers (`# `, `## `, …).
  out = out.replace(/^#+\s+/gm, '');
  // Leading blockquote markers.
  out = out.replace(/^>\s?/gm, '');
  // Leading list markers (`- `, `* `, `+ `, numbered `1. `).
  out = out.replace(/^[ \t]*[-*+]\s+/gm, '');
  out = out.replace(/^[ \t]*\d+\.\s+/gm, '');
  return out;
}

/**
 * Escape AND strip — convenience for "I want plaintext but if anything
 * looks markdown-ish, keep it literal". Calls strip first, then
 * escapes the survivors.
 */
export function sanitizeForDialect(
  text: string,
  dialect: MarkdownDialect,
): string {
  return escapeForDialect(stripMarkdown(text), dialect);
}
