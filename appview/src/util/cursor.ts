import { z } from 'zod'

/**
 * Opaque pagination cursor — shared helper.
 *
 * Wire format is a base64url-wrapped JSON envelope `{v, ...payload}`.
 * base64url avoids URL-percent-encoding when the cursor flows through
 * query strings (no need for callers to encodeURIComponent it again).
 *
 * Each endpoint defines its own payload shape via a Zod schema (e.g.
 * `{bucket, uri}` for service-search's bucket-binned composite score;
 * `{ts, uri}` for peerlens endpoints sorted on recordCreatedAt).
 *
 * Why opaque (not `${ts}::${uri}` plaintext): a future pagination
 * strategy change — say, swapping bucket-binned ordering for true
 * keyset on score+uri, or adding a tiebreaker column — can rev
 * `CURSOR_VERSION` and reject mid-pagination cursors loudly instead
 * of silently mis-paginating. Clients see a 400, restart from page 1.
 *
 * Versioning stance: if an endpoint's RANKING_VERSION bumps, the
 * cursor `v` should bump too. Cursors encode a pagination state
 * implicitly tied to the row ordering — if the ordering changes,
 * an in-flight cursor's "next page" claim is wrong. Coupling them
 * keeps the contract honest.
 */

/**
 * Bump when the envelope shape changes (not when a single endpoint's
 * payload shape changes — those can swap Zod schemas without a
 * version bump as long as the new schema rejects old payloads).
 */
const CURSOR_VERSION = 1

/**
 * Error subclass that names itself `ZodError` so `web/server.ts`'s
 * 400-mapping path picks it up. Mirrors the existing
 * `Object.assign(new Error(...), { name: 'ZodError' })` pattern
 * used throughout `api/xrpc/*`; centralising it here keeps each
 * call site terse.
 */
export class InvalidCursorError extends Error {
  override name = 'ZodError'
  constructor(message = 'Invalid cursor format') {
    super(message)
  }
}

/**
 * Encode a payload as an opaque base64url-wrapped JSON envelope.
 * The envelope shape is `{v: CURSOR_VERSION, ...payload}` — the
 * version is stamped here so callers only think about their own
 * payload shape.
 */
export function encodeCursor<T extends object>(payload: T): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, ...payload }),
    'utf8',
  ).toString('base64url')
}

/**
 * Decode + validate an opaque cursor. Throws `InvalidCursorError`
 * (→ 400 `InvalidRequest`) when:
 *   - the input isn't valid base64url JSON
 *   - the envelope `v` doesn't match `CURSOR_VERSION`
 *   - the payload fails the caller-supplied Zod schema
 *
 * The schema validates the *payload only* — `v` is checked by this
 * helper and stripped before the schema runs, so callers describe
 * `{bucket, uri}` or `{ts, uri}` without re-declaring `v`.
 */
export function decodeCursor<T extends object>(
  raw: string,
  schema: z.ZodType<T>,
): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError()
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== CURSOR_VERSION
  ) {
    throw new InvalidCursorError()
  }
  const { v: _v, ...rest } = parsed as { v: number } & Record<string, unknown>
  const result = schema.safeParse(rest)
  if (!result.success) {
    throw new InvalidCursorError()
  }
  return result.data
}
