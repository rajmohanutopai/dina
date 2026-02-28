#!/usr/bin/env npx tsx
/**
 * AppView test status reporting: per-section pass/skip/fail breakdown.
 *
 * Runs unit and integration test suites for the AppView trust service
 * and reports per-section status. AppView is a standalone TypeScript service
 * with its own PostgreSQL database, independent of Core (Go) and Brain (Python).
 *
 * Tests use Vitest. Integration tests require PostgreSQL (via Docker Compose
 * or testcontainers). Unit tests run without any external dependencies.
 *
 * Docker behavior:
 *   When integration tests are included, the runner auto-detects whether
 *   PostgreSQL is reachable. If not, it automatically starts it via Docker
 *   Compose (postgres + migrate services), runs migrations, and tears down
 *   on exit. Use --no-docker to skip this and fail fast instead.
 *
 * Usage:
 *   npx tsx test_appview.ts                        # All tests — auto-starts Docker if needed
 *   npx tsx test_appview.ts --suite unit            # Unit tests only (no Docker needed)
 *   npx tsx test_appview.ts --suite integration     # Integration tests (auto-starts Docker)
 *   npx tsx test_appview.ts --restart               # Force rebuild Docker containers
 *   npx tsx test_appview.ts --no-docker             # Skip Docker auto-start (fail if no Postgres)
 *   npx tsx test_appview.ts --json                  # Machine-readable JSON output
 *   npx tsx test_appview.ts -v                      # Verbose — show individual tests
 *   npx tsx test_appview.ts --no-color              # Disable ANSI colors
 */

import { execSync, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const APPVIEW_ROOT = resolve(fileURLToPath(import.meta.url), '..')
const COMPOSE_FILE = join(APPVIEW_ROOT, 'docker-compose.yml')

// ---------------------------------------------------------------------------
// Cleanup registry (handles SIGINT/SIGTERM gracefully)
// ---------------------------------------------------------------------------

const cleanupFns: Array<() => void> = []

function runCleanup(): void {
  const fns = cleanupFns.splice(0)
  for (const fn of fns.reverse()) {
    try {
      fn()
    } catch (e) {
      process.stderr.write(`  Warning: cleanup error: ${e}\n`)
    }
  }
}

function registerCleanup(fn: () => void): void {
  if (cleanupFns.length === 0) {
    process.on('SIGINT', () => { runCleanup(); process.exit(130) })
    process.on('SIGTERM', () => { runCleanup(); process.exit(143) })
    process.on('exit', runCleanup)
  }
  cleanupFns.push(fn)
}

// ---------------------------------------------------------------------------
// Docker Compose lifecycle (PostgreSQL for integration tests)
// ---------------------------------------------------------------------------

const POSTGRES_PORT = 5432

function waitForPostgres(host = 'localhost', port = POSTGRES_PORT, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`PostgreSQL not ready after ${timeoutMs / 1000}s on ${host}:${port}`))
        return
      }
      const sock = createConnection({ host, port }, () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        setTimeout(attempt, 1000)
      })
      sock.setTimeout(3000, () => {
        sock.destroy()
        setTimeout(attempt, 1000)
      })
    }
    attempt()
  })
}

