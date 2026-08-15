/**
 * THE INTEGRATION SUITE MUST BE RUN BY SOMETHING.
 *
 * `appview` is a root npm workspace, so the monorepo's `npm test` sweep
 * (`npm test --workspaces --if-present`) reaches it. Its integration suite
 * talks to a real Postgres and fails loudly without one, so `appview`'s own
 * `test` script points at the UNIT suite only — otherwise every developer and
 * every other workflow would need a database to get a green monorepo run.
 *
 * That narrowing is safe ONLY while a pipeline still runs the integration
 * tests against a real database. An infrastructure-gated suite that no
 * pipeline runs is a suite that does not exist: it stays green by never
 * executing, which is the failure this file exists to prevent.
 *
 * So this test asserts BOTH halves of that bargain at once — the narrowing
 * and the job that pays for it. Delete the job, drop the Postgres service, or
 * stop triggering on `appview/**` and this goes red.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APPVIEW_ROOT = path.resolve(HERE, '../..')
const REPO_ROOT = path.resolve(APPVIEW_ROOT, '..')

const pkg = JSON.parse(
  readFileSync(path.join(APPVIEW_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> }

const workflow = readFileSync(
  path.join(REPO_ROOT, '.github/workflows/appview-test.yml'),
  'utf8',
)

describe('appview CI contract', () => {
  it('exposes the three suites separately', () => {
    expect(pkg.scripts['test:unit']).toContain('tests/unit/')
    expect(pkg.scripts['test:integration']).toContain('tests/integration/')
    // `test:all` keeps a way to run everything locally against a live DB.
    expect(pkg.scripts['test:all']).toBeTruthy()
  })

  it('keeps the workspace-sweep `test` script free of the integration suite', () => {
    // The monorepo sweep must stay runnable with no database. `test` may
    // delegate (`npm run test:unit`) or inline the unit path, but it must not
    // reach `tests/integration/` or the whole-suite runner.
    const test = pkg.scripts.test
    expect(test).toBeTruthy()
    expect(test).not.toContain('tests/integration/')
    expect(test).not.toContain('test:all')
    expect(test === 'npm run test:unit' || test.includes('tests/unit/')).toBe(true)
  })

  it('has a workflow that runs the integration suite against a real Postgres', () => {
    expect(workflow).toContain('npm run test:integration --workspace @dina/appview')
    // A service container, not a mock and not a skipped step.
    expect(workflow).toMatch(/services:\s*\n\s*postgres:/)
    expect(workflow).toContain('image: postgres:17')
    // Migrations must run first, or the suite meets an empty database.
    expect(workflow).toContain('npm run migrate --workspace @dina/appview')
    // DATABASE_URL must point at the service container.
    expect(workflow).toMatch(/DATABASE_URL:\s*postgres(ql)?:\/\/\S+/)
  })

  it('triggers that workflow on appview changes', () => {
    // Two `paths:` blocks (push + pull_request); both must list appview.
    const appviewPaths = workflow.match(/^\s+- "appview\/\*\*"$/gm) ?? []
    expect(appviewPaths.length).toBeGreaterThanOrEqual(2)
  })

  it('typechecks under the root `npm run typecheck` sweep', () => {
    // Root typecheck is `npm run typecheck --workspaces --if-present`, so a
    // workspace with no `typecheck` script is silently skipped — appview was,
    // for as long as it had none.
    expect(pkg.scripts.typecheck).toContain('tsc')
    expect(pkg.scripts.typecheck).toContain('--noEmit')
  })
})
