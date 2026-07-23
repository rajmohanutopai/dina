/**
 * Item 3e — the gate decision (composes 3a–3d) + classification-only mode.
 *
 * `gateToolCall` is the single entry point a coding-agent hook calls. It:
 *   1. dispatches the raw tool call to the right classifier —
 *      Bash → bash_classifier (3c); a file tool → coding_classifier (3b);
 *      a network tool → host-allowlist; anything else → conservative MODERATE;
 *   2. turns the risk into an outcome (SAFE→allow, MODERATE/HIGH→approval,
 *      BLOCKED→deny);
 *   3. in `enforce` mode, mints a payload-bound single-use permit (3d) for an
 *      allowed call, and leaves approval/deny for the owner-approval path;
 *   4. in `classify_only` mode, returns the SAME classification but enforces
 *      nothing (no permit, no block) — the advisory/observability conformance
 *      class, where the hook reports intent but Core is not the hard gate.
 *
 * The two modes map to the two conformance classes (item 4): an enforcing host
 * and a classification-only host see identical `action`/`risk`; only `enforced`
 * and whether a permit is issued differ.
 */

import {
  classifyFileToolCall,
  isProtectedPath,
  canonicalizePath,
  type ProtectedPathOptions,
} from './coding_classifier';
import { classifyBashCommand } from './bash_classifier';
import { PermitStore, hashPayload, type PermitRecord, type ToolPayload } from './permit';
import { getDefaultRiskLevel, type RiskLevel } from '@dina/core';

export type GateMode = 'enforce' | 'classify_only';
export type GateOutcome = 'allow' | 'approval_required' | 'deny';

/** Structured tools whose path operands live in known input fields. */
const FILE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Cat']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

export interface GateInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  agentDid: string;
  sessionId: string;
  vaultDir: string;
  cwd?: string;
  keyDirs?: string[];
  allowedHosts?: string[];
  mode: GateMode;
}

export interface GateDecision {
  mode: GateMode;
  action: string;
  risk: RiskLevel;
  outcome: GateOutcome;
  /** true in enforce mode (Core acted on the decision); false in classify_only. */
  enforced: boolean;
  /** Minted only for an allowed call in enforce mode. */
  permit?: PermitRecord;
  /** SHA-256 of the exact `(tool, input)` payload — present in enforce mode. */
  payloadHash?: string;
  reason: string;
}

function riskToOutcome(risk: RiskLevel): GateOutcome {
  if (risk === 'SAFE') return 'allow';
  if (risk === 'BLOCKED') return 'deny';
  return 'approval_required'; // MODERATE / HIGH
}

/** Target file paths named inside an `apply_patch` patch body. */
function applyPatchTargets(input: Record<string, unknown>): string[] {
  const patch =
    typeof input.input === 'string'
      ? input.input
      : typeof input.patch === 'string'
        ? input.patch
        : '';
  if (patch === '') return [];
  const out: string[] = [];
  // `*** Add File: p` / `Update File: p` / `Delete File: p`, AND the rename
  // destination `*** Move to: p` (no `File:` token) — the audit-found gap.
  const re = /^\*\*\*\s+(?:(?:Add|Update|Delete)\s+File|Move\s+to):\s*(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) out.push(m[1]);
  return out;
}

/** Pull the path operands a file tool declares. */
function extractPaths(toolName: string, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v !== '') out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x !== '') out.push(x);
  };
  push(input.file_path);
  push(input.notebook_path);
  push(input.path);
  push(input.paths); // some tools (and MCP fs tools) use a `paths` array
  // apply_patch names its targets in the patch body, not a path field.
  for (const p of applyPatchTargets(input)) out.push(p);
  // Glob's `pattern` IS a filesystem path glob (`<vault>/**/*` would enumerate
  // the vault) — check it. Grep's `pattern` is a SEARCH string, not a path.
  if (toolName === 'Glob') push(input.pattern);
  return out;
}

/** True if a string looks like a filesystem PATH (has a separator) — worth a
 *  protected-path check. A bare word (`credentials`, `.env`) is NOT treated as a
 *  path here: for an unknown tool it stays the default MODERATE (owner approval),
 *  not a hard deny — only obvious paths fail closed. Known file tools still
 *  basename-match secrets via extractPaths + isProtectedPath. */
function looksLikePath(s: string): boolean {
  return s.includes('/') || s.startsWith('~');
}

/**
 * Every PATH-LIKE string value anywhere in an object — for unknown-tool
 * scanning. Only path-like strings are collected, so a benign bare word that
 * happens to match a secret basename (`credentials`, `.env`) isn't hard-denied
 * when it's plainly not a path. Depth cap is generous (fail-closed still holds
 * for realistic inputs) but bounds pathological recursion.
 */
function deepStrings(v: unknown, acc: string[], depth = 0): string[] {
  if (depth > 24) return acc;
  if (typeof v === 'string') {
    if (v !== '' && looksLikePath(v)) acc.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) deepStrings(x, acc, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) deepStrings(x, acc, depth + 1);
  }
  return acc;
}

