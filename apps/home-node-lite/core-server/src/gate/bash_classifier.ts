/**
 * Item 3c — Bash command classifier (Plugin Developer Surface §12.1/§12.4).
 *
 * A shell command line is Turing-complete, so we CANNOT prove what an arbitrary
 * command does. The design is therefore fail-closed and conservative:
 *
 *   1. Recognise a bounded set of known-safe / known-risky verbs and map them to
 *      coding-taxonomy actions (path-aware for file verbs, host-aware for
 *      network verbs).
 *   2. BLOCK everything we cannot verify: a parse error (unbalanced quotes),
 *      command/process substitution (`$(…)`, backticks, `<(…)`), an inline-code
 *      interpreter (`python -c`, `bash -c`, `node -e`, read-from-stdin), or a
 *      pipe INTO an interpreter (`curl … | sh`). Any of these can read a secret
 *      invisibly, so path-awareness alone cannot make them safe.
 *
 * A command line may chain several simple commands (`a && b | c ; d`). Each is
 * classified independently and the MOST dangerous result wins.
 *
 * Like the file classifier this is a framework-mediated guarantee (§16): it
 * gates the Bash tool calls Core sees; it is not an OS sandbox.
 */

import {
  canonicalizePath,
  isProtectedPath,
  pathHitsProtected,
  type ProtectedPathOptions,
} from './coding_classifier';
import { getDefaultRiskLevel, type RiskLevel } from '@dina/core';

export interface BashClassifyInput {
  command: string;
  /** Dina vault/state dir (resolved for containment). */
  vaultDir: string;
  /** Working dir for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra key/credential dirs. */
  keyDirs?: string[];
  /**
   * Hosts an unauthenticated network fetch may reach without escalating to
   * HIGH. A network verb to any other host is `network_egress_untrusted`.
   */
  allowedHosts?: string[];
}

export interface BashClassification {
  action: string;
  risk: RiskLevel | undefined;
  /** Short, PII-free explanation for the audit log. */
  reason: string;
}

const RISK_RANK: Record<RiskLevel, number> = {
  SAFE: 0,
  MODERATE: 1,
  HIGH: 2,
  BLOCKED: 3,
};

/** Prefix words that wrap a real command; skipped to find the true verb. */
const WRAPPER_PREFIXES = new Set(['command', 'nice', 'nohup', 'time', 'stdbuf', 'exec']);
/** Wrappers that ALSO escalate privilege → force system_modify. */
const PRIVILEGE_PREFIXES = new Set(['sudo', 'su', 'doas']);

/** Verbs that read file content → protected operand ⇒ secret_read. */
const READ_VERBS = new Set([
  'cat', 'tac', 'rev', 'bat', 'less', 'more', 'head', 'tail', 'nl', 'od', 'xxd',
  'hexdump', 'strings', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cut',
  'sort', 'uniq', 'comm', 'wc', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum',
  'sha512sum', 'base64', 'base32', 'basenc', 'diff', 'cmp', 'file', 'stat',
  'readlink', 'fold', 'expand', 'unexpand', 'pr', 'column', 'fmt', 'paste',
]);
/** Verbs that write/create files → protected operand ⇒ secret_write. */
const WRITE_VERBS = new Set(['touch', 'mkdir', 'tee', 'install', 'ln']);
/** Verbs that both read a source and write a dest. */
const COPY_VERBS = new Set(['cp', 'mv', 'rsync', 'dd']); // rsync/dd also below; copy wins locally
/** Destructive file verbs → HIGH (protected target ⇒ secret_write BLOCKED). */
const DESTRUCTIVE_VERBS = new Set(['rm', 'unlink', 'shred', 'srm', 'rmdir', 'truncate']);
/** Always-benign verbs (never touch secret content). */
const BENIGN_VERBS = new Set([
  'echo', 'printf', 'pwd', 'cd', 'ls', 'dir', 'true', 'false', 'test', '[',
  'which', 'type', 'whoami', 'hostname', 'uname', 'date', 'id', 'groups', 'tty',
  'clear', 'history', 'basename', 'dirname', 'realpath', 'seq', 'yes', 'sleep',
  'export', 'set', 'unset', 'alias', 'jobs', 'tput', 'env',
  // common read-only status commands (no file-content or secret access)
  'ps', 'df', 'du', 'uptime', 'free', 'printenv', 'locale', 'arch', 'nproc', 'whereis',
]);
const PACKAGE_MANAGERS = new Set([
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'gem', 'cargo', 'brew', 'apt', 'apt-get',
  'dnf', 'yum', 'composer', 'bundle', 'poetry', 'go', 'mvn', 'gradle', 'nuget',
]);
const NETWORK_VERBS = new Set([
  'curl', 'wget', 'http', 'https', 'nc', 'ncat', 'netcat', 'telnet', 'ssh',
  'scp', 'sftp', 'ftp', 'aria2c', 'httpie',
]);
const SYSTEM_VERBS = new Set([
  'chmod', 'chown', 'chgrp', 'mount', 'umount', 'launchctl', 'systemctl',
  'service', 'defaults', 'scutil', 'pfctl', 'iptables', 'nft', 'setenforce',
  'visudo', 'dscl', 'killall', 'kill', 'pkill', 'reboot', 'shutdown', 'crontab',
  'sysctl', 'passwd', 'usermod', 'dseditgroup',
]);
const DEPLOY_VERBS = new Set([
  'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform',
  'pulumi', 'ansible', 'ansible-playbook', 'aws', 'gcloud', 'az', 'vercel',
  'netlify', 'fly', 'flyctl', 'heroku', 'serverless', 'sls', 'cdk', 'eb',
]);
const INTERPRETERS = new Set([
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'sh',
  'bash', 'zsh', 'fish', 'osascript', 'rscript', 'lua', 'tclsh',
]);
/** Alternate interpreter binary names that normalise to a known interpreter. */
const INTERPRETER_ALIASES: Record<string, string> = {
  nodejs: 'node', dash: 'sh', ksh: 'sh', ash: 'sh', mksh: 'sh', pwsh: 'sh', powershell: 'sh',
};
/** Resolve a verb to a known interpreter, stripping a version suffix
 *  (`python3.11`→`python`, `ruby2.7`→`ruby`) and applying aliases. */