async function startDocker(restart: boolean): Promise<number> {
  const t0 = performance.now()
  const composeEnv = { ...process.env, POSTGRES_PASSWORD: 'dina' }
  const compose = (...args: string[]) =>
    spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
      stdio: 'pipe', timeout: 120_000, env: composeEnv, encoding: 'utf-8',
    })

  if (restart) {
    process.stderr.write('  Tearing down existing containers (--restart)...\n')
    compose('down', '-v')
  }

  // Check if Postgres is already healthy
  let alreadyHealthy = !restart
  if (alreadyHealthy) {
    try {
      await waitForPostgres('localhost', POSTGRES_PORT, 3000)
    } catch {
      alreadyHealthy = false
    }
  }

  let weStarted = false
  if (alreadyHealthy) {
    process.stderr.write('  PostgreSQL already healthy — reusing.\n')
  } else {
    weStarted = true
    process.stderr.write('  Starting PostgreSQL via Docker Compose...\n')

    const up = compose('up', '-d', 'postgres')
    if (up.status !== 0) {
      const tail = (up.stderr || '').trim().split('\n').slice(-10).join('\n')
      throw new Error(`docker compose up failed (exit ${up.status}):\n${tail}`)
    }

    await waitForPostgres('localhost', POSTGRES_PORT, 60_000)
    process.stderr.write('  PostgreSQL ready.\n')
  }

  // Sync schema to DB using drizzle-kit push (reads TypeScript schema directly,
  // no migration journal needed). Then apply any extra SQL migrations.
  const dbUrl = 'postgresql://dina:dina@localhost:5432/dina_trust'
  const pushEnv = { ...composeEnv, DATABASE_URL: dbUrl }

  process.stderr.write('  Syncing database schema (drizzle-kit push)...\n')
  const push = spawnSync('npx', ['drizzle-kit', 'push', '--force'], {
    stdio: 'pipe', timeout: 60_000, cwd: APPVIEW_ROOT, encoding: 'utf-8', env: pushEnv,
  })
  if (push.status !== 0) {
    const errTail = (push.stderr || '').trim().split('\n').slice(-5).join('\n')
    process.stderr.write(`  Warning: drizzle-kit push failed (exit ${push.status})\n${errTail}\n`)
  }

  // Apply extra SQL migrations (e.g. search_vector tsvector column)
  const drizzleDir = join(APPVIEW_ROOT, 'drizzle')
  if (existsSync(drizzleDir)) {
    const sqlFiles = readdirSync(drizzleDir).filter(f => f.endsWith('.sql')).sort()
    for (const sqlFile of sqlFiles) {
      const sqlPath = join(drizzleDir, sqlFile)
      process.stderr.write(`  Applying ${sqlFile}...\n`)
      const psql = spawnSync('psql', [dbUrl, '-f', sqlPath], {
        stdio: 'pipe', timeout: 30_000, encoding: 'utf-8', env: composeEnv,
      })
      if (psql.status !== 0) {
        // Fallback: run SQL via node pg if psql not available
        const sqlContent = readFileSync(sqlPath, 'utf-8')
        const runSql = spawnSync('node', ['-e', `
          const pg = require('pg');
          const pool = new pg.Pool({ connectionString: '${dbUrl}' });
          pool.query(\`${sqlContent.replace(/`/g, '\\`')}\`)
            .then(() => { pool.end(); })
            .catch(e => { console.error(e.message); pool.end(); process.exit(0); });
        `], { stdio: 'pipe', timeout: 30_000, encoding: 'utf-8', cwd: APPVIEW_ROOT, env: composeEnv })
        if (runSql.status !== 0) {
          process.stderr.write(`  Warning: failed to apply ${sqlFile}\n`)
        }
      }
    }
  }

  const elapsed = (performance.now() - t0) / 1000

  if (weStarted) {
    registerCleanup(() => {
      process.stderr.write('\n  Stopping Docker containers...\n')
      compose('down', '-v')
      process.stderr.write('  Docker containers stopped.\n')
    })
  }

  return elapsed
}

// ---------------------------------------------------------------------------
// Section map: parse TEST_PLAN.md §N headers
// ---------------------------------------------------------------------------

const SECTION_HEADER_RE = /^##\s+§(\d+)\s*[—–-]\s*(.+)/