function hostOf(raw: string): string | null {
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Classify a raw tool call → { action, risk, reason } (no enforcement). */
export function classifyToolCall(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  vaultDir: string;
  cwd?: string;
  keyDirs?: string[];
  allowedHosts?: string[];
}): { action: string; risk: RiskLevel; reason: string } {
  const { toolName } = input;

  if (toolName === 'Bash') {
    const command = typeof input.toolInput.command === 'string' ? input.toolInput.command : '';
    const r = classifyBashCommand({
      command,
      vaultDir: input.vaultDir,
      cwd: input.cwd,
      keyDirs: input.keyDirs,
      allowedHosts: input.allowedHosts,
    });
    return { action: r.action, risk: r.risk ?? 'MODERATE', reason: r.reason };
  }

  if (FILE_READ_TOOLS.has(toolName) || FILE_WRITE_TOOLS.has(toolName)) {
    const rawPaths = extractPaths(toolName, input.toolInput);
    const r = classifyFileToolCall({
      toolName,
      rawPaths,
      vaultDir: input.vaultDir,
      cwd: input.cwd,
      keyDirs: input.keyDirs,
    });
    return { action: r.action, risk: r.risk ?? 'MODERATE', reason: `${toolName} → ${r.action}` };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    const url = typeof input.toolInput.url === 'string' ? input.toolInput.url : '';
    const host = hostOf(url);
    const allow = new Set((input.allowedHosts ?? []).map((h) => h.toLowerCase()));
    if (host && allow.has(host))
      return { action: 'network_egress', risk: 'MODERATE', reason: `${toolName} → allowlisted host` };
    return {
      action: 'network_egress_untrusted',
      risk: 'HIGH',
      reason: `${toolName} → ${host ? 'non-allowlisted host' : 'unresolved host'}`,
    };
  }

  // Unknown / MCP / future tools: conservative MODERATE (approval), never a
  // silent allow. But still honour path protection if the input names one.
  const opts: ProtectedPathOptions = {
    vaultDir: input.vaultDir,
    keyDirs: input.keyDirs,
  };
  const cwd = input.cwd ?? process.cwd();
  // We can't know an unknown tool's field names, so scan EVERY string value in
  // its input: if any resolves to a protected path, fail closed to BLOCKED.
  for (const p of deepStrings(input.toolInput, [])) {
    if (isProtectedPath(canonicalizePath(p, cwd), opts))
      return { action: 'secret_read', risk: 'BLOCKED', reason: `${toolName} names a protected path` };
  }
  return { action: 'code_edit_external', risk: 'MODERATE', reason: `unrecognised tool (${toolName})` };
}

/**
 * The gate decision. Composes classify (3a–3c) + permit (3d), applying the mode.
 * A caller in enforce mode redeems `decision.permit` when the tool actually
 * runs; approval-required calls mint their permit later via `mintApprovedPermit`.
 */
export function gateToolCall(input: GateInput, permits: PermitStore): GateDecision {
  const { action, risk, reason } = classifyToolCall(input);
  const outcome = riskToOutcome(risk);

  if (input.mode === 'classify_only') {
    return { mode: 'classify_only', action, risk, outcome, enforced: false, reason };
  }

  // enforce
  const payload = toPayload(input);
  const payloadHash = hashPayload(payload);

  if (outcome === 'allow') {
    const permit = permits.mint({
      action,
      risk,
      payload,
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      decision: 'auto',
    });
    return { mode: 'enforce', action, risk, outcome, enforced: true, permit, payloadHash, reason };
  }

  if (outcome === 'approval_required') {
    // Item B — the agent's retry AFTER the owner approved: redeem the single-use
    // approved permit for THIS exact payload. A payload that classifies
    // MODERATE/HIGH is deterministic, so it never has an `auto` permit (those are
    // minted only for SAFE calls) — the only thing `consume` can match here is an
    // owner-approved permit; the `decision === 'approved'` guard makes that
    // explicit. First matching retry is allowed and the permit is consumed; a
    // second finds it spent → falls through to approval_required (re-gate).
    const redeemed = permits.consume({
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      payload,
    });
    if (redeemed.ok && redeemed.permit.decision === 'approved') {
      return {
        mode: 'enforce',
        action,
        risk,
        outcome: 'allow',
        enforced: true,
        permit: redeemed.permit,
        payloadHash,
        reason: `${reason} (redeemed owner-approved permit)`,
      };
    }
    // No approved permit yet → the route creates/reuses the owner-approval card.
    return { mode: 'enforce', action, risk, outcome, enforced: true, payloadHash, reason };
  }

  // deny (BLOCKED): no permit, no card.
  return { mode: 'enforce', action, risk, outcome, enforced: true, payloadHash, reason };
}

/** Mint the permit that redeems an owner-approved MODERATE/HIGH call. */
export function mintApprovedPermit(input: GateInput, permits: PermitStore): PermitRecord {
  const { action, risk } = classifyToolCall(input);
  return permits.mint({
    action,
    risk,
    payload: toPayload(input),
    agentDid: input.agentDid,
    sessionId: input.sessionId,
    decision: 'approved',
  });
}

function toPayload(input: GateInput): ToolPayload {
  return { tool: input.toolName, input: input.toolInput };
}