function interpreterName(verb: string): string | null {
  const v = verb.toLowerCase();
  if (INTERPRETERS.has(v)) return v;
  const stripped = v.replace(/[0-9]+(\.[0-9]+)*$/, '');
  if (INTERPRETERS.has(stripped)) return stripped;
  return INTERPRETER_ALIASES[v] ?? null;
}
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'fish']);
/**
 * True if an interpreter runs INLINE code (opaque → BLOCKED) given its args.
 * Flag semantics differ by interpreter, so this is interpreter-specific — the
 * generic "ends in e/c" heuristic over-fired (`bash -xe script.sh` is errexit +
 * a SCRIPT, not inline) and under-fired (perl `-E`/`-0e`, `node -p`).
 */
function hasInlineCode(interp: string, args: string[]): boolean {
  if (args.some((a) => a === '-')) return true; // read program from stdin
  if (SHELL_INTERPRETERS.has(interp)) {
    // A shell: only `-c '…'` (possibly clustered, e.g. `-ec`) is inline; a
    // trailing `-e`/`-x` is errexit/xtrace on a SCRIPT, NOT inline code.
    return args.some((a) => a === '-c' || /^-[a-zA-Z]*c$/.test(a));
  }
  if (interp === 'perl' || interp === 'ruby') {
    // -e / -E / clustered (-ne, -pe, -nE, -0e) — any cluster ending in e/E.
    return args.some((a) => /^-[a-zA-Z0-9]*[eE]$/.test(a));
  }
  if (interp === 'python') {
    return args.some((a) => a === '-c' || a === '--command');
  }
  if (interp === 'node' || interp === 'deno' || interp === 'bun') {
    // deno/bun run inline code via the `eval` SUBCOMMAND, not a flag.
    if ((interp === 'deno' || interp === 'bun') && args[0] === 'eval') return true;
    return args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print');
  }
  if (interp === 'php') {
    // php's inline-eval flag is `-r`/`-R` (NOT -e, which is debug info).
    return args.some((a) => a === '-r' || a === '-R' || a === '-F');
  }
  // lua / osascript / rscript / tclsh / … — inline via `-e` (or the generic set).
  return args.some((a) => INLINE_CODE_FLAGS.has(a) || a === '-e' || /^-[a-zA-Z0-9]*[ec]$/.test(a));
}
/** Local build/task runners that execute arbitrary project scripts. */
const BUILD_VERBS = new Set(['make', 'cmake', 'ninja', 'bazel', 'buck', 'rake', 'just', 'task']);
/** Inline-code flags that make an interpreter opaque → BLOCKED. */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--command', '-']);
/** git subcommands that rewrite/discard history or force-push → HIGH. */
const GIT_DESTRUCTIVE = new Set(['reset', 'clean', 'rebase', 'filter-branch', 'reflog', 'gc', 'prune']);

interface Tokenized {
  segments: string[][]; // each simple command as unquoted tokens
  rawSegments: string[]; // raw text of each segment (for redirect scan)
  obfuscated: boolean; // contains $( ) / backtick / <( ) / >( )
  parseError: boolean; // unbalanced quotes
}

/**
 * Split a command line into simple-command segments (on top-level `;`, `&&`,
 * `||`, `|`, `&`, newline), quote-aware, and flag any command/process
 * substitution. Fail-closed: unbalanced quotes ⇒ parseError.
 */
export function tokenizeBash(command: string): Tokenized {
  const segments: string[][] = [];
  const rawSegments: string[] = [];
  let cur: string[] = [];
  let token = '';
  let rawStart = 0;
  let quote: '"' | "'" | null = null;
  let obfuscated = false;
  const s = command;

  const pushToken = () => {
    if (token !== '') {
      cur.push(token);
      token = '';
    }
  };
  const pushSegment = (endIdx: number) => {
    pushToken();
    if (cur.length > 0) {
      segments.push(cur);
      rawSegments.push(s.slice(rawStart, endIdx));
    }
    cur = [];
    rawStart = endIdx;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === '\\' && i + 1 < s.length) {
        token += s[++i]; // escaped char inside double quotes
      } else if (quote === '"' && (c === '`' || (c === '$' && s[i + 1] === '('))) {
        obfuscated = true; // substitution is live inside double quotes
        token += c;
      } else {
        token += c;
      }
      continue;
    }
    // outside quotes
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < s.length) token += s[++i];
      continue;
    }
    if (c === '`') {
      obfuscated = true;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      obfuscated = true;
      i++;
      continue;
    }
    // ANSI-C / locale quoting: `$'\x2f…'` and `$"…"` interpret escapes, which
    // can hide path separators from the classifier — treat as unverifiable.
    if (c === '$' && (s[i + 1] === "'" || s[i + 1] === '"')) {
      obfuscated = true;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      obfuscated = true; // process substitution
      i++;
      continue;
    }
    // control operators → segment boundary
    if (c === ';' || c === '\n') {
      pushSegment(i);
      rawStart = i + 1;
      continue;
    }
    if (c === '&') {
      // `>&`, `<&` (fd-dup / redirect-both) and `&>` are REDIRECTS, not control
      // operators — keep the `&` glued so redirectTargets can see the whole
      // operator (a real shell writes both streams for `>&file`).
      const prevCh = token.length > 0 ? token[token.length - 1] : '';
      if (prevCh === '>' || prevCh === '<' || s[i + 1] === '>') {
        token += c;
        continue;
      }
      const two = s[i + 1] === '&'; // &&
      pushSegment(i);
      i += two ? 1 : 0;
      rawStart = i + 1;
      continue;
    }
    if (c === '|') {
      // `>|` is a noclobber-override REDIRECT, not a pipe — keep it glued.
      if (token.length > 0 && token[token.length - 1] === '>') {
        token += c;
        continue;
      }
      const two = s[i + 1] === '|'; // ||
      pushSegment(i);
      i += two ? 1 : 0;
      rawStart = i + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushToken();
      continue;
    }
    token += c;
  }
  pushSegment(s.length);

  return { segments, rawSegments, obfuscated, parseError: quote !== null };
}

