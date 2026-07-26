/**
 * Item 4 — integration test for the fs-backed coding gate injected into the
 * `/v1/agent/gate` route. Drives the REAL gate (classifier 3b/3c + permit 3d)
 * against a real on-disk vault, proving the injected impl the route calls
 * actually classifies and mints/redeems — not just the stub the @dina/core
 * contract test uses.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCodingGate } from '../src/gate/coding_gate_impl';

let root: string;
let vaultDir: string;
let projectDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-impl-')));
  vaultDir = path.join(root, 'vault');
  projectDir = path.join(root, 'project');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'keyfile'), 'SEED');
  fs.writeFileSync(path.join(projectDir, 'index.ts'), 'x');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const AGENT = 'did:key:z6MkAgent';

describe('createCodingGate — real classify + permit', () => {
  it('allows a project read and mints a redeemable permit', () => {
    const { gate, permits } = createCodingGate({ vaultDir });
    const toolInput = { file_path: 'index.ts' };
    const res = gate({
      toolName: 'Read',
      toolInput,
      agentDid: AGENT,
      sessionId: 's1',
      cwd: projectDir,
      mode: 'enforce',
    });
    expect(res).toMatchObject({
      action: 'code_read',
      risk: 'SAFE',
      outcome: 'allow',
      enforced: true,
    });
    expect(res.permitId).toBeDefined();

    // the minted permit redeems for the exact payload
    const redeem = permits.consume({
      agentDid: AGENT,
      sessionId: 's1',
      payload: { tool: 'Read', input: toolInput },
    });
    expect(redeem.ok).toBe(true);
  });

  it('denies a read of the seed keyfile', () => {
    const { gate, permits } = createCodingGate({ vaultDir });
    const res = gate({
      toolName: 'Read',
      toolInput: { file_path: path.join(vaultDir, 'keyfile') },
      agentDid: AGENT,
      sessionId: 's1',
      cwd: projectDir,
      mode: 'enforce',
    });
    expect(res).toMatchObject({ risk: 'BLOCKED', outcome: 'deny', enforced: true });
    expect(res.permitId).toBeUndefined();
    expect(permits.size()).toBe(0);
  });

  it('requires approval for a Bash package install', () => {
    const { gate, permits } = createCodingGate({ vaultDir });
    const res = gate({
      toolName: 'Bash',
      toolInput: { command: 'npm install' },
      agentDid: AGENT,
      sessionId: 's1',
      cwd: projectDir,
      mode: 'enforce',
    });
    expect(res).toMatchObject({
      action: 'package_install',
      risk: 'MODERATE',
      outcome: 'approval_required',
    });
    expect(permits.size()).toBe(0);
  });

  it('denies a Bash read of a vault file (path-aware)', () => {
    const { gate } = createCodingGate({ vaultDir });
    const res = gate({
      toolName: 'Bash',
      toolInput: { command: `cat ${path.join(vaultDir, 'keyfile')}` },
      agentDid: AGENT,
      sessionId: 's1',
      cwd: projectDir,
      mode: 'enforce',
    });
    expect(res.outcome).toBe('deny');
  });

  it('classify_only enforces nothing and mints no permit', () => {
    const { gate, permits } = createCodingGate({ vaultDir });
    const res = gate({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      agentDid: AGENT,
      sessionId: 's1',
      cwd: projectDir,
      mode: 'classify_only',
    });
    expect(res).toMatchObject({ risk: 'HIGH', outcome: 'approval_required', enforced: false });
    expect(res.permitId).toBeUndefined();
    expect(permits.size()).toBe(0);
  });

  it('honours a network host allowlist', () => {
    const { gate } = createCodingGate({ vaultDir, allowedHosts: ['api.trusted.test'] });
    const ok = gate({
      toolName: 'WebFetch',
      toolInput: { url: 'https://api.trusted.test/v1' },
      agentDid: AGENT,
      sessionId: 's1',
      mode: 'enforce',
    });
    expect(ok.risk).toBe('MODERATE');
    const bad = gate({
      toolName: 'WebFetch',
      toolInput: { url: 'https://evil.test/x' },
      agentDid: AGENT,
      sessionId: 's1',
      mode: 'enforce',
    });
    expect(bad.risk).toBe('HIGH');
  });
});

// Item B — the owner-approval permit loop end-to-end on the REAL gate + the
// authority it injects into @dina/core. An unknown tool classifies MODERATE
// (`code_edit_external`) deterministically, so no fs state is needed.
describe('createCodingGate — owner-approval permit loop (Item B)', () => {
  const modCall = (over: Record<string, unknown> = {}) => ({
    toolName: 'SomeMcpTool',
    toolInput: { x: 'y' },
    agentDid: AGENT,
    sessionId: 's1',
    cwd: projectDir,
    mode: 'enforce' as const,
    ...over,
  });

  it('MODERATE with no permit → approval_required + payload hash (no permit minted)', () => {
    const { gate, permits } = createCodingGate({ vaultDir });
    const res = gate(modCall());
    expect(res).toMatchObject({ risk: 'MODERATE', outcome: 'approval_required', enforced: true });
    expect(res.permitId).toBeUndefined();
    expect(res.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(permits.size()).toBe(0); // approval mints nothing until the owner says yes
  });

  it('approve → mintApproved → retry redeems once (single-use)', () => {
    const { gate, authority } = createCodingGate({ vaultDir });

    const first = gate(modCall());
    expect(first.outcome).toBe('approval_required');

    // Owner approves: mint the approved permit bound to the exact payload hash.
    authority.mintApproved({
      agentDid: AGENT,
      sessionId: 's1',
      effectiveProfile: 'full_supervision',
      policyVersion: 0,
      authorityOrigin: 'unknown',
      payloadHash: first.payloadHash as string,
      action: first.action,
      risk: 'MODERATE',
    });

    // Agent retries the SAME call → the approved permit is redeemed → allow.
    const second = gate(modCall());
    expect(second.outcome).toBe('allow');
    expect(second.permitId).toBeDefined();
    expect(second.reason).toMatch(/redeemed owner-approved permit/);

    // A third identical call → the single-use permit is spent → re-gates.
    const third = gate(modCall());
    expect(third.outcome).toBe('approval_required');
  });

  it('an altered payload after approval does NOT redeem (hash-bound)', () => {
    const { gate, authority } = createCodingGate({ vaultDir });
    const first = gate(modCall());
    authority.mintApproved({
      agentDid: AGENT,
      sessionId: 's1',
      effectiveProfile: 'full_supervision',
      policyVersion: 0,
      authorityOrigin: 'unknown',
      payloadHash: first.payloadHash as string,
      action: first.action,
      risk: 'MODERATE',
    });
    // Bait-and-switch: same tool, different input → different hash → no redeem.
    const altered = gate(modCall({ toolInput: { x: 'EVIL' } }));
    expect(altered.outcome).toBe('approval_required');
  });

  it("a different session cannot redeem another session's approved permit", () => {
    const { gate, authority } = createCodingGate({ vaultDir });
    const first = gate(modCall({ sessionId: 's1' }));
    authority.mintApproved({
      agentDid: AGENT,
      sessionId: 's1',
      effectiveProfile: 'full_supervision',
      policyVersion: 0,
      authorityOrigin: 'unknown',
      payloadHash: first.payloadHash as string,
      action: first.action,
      risk: 'MODERATE',
    });
    // Same payload, DIFFERENT session → principal mismatch → not redeemed.
    const other = gate(modCall({ sessionId: 's2' }));
    expect(other.outcome).toBe('approval_required');
  });
});
