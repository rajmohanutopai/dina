#!/usr/bin/env node
/**
 * Run the TypeScript test suites without exhausting the machine's memory.
 *
 *   node scripts/test/safe_test.mjs                     every workspace, one after another
 *   node scripts/test/safe_test.mjs --only core,mobile  just these (by folder name or path)
 *   node scripts/test/safe_test.mjs --only core -- __tests__/commerce/term
 *                                                       extra args go to jest / vitest
 *   node scripts/test/safe_test.mjs --list              show the suites and their commands
 *
 * Why: a plain `jest` starts a worker for nearly every core, each holding
 * ts-jest and the sources. Several suites at once, or several Claude sessions
 * each running one, can use up the laptop's memory. This runner sets four limits:
 *
 *   1. ONE RUN AT A TIME across every session: a lock file; a second run waits.
 *   2. Suites run one after another, each with few workers (--workers, default 2),
 *      jest's --workerIdleMemoryLimit, and a V8 heap cap on every Node process.
 *   3. A WATCHDOG adds up the resident memory of the suite's whole process tree
 *      every second; past --budget-mb it stops the suite and reports it.
 *   4. Before each suite it checks the machine's free memory and waits while it
 *      is below --min-free-mb.
 *
 * Options (defaults in brackets):
 *   --workers N          test workers per suite [2]
 *   --budget-mb N        memory budget for one suite's process tree [6144]
 *   --heap-mb N          --max-old-space-size for each Node process [3072]
 *   --worker-limit SIZE  jest --workerIdleMemoryLimit [1024MB]
 *   --min-free-mb N      free memory needed before a suite starts [2048]
 *   --wait-free-s N      how long to wait for that memory [300]
 *   --lock-wait-s N      how long to wait for another run to finish [3600]
 *   --bail               stop at the first failing suite
 *
 * Logs: scripts/test/.safe_test/logs/<suite>.log (git-ignored). Exit code 1 if
 * any suite failed, was stopped, or could not start.
 */

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = path.join(ROOT, 'scripts', 'test', '.safe_test');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const LOCK_FILE = path.join(STATE_DIR, 'lock');

// --- options ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    workers: 2,
    budgetMb: 6144,
    heapMb: 3072,
    workerLimit: '1024MB',
    minFreeMb: 2048,
    waitFreeS: 300,
    lockWaitS: 3600,
    bail: false,
    list: false,
    only: null,
    passthrough: [],
  };
  const numeric = {
    '--workers': 'workers',
    '--budget-mb': 'budgetMb',
    '--heap-mb': 'heapMb',
    '--min-free-mb': 'minFreeMb',
    '--wait-free-s': 'waitFreeS',
    '--lock-wait-s': 'lockWaitS',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts.passthrough = argv.slice(i + 1);
      break;
    }
    if (arg in numeric) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) fail(`${arg} needs a positive whole number`);
      opts[numeric[arg]] = value;
    } else if (arg === '--worker-limit') opts.workerLimit = argv[++i];
    else if (arg === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--bail') opts.bail = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/\n');
      process.exit(0);
    } else fail(`unknown option ${arg} (see --help)`);
  }
  if (opts.passthrough.length > 0 && (opts.only === null || opts.only.length !== 1)) {
    fail('extra test args (after --) need exactly one suite in --only');
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`safe_test: ${message}\n`);
  process.exit(2);
}

// --- suites ---------------------------------------------------------------------

/** Every workspace folder with a test script, in the root package's workspace order. */
function discoverSuites() {
  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dirs = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(ROOT, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent).sort()) dirs.push(path.join(parent, name));
    } else dirs.push(path.join(ROOT, pattern));
  }
  const suites = [];
  for (const dir of dirs) {
    const pkgPath = path.join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.scripts?.test !== 'string') continue;
    suites.push({ name: path.relative(ROOT, dir), dir, scripts: pkg.scripts });
  }
  return suites;
}

function selectSuites(all, only) {
  if (only === null) return all;
  return only.map((want) => {
    const hits = all.filter((s) => s.name === want || path.basename(s.dir) === want);
    if (hits.length !== 1) {
      fail(hits.length === 0 ? `no suite named ${want}` : `${want} is ambiguous: ${hits.map((h) => h.name).join(', ')}`);
    }
    return hits[0];
  });
}

/**
 * Turn a package's test script into steps the runner can limit: each `&&` part
 * becomes one step; `npm run x` is followed into script x; jest and vitest get
 * the worker limits. Anything else (a build step) runs as written.
 */