/** Strip a leading `FOO=bar` env-assignment run and wrapper prefixes. */
function unwrapVerb(tokens: string[]): { verb: string | null; args: string[]; privileged: boolean } {
  let i = 0;
  let privileged = false;
  // env assignments: FOO=bar ...
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  // wrapper prefixes (sudo / env / nice / …), possibly repeated
  for (;;) {
    const t = tokens[i];
    if (t === undefined) break;
    const b = basename(t);
    if (PRIVILEGE_PREFIXES.has(b)) {
      privileged = true;
      i++;
      // `sudo -u user cmd` — skip option flags following sudo
      while (i < tokens.length && tokens[i].startsWith('-')) i += tokens[i] === '-u' || tokens[i] === '--user' ? 2 : 1;
      continue;
    }
    if (WRAPPER_PREFIXES.has(b) || b === 'env') {
      i++;
      // env may carry FOO=bar before the real command
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
      continue;
    }
    break;
  }
  const verb = tokens[i] !== undefined ? basename(tokens[i]) : null;
  return { verb, args: tokens.slice(i + 1), privileged };
}

function basename(p: string): string {
  const cleaned = p.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Non-flag positional arguments that look like file paths. */
function pathArgs(args: string[]): string[] {
  return args.filter((a) => a !== '' && !a.startsWith('-'));
}

/** The value glued after a value-taking short flag inside a single-dash CLUSTER
 *  (`-aF.env` → `.env` for letters='F'), or null. getopt attaches the value to
 *  the LAST value-taking flag in the cluster. */
function clusteredFlagValue(token: string, letters: string): string | null {
  if (!token.startsWith('-') || token.startsWith('--')) return null;
  const m = token.match(new RegExp(`^-[a-zA-Z]*[${letters}](.+)$`));
  return m ? m[1] : null;
}

/** Values supplied to the given flags — separate (`-o F`), attached (`-oF`), or
 *  `--flag=F`. Only for flags whose value is genuinely a FILE (e.g. `sort -o`). */
function flagValues(args: string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const f of flags) {
      if (a === f) {
        if (args[i + 1] !== undefined) out.push(args[i + 1]);
      } else if (f.startsWith('--') && a.startsWith(f + '=')) {
        out.push(a.slice(f.length + 1));
      } else if (!f.startsWith('--') && a.startsWith(f) && a.length > f.length) {
        out.push(a.slice(f.length));
      }
    }
  }
  return out;
}

/** Verbs whose FIRST non-flag arg is a pattern/program, not a path. */
const PATTERN_FIRST_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'nawk', 'mawk']);

/** Unambiguous secret FILENAMES. Common words (keyfile/credentials) are omitted. */
const SECRET_NAMES_SRC =
  String.raw`\.env\b|\.npmrc\b|\.netrc\b|\.pgpass\b|\.git-credentials\b|\.pypirc\b|\.dockercfg\b|id_(?:rsa|ed25519|ecdsa|dsa)\b|wrapped_seed|recovery-phrase|pds_identity|authorized_keys`;
/** A secret name inside a QUOTED string (awk `ARGV[1]="…"`, `getline < "…"`). */
const SECRET_QUOTED = new RegExp(`["'][^"']*(?:${SECRET_NAMES_SRC})`, 'i');
/** A secret name read/written by a sed `r`/`w`/`R`/`W` file command. The `r`/`w`
 *  must be at a COMMAND boundary (program start / after `;{}`/space) OR glued to
 *  a `-…e` flag cluster (`-ne'r.env'` → `-ner.env`); `\s*` allows a glued
 *  filename (`sed 'r.env'`, BSD sed). This anchoring means a mere mention inside
 *  a substitution (`s/.npmrc/X/`) or a filename like `four.env` does NOT match. */
const SECRET_SED_RW = new RegExp(
  `(?:(?:^|[;{}\\s])|-[a-zA-Z]*[eE])[rRwW]\\s*\\S*(?:${SECRET_NAMES_SRC})`,
  'i',
);

/** Awk/sed program-source flags whose VALUE is a program (`-e prog`). */
const AWK_SED_PROG_FLAGS = new Set(['-e', '--source', '--expression', '--program']);
/** Awk/sed flags whose following VALUE is NOT a program (`-v var=val`, `-F sep`). */
const AWK_SED_VALUE_FLAGS = new Set(['-v', '--assign', '-F', '--field-separator', '--characters-as-bytes']);

/**
 * Collect every inspectable program string from an awk/sed arg list — all
 * `-e`/`--expression` values plus the first positional (only when no `-e`/`-f`),
 * skipping `-v var=val` values. `fromFile` is true if a `-f progfile` external
 * (non-inspectable) script is used.
 */
