/**
 * Item 3b — path-aware file-tool classifier (Plugin Developer Surface §12.1/§12.3).
 *
 * Maps a coding agent's file tool call (`Read`/`Grep`/`Write`/`Edit`/…) to a
 * coding-taxonomy action (`CODING_ACTION_POLICY` in @dina/core). The security
 * core is path-awareness: a read whose CANONICAL (symlink- and `..`-resolved)
 * path targets a protected artifact — the seed keyfile, wrapped seed, recovery
 * phrase, PDS creds, a vault `.sqlite`, a `.env`/secret, or an SSH/PEM key —
 * classifies as `secret_read` (BLOCKED); a write/edit to one classifies as
 * `secret_write` (BLOCKED). Everything else is `code_read`/`code_edit` (SAFE) or
 * `code_edit_external` (MODERATE, e.g. `NotebookEdit`).
 *
 * This is a framework-mediated guarantee (§16): it gates the tool calls Core
 * sees; it does not stop a same-UID process opening the file directly. The
 * `fs.realpath` canonicalisation lives here (Node I/O) rather than in the pure
 * @dina/core; the taxonomy + risk lookup are imported from @dina/core.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDefaultRiskLevel, type RiskLevel } from '@dina/core';

/**
 * Dina state filenames protected WHEREVER they appear — the seed keyfile
 * (`keyfile`) is deliberately NOT here: it's a common enough word that matching
 * it anywhere over-blocks `grep keyfile` / `cat keyfile`, and the REAL seed under
 * the vault dir is caught by containment (a symlink/copy resolves into the vault
 * too). Only the unambiguous, Dina-specific names — a stray copy of which would
 * leak the seed — match by basename anywhere.
 */
const DINA_STATE_ANYWHERE = new Set([
  'wrapped_seed.bin',
  'recovery-phrase.txt',
  'pds_identity.json',
]);

/** Basename patterns for generic secrets / private keys / plaintext creds. */
const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /\.keystore$/i,
  /\.(p12|pfx|jks|der|p8|asc|gpg)$/i, // keystores / DER / PKCS8 / PGP
  /^id_(rsa|ed25519|ecdsa|dsa)$/i, // ssh private keys
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /^credentials$/i,
  /\.credentials$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.dockercfg$/i,
];

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Cat']);
/** Write/edit tools that stay inside project files → SAFE when unprotected. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'apply_patch']);

export interface ProtectedPathOptions {
  /** The Dina vault/state dir — canonical (realpath-resolved). */
  vaultDir: string;
  /** Extra key/credential dirs — canonical. */
  keyDirs?: string[];
}

/**
 * True if a CANONICAL path targets a protected artifact. Assumes `canonicalPath`
 * and the option dirs are already realpath-resolved (the caller does that), so
 * this is pure path/string reasoning.
 */
export function isProtectedPath(canonicalPath: string, opts: ProtectedPathOptions): boolean {
  if (!canonicalPath) return false;
  // An unresolvable path (symlink cycle / pathological depth) fails CLOSED.
  if (canonicalPath.includes('\0')) return true;
  const p = path.normalize(canonicalPath);
  const base = path.basename(p);

  // Anything under the Dina vault/state dir: keyfile, wrapped seed, recovery
  // phrase, PDS creds, vault *.sqlite, config, inbox — the raw vault + secrets.
  if (opts.vaultDir && isUnder(p, path.normalize(opts.vaultDir))) return true;
  for (const dir of opts.keyDirs ?? []) {
    if (dir && isUnder(p, path.normalize(dir))) return true;
  }
  if (DINA_STATE_ANYWHERE.has(base.toLowerCase())) return true;
  if (SECRET_BASENAME_PATTERNS.some((re) => re.test(base))) return true;
  return false;
}

/**
 * True if `child` is `parent` or lives beneath it (no `..` escape).
 *
 * Compared case-INSENSITIVELY: macOS/APFS (and Windows) are case-insensitive by
 * default, so `fs.realpath` preserves the requested case and a case-variant
 * (`/Vault/KeyFile`) would otherwise slip a case-sensitive `path.relative`
 * check. Lowercasing both sides is safe on a case-sensitive fs too — a genuinely
 * distinct `/vaultdata` still isn't under `/vault` (relative stays `../…`).
 */
