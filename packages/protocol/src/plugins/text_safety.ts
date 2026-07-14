/**
 * Consent-facing spoofing-char detection (§14).
 *
 * Any string rendered to the owner on the consent / Activity surfaces —
 * a manifest display_name, a capability description, a trust-anchor
 * `orgDid`/`keyId` — must be free of characters that render DECEPTIVELY:
 * a bidi override can visually reverse a scope description; a zero-width
 * char can hide text; C0/C1 controls corrupt the render. This is the
 * single source of truth for that check, shared by the manifest
 * validator and the trust-anchor verifier so both agree byte-for-byte.
 *
 * Pure function. Zero runtime deps.
 */

/**
 * True when `str` contains any control / bidi-override / zero-width /
 * BOM code point. Beyond ASCII C0/DEL, rejects C1 controls (0x80–0x9F),
 * Unicode bidi overrides/isolates (U+202A–202E, U+2066–2069), and
 * zero-width / BOM formatting (U+200B–200D, U+FEFF). Iterates code
 * points (astral-safe).
 */
export function hasUnsafeText(str: string): boolean {
  for (const ch of str) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || c === 0x7f) return true; // C0 + DEL
    if (c >= 0x80 && c <= 0x9f) return true; // C1 controls
    if (c >= 0x202a && c <= 0x202e) return true; // bidi embeddings / overrides
    if (c >= 0x2066 && c <= 0x2069) return true; // bidi isolates
    if (c >= 0x200b && c <= 0x200d) return true; // zero-width space / joiners
    if (c === 0xfeff) return true; // BOM / zero-width no-break space
  }
  return false;
}