function awkSedPrograms(args: string[]): { progs: string[]; files: string[]; fromFile: boolean } {
  const progs: string[] = [];
  const files: string[] = [];
  let sawExplicit = false;
  let fromFile = false;
  let tookPositional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (AWK_SED_PROG_FLAGS.has(a)) {
      if (args[i + 1] !== undefined) progs.push(args[i + 1]);
      sawExplicit = true;
      i++;
    } else if (a.startsWith('-e') && a.length > 2) {
      progs.push(a.slice(2));
      sawExplicit = true;
    } else if (a === '-f' || a === '--file') {
      fromFile = true;
      sawExplicit = true;
      i++;
    } else if (a.startsWith('-f') && a.length > 2) {
      fromFile = true;
      sawExplicit = true;
    } else if (AWK_SED_VALUE_FLAGS.has(a)) {
      i++; // skip the value — it is neither a program nor a file
    } else if (!a.startsWith('-')) {
      if (!sawExplicit && !tookPositional) {
        progs.push(a); // the first positional is the program (when no -e/-f)
        tookPositional = true;
      } else {
        files.push(a); // subsequent positionals are data FILES
      }
    }
  }
  return { progs, files, fromFile };
}

const GREP_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

/**
 * The FILES a grep-family invocation reads: `-f`/`--file` PATTERN-files (grep
 * reads them too) + the positional search files. The leading positional is the
 * search PATTERN — and dropped — ONLY when no pattern flag supplied it. A
 * separate `-e PATTERN` / `--regexp PATTERN` value is a pattern, not a file, and
 * is skipped (audit: `grep --regexp=. .env` must keep `.env`; `grep -e creds x`
 * must NOT flag `creds`).
 */
function grepFiles(args: string[]): string[] {
  const patternFiles: string[] = [];
  const positionals: string[] = [];
  let patternFromFlag = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--regexp') {
      patternFromFlag = true;
      i++; // skip the pattern VALUE
    } else if ((a.startsWith('-e') && a.length > 2) || a.startsWith('--regexp=')) {
      patternFromFlag = true; // attached pattern
    } else if (a === '-f' || a === '--file') {
      patternFromFlag = true;
      if (args[i + 1] !== undefined) patternFiles.push(args[i + 1]); // -f FILE is READ
      i++;
    } else if (a.startsWith('-f') && a.length > 2) {
      patternFromFlag = true;
      patternFiles.push(a.slice(2));
    } else if (a.startsWith('--file=')) {
      patternFromFlag = true;
      patternFiles.push(a.slice('--file='.length));
    } else if (!a.startsWith('-')) {
      positionals.push(a);
    }
  }
  const search = patternFromFlag ? positionals : positionals.slice(1);
  return [...patternFiles, ...search];
}

/** Path operands of a verb — the FILE arguments, excluding the pattern/program
 *  and (for awk/sed) `-v`/`-e`/`-f` values. */
function operandPathArgs(verb: string, args: string[]): string[] {
  if (verb === 'awk' || verb === 'gawk' || verb === 'nawk' || verb === 'mawk' || verb === 'sed') {
    return awkSedPrograms(args).files;
  }
  if (GREP_VERBS.has(verb)) return grepFiles(args);
  const nonFlag = pathArgs(args);
  return PATTERN_FIRST_VERBS.has(verb) && nonFlag.length > 0 ? nonFlag.slice(1) : nonFlag;
}

