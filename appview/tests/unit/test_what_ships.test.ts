/**
 * Test what ships: AppView runs the compiled builds of @dina/a2a,
 * @dina/commerce-protocol and @dina/ucp (`node --conditions=compiled`), so its tests must
 * load those builds too, never the TypeScript source Vite would transform.
 * A tsc-compiled module marks itself `__esModule`, and its imports read
 * `(0, x_1.f)`; Vite's transform of the source does neither.
 */

import * as a2a from '@dina/a2a'
import * as commerce from '@dina/commerce-protocol'
import * as ucp from '@dina/ucp'
import { describe, expect, it } from 'vitest'

describe('the workspace packages AppView tests are the builds AppView runs', () => {
  it.each([
    ['@dina/a2a', a2a as Record<string, unknown>, 'verifyDirectoryEnvelope'],
    ['@dina/commerce-protocol', commerce as Record<string, unknown>, 'validateCanonicalInteger'],
    ['@dina/ucp', ucp as Record<string, unknown>, 'createUcpHost'],
  ])('%s loads from its compiled build', (_name, mod, fn) => {
    expect(Object.getOwnPropertyDescriptor(mod, '__esModule')).toBeDefined()
    const source = String(mod[fn])
    expect(source).not.toContain('__vite_ssr_import')
  })

  it('a function that calls an import reads as the compiled build writes it', () => {
    expect(String(a2a.verifyDirectoryEnvelope)).toMatch(/\(0, [a-z0-9_]+_1\.[A-Za-z0-9_]+\)/)
  })
})
