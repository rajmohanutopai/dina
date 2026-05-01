/**
 * Shared JSON-LD block extraction (TN-V2-META-009 + META-010).
 *
 * Both META-009 (price extractor) and META-010 (schedule extractor)
 * need the same primitive: pull every
 * `<script type="application/ld+json">…</script>` block out of an
 * HTML string. This module is the single source of truth so adding
 * a third extractor (e.g. a future product-attribute scraper)
 * doesn't fork the regex three ways.
 *
 * Robust against:
 *   - Mixed-case `application/LD+JSON` script type
 *   - Attribute order (`type` before/after other attrs)
 *   - Whitespace inside the tag
 *   - Multiple blocks on the same page
 * Brittle against:
 *   - HTML inside the `<script>` body — JSON-LD by spec contains
 *     only JSON, never raw HTML, so we don't need a full HTML parser.
 *
 * Returns the trimmed JSON payload of each block (caller decodes
 * with `JSON.parse` inside a try/catch — one bad block must not
 * poison sibling blocks).
 */

export function extractJsonLdBlocks(html: string | null | undefined): string[] {
  if (typeof html !== 'string' || html.length === 0) return []
  const blocks: string[] = []
  // [\s\S]*? required because the dot doesn't match newlines without
  // the /s flag (older bundlers may strip it). The character class
  // is the portable form.
  const pattern = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const body = match[1].trim()
    if (body.length > 0) blocks.push(body)
  }
  return blocks
}
