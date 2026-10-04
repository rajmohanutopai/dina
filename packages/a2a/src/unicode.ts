/**
 * Code points that render as nothing, or reorder what is around them, and so
 * let text say one thing to a model and another to the person reading it.
 * Sanitation removes them from every remote string, and from every outgoing
 * string the owner approves, so what is shown is what is sent or kept.
 *
 * The set, by code point (not UTF-16 unit, so astral characters are judged
 * too):
 *  - C0 and C1 controls and DEL, except tab, line feed and carriage return;
 *  - every format character (General Category Cf), which includes the bidi
 *    embeddings, overrides and isolates, the zero-width characters, the soft
 *    hyphen, the invisible operators, and the tag block (U+E0001,
 *    U+E0020–E007F) that can spell hidden ASCII;
 *  - the line and paragraph separators (Zl, Zp);
 *  - variation selectors (U+FE00–FE0F, U+E0100–E01EF) and the Mongolian free
 *    variation selectors, which can carry hidden bytes after any character;
 *  - the combining grapheme joiner and the Hangul fillers, which render
 *    blank;
 *  - every other code point Unicode marks Default_Ignorable_Code_Point,
 *    which a renderer must draw as nothing: the Khmer inherent vowels, the
 *    unassigned U+FFF0–FFF8 and the whole of U+E0000–E0FFF.
 *
 * The ranges are written out rather than matched with `\p{Cf}` or
 * `\p{Default_Ignorable_Code_Point}`, so the result cannot depend on the
 * JavaScript engine's Unicode tables (Hermes, V8, JSC differ by version).
 * Tests check the list covers every Cf and every default-ignorable code
 * point the test runtime knows.
 */

/** [first, last] inclusive, ascending, non-overlapping. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  // Khmer inherent vowels: assigned, but drawn as nothing (Default_Ignorable_Code_Point).
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  // U+2065 is unassigned: held with its neighbours, so an assignment there is covered at once.
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  // U+FFF0-FFF8 are unassigned and default-ignorable; held with the interlinear annotations.
  [0xfff0, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  // The whole tags and variation-selectors block: every code point in it is default-ignorable,
  // assigned or not, so an assignment there is covered at once.
  [0xe0000, 0xe0fff],
];

export function isInvisibleCodePoint(cp: number): boolean {
  let lo = 0;
  let hi = INVISIBLE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = INVISIBLE_RANGES[mid];
    if (range === undefined) return false;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export interface StripReport {
  /** True once any code point or lone surrogate has been removed. */
  stripped: boolean;
}

/**
 * `s` without invisible code points and without lone surrogates; surrogate
 * pairs are judged as the one code point they encode.
 */
export function stripInvisible(s: string, report?: StripReport): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    const loneSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    if (!loneSurrogate && !isInvisibleCodePoint(cp)) out += s.slice(i, i + width);
    i += width;
  }
  if (report !== undefined && out !== s) report.stripped = true;
  return out;
}

/** The default bound for a remote's prose, in code points. */
export const MAX_TEXT_CODE_POINTS = 1000;
/** The bound for a remote agent's name, in code points. */
export const A2A_NAME_MAX_CODE_POINTS = 120;

/**
 * Owner-safe text from a remote's words (a card's name, a skill, a scheme):
 * invisible characters removed, whitespace collapsed, bounded by code point.
 * The one rule wherever an outside agent's words are shown or handed to a
 * model: Core's registration and lists, Brain's directory search.
 */
export function a2aDisplayText(value: unknown, maxCodePoints = MAX_TEXT_CODE_POINTS): string {
  if (typeof value !== 'string') return '';
  const clean = stripInvisible(value).replace(/\s+/g, ' ').trim();
  const points = [...clean];
  return points.length > maxCodePoints ? `${points.slice(0, maxCodePoints - 1).join('')}…` : clean;
}