function isUnder(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Canonicalise a raw path to an absolute, symlink-resolved path. For a target
 * that does not exist yet (a new `Write`), resolve the nearest EXISTING ancestor
 * and re-append the non-existent tail — so a symlinked parent dir is still
 * resolved and cannot be used to escape the protected check.
 */
export function canonicalizePath(rawPath: string, cwd: string): string {
  // Do NOT use path.resolve — it collapses `..` LEXICALLY before symlinks are
  // resolved, diverging from the kernel when a component is a symlink (a mid-path
  // `..` after `inbox -> /vault` must resolve against /vault, not the lexical
  // parent). Build the absolute path preserving `..`, then resolve step by step.
  const abs = path.isAbsolute(rawPath) ? rawPath : `${cwd}${path.sep}${rawPath}`;
  return canonicalizeAbs(abs, new Set(), 0);
}

/**
 * A NUL-bearing sentinel returned when a path cannot be resolved (a symlink
 * cycle or pathological depth). `isProtectedPath` treats any NUL-bearing path as
 * protected, so an unresolvable path fails CLOSED (BLOCKED), never open.
 */
const UNRESOLVABLE = '\0unresolvable';

/**
 * Resolve an absolute path, following symlinks MANUALLY so that a **dangling**
 * leaf symlink (target not created yet) is still followed. The parent is
 * resolved to its REAL location FIRST, so a relative leaf-symlink target
 * resolves against the true directory even when a path component is itself a
 * symlink. `fs.realpathSync` gives up on a missing target and would leave the
 * leaf unresolved — letting a `Write` through `project/link -> <vault>/new.db`
 * plant a file in the vault while it classifies as a benign project edit.
 */
function canonicalizeAbs(abs: string, seen: Set<string>, depth: number): string {
  if (depth > 4096) return UNRESOLVABLE; // extreme backstop (never hit by real paths)
  const parent = path.dirname(abs);
  if (parent === abs) return abs; // filesystem root

  // Resolve the PARENT first (it may itself traverse a symlink), then rebuild
  // this path on the real parent — so both a relative leaf target AND a mid-path
  // `..` resolve against the TRUE directory. `path.join` collapses `..`/`.`
  // against the already-resolved parent (kernel-correct order).
  const realParent = canonicalizeAbs(parent, seen, depth + 1);
  if (realParent.includes('\0')) return UNRESOLVABLE;
  const real = path.join(realParent, path.basename(abs));

  // Follow the leaf if it is itself a symlink — even a dangling one. A seen-set
  // catches a symlink CYCLE precisely and fails CLOSED, so we don't need a low
  // depth cap that would over-block a deeply-nested legitimate path.
  try {
    if (fs.lstatSync(real).isSymbolicLink()) {
      if (seen.has(real)) return UNRESOLVABLE; // cycle
      seen.add(real);
      const target = path.resolve(realParent, fs.readlinkSync(real));
      return canonicalizeAbs(target, seen, depth + 1);
    }
  } catch {
    // `real` does not exist (a new file under a resolved parent) — that's fine.
  }
  try {
    return fs.realpathSync(real);
  } catch {
    return real; // non-existent target under a real parent
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(path.resolve(p));
  }
}

/** Contains a shell glob / brace metacharacter. */
function hasGlob(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

/** Expand `{a,b}` brace alternations (recursively) into concrete strings. */
function braceExpand(p: string): string[] {
  const m = p.match(/\{([^{}]*)\}/);
  if (!m) return [p];
  return m[1].split(',').flatMap((o) => braceExpand(p.replace(m[0], o)));
}

/** Regex metacharacters to escape when compiling a glob segment. */
const REGEX_META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '\\']);

