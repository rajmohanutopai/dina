/**
 * Shareable Dina contact card.
 *
 * A plain-text blob the user can send over WhatsApp / SMS / email, and that
 * the recipient can paste straight into "Add contact". It is human-readable
 * AND machine-parseable, and the two halves round-trip:
 *
 *   parseContactCard(buildContactCard(x)).identifier === x.did
 *
 * Format (kept deliberately simple so it survives messenger reformatting):
 *
 *   Aalber
 *   Handle: aalber.test-pds.dinakernel.com
 *   Dina ID: did:plc:s6mbp7pokaqsh5nko26wie5u
 *   Add me on Dina.
 *
 * The name is the first line; the rest are labelled. The parser is lenient —
 * it also accepts a bare DID, a bare handle, or a "Name\ndid:…" two-liner,
 * because people paste messy fragments.
 */

export interface ParsedContactCard {
  /** What "Add contact" should resolve: a DID if present, else a handle. */
  identifier: string;
  /** Friendly name, if the card carried one. */
  name?: string;
  /** Handle, if present. */
  handle?: string;
  /** DID, if present. */
  did?: string;
}

// did:plc is EXACTLY 24 base32 (lowercase a-z, 2-7) chars. Pinning the
// length — and NOT using /i — stops the match from greedily swallowing
// trailing text that follows the DID with no separator (e.g.
// "…rigxwAdd me on Dina." would otherwise eat "Add").
const DID_RE = /did:plc:[a-z2-7]{24}/;
// A hostname-like handle: at least two dot-separated labels.
const HANDLE_RE = /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+){1,}/i;
const LABEL_RE = /^(handle|dina id|id|did|add me|name)\b/i;

export function buildContactCard(opts: {
  name?: string | null;
  handle?: string | null;
  did: string;
}): string {
  const lines: string[] = [];
  if (opts.name != null && opts.name.trim() !== '') lines.push(opts.name.trim());
  if (opts.handle != null && opts.handle.trim() !== '') {
    lines.push(`Handle: ${opts.handle.trim()}`);
  }
  lines.push(`Dina ID: ${opts.did}`);
  lines.push('Add me on Dina.');
  return lines.join('\n');
}

export function parseContactCard(text: string): ParsedContactCard {
  const did = text.match(DID_RE)?.[0];

  // Handle: prefer an explicit "Handle:" label; else the first hostname-like
  // token (the DID has no dots, so it never matches HANDLE_RE).
  let handle: string | undefined;
  const labelled = text.match(/handle:\s*(\S+)/i)?.[1];
  if (labelled != null && !DID_RE.test(labelled) && HANDLE_RE.test(labelled)) {
    handle = labelled;
  } else {
    handle = text.match(HANDLE_RE)?.[0];
  }

  // Name: the first non-empty line that isn't a label line, the DID, or the
  // handle. An explicit "Name: X" wins.
  let name: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const nameLabel = line.match(/^name:\s*(.+)/i)?.[1];
    if (nameLabel != null) {
      name = nameLabel.trim();
      break;
    }
    if (LABEL_RE.test(line)) continue;
    if (did != null && line.includes(did)) continue;
    if (handle != null && line.includes(handle)) continue;
    if (DID_RE.test(line) || HANDLE_RE.test(line)) continue;
    name = line;
    break;
  }

  const identifier = did ?? handle ?? text.trim();
  return { identifier, name, handle, did };
}
