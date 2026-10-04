/**
 * The text rules for an approval card mirrored to the owner's phone
 * (`/v1/agent/approval-sync/v1/proposals`): bounded, single-line titles and
 * multiline details with no control, bidi or zero-width characters (tab and
 * line feed allowed in a detail). One module, so the route that accepts a
 * mirror and the sources that build one cannot disagree.
 */

export const MIRROR_MAX_LABEL = 160;
export const MIRROR_MAX_DETAIL = 4_000;

/**
 * Whether a mirrored card's title and detail pass the mirror route's checks. A
 * source that builds a facade-style proposal asks first, so a card that can
 * never be mirrored is kept off the phone instead of being refused on every
 * sync tick.
 */
export function isMirrorableTitle(value: string): boolean {
  return bounded(value, MIRROR_MAX_LABEL) !== '' && !hasUnsafeText(value);
}

export function isMirrorableDetail(value: string): boolean {
  return boundedMultiline(value, MIRROR_MAX_DETAIL) !== '' && !hasUnsafeMultilineText(value);
}

export function bounded(value: unknown, max: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : '';
}

export function boundedMultiline(value: unknown, max: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : '';
}

export function hasUnsafeText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

export function hasUnsafeMultilineText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