function parseSectionHeaders(planPath: string): Map<number, string> {
  const sections = new Map<number, string>()
  if (!existsSync(planPath)) return sections

  const lines = readFileSync(planPath, 'utf-8').split('\n')
  for (const line of lines) {
    const m = SECTION_HEADER_RE.exec(line)
    if (m) {
      const num = parseInt(m[1], 10)
      let name = m[2].trim()
      // Clean trailing parens/backticks
      name = name.replace(/\s*\(.*$/, '').replace(/\s*`.*$/, '').trim()
      sections.set(num, name)
    }
  }
  return sections
}

// ---------------------------------------------------------------------------
// Test ID → Section mapping
// ---------------------------------------------------------------------------

const SECTION_FROM_NAME_RE = /§(\d+)/
const SECTION_FROM_FILE_RE = /^(\d+)-[a-z]/

function extractSectionFromName(testName: string): number {
  const m = SECTION_FROM_NAME_RE.exec(testName)
  return m ? parseInt(m[1], 10) : 0
}

function extractSectionFromFile(filename: string): number {
  const m = SECTION_FROM_FILE_RE.exec(filename)
  return m ? parseInt(m[1], 10) : 0
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string
  status: 'PASS' | 'SKIP' | 'FAIL'
  section: number
  duration: number // seconds
  file: string
}

interface SectionStats {
  number: number
  name: string
  total: number
  passed: number
  skipped: number
  failed: number
  duration: number
}

function statusLabel(s: SectionStats): string {
  if (s.failed > 0) return 'FAILED'
  if (s.total === 0) return 'Empty'
  if (s.passed === s.total) return 'Complete'
  if (s.passed > 0) return 'Partial'
  return 'Skip'
}

// ---------------------------------------------------------------------------
// Vitest JSON output parser
// ---------------------------------------------------------------------------

interface VitestJsonResult {
  testResults?: Array<{
    name?: string
    assertionResults?: Array<{
      fullName?: string
      title?: string
      status?: string
      duration?: number | null
      ancestorTitles?: string[]
    }>
  }>
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
}

const STATUS_MAP: Record<string, 'PASS' | 'SKIP' | 'FAIL'> = {
  passed: 'PASS',
  failed: 'FAIL',
  pending: 'SKIP',
  skipped: 'SKIP',
  todo: 'SKIP',
}

function parseVitestJson(jsonPath: string): TestResult[] {
  const results: TestResult[] = []
  if (!existsSync(jsonPath)) return results

  let data: VitestJsonResult
  try {
    data = JSON.parse(readFileSync(jsonPath, 'utf-8'))
  } catch {
    process.stderr.write(`  Warning: could not parse ${jsonPath}\n`)
    return results
  }

  for (const fileEntry of data.testResults ?? []) {
    const filePath = fileEntry.name ?? ''
    const filename = basename(filePath)
    const fileSection = extractSectionFromFile(filename)

    for (const assertion of fileEntry.assertionResults ?? []) {
      const fullName = assertion.fullName ?? assertion.title ?? ''
      const rawStatus = assertion.status ?? 'failed'
      const durationMs = assertion.duration ?? 0
      const status = STATUS_MAP[rawStatus] ?? 'FAIL'

      let section = extractSectionFromName(fullName)
      // Try ancestorTitles if fullName didn't have it
      if (section === 0 && assertion.ancestorTitles) {
        for (const title of assertion.ancestorTitles) {
          section = extractSectionFromName(title)
          if (section > 0) break
        }
      }
      if (section === 0) section = fileSection

      results.push({
        name: fullName,
        status,
        section,
        duration: durationMs / 1000,
        file: filename,
      })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Suite configuration & runner
// ---------------------------------------------------------------------------

interface SuiteConfig {
  name: string
  testDir: string
  plan: string
}

const SUITES: Record<string, SuiteConfig> = {
  unit: {
    name: 'Unit Tests',
    testDir: 'tests/unit/',
    plan: 'UNIT_TEST_PLAN.md',
  },
  integration: {
    name: 'Integration Tests',
    testDir: 'tests/integration/',
    plan: 'INTEGRATION_TEST_PLAN.md',
  },
}

interface SuiteResult {
  tests: TestResult[]
  sectionMap: Map<number, string>
  wallTime: number
  rawOutput: string
}

function runSuite(key: string): SuiteResult {
  const cfg = SUITES[key]
  const planPath = join(APPVIEW_ROOT, cfg.plan)
  const sectionMap = parseSectionHeaders(planPath)
  const jsonFile = join(APPVIEW_ROOT, `test-results-${key}.json`)

  // Clean up previous result file
  if (existsSync(jsonFile)) unlinkSync(jsonFile)

  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://dina:dina@localhost:5432/dina_trust',
  }

  const t0 = performance.now()
  const result = spawnSync('npx', [
    'vitest', 'run',
    cfg.testDir,
    '--reporter=json',
    `--outputFile=test-results-${key}.json`,
    '--reporter=verbose',
  ], {
    cwd: APPVIEW_ROOT,
    timeout: 300_000,
    encoding: 'utf-8',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const wallTime = (performance.now() - t0) / 1000
  const rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

  // Parse JSON output
  let tests: TestResult[] = []
  if (existsSync(jsonFile)) {
    tests = parseVitestJson(jsonFile)
    try { unlinkSync(jsonFile) } catch { /* ignore */ }
  }

  return { tests, sectionMap, wallTime, rawOutput }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(tests: TestResult[], sectionMap: Map<number, string>): SectionStats[] {
  const stats = new Map<number, SectionStats>()
  for (const [num, name] of sectionMap) {
    stats.set(num, { number: num, name, total: 0, passed: 0, skipped: 0, failed: 0, duration: 0 })
  }

  let unmapped = 0
  for (const t of tests) {
    if (t.section === 0) { unmapped++; continue }
    if (!stats.has(t.section)) {
      stats.set(t.section, {
        number: t.section, name: `Section ${t.section}`,
        total: 0, passed: 0, skipped: 0, failed: 0, duration: 0,
      })
    }
    const s = stats.get(t.section)!
    s.total++
    s.duration += t.duration
    if (t.status === 'PASS') s.passed++
    else if (t.status === 'SKIP') s.skipped++
    else s.failed++
  }

  if (unmapped) {
    process.stderr.write(`  (${unmapped} tests could not be mapped to a section)\n`)
  }

  return [...stats.values()].sort((a, b) => a.number - b.number)
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

function useColor(noColorFlag: boolean): boolean {
  if (noColorFlag || process.env.NO_COLOR) return false
  return process.stdout.isTTY ?? false
}

class Colors {
  private on: boolean
  constructor(enabled: boolean) { this.on = enabled }
  private w(code: string, text: string): string {
    return this.on ? `\x1b[${code}m${text}\x1b[0m` : text
  }
  green(t: string) { return this.w('32', t) }
  yellow(t: string) { return this.w('33', t) }
  red(t: string) { return this.w('1;31', t) }
  dim(t: string) { return this.w('2', t) }
  bold(t: string) { return this.w('1', t) }
  cyan(t: string) { return this.w('36', t) }
  status(label: string): string {
    const fn: Record<string, (t: string) => string> = {
      Complete: (t) => this.green(t),
      Partial: (t) => this.yellow(t),
      Skip: (t) => this.dim(t),
      Empty: (t) => this.dim(t),
      FAILED: (t) => this.red(t),
    }
    return fn[label] ? fn[label](label) : label
  }
}

// ---------------------------------------------------------------------------
// ASCII table renderer
// ---------------------------------------------------------------------------

const SEP = '\u2500' // ─
const CROSS = '\u253c' // ┼

function fmtTime(seconds: number): string {
  if (seconds < 0.01) return '  <10ms'
  if (seconds < 1) return `${(seconds * 1000).toFixed(0).padStart(5)}ms`
  if (seconds < 60) return `${seconds.toFixed(1).padStart(5)}s `
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2)}m${s.toFixed(1).padStart(4, '0')}s`
}

function fmtStartup(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s.toFixed(0)}s`
}

function groupBySection(tests: TestResult[]): Map<number, TestResult[]> {
  const groups = new Map<number, TestResult[]>()
  for (const t of tests) {
    if (!groups.has(t.section)) groups.set(t.section, [])
    groups.get(t.section)!.push(t)
  }
  return groups
}

function renderSuite(
  name: string, sections: SectionStats[], c: Colors,
  wallTime = 0, tests?: TestResult[], verbose = false,
): void {
  let header = `=== ${name} ===`
  if (wallTime > 0) header += `  (${fmtTime(wallTime).trim()})`
  console.log(`\n${c.bold(header)}`)
  console.log(
    ` ${'§'.padStart(3)} | ${'Section'.padEnd(40)} | ${'Total'.padStart(5)}`
    + ` | ${'Pass'.padStart(4)} | ${'Skip'.padStart(4)} | ${'Fail'.padStart(4)}`
    + ` | ${'Time'.padStart(7)} | Status`
  )
  const rule =
    SEP.repeat(5) + CROSS + SEP.repeat(42) + CROSS + SEP.repeat(7)
    + CROSS + SEP.repeat(6) + CROSS + SEP.repeat(6) + CROSS + SEP.repeat(6)
    + CROSS + SEP.repeat(9) + CROSS + SEP.repeat(10)
  console.log(rule)

  const bySection = (verbose && tests) ? groupBySection(tests) : new Map()

  let tot = 0, pas = 0, ski = 0, fai = 0, totDur = 0
  for (const s of sections) {
    if (s.total === 0) continue
    tot += s.total; pas += s.passed; ski += s.skipped; fai += s.failed; totDur += s.duration
    console.log(
      ` ${String(s.number).padStart(3)} | ${s.name.slice(0, 40).padEnd(40)} | ${String(s.total).padStart(5)}`
      + ` | ${String(s.passed).padStart(4)} | ${String(s.skipped).padStart(4)} | ${String(s.failed).padStart(4)}`
      + ` | ${fmtTime(s.duration)} | ${c.status(statusLabel(s))}`
    )

    if (verbose && bySection.has(s.number)) {
      const sectionTests = bySection.get(s.number)!.sort((a, b) => a.name.localeCompare(b.name))
      for (const t of sectionTests) {
        const statusStr = t.status === 'PASS' ? c.green('PASS')
          : t.status === 'SKIP' ? c.dim('SKIP') : c.red('FAIL')
        const dur = t.duration > 0 ? fmtTime(t.duration) : ''
        console.log(`     |   ${statusStr} ${t.name.slice(0, 70).padEnd(70)} ${dur}`)
      }
    }
  }

  console.log(rule)
  console.log(
    ` ${''.padStart(3)} | ${'TOTAL'.padEnd(40)} | ${String(tot).padStart(5)}`
    + ` | ${String(pas).padStart(4)} | ${String(ski).padStart(4)} | ${String(fai).padStart(4)}`
    + ` | ${fmtTime(totDur)} |`
  )
}

function renderGrandSummary(
  rows: Array<{ name: string; total: number; passed: number; skipped: number; failed: number; wallTime: number }>,
  c: Colors,
): void {
  console.log(`\n${c.bold('=== AppView Grand Summary ===')}`)
  console.log(
    ` ${'Suite'.padEnd(20)} | ${'Total'.padStart(5)}`
    + ` | ${'Pass'.padStart(4)} | ${'Skip'.padStart(4)} | ${'Fail'.padStart(4)}`
    + ` | ${'Time'.padStart(7)} | Progress`
  )
  const rule =
    SEP.repeat(22) + CROSS + SEP.repeat(7)
    + CROSS + SEP.repeat(6) + CROSS + SEP.repeat(6) + CROSS + SEP.repeat(6)
    + CROSS + SEP.repeat(9) + CROSS + SEP.repeat(10)
  console.log(rule)

  let gt = 0, gp = 0, gs = 0, gf = 0, gTime = 0
  for (const r of rows) {
    gt += r.total; gp += r.passed; gs += r.skipped; gf += r.failed; gTime += r.wallTime
    const pct = r.total > 0 ? (r.passed / r.total * 100) : 0
    console.log(
      ` ${r.name.padEnd(20)} | ${String(r.total).padStart(5)}`
      + ` | ${String(r.passed).padStart(4)} | ${String(r.skipped).padStart(4)} | ${String(r.failed).padStart(4)}`
      + ` | ${fmtTime(r.wallTime)} | ${pct.toFixed(1).padStart(5)}%`
    )
  }

  console.log(rule)
  const gpct = gt > 0 ? (gp / gt * 100) : 0
  console.log(
    ` ${'TOTAL'.padEnd(20)} | ${String(gt).padStart(5)}`
    + ` | ${String(gp).padStart(4)} | ${String(gs).padStart(4)} | ${String(gf).padStart(4)}`
    + ` | ${fmtTime(gTime)} | ${gpct.toFixed(1).padStart(5)}%`
  )
}

// ---------------------------------------------------------------------------
// npm dependency check
// ---------------------------------------------------------------------------

function ensureNpmDeps(): void {
  if (!existsSync(join(APPVIEW_ROOT, 'node_modules'))) {
    process.stderr.write('  Installing npm dependencies...\n')
    const r = spawnSync('npm', ['install'], {
      cwd: APPVIEW_ROOT, stdio: 'pipe', timeout: 120_000, encoding: 'utf-8',
    })
    if (r.status !== 0) {
      throw new Error(`npm install failed (exit ${r.status}):\n${(r.stderr ?? '').slice(-500)}`)
    }
    process.stderr.write('  npm dependencies installed.\n')
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CLIOpts {
  suite: string | null
  json: boolean
  noColor: boolean
  noDocker: boolean
  restart: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): CLIOpts {
  const opts: CLIOpts = {
    suite: null, json: false, noColor: false,
    noDocker: false, restart: false, verbose: false,
  }
  let i = 2 // skip node + script path
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--no-color') opts.noColor = true
    else if (a === '--no-docker') opts.noDocker = true
    else if (a === '--restart') opts.restart = true
    else if (a === '-v' || a === '--verbose') opts.verbose = true
    else if (a === '--suite' && i + 1 < argv.length) { i++; opts.suite = argv[i].toLowerCase() }
    else if (a === '-h' || a === '--help') {
      console.log(`AppView Test Runner

When integration tests are included, Docker (PostgreSQL + migrations) is
auto-started if PostgreSQL is not already reachable. Containers are torn
down on exit. Use --no-docker to disable this.

Usage:
  npx tsx test_appview.ts                        # All tests — auto-starts Docker if needed
  npx tsx test_appview.ts --suite unit            # Unit tests only (no Docker needed)
  npx tsx test_appview.ts --suite integration     # Integration tests (auto-starts Docker)
  npx tsx test_appview.ts --restart               # Force rebuild Docker containers
  npx tsx test_appview.ts --no-docker             # Skip Docker auto-start (fail if no Postgres)
  npx tsx test_appview.ts --json                  # Machine-readable JSON output
  npx tsx test_appview.ts -v                      # Verbose — show individual tests
  npx tsx test_appview.ts --no-color              # Disable ANSI colors`)
      process.exit(0)
    }
    i++
  }
  return opts
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scriptT0 = performance.now()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logDir = join(tmpdir(), `appview-tests-${timestamp}`)
  mkdirSync(logDir, { recursive: true })

  const opts = parseArgs(process.argv)
  const c = new Colors(useColor(opts.noColor))

  // Validate suite filter
  const keys = opts.suite
    ? (SUITES[opts.suite] ? [opts.suite] : null)
    : Object.keys(SUITES)

  if (!keys) {
    process.stderr.write(
      `ERROR: Unknown suite '${opts.suite}'. Valid: ${Object.keys(SUITES).join(', ')}\n`
    )
    process.exit(2)
  }

  if (!opts.json) {
    process.stderr.write(`${c.bold('AppView Test Runner')}\n`)
    process.stderr.write(`  Root: ${APPVIEW_ROOT}\n`)
  }

  // Ensure npm dependencies
  ensureNpmDeps()

  // Docker lifecycle — auto-start for integration tests when Postgres is unreachable
  const hasIntegration = keys.includes('integration')
  let startupTime = 0

  if (hasIntegration) {
    if (opts.restart) {
      // --restart: force rebuild regardless of current state
      if (!opts.json) process.stderr.write('  Rebuilding Docker containers (--restart)...\n')
      try {
        startupTime = await startDocker(true)
        if (!opts.json) process.stderr.write(`  PostgreSQL ready (${fmtStartup(startupTime)})\n`)
      } catch (e) {
        process.stderr.write(`ERROR: Failed to start Docker: ${e}\n`)
        process.exit(3)
      }
    } else {
      // Check if Postgres is already reachable
      let postgresReady = false
      try {
        await waitForPostgres('localhost', POSTGRES_PORT, 3000)
        postgresReady = true
        if (!opts.json) process.stderr.write('  PostgreSQL detected (external).\n')
      } catch {
        postgresReady = false
      }

      if (!postgresReady) {
        if (opts.noDocker) {
          // User explicitly opted out of Docker
          if (!opts.json) {
            process.stderr.write(
              '  Warning: PostgreSQL not reachable and --no-docker specified.\n'
              + '  Integration tests will fail. Start PostgreSQL manually.\n'
            )
          }
        } else {
          // Auto-start Docker
          if (!opts.json) process.stderr.write('  PostgreSQL not reachable — auto-starting via Docker...\n')
          try {
            startupTime = await startDocker(false)
            if (!opts.json) process.stderr.write(`  PostgreSQL ready (${fmtStartup(startupTime)})\n`)
          } catch (e) {
            process.stderr.write(`ERROR: Failed to auto-start Docker: ${e}\n`)
            process.stderr.write('  Use --no-docker to skip, or start PostgreSQL manually.\n')
            process.exit(3)
          }
        }
      }
    }
  }

  try {
    const allJson: Record<string, unknown> = {}
    const summaryRows: Array<{ name: string; total: number; passed: number; skipped: number; failed: number; wallTime: number }> = []

    for (const key of keys) {
      const cfg = SUITES[key]
      if (!opts.json) process.stderr.write(`\nRunning ${cfg.name}...\n`)

      const { tests, sectionMap, wallTime, rawOutput } = runSuite(key)
      if (rawOutput) {
        writeFileSync(join(logDir, `${key}.log`), rawOutput)
      }
      const sections = aggregate(tests, sectionMap)

      const tot = sections.reduce((a, s) => a + s.total, 0)
      const pas = sections.reduce((a, s) => a + s.passed, 0)
      const ski = sections.reduce((a, s) => a + s.skipped, 0)
      const fai = sections.reduce((a, s) => a + s.failed, 0)
      const secDur = sections.reduce((a, s) => a + s.duration, 0)

      if (opts.json) {
        allJson[key] = {
          sections: sections
            .filter(s => s.total > 0)
            .map(s => ({
              number: s.number,
              name: s.name,
              total: s.total,
              passed: s.passed,
              skipped: s.skipped,
              failed: s.failed,
              status: statusLabel(s),
              duration_s: Math.round(s.duration * 1000) / 1000,
            })),
          summary: {
            total: tot,
            passed: pas,
            skipped: ski,
            failed: fai,
            duration_s: Math.round(secDur * 1000) / 1000,
            wall_time_s: Math.round(wallTime * 1000) / 1000,
          },
        }
      } else {
        renderSuite(cfg.name, sections, c, wallTime, tests, opts.verbose)
      }

      summaryRows.push({ name: cfg.name, total: tot, passed: pas, skipped: ski, failed: fai, wallTime })
    }

    const totalTime = (performance.now() - scriptT0) / 1000

    if (opts.json) {
      allJson._timing = {
        startup_s: Math.round(startupTime * 1000) / 1000,
        total_s: Math.round(totalTime * 1000) / 1000,
      }
      allJson._log_dir = logDir
      console.log(JSON.stringify(allJson, null, 2))
      process.stderr.write(`\nDetailed logs: ${logDir}/\n`)
    } else {
      if (summaryRows.length > 1) {
        renderGrandSummary(summaryRows, c)
      }
      const parts: string[] = []
      if (startupTime > 0) parts.push(`startup: ${fmtStartup(startupTime)}`)
      parts.push(`total: ${fmtStartup(totalTime)}`)
      console.log(`\n  [${parts.join(' | ')}]`)
      console.log(`  Detailed logs: ${logDir}/`)
    }
  } finally {
    runCleanup()
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e}\n`)
  runCleanup()
  process.exit(1)
})