function planSteps(suite, opts, scriptName = 'test', depth = 0) {
  if (depth > 5) fail(`${suite.name}: scripts nest too deep`);
  const script = suite.scripts[scriptName];
  if (typeof script !== 'string') fail(`${suite.name}: no script ${scriptName}`);
  const steps = [];
  for (const part of script.split('&&').map((p) => p.trim())) {
    const words = part.split(/\s+/);
    const env = {};
    while (words.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) {
      const [key, ...value] = words.shift().split('=');
      env[key] = value.join('=');
    }
    const [command, ...rest] = words;
    if (command === 'npm' && rest[0] === 'run' && rest[1] !== undefined && rest.length === 2) {
      steps.push(...planSteps(suite, opts, rest[1], depth + 1));
    } else if (command === 'jest') {
      steps.push({
        env,
        argv: ['npx', 'jest', ...rest, `--maxWorkers=${opts.workers}`, `--workerIdleMemoryLimit=${opts.workerLimit}`, ...opts.passthrough],
        runner: 'jest',
      });
    } else if (command === 'vitest') {
      steps.push({
        env,
        argv: ['npx', 'vitest', ...rest, `--maxWorkers=${opts.workers}`, '--minWorkers=1', ...opts.passthrough],
        runner: 'vitest',
      });
    } else {
      steps.push({ env, argv: ['sh', '-c', part], runner: 'other' });
    }
  }
  return steps;
}

// --- memory ---------------------------------------------------------------------

/** Memory the system could hand out now, in MB (macOS: vm_stat; Linux: MemAvailable). */
function freeMemoryMb() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8' });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
      return Math.floor((available * pageSize) / 1048576);
    }
    if (process.platform === 'linux') {
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0);
      return Math.floor(kb / 1024);
    }
  } catch {
    // fall through to the portable figure
  }
  return Math.floor(os.freemem() / 1048576);
}

/** Resident memory of `rootPid` and every process under it, in MB. */
function treeRssMb(rootPid) {
  let out;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  } catch {
    return 0;
  }
  const children = new Map();
  const rss = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid)) continue;
    rss.set(pid, kb);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return Math.round(total / 1024);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFreeMemory(opts) {
  const deadline = Date.now() + opts.waitFreeS * 1000;
  let free = freeMemoryMb();
  let told = false;
  while (free < opts.minFreeMb) {
    if (Date.now() > deadline) return { ok: false, free };
    if (!told) {
      log(`  waiting: ${free} MB free, need ${opts.minFreeMb} MB`);
      told = true;
    }
    await sleep(5000);
    free = freeMemoryMb();
  }
  return { ok: true, free };
}

// --- the lock -------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Take the one-run lock, waiting for a live holder; a dead holder's lock is cleared.
 *
 * The lock appears whole or not at all: its content is written to a private
 * file first, then hard-linked into place, which is atomic and fails if a lock
 * exists — so no reader ever sees a half-written lock. A dead holder's lock is
 * cleared by one clearer at a time, and only while the dead holder still owns
 * it (`clearDeadLock`): a lock a live process took in between is never touched.
 */