/** True if any arg carries an unexpanded shell variable ($VAR or ${VAR}). */
function hasVar(...args: string[]): boolean {
  return args.some((a) => /\$\{?[A-Za-z_]/.test(a));
}

/** A string worth a protected-path check: has a separator (a real path), so a
 *  bare word like a `grep` pattern (`keyfile`, `credentials`) isn't scanned. */
function looksLikePath(s: string): boolean {
  return s.includes('/') || s.startsWith('~');
}

/**
 * Candidate PATH-LIKE strings inside a single token, for the verb-agnostic scan:
 * the token itself, plus what follows a `KEY=` (dd `if=/of=`, `--output=`) and/or
 * an `@` (curl/httpie `@file`, `name@file`, `name=@file`). Only path-like
 * candidates are returned, so a bare word never trips the scan.
 */
function candidateOperandPaths(token: string): string[] {
  const out: string[] = [];
  // The bare token is only treated as a path if it has a separator — so a plain
  // word (a grep pattern like `credentials`) isn't scanned.
  if (looksLikePath(token)) out.push(token);
  // The value AFTER `=` (dd `if=FILE`/`of=FILE`, `--output=FILE`) or `@`
  // (curl/httpie `@FILE`, `name@FILE`) IS an operand file — always check it,
  // even a bare basename (`dd if=.env`), which the path nets would otherwise miss.
  const eq = token.indexOf('=');
  if (eq >= 0 && eq < token.length - 1) out.push(token.slice(eq + 1));
  const at = token.indexOf('@');
  if (at >= 0 && at < token.length - 1) out.push(token.slice(at + 1));
  return out.filter((p) => p.length > 0);
}

/**
 * Redirect targets in a raw segment (both `>`/`>>` writes and `<` reads).
 *
 * The operator is matched WITHOUT requiring leading whitespace, so a redirect
 * glued to the previous token (`cat -</vault/keyfile`, `echo pwn>/vault/keyfile`)
 * is caught — a real shell treats those as redirections. `(?![(<])` skips
 * process substitution `>(`/`<(` (already flagged obfuscated) and `<<`
 * here-docs; the target excludes redirect/control metacharacters.
 */
function redirectTargets(raw: string): { writes: string[]; reads: string[] } {
  const writes: string[] = [];
  const reads: string[] = [];
  // Leading `\d+` (fd) or `&` (`&>`), operator, optional `&` (`>&`, `<&`), then
  // the target. `(?![(<])` skips process substitution `>(`/`<(`.
  const re = /(?:\d+|&)?(>>?|<)[&|]?(?![(<])\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const target = m[2].replace(/^['"]|['"]$/g, '');
    // A digit or `-` target is a file-descriptor dup/close (`2>&1`, `>&-`),
    // not a file — never a redirect to a path.
    if (target === '' || /^\d+$|^-$/.test(target)) continue;
    if (m[1] === '<') reads.push(target);
    else writes.push(target);
  }
  return { writes, reads };
}

function worse(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/**
 * Classify a whole Bash command line → the most dangerous coding action across
 * its simple commands (+ risk + a PII-free reason).
 */
export function classifyBashCommand(input: BashClassifyInput): BashClassification {
  const cmd = input.command.trim();
  if (cmd === '') return blocked('empty command');

  const tok = tokenizeBash(cmd);
  if (tok.parseError) return blocked('unparseable (unbalanced quotes)');
  if (tok.obfuscated) return blocked('command/process substitution — cannot verify what it reads');
  // `$IFS` (or `${IFS}`) is a field-splitting obfuscation: it glues a verb to
  // its path so the tokenizer can't separate them. Never legitimate in a coding
  // command — fail closed.
  if (/\$\{?IFS\b/.test(cmd)) return blocked('$IFS field-splitting — cannot verify');

  const cwd = input.cwd ?? process.cwd();
  const opts: ProtectedPathOptions = {
    vaultDir: safe(input.vaultDir),
    keyDirs: (input.keyDirs ?? []).map(safe),
  };
  // Glob-aware: a glob/brace operand is expanded on the real fs so a metachar in
  // a directory component (`/vault-parent/vau*​/keyfile`) can't hide a vault path.
  const anyProtected = (paths: string[]): boolean =>
    paths.some((p) => pathHitsProtected(p, cwd, opts));

  // Global redirect scan across the WHOLE command — catches a redirect even if
  // segment splitting ever strands the operator from its target.
  const gr = redirectTargets(cmd);
  if (anyProtected(gr.writes)) return { action: 'secret_write', risk: 'BLOCKED', reason: 'redirect writes a protected path' };
  if (anyProtected(gr.reads)) return { action: 'secret_read', risk: 'BLOCKED', reason: 'redirect reads a protected path' };
  if (gr.writes.some((w) => hasVar(w)) || gr.reads.some((r) => hasVar(r)))
    return { action: 'secret_write', risk: 'BLOCKED', reason: 'redirect to a variable-expanded path' };

  // Per-verb classification first, so a verb the table understands keeps its
  // precise label (rm → secret_write, sed -i → secret_write, …).
  const results: Array<{ action: string; risk: RiskLevel; reason: string }> = [];
  for (let si = 0; si < tok.segments.length; si++) {
    const seg = classifySegment(tok.segments[si], tok.rawSegments[si] ?? '', input, anyProtected);
    results.push(seg);
    if (seg.risk === 'BLOCKED') break; // BLOCKED already dominates
  }
  let winner = results[0];
  for (const r of results) if (RISK_RANK[r.risk] >= RISK_RANK[winner.risk]) winner = r;
  if (winner.risk === 'BLOCKED') return { action: winner.action, risk: winner.risk, reason: winner.reason };

  // VERB-AGNOSTIC net for what the per-verb table MISSED — scan every token
  // (stripping operand prefixes like `if=`, `of=`, `@`, `name=@`, `--output=`)
  // for a protected path, whatever the verb (dd `if=/of=`, curl `-o/--output`,
  // tar `-f`, httpie `field@file`, any future verb).
  for (const seg of tok.segments) {
    for (const t of seg) {
      if (anyProtected(candidateOperandPaths(t)))
        return { action: 'secret_read', risk: 'BLOCKED', reason: 'command references a protected path' };
    }
  }
  // Last net: a protected path embedded in a quoted program/arg the tokenizer
  // kept whole — if the canonical vault dir appears anywhere, BLOCK.
  if (opts.vaultDir && cmd.toLowerCase().includes(opts.vaultDir.toLowerCase()))
    return { action: 'secret_read', risk: 'BLOCKED', reason: 'command references the vault directory' };

  return { action: winner.action, risk: winner.risk, reason: winner.reason };

  function safe(p: string): string {
    try {
      // realpath via coding_classifier's canonicalize (handles missing dirs)
      return canonicalizePath(p, cwd);
    } catch {
      return p;
    }
  }
}

function classifySegment(
  tokens: string[],
  raw: string,
  input: BashClassifyInput,
  anyProtected: (paths: string[]) => boolean,
): { action: string; risk: RiskLevel; reason: string } {
  // Env-dump commands disclose process secrets (API tokens, signing keys, cloud
  // creds) with no filesystem read (audit). `printenv` (any), and a BARE
  // `env`/`set`/`export`/`declare`/`typeset` (no command / no assignment) dump
  // the environment → treat as a secret read. `env FOO=bar cmd` (a wrapper) and
  // `set -e` / `export FOO=bar` (options/assignments) are NOT dumps and fall
  // through. Runs before unwrapVerb (which would consume a leading `env`).
  {
    const firstReal = tokens.find((t) => t !== '' && !/^[A-Za-z_]\w*=/.test(t) && !t.startsWith('-'));
    const dv = firstReal ? basename(firstReal) : '';
    if (dv === 'printenv') return mk('secret_read', 'printenv discloses environment secrets', 'BLOCKED');
    if (dv === 'env' || dv === 'set' || dv === 'export' || dv === 'declare' || dv === 'typeset') {
      const rest = tokens.slice(tokens.indexOf(firstReal as string) + 1).filter((t) => t !== '');
      const hasCommand = rest.some((t) => !t.startsWith('-') && !/^[A-Za-z_]\w*=/.test(t));
      const hasAssignment = rest.some((t) => /^[A-Za-z_]\w*=/.test(t));
      // `env` dumps unless it wraps a command; the shell builtins
      // (`set`/`export`/`declare`/`typeset`) dump only in their BARE form —
      // `set -e` (errexit) and `export FOO=bar` are options/assignments, not dumps.
      const dumps = dv === 'env' ? !hasCommand && !hasAssignment : rest.length === 0;
      if (dumps) return mk('secret_read', `${dv} discloses environment secrets`, 'BLOCKED');
    }
  }

  const { verb, args, privileged } = unwrapVerb(tokens);
  if (verb === null) return mk('code_read', 'no command');

  // Redirect targets always count, regardless of verb.
  const redir = redirectTargets(raw);
  if (anyProtected(redir.writes)) return mk('secret_write', `redirect writes a protected path`);
  if (anyProtected(redir.reads)) return mk('secret_read', `redirect reads a protected path`);
  // A redirect target we cannot resolve (variable expansion) — indirect write/read.
  if (redir.writes.some((w) => hasVar(w)) || redir.reads.some((r) => hasVar(r)))
    return mk('secret_write', 'redirect to a variable-expanded path — cannot verify', 'BLOCKED');

  if (privileged) return mk('system_modify', `privileged (sudo) — ${verb}`);

  // Indirection guard: a path operand with an unexpanded shell variable ($VAR /
  // ${VAR}) cannot be resolved to a concrete path, so a secret-capable verb
  // (read / in-place edit / copy / write / destroy) could touch a protected
  // path we cannot see. Per §12.4 "indirect path-bearing → BLOCKED".
  // Only the PATH operands count for indirection — for a pattern-first verb
  // (grep/sed/awk) the first non-flag arg is the search pattern/program, not a
  // path, so a `$VAR` there must NOT trip the guard (`grep "$PATTERN" file`).
  const indirect = hasVar(...operandPathArgs(verb, args));
  const SECRET_CAPABLE =
    READ_VERBS.has(verb) ||
    COPY_VERBS.has(verb) ||
    WRITE_VERBS.has(verb) ||
    DESTRUCTIVE_VERBS.has(verb) ||
    verb === 'sed' ||
    verb === 'awk' ||
    verb === 'find';
  if (indirect && SECRET_CAPABLE)
    return mk('secret_read', `${verb} on a variable-expanded path — cannot verify`, 'BLOCKED');

  // Interpreters: inline code / stdin ⇒ opaque ⇒ BLOCKED; script file ⇒ MODERATE.
  // Resolve versioned/aliased names (python3.11, nodejs, dash, perl -pe …).
  const interp = interpreterName(verb);
  if (interp !== null) {
    if (hasInlineCode(interp, args) || args.length === 0) {
      return mk('secret_read', `interpreter inline code / stdin (${verb}) — opaque`, 'BLOCKED');
    }
    if (anyProtected(pathArgs(args))) return mk('secret_read', `${verb} reads a protected file`);
    return mk('code_edit_external', `runs a local script via ${verb}`);
  }

  if (BENIGN_VERBS.has(verb)) return mk('code_read', verb);

  if (READ_VERBS.has(verb)) {
    // `sort -o FILE` WRITES its output — the attached form `-o.env` (no space/`=`)
    // slips pathArgs/candidateOperandPaths, so check the output target (audit).
    if (verb === 'sort' && anyProtected(flagValues(args, ['-o', '--output'])))
      return mk('secret_write', `sort -o writes a protected path`, 'BLOCKED');
    // operandPathArgs drops the leading pattern for grep/rg/etc — a `$VAR` or a
    // secret-looking WORD in the search pattern is not a file operand.
    return anyProtected(operandPathArgs(verb, args))
      ? mk('secret_read', `${verb} reads a protected path`)
      : mk('code_read', verb);
  }
  if (verb === 'sed' || verb === 'awk' || verb === 'gawk' || verb === 'nawk' || verb === 'mawk') {
    // Rather than perfectly parse awk/sed getopt (which repeatedly leaked —
    // `-v`-hidden, second `-e`, `--source=`, clustered `-ne<prog>`), scan ALL
    // args joined. A shell `|` is a SEGMENT boundary, so a `|` inside this
    // segment is genuinely an awk in-program pipe (exec), and any program text
    // — wherever getopt tucked it — is covered. Fail closed on the opaque /
    // exec / secret-file constructs.
    const joined = args.join(' ');
    const awkFamily = verb !== 'sed';
    const awkOpaque = awkFamily && /system\s*\(|getline|\|/.test(joined);
    // sed `e` execute: a standalone `e` command, OR an `s///…e…` flag. The
    // s-command bodies use a TEMPERED dot `(?!\1).` so they can't swallow the
    // delimiter — otherwise the flag scan runs past the command into a filename
    // (e.g. `.../keyfil` + `e`) and spuriously matches.
    const sedExec =
      verb === 'sed' &&
      // standalone `e` execute — possibly after an ADDRESS (`1e`, `$e`, `/re/e`,
      // `1,3e`), so digits / `$` / `/` / `,` may precede it, not just a boundary.
      (/(^|[;}\n\s\d$/,])e(\s|;|$)/.test(joined) ||
        /s([^\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-z0-9]*e/.test(joined));
    // A secret file referenced INSIDE the program (awk ARGV/getline in quotes,
    // sed `r`/`w`) — NOT a mere mention in a substitution pattern.
    const secretRef = SECRET_QUOTED.test(joined) || (verb === 'sed' && SECRET_SED_RW.test(joined));
    if (awkOpaque || sedExec || secretRef)
      return mk('secret_read', `${verb} inline exec / secret-file read — opaque`, 'BLOCKED');
    // `-f`/`--file` (any spelling) = an external script we can't inspect → MODERATE.
    if (args.some((a) => a === '-f' || a === '--file' || (a.startsWith('-f') && a.length > 2) || a.startsWith('--file=')))
      return mk('code_edit_external', `${verb} -f external script`, 'MODERATE');

    const inPlace = args.some((a) => a === '-i' || a.startsWith('-i'));
    // Protected FILE operands are also caught by the global token-scan net; this
    // keeps the precise read/write label for the common case.
    const files = operandPathArgs(verb, args);
    if (anyProtected(files)) return mk(inPlace ? 'secret_write' : 'secret_read', `${verb} on a protected path`);
    return inPlace ? mk('code_edit', `${verb} -i`) : mk('code_read', verb);
  }
  if (WRITE_VERBS.has(verb)) {
    return anyProtected(pathArgs(args))
      ? mk('secret_write', `${verb} targets a protected path`)
      : mk('code_edit', verb);
  }
  if (COPY_VERBS.has(verb)) {
    const files = pathArgs(args);
    if (anyProtected(files)) return mk('secret_read', `${verb} touches a protected path`);
    // rsync/scp can be network — handled by NETWORK when host-like arg present
    if (files.some(looksRemote)) return networkResult(verb, files, input);
    return mk('code_edit', verb);
  }
  if (DESTRUCTIVE_VERBS.has(verb)) {
    return anyProtected(pathArgs(args))
      ? mk('secret_write', `${verb} would destroy a protected path`)
      : mk('fs_destructive', verb, 'HIGH');
  }
  if (verb === 'find') {
    if (args.some((a) => a === '-exec' || a === '-execdir' || a === '-ok'))
      return mk('code_edit_external', 'find -exec runs arbitrary commands', 'MODERATE');
    if (args.some((a) => a === '-delete')) return mk('fs_destructive', 'find -delete', 'HIGH');
    return anyProtected(pathArgs(args)) ? mk('secret_read', 'find over a protected path') : mk('code_read', 'find');
  }

  if (verb === 'git' || verb === 'hg' || verb === 'svn') {
    // A VCS subcommand can READ/WRITE a protected file operand (`git diff
    // --no-index /dev/null .env`, `git show HEAD:.env`, `git hash-object .env`,
    // `git mv .env x`) — the operand check every other file verb does was
    // missing (audit). Operands can be paths OR `rev:path`/`rev..rev` — check
    // every split component + the whole token.
    const operands: string[] = [];
    for (const a of args.slice(1).filter((x) => !x.startsWith('-'))) {
      operands.push(a, ...a.split(/[:]|\.\./));
    }
    // git file-bearing flags READ a file: `-F/--file` (commit/tag message file —
    // `git commit -F.env` stores .env as the message), `-o/--output`, grep `-f`.
    // The attached short form (`-F.env`) starts with `-`, so the filter above
    // dropped it (audit). flagValues covers attached/separate/`--flag=`;
    // clusteredFlagValue covers a value glued after a flag cluster (`-aF.env`).
    operands.push(...flagValues(args, ['-F', '--file', '-o', '--output', '-f']));
    for (const a of args) {
      const v = clusteredFlagValue(a, 'Fof');
      if (v) operands.push(v);
    }
    // Only a CONCRETE protected operand blocks — a git operand is often a branch
    // or revision, incl. a `$VAR` branch (`git checkout $BRANCH`), so an
    // indirection check here would over-block the common case.
    if (anyProtected(operands)) return mk('secret_read', `${verb} touches a protected path`, 'BLOCKED');
    return classifyVcs(verb, args);
  }

  if (PACKAGE_MANAGERS.has(verb)) return classifyPackage(verb, args, input, anyProtected);

  if (NETWORK_VERBS.has(verb)) {
    const uploads = uploadPaths(args);
    if (verb === 'scp' || verb === 'rsync' || verb === 'sftp') {
      // local (non-remote) positional args are upload sources.
      for (const a of pathArgs(args)) if (!looksRemote(a)) uploads.push(a);
    }
    if (anyProtected(uploads) || uploads.some((u) => hasVar(u)))
      return mk('secret_read', `${verb} would upload a protected/indirect file`, 'BLOCKED');
    return networkResult(verb, args, input);
  }

  if (SYSTEM_VERBS.has(verb)) return mk('system_modify', verb, 'HIGH');
  if (DEPLOY_VERBS.has(verb)) return mk('deploy', verb, 'HIGH');
  if (BUILD_VERBS.has(verb)) return mk('code_edit_external', `runs a build/task runner (${verb})`, 'MODERATE');

  // Unknown verb (a local binary/script) — could do anything: conservative MODERATE.
  return mk('code_edit_external', `unrecognised command (${verb})`, 'MODERATE');

  function mk(action: string, reason: string, forced?: RiskLevel): { action: string; risk: RiskLevel; reason: string } {
    const risk = forced ?? (getDefaultRiskLevel(action) as RiskLevel);
    return { action, risk, reason };
  }
}

function classifyVcs(
  verb: string,
  args: string[],
): { action: string; risk: RiskLevel; reason: string } {
  const sub = args.find((a) => !a.startsWith('-'));
  const rest = args;
  if (verb === 'git') {
    if (sub === 'push') {
      const forced = rest.some((a) => a === '-f' || a === '--force' || a.startsWith('--force-with-lease'));
      return forced
        ? { action: 'vcs_destructive', risk: 'HIGH', reason: 'git push --force' }
        : { action: 'vcs_push', risk: 'MODERATE', reason: 'git push' };
    }
    if (sub && GIT_DESTRUCTIVE.has(sub)) {
      // `git reset --hard`, `git clean -f`, `git rebase`, filter-branch, reflog, gc/prune
      if (sub === 'reset' && !rest.some((a) => a === '--hard' || a === '--keep' || a === '--merge')) {
        return { action: 'vcs_local', risk: 'SAFE', reason: 'git reset (soft/mixed)' };
      }
      return { action: 'vcs_destructive', risk: 'HIGH', reason: `git ${sub}` };
    }
    if (sub === 'checkout' || sub === 'restore' || sub === 'switch') {
      // `git checkout -- .` / `git restore .` discard working-tree changes
      if (rest.some((a) => a === '--' || a === '.') || sub === 'restore')
        return { action: 'vcs_destructive', risk: 'HIGH', reason: `git ${sub} (discards changes)` };
    }
    if (sub === 'remote' || sub === 'config') {
      // `git config`/`git remote add` can rewrite repo config → MODERATE
      return { action: 'code_edit_external', risk: 'MODERATE', reason: `git ${sub}` };
    }
  }
  // status/diff/log/add/commit/stash/branch/fetch/pull/clone/merge/tag → local
  return { action: 'vcs_local', risk: 'SAFE', reason: `${verb} ${sub ?? ''}`.trim() };
}

function classifyPackage(
  verb: string,
  args: string[],
  input: BashClassifyInput,
  anyProtected: (p: string[]) => boolean,
): { action: string; risk: RiskLevel; reason: string } {
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  // A file OPERAND (pip `install -r .env`, `bundle exec cat .env`) that resolves
  // to a protected path → BLOCK, like every other file-touching verb (audit).
  if (anyProtected(pathArgs(args)))
    return { action: 'secret_read', risk: 'BLOCKED', reason: `${verb} touches a protected path` };
  const INSTALL = new Set(['install', 'i', 'add', 'ci', 'get', 'update', 'upgrade', 'remove', 'uninstall', 'rm', 'sync']);
  const PUBLISH = new Set(['publish', 'push', 'release', 'deploy']);
  // RUNNER subcommands run arbitrary project/build code (build.rs, Rakefile,
  // an exec'd command) → MODERATE for EVERY manager, not just npm/go (audit:
  // `cargo run`, `bundle exec`, `poetry run` were falling through to SAFE).
  const RUNNERS = new Set(['run', 'exec', 'test', 'start', 'dlx', 'build', 'bench', 'watch', 'tauri']);
  if (PUBLISH.has(sub)) return { action: 'deploy', risk: 'HIGH', reason: `${verb} ${sub}` };
  if (INSTALL.has(sub)) return { action: 'package_install', risk: 'MODERATE', reason: `${verb} ${sub}` };
  if (RUNNERS.has(sub)) return { action: 'code_edit_external', risk: 'MODERATE', reason: `${verb} ${sub} (runs code)` };
  // bare `npm`, `npm ls`, `pip list`, `cargo --version` → benign read
  return { action: 'code_read', risk: 'SAFE', reason: `${verb} ${sub}`.trim() };
}

function looksRemote(arg: string): boolean {
  return /^[^/\s]+@[^/\s]+:/.test(arg) || /^(ssh|scp|rsync|https?|ftp):\/\//.test(arg);
}

/** Flags whose value is a RAW file path (no `@`): `curl -T file`. */
const RAW_PATH_FLAGS = new Set(['-T', '--upload-file']);
/** Flags whose value carries a file via `@` (`@file` or `name@file`/`name=@file`). */
const AT_FILE_FLAGS = new Set([
  '-d', '--data', '--data-binary', '--data-ascii', '--data-raw', '--data-urlencode',
  '-F', '--form', '--form-string',
]);

/** The file a data/form/upload flag value references, or null (inline data). */
function uploadFileOf(flag: string, value: string): string | null {
  if (RAW_PATH_FLAGS.has(flag)) return value; // -T / --upload-file: raw path
  const at = value.indexOf('@'); // -d/-F/--data-urlencode: `@file` or `name@file`
  return at >= 0 ? value.slice(at + 1) : null;
}

/** Paths a network verb would upload — every curl/wget file-read form. */
function uploadPaths(args: string[]): string[] {
  const out: string[] = [];
  const push = (f: string | null) => {
    if (f) out.push(f);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((RAW_PATH_FLAGS.has(a) || AT_FILE_FLAGS.has(a)) && args[i + 1] !== undefined) {
      push(uploadFileOf(a, args[i + 1])); // exact flag + separate value
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0 && a.startsWith('--')) {
      const flag = a.slice(0, eq); // `--data-binary=@file`, `--upload-file=file`
      if (RAW_PATH_FLAGS.has(flag) || AT_FILE_FLAGS.has(flag)) {
        push(uploadFileOf(flag, a.slice(eq + 1)));
        continue;
      }
    }
    if (a.startsWith('-T') && a.length > 2) {
      out.push(a.slice(2)); // attached `-Tfile`
    } else if ((a.startsWith('-d') || a.startsWith('-F')) && a.length > 2) {
      push(uploadFileOf('-d', a.slice(2))); // attached `-d@file` / `-Fname=@file`
    } else if (a.startsWith('@')) {
      out.push(a.slice(1)); // bare `@file`
    }
  }
  return out;
}

function networkResult(
  verb: string,
  args: string[],
  input: BashClassifyInput,
): { action: string; risk: RiskLevel; reason: string } {
  const hosts = extractHosts(args);
  const allow = new Set((input.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const allTrusted = hosts.length > 0 && hosts.every((h) => allow.has(h));
  if (allTrusted) return { action: 'network_egress', risk: 'MODERATE', reason: `${verb} → allowlisted host` };
  return { action: 'network_egress_untrusted', risk: 'HIGH', reason: `${verb} → non-allowlisted host` };
}

function extractHosts(args: string[]): string[] {
  const hosts: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? a : `scheme://${a}`;
    try {
      hosts.push(new URL(url).hostname.toLowerCase());
    } catch {
      const at = a.includes('@') ? a.split('@')[1] : a;
      const host = at.split(/[:/]/)[0];
      if (host) hosts.push(host.toLowerCase());
    }
  }
  return hosts;
}

function blocked(reason: string): BashClassification {
  return { action: 'secret_read', risk: 'BLOCKED', reason };
}