/** Compile one glob path-segment (`*`, `?`, `[...]`) to an anchored RegExp. */
function globSegToRegex(seg: string): RegExp {
  let re = '^';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      let j = i + 1;
      if (seg[j] === '!' || seg[j] === '^') j++;
      if (seg[j] === ']') j++;
      while (j < seg.length && seg[j] !== ']') j++;
      re += seg.slice(i, j + 1).replace(/^\[!/, '[^');
      i = j;
    } else if (REGEX_META.has(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re + '$');
}

/**
 * Walk a (no-brace) glob pattern segment by segment, FOLLOWING symlinks at each
 * step — exactly as bash/zsh do — and return true if any expansion is a
 * protected path. fs.globSync is NOT used: it refuses to descend a
 * wildcard-matched symlinked directory, so a "cat u<star>/vault/keyfile" through
 * a symlink would read the seed while globSync returned nothing (audit CRITICAL).
 */
function globWalkHitsProtected(
  absPattern: string,
  cwd: string,
  opts: ProtectedPathOptions,
): boolean {
  const segs = absPattern.split(path.sep).filter((s) => s !== '');
  const walk = (dir: string, i: number, depth: number): boolean => {
    if (depth > 64) return true; // runaway → fail closed
    if (i >= segs.length) return isProtectedPath(canonicalizePath(dir, cwd), opts);
    const seg = segs[i];
    const join = (d: string, s: string) => (d === path.sep ? path.sep + s : d + path.sep + s);
    if (!hasGlob(seg)) return walk(join(dir, seg), i + 1, depth);
    let entries: string[];
    try {
      entries = fs.readdirSync(fs.realpathSync(dir)); // realpath → follow symlinks
    } catch {
      return false;
    }
    const re = globSegToRegex(seg);
    for (const e of entries) {
      // bash default (dotglob off): `*` does not match a leading-dot name unless
      // the glob segment itself starts with `.`.
      if (e.startsWith('.') && !seg.startsWith('.')) continue;
      if (re.test(e) && walk(join(dir, e), i + 1, depth + 1)) return true;
    }
    return false;
  };
  return walk(path.sep, 0, 0);
}

/**
 * Protected-path check that is GLOB-AWARE. A glob/brace in a DIRECTORY component
 * would otherwise evade containment: the literal path does not exist,
 * canonicalises unchanged, and isn't under the vault. A glob operand is walked on
 * the REAL fs, following symlinks as the shell does; a brace-expanded concrete
 * path is checked directly.
 */
export function pathHitsProtected(
  rawPath: string,
  cwd: string,
  opts: ProtectedPathOptions,
): boolean {
  if (!hasGlob(rawPath)) return isProtectedPath(canonicalizePath(rawPath, cwd), opts);
  for (const pat of braceExpand(rawPath)) {
    if (!hasGlob(pat)) {
      if (isProtectedPath(canonicalizePath(pat, cwd), opts)) return true;
      continue;
    }
    const abs = path.isAbsolute(pat) ? pat : path.join(cwd, pat);
    if (globWalkHitsProtected(abs, cwd, opts)) return true;
  }
  return false;
}

export interface FileToolClassification {
  action: string;
  risk: RiskLevel | undefined;
}

/**
 * Classify a file tool call → a coding-taxonomy action (+ its risk). Every raw
 * path operand is canonicalised (symlink/`..`-resolved) before the protected
 * check, so a symlinked or `../`-escaping path to a secret is still caught.
 */
export function classifyFileToolCall(input: {
  toolName: string;
  /** Raw path operand(s) as the agent supplied them. */
  rawPaths: string[];
  /** Dina vault/state dir (may be symlinked — resolved here). */
  vaultDir: string;
  /** Working dir for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra key/credential dirs. */
  keyDirs?: string[];
}): FileToolClassification {
  const cwd = input.cwd ?? process.cwd();
  const opts: ProtectedPathOptions = {
    vaultDir: safeRealpath(input.vaultDir),
    keyDirs: (input.keyDirs ?? []).map(safeRealpath),
  };
  const anyProtected = input.rawPaths.some((raw) => pathHitsProtected(raw, cwd, opts));

  let action: string;
  if (READ_TOOLS.has(input.toolName)) {
    action = anyProtected ? 'secret_read' : 'code_read';
  } else if (anyProtected) {
    // Any write/edit tool aimed at a protected target.
    action = 'secret_write';
  } else if (WRITE_TOOLS.has(input.toolName)) {
    action = 'code_edit';
  } else {
    // NotebookEdit (writes to an external notebook host) AND any file tool this
    // classifier does not recognise: conservatively MODERATE (needs approval),
    // never a silent SAFE fall-through. The dispatcher (item 4) should only
    // route file tools here; an unrecognised name lands here as a safety net.
    action = 'code_edit_external';
  }
  return { action, risk: getDefaultRiskLevel(action) };
}
