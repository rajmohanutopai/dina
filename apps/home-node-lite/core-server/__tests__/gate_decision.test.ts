/**
 * Item 3e — gate decision + classification-only mode tests.
 *
 * Verifies the tool dispatch (Bash / file / network / unknown), the two modes
 * (enforce vs classify_only), and the end-to-end SAFE → permit → redeem flow.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyToolCall,
  gateToolCall,
  mintApprovedPermit,
  type GateInput,
} from '../src/gate/gate_decision';
import { PermitStore } from '../src/gate/permit';

let root: string;
let vaultDir: string;
let projectDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dec-')));
  vaultDir = path.join(root, 'vault');
  projectDir = path.join(root, 'project');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'keyfile'), 'SEED');
  fs.writeFileSync(path.join(projectDir, 'index.ts'), 'x');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const base = (over: Partial<GateInput>): GateInput => ({
  toolName: 'Read',
  toolInput: { file_path: 'index.ts' },
  agentDid: 'did:key:z6MkAgent',
  sessionId: 'sess-1',
  vaultDir,
  cwd: projectDir,
  mode: 'enforce',
  ...over,
});

const classify = (toolName: string, toolInput: Record<string, unknown>, allowedHosts?: string[]) =>
  classifyToolCall({ toolName, toolInput, vaultDir, cwd: projectDir, allowedHosts });

describe('classifyToolCall — dispatch', () => {
  it('Bash → bash classifier', () => {
    expect(classify('Bash', { command: 'rm -rf build' }).risk).toBe('HIGH');
    expect(classify('Bash', { command: 'git status' }).risk).toBe('SAFE');
    expect(classify('Bash', { command: `cat ${path.join(vaultDir, 'keyfile')}` }).risk).toBe('BLOCKED');
  });
  it('Read of a project file → code_read SAFE', () => {
    expect(classify('Read', { file_path: 'index.ts' })).toMatchObject({ action: 'code_read', risk: 'SAFE' });
  });
  it('Read of the keyfile → secret_read BLOCKED', () => {
    expect(classify('Read', { file_path: path.join(vaultDir, 'keyfile') }).risk).toBe('BLOCKED');
  });
  it('Write to a project file → code_edit SAFE', () => {
    expect(classify('Write', { file_path: 'new.ts' }).action).toBe('code_edit');
  });
  it('NotebookEdit → code_edit_external MODERATE', () => {
    expect(classify('NotebookEdit', { notebook_path: 'a.ipynb' }).risk).toBe('MODERATE');
  });
  it('WebFetch to a non-allowlisted host → HIGH', () => {
    expect(classify('WebFetch', { url: 'https://evil.example/x' }).risk).toBe('HIGH');
  });
  it('WebFetch to an allowlisted host → MODERATE', () => {
    expect(classify('WebFetch', { url: 'https://api.trusted.test/v1' }, ['api.trusted.test']).risk).toBe('MODERATE');
  });
  it('unknown/MCP tool → MODERATE (no silent allow)', () => {
    expect(classify('mcp__something__do_thing', { foo: 'bar' }).risk).toBe('MODERATE');
  });
  it('unknown tool naming a protected path → BLOCKED', () => {
    expect(classify('mcp__x__read', { path: path.join(vaultDir, 'keyfile') }).risk).toBe('BLOCKED');
  });

  // ── AUDIT regressions ──────────────────────────────────────────────────────
  it('AUDIT: apply_patch writing a protected path (target in the patch body) → BLOCKED', () => {
    const patch = `*** Begin Patch\n*** Update File: ${path.join(vaultDir, 'keyfile')}\n@@\n-old\n+pwn\n*** End Patch`;
    expect(classify('apply_patch', { input: patch }).risk).toBe('BLOCKED');
  });
  it('AUDIT: unknown MCP tool naming a protected path in a `paths` array → BLOCKED', () => {
    expect(classify('mcp__fs__read_multiple_files', { paths: [path.join(vaultDir, 'keyfile')] }).risk).toBe('BLOCKED');
  });
  it('AUDIT: unknown tool naming a protected path in a NESTED field → BLOCKED', () => {
    expect(classify('mcp__x__do', { opts: { target: path.join(vaultDir, 'keyfile') } }).risk).toBe('BLOCKED');
  });

  // ── AUDIT round 2 ───────────────────────────────────────────────────────────
  it('AUDIT2: apply_patch rename destination (*** Move to:) to a protected path → BLOCKED', () => {
    const patch = `*** Begin Patch\n*** Move to: ${path.join(vaultDir, 'keyfile')}\n*** End Patch`;
    expect(classify('apply_patch', { input: patch }).risk).toBe('BLOCKED');
  });
  it('AUDIT2: deeply-nested (>6) protected path in an unknown tool → still BLOCKED', () => {
    const input = { a: { b: { c: { d: { e: { f: { g: path.join(vaultDir, 'keyfile') } } } } } } };
    expect(classify('mcp__x__do', input).risk).toBe('BLOCKED');
  });
  it('AUDIT2: a benign bare word matching a secret basename is NOT hard-denied', () => {
    // 'credentials' / '.env' as plain values (not paths) → MODERATE (approval),
    // never a silent SAFE and never an over-block to BLOCKED.
    expect(classify('mcp__x__do', { mode: 'credentials' }).risk).toBe('MODERATE');
    expect(classify('mcp__x__do', { name: '.env' }).risk).toBe('MODERATE');
  });

  // ── AUDIT round 12 ──────────────────────────────────────────────────────────
  it('AUDIT12: Glob pattern enumerating the vault dir → BLOCKED (pattern IS a path)', () => {
    expect(classify('Glob', { pattern: path.join(vaultDir, '*') }).risk).toBe('BLOCKED');
    expect(classify('Glob', { pattern: path.join(vaultDir, 'key*') }).risk).toBe('BLOCKED');
  });
  it('AUDIT12: OVER-BLOCK guard — a benign project Glob stays SAFE', () => {
    expect(classify('Glob', { pattern: path.join(projectDir, '*.ts') }).risk).toBe('SAFE');
  });
});

describe('gateToolCall — classify_only mode', () => {
  it('enforces nothing and mints no permit, but reports the classification', () => {
    const permits = new PermitStore();
    const d = gateToolCall(base({ toolName: 'Bash', toolInput: { command: 'rm -rf build' }, mode: 'classify_only' }), permits);
    expect(d).toMatchObject({ mode: 'classify_only', risk: 'HIGH', outcome: 'approval_required', enforced: false });
    expect(d.permit).toBeUndefined();
    expect(permits.size()).toBe(0);
  });
  it('a BLOCKED call in classify_only is advisory only', () => {
    const permits = new PermitStore();
    const d = gateToolCall(base({ toolName: 'Read', toolInput: { file_path: path.join(vaultDir, 'keyfile') }, mode: 'classify_only' }), permits);
    expect(d).toMatchObject({ outcome: 'deny', enforced: false });
    expect(permits.size()).toBe(0);
  });
});

describe('gateToolCall — enforce mode', () => {
  it('SAFE → allow + mints a payload-bound permit', () => {
    const permits = new PermitStore();
    const d = gateToolCall(base({ toolName: 'Read', toolInput: { file_path: 'index.ts' } }), permits);
    expect(d).toMatchObject({ outcome: 'allow', enforced: true });
    expect(d.permit).toBeDefined();
    expect(permits.size()).toBe(1);
  });
  it('BLOCKED → deny, no permit', () => {
    const permits = new PermitStore();
    const d = gateToolCall(base({ toolName: 'Bash', toolInput: { command: `cat ${path.join(vaultDir, 'keyfile')}` } }), permits);
    expect(d).toMatchObject({ outcome: 'deny', enforced: true });
    expect(d.permit).toBeUndefined();
    expect(permits.size()).toBe(0);
  });
  it('MODERATE → approval_required, no permit yet', () => {
    const permits = new PermitStore();
    const d = gateToolCall(base({ toolName: 'Bash', toolInput: { command: 'npm install' } }), permits);
    expect(d).toMatchObject({ outcome: 'approval_required', enforced: true });
    expect(d.permit).toBeUndefined();
    expect(permits.size()).toBe(0);
  });
});

describe('end-to-end — allow → redeem the permit', () => {
  it('a SAFE call mints a permit that redeems for the same payload only', () => {
    const permits = new PermitStore();
    const input = base({ toolName: 'Write', toolInput: { file_path: 'new.ts', content: 'x' } });
    const d = gateToolCall(input, permits);
    expect(d.outcome).toBe('allow');

    // redeem with the exact payload → ok
    const ok = permits.consume({
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      payload: { tool: input.toolName, input: input.toolInput },
    });
    expect(ok.ok).toBe(true);

    // a second redemption of the same permit fails (single-use)
    const again = permits.consume({
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      payload: { tool: input.toolName, input: input.toolInput },
    });
    expect(again).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a bait-and-switch payload cannot redeem an allow permit', () => {
    const permits = new PermitStore();
    const input = base({ toolName: 'Write', toolInput: { file_path: 'new.ts', content: 'x' } });
    gateToolCall(input, permits);
    const res = permits.consume({
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      payload: { tool: 'Write', input: { file_path: 'new.ts', content: 'DIFFERENT' } },
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('mintApprovedPermit', () => {
  it('mints an approved permit that redeems the owner-approved call', () => {
    const permits = new PermitStore();
    const input = base({ toolName: 'Bash', toolInput: { command: 'npm install' } });
    // gate says approval_required
    expect(gateToolCall(input, permits).outcome).toBe('approval_required');
    // owner approves → mint
    const p = mintApprovedPermit(input, permits);
    expect(p.decision).toBe('approved');
    // agent retries the exact call → redeems
    const res = permits.consume({
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      payload: { tool: input.toolName, input: input.toolInput },
    });
    expect(res.ok).toBe(true);
  });
});
