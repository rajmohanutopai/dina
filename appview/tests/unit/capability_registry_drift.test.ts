/**
 * Drift gate: the canonical capability registry is the SHARED source of
 * truth, duplicated across workspaces because appview is standalone and
 * Core's ingress resolver must run synchronously + locally (it cannot
 * await an AppView fetch). The two physical copies MUST be byte-identical.
 *
 * Spec: docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 1 — "registry is a
 * shared code module … a check-in test asserts the AppView copy and the
 * @dina/* copy are byte-identical."
 *
 * If this fails: you edited one copy and not the other. Sync them.
 *   appview/src/shared/capability-registry.ts            (source of truth)
 *   packages/protocol/src/services/capability-registry.ts (verbatim copy)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url)) // appview/tests/unit
const appviewCopy = path.resolve(here, '../../src/shared/capability-registry.ts')
const protocolCopy = path.resolve(
  here,
  '../../../packages/protocol/src/services/capability-registry.ts',
)

describe('capability-registry — cross-workspace drift gate', () => {
  it('appview copy and @dina/protocol copy are byte-identical', () => {
    const a = readFileSync(appviewCopy)
    const b = readFileSync(protocolCopy)
    // Compare bytes, not decoded strings, so even an encoding/BOM/newline
    // difference is caught.
    expect(a.equals(b)).toBe(true)
  })
})
