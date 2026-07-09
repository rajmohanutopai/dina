/**
 * Log-hygiene scanner — MRS-14 (docs/E2E_TESTING.md §4.3, §7).
 *
 * The deterministic security sweep: vault content, secrets, and recovery
 * phrases must NEVER appear in server stdout logs or the browser console.
 * This is a leak check, and it stays regex/token-exact — never the judge.
 *
 * SCOPE (per §4.3): scan server logs + the browser console + unexpected
 * third-party network egress. Do NOT scan same-origin `/api/v1/*` response
 * BODIES rendered to the owner — those legitimately carry the owner's own
 * answer text ("dinosaurs", "HbA1c") and are the product working, not a
 * leak. (This module is fed only logs/console/egress, never response
 * bodies, so the scope is enforced by the call sites.)
 */

export interface HygieneViolation {
  source: string;
  kind: string;
  excerpt: string;
}

/** Seeded vault content the E2E flows write — must never reach a log. */
const VAULT_TOKENS = [
  'HbA1c',
  'blood pressure',
  'Barclays',
  'cold brew',
  'Neptune',
  'dinosaur',
];

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  // Precise, high-signal secret prefixes.
  { kind: 'google/gemini-api-key', re: /AIza[0-9A-Za-z_-]{20,}/ },
  { kind: 'openai-style-key', re: /sk-[A-Za-z0-9]{20,}/ },
  // NB: the ATProto PDS app-password SHAPE (xxxx-xxxx-xxxx-xxxx) is
  // deliberately NOT matched by regex — it false-positives on ordinary
  // hyphenated identifiers (e.g. the npm banner "home-node-lite-core").
  // To catch the actual password, capture the literal from onboarding and
  // grep for it (future enhancement); a shape match is worse than none.
];

// A 12/24-word recovery-phrase run (all-lowercase words).
const MNEMONIC_RE = /\b([a-z]+ ){11,}[a-z]+\b/;

// Any DID reference. A CONTACT's DID in a log leaks the social graph; the
// node's own DIDs are allowlisted via `ownDids`.
const DID_RE = /did:(?:plc|key):[A-Za-z0-9]+/g;

export interface ScanOptions {
  /** Return true ONLY to suppress the MNEMONIC check for a specific known
   *  line (Core's first-boot "generated master seed" dev-warning — the
   *  node's own throwaway-stack seed). It does NOT suppress the vault-token
   *  / secret / DID checks, so a real leak that happens to share the line
   *  is still caught. */
  allowMnemonicLine?: (line: string) => boolean;
  /** When provided, any `did:*` in a line that is NOT in this set is flagged
   *  as a foreign-DID (social-graph) leak. Omit to disable the DID check —
   *  e.g. single-node flows with no contacts, where every DID is the node's
   *  own. Pass the owner + node DIDs once D2D/Talk tests introduce contacts. */
  ownDids?: Set<string>;
}

/** Scan text (a log file or the browser console transcript) for leaks. */
export function scanForLeaks(
  text: string,
  source: string,
  opts: ScanOptions = {},
): HygieneViolation[] {
  const violations: HygieneViolation[] = [];
  for (const line of text.split('\n')) {
    const lower = line.toLowerCase();
    // Vault content — always checked (never allowlisted).
    for (const token of VAULT_TOKENS) {
      if (lower.includes(token.toLowerCase())) {
        violations.push({ source, kind: `vault-token:${token}`, excerpt: line.slice(0, 160) });
      }
    }
    // Secrets — always checked.
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        violations.push({ source, kind: `secret:${kind}`, excerpt: line.slice(0, 80) });
      }
    }
    // Foreign-DID (opt-in) — a contact DID leaks the social graph.
    if (opts.ownDids !== undefined) {
      for (const did of line.match(DID_RE) ?? []) {
        if (!opts.ownDids.has(did)) {
          violations.push({ source, kind: `foreign-did:${did.slice(0, 24)}`, excerpt: line.slice(0, 80) });
        }
      }
    }
    // Recovery phrase — suppressed ONLY for the known core-boot-seed line.
    if (MNEMONIC_RE.test(line) && opts.allowMnemonicLine?.(line) !== true) {
      violations.push({ source, kind: 'recovery-phrase', excerpt: line.slice(0, 40) });
    }
  }
  return violations;
}

/**
 * Core logs its own freshly-generated master-seed mnemonic once at first
 * boot (a dev-warning: "first-boot: generated master seed…"). That is the
 * node's OWN key material in a throwaway test stack, not a vault-content
 * leak — allowlist that specific line so the mnemonic sweep doesn't trip
 * on it while still catching any OTHER recovery-phrase in a log.
 */
export function isCoreBootSeedLine(line: string): boolean {
  // ONLY the Core's OWN first-boot seed dev-warning is allowlisted. That line
  // (core-server/src/boot.ts: `logger.warn({ mnemonic }, 'first-boot:
  // generated master seed; write down this mnemonic')`) is emitted by pino as a
  // single JSON object, so it carries the `"mnemonic":` field AND the
  // distinctive first-boot master-seed SOURCE MARKER together. Requiring the
  // marker — not just the field name — is the whole point: a REAL
  // recovery-phrase leak serialized as `{"mnemonic":"…"}` from any OTHER source
  // does NOT carry the first-boot/master-seed msg, so it is NOT masked here —
  // it stays flagged by the MNEMONIC sweep. (The scan runs against the fully
  // flushed log at teardown, so the whole line — field + msg — is present.)
  return (
    line.includes('"mnemonic":') &&
    line.includes('first-boot') &&
    line.includes('master seed')
  );
}

/** Hosts the browser is allowed to reach: the loopback stack + the test
 *  fleet. Anything else is unexpected egress. */
export const ALLOWED_EGRESS_HOSTS = [
  '127.0.0.1',
  'localhost',
  'test-pds.dinakernel.com',
  'test-appview.dinakernel.com',
  'test-mailbox.dinakernel.com',
  // Legitimate identity/service hosts the SPA reaches during onboarding +
  // boot (observed): the PLC directory for DID resolution, and the grants
  // service for starter-credits.
  'plc.directory',
  'test-grants.dinakernel.com',
];

export function egressHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isAllowedEgress(url: string): boolean {
  const host = egressHost(url);
  if (host === null) return true; // data:, blob:, relative — not egress
  return ALLOWED_EGRESS_HOSTS.some((a) => host === a || host.endsWith(`.${a}`));
}
