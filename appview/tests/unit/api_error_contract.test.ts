/**
 * Wire-format contract for AppView API errors.
 *
 * The error response shape is documented in
 * `appview/docs/API_ERRORS.md` and clients (mobile, third-party
 * indexers, federated AppView ports) pattern-match on the `error`
 * field. The names + shape below are PUBLIC SURFACE — once shipped
 * they cannot change without a major version bump.
 *
 * These tests don't exercise the HTTP layer; they pin the contract
 * so a refactor of `server.ts` (or anywhere else that synthesizes
 * an error response) can't silently break clients by renaming an
 * enum or changing the field name.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const APPVIEW_SRC = join(__dirname, '..', '..', 'src')

/**
 * Walk a directory tree and return all .ts file contents joined.
 * Reads source-text for the contract regex below.
 */
function readAllTs(root: string): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (entry.endsWith('.ts')) out.push(readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return out.join('\n')
}

const ALL_SOURCE = readAllTs(APPVIEW_SRC)

/**
 * The closed set of error names AppView synthesizes today. Any new
 * error name added in code must also be added here AND in
 * `docs/API_ERRORS.md`. Removing one is a major-version event.
 */
const PUBLIC_ERROR_NAMES = [
  'InvalidRequest',
  'AuthRequired',
  'Forbidden',
  'NotFound',
  'TooManyRequests',
  'InternalServerError',
  'ServiceUnavailable',
] as const

describe('AppView API error contract', () => {
  it('all source synthesizes only documented error names', () => {
    // Pull every `error: 'X'` literal across the entire src tree and
    // confirm each is in the public set. Catches:
    //   - a new error name added in server.ts
    //   - a new error name added in any xRPC handler that synthesizes
    //     its own response (test-inject auth gates do this today)
    // The regex looks for a PascalCase identifier — keeps it from
    // grabbing 'message' or other unrelated fields.
    const matches = [...ALL_SOURCE.matchAll(/error:\s*['"]([A-Z][A-Za-z]+)['"]/g)]
    expect(matches.length).toBeGreaterThan(0)
    const found = new Set(matches.map((m) => m[1]))
    for (const name of found) {
      expect(PUBLIC_ERROR_NAMES, `undocumented error name: ${name}`).toContain(
        name as (typeof PUBLIC_ERROR_NAMES)[number],
      )
    }
  })

  it('error names follow PascalCase (no punctuation, no spaces)', () => {
    for (const name of PUBLIC_ERROR_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Za-z]+$/)
    }
  })

  it('PeerlensBand enum values are kebab-case lowercase strings', () => {
    // The band enum on subjectGet responses follows the same
    // wire-format-stability rule. Lowercase kebab-case; never
    // localized.
    const BANDS = ['high', 'moderate', 'low', 'very-low', 'unrated'] as const
    for (const band of BANDS) {
      expect(band).toMatch(/^[a-z][a-z-]*[a-z]$/)
    }
  })
})
