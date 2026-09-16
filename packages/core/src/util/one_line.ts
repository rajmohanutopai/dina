/**
 * One bounded line of text — the sanitiser every owner-facing or wire-bound
 * string field in Core runs through before it is stored, rendered or sent.
 *
 * Strips C0/C1 control characters and the Unicode line separators (a log
 * line and a card both render them), strips the bidi overrides and zero-width
 * joiners (a reversed legal name misreads on a card as much as in a log),
 * collapses whitespace, trims, and bounds the length. One definition, so the
 * context projector, the group plan and whatever comes next cannot disagree
 * about what "one clean line" means.
 */
export function oneLine(value: string, max: number): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}