async function acquireLock(opts) {
  mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + opts.lockWaitS * 1000;
  const mine = `${LOCK_FILE}.${process.pid}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cwd: process.cwd() }));
  let told = false;
  try {
    for (;;) {
      try {
        linkSync(mine, LOCK_FILE);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const holder = readHolder(LOCK_FILE);
      if (holder === null) {
        // Vanished between the link and the read: try again at once.
        continue;
      }
      if (!pidAlive(Number(holder.pid))) {
        clearDeadLock(Number(holder.pid));
        continue;
      }
      if (Date.now() > deadline) fail(`another test run (pid ${holder.pid}, since ${holder.started}) still holds the lock`);
      if (!told) {
        log(`waiting for another test run to finish (pid ${holder.pid}, since ${holder.started})`);
        told = true;
      }
      await sleep(5000);
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

function readHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove the lock only if it is still the one `deadPid` held. One clearer at a
 * time: whoever creates the `clearing` marker (O_EXCL) re-reads the lock and
 * removes it only if the dead holder still owns it, so a lock a live process
 * took in between is never touched — nothing is moved aside and given back. A
 * marker left by a clearer that died is itself cleared after 30 seconds.
 */
function clearDeadLock(deadPid) {
  const marker = `${LOCK_FILE}.clearing`;
  let fd;
  try {
    fd = openSync(marker, 'wx');
  } catch {
    try {
      if (Date.now() - statSync(marker).mtimeMs > 30_000) rmSync(marker, { force: true });
    } catch {
      /* gone already */
    }
    return;
  }
  try {
    const holder = readHolder(LOCK_FILE);
    if (holder !== null && Number(holder.pid) === deadPid && !pidAlive(deadPid)) {
      rmSync(LOCK_FILE, { force: true });
    }
  } finally {
    closeSync(fd);
    rmSync(marker, { force: true });
  }
}

function releaseLock() {
  try {
    const holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (Number(holder.pid) === process.pid) rmSync(LOCK_FILE, { force: true });
  } catch {
    // nothing to release
  }
}

// --- running --------------------------------------------------------------------

function log(line) {
  process.stdout.write(`${line}\n`);
}

let current = null; // the running step's process group, for Ctrl-C

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** Run one step under the watchdog. Resolves {code, peakMb, overBudget}. */
function runStep(step, suite, opts, logFd) {
  return new Promise((resolve) => {
    const nodeOptions = [process.env.NODE_OPTIONS, step.env.NODE_OPTIONS, `--max-old-space-size=${opts.heapMb}`]
      .filter(Boolean)
      .join(' ');
    const child = spawn(step.argv[0], step.argv.slice(1), {
      cwd: suite.dir,
      env: { ...process.env, ...step.env, NODE_OPTIONS: nodeOptions, CI: process.env.CI ?? '1' },
      stdio: ['ignore', logFd, logFd],
      detached: true, // its own process group, so the whole tree can be stopped
    });
    current = child.pid;
    let peakMb = 0;
    let overBudget = false;
    const sample = () => {
      const mb = treeRssMb(child.pid);
      peakMb = Math.max(peakMb, mb);
      if (mb > opts.budgetMb && !overBudget) {
        overBudget = true;
        log(`  stopping ${suite.name}: ${mb} MB is over the ${opts.budgetMb} MB budget`);
        killGroup(child.pid, 'SIGTERM');
        setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
      }
    };
    const first = setTimeout(sample, 300);
    const watch = setInterval(sample, 1000);
    child.on('exit', (code, signal) => {
      clearTimeout(first);
      clearInterval(watch);
      current = null;
      resolve({ code: code ?? (signal ? 1 : 0), peakMb, overBudget });
    });
  });
}

/** The result line jest or vitest printed, read back from the log. */
function summaryFromLog(logPath) {
  const text = readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const jest = text.match(/^Tests:.*$/gm);
  if (jest) return jest.map((l) => l.replace(/^Tests:\s+/, '')).join(' | ');
  const vitest = text.match(/^\s*Tests\s+.*$/gm);
  if (vitest) return vitest.map((l) => l.trim().replace(/^Tests\s+/, '')).join(' | ');
  return '';
}

function failuresFromLog(logPath, max = 15) {
  const text = readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  return text
    .split('\n')
    .filter((l) => /✕|^\s*FAIL\s|●.*›|×/.test(l))
    .slice(0, max);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const suites = selectSuites(discoverSuites(), opts.only);
  if (opts.list) {
    for (const suite of suites) {
      log(`${suite.name}`);
      for (const step of planSteps(suite, opts)) {
        const env = Object.entries(step.env).map(([k, v]) => `${k}=${v} `).join('');
        log(`    ${env}${step.argv.join(' ')}`);
      }
    }
    return 0;
  }

  await acquireLock(opts);
  const stop = () => {
    if (current !== null) killGroup(current, 'SIGTERM');
    releaseLock();
    process.exit(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  mkdirSync(LOG_DIR, { recursive: true });
  log(`safe_test: ${suites.length} suite(s), ${opts.workers} worker(s), budget ${opts.budgetMb} MB, heap ${opts.heapMb} MB`);
  const results = [];
  try {
    for (const suite of suites) {
      const room = await waitForFreeMemory(opts);
      if (!room.ok) {
        log(`✗ ${suite.name}: not started, only ${room.free} MB free`);
        results.push({ suite: suite.name, status: 'not started (low memory)', peakMb: 0 });
        if (opts.bail) break;
        continue;
      }
      const logPath = path.join(LOG_DIR, `${suite.name.replace(/[\\/]/g, '__')}.log`);
      const logFd = openSync(logPath, 'w');
      const started = Date.now();
      let status = 'passed';
      let peakMb = 0;
      for (const step of planSteps(suite, opts)) {
        writeFileSync(logFd, `\n$ ${step.argv.join(' ')}\n`);
        const ran = await runStep(step, suite, opts, logFd);
        peakMb = Math.max(peakMb, ran.peakMb);
        if (ran.overBudget) {
          status = `stopped (over ${opts.budgetMb} MB)`;
          break;
        }
        if (ran.code !== 0) {
          status = 'failed';
          break;
        }
      }
      closeSync(logFd);
      const seconds = Math.round((Date.now() - started) / 1000);
      const summary = summaryFromLog(logPath);
      log(`${status === 'passed' ? '✓' : '✗'} ${suite.name}: ${status} · ${summary || 'no test summary'} · peak ${peakMb > 0 ? `${peakMb} MB` : 'not measured'} · ${seconds}s`);
      if (status !== 'passed') {
        for (const line of failuresFromLog(logPath)) log(`    ${line.trim()}`);
        log(`    log: ${path.relative(ROOT, logPath)}`);
      }
      results.push({ suite: suite.name, status, peakMb, seconds, summary });
      if (status !== 'passed' && opts.bail) break;
    }
  } finally {
    releaseLock();
  }

  const bad = results.filter((r) => r.status !== 'passed');
  const peak = Math.max(0, ...results.map((r) => r.peakMb));
  writeFileSync(path.join(STATE_DIR, 'last_run.json'), JSON.stringify({ finished: new Date().toISOString(), opts, results }, null, 2));
  log(`\n${results.length - bad.length}/${results.length} suite(s) passed; highest peak ${peak} MB`);
  return bad.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    releaseLock();
    process.stderr.write(`safe_test: ${err.stack ?? err}\n`);
    process.exit(2);
  },
);
