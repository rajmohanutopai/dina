/**
 * E2E — `/ask` against a sensitive/locked persona.
 *
 * Pins the chain that ADMIN_GAP.md flagged as missing in TS HNL:
 *
 *   chat input → persona resolver → checkPersonaGate → AskRegistry
 *     ─ open default persona → answers immediately (fast path).
 *     ─ closed sensitive persona → returns 200 + `pending_approval`.
 *   operator approves via AskApprovalGateway →
 *     AskRegistry resumes (`pending_approval → in_flight`).
 *   handler re-issues executeFn → answer returned, `markComplete`.
 *
 * Mocked: LLM (canned answers), persona resolver (keyword-based),
 * persona table (general=default+open, financial=sensitive+open).
 *
 * NOT in scope here: the Brain HTTP surface, the notification
 * frame dispatcher (no UI yet — task 5.x), the actual SQLCipher
 * vault unlock. The test exercises the decision logic + state
 * machine end to end without HTTP.
 */

import { ApprovalManager } from '@dina/core/src/approval/manager';
import { createAskHandler, type AskExecuteFn } from '../../src/ask/ask_handler';
import { AskRegistry, InMemoryAskAdapter } from '../../src/ask/ask_registry';
import {
  AskApprovalGateway,
  type ApprovalSource,
  type ApprovalSourceStatus,
} from '../../src/ask/ask_approval_gateway';
import {
  approvalIdForAsk,
  buildPersonaGuardedExecuteFn,
  type GuardedLLM,
  type PersonaInfo,
} from '../../src/ask/persona_guarded_ask';

// ---------------------------------------------------------------------------
// Test harness — minimal stand-ins for the production wiring.
// ---------------------------------------------------------------------------

const REQUESTER_DID = 'did:key:z6MkUserAlonso';

/**
 * Adapt the in-memory ApprovalManager to the gateway's
 * ApprovalSource interface. In production, Core's HTTP-backed
 * approval registry plugs into the same interface.
 */
function approvalManagerSource(mgr: ApprovalManager): ApprovalSource {
  return {
    getStatus(approvalId: string): ApprovalSourceStatus {
      const r = mgr.getRequest(approvalId);
      if (!r) return 'unknown';
      if (r.status === 'pending') return 'pending';
      if (r.status === 'approved') return 'approved';
      return 'denied';
    },
    approve(approvalId: string): void {
      mgr.approveRequest(approvalId, 'single', 'test-operator');
    },
    deny(approvalId: string): void {
      mgr.denyRequest(approvalId);
    },
  };
}

const personaTable: Record<string, PersonaInfo> = {
  general: { name: 'general', tier: 'default', open: true },
  // Sensitive + open is the realistic finance shape: DEK is loaded
  // (the user already provided the passphrase at boot) but each
  // brain-initiated read still needs explicit per-call approval.
  financial: { name: 'financial', tier: 'sensitive', open: true },
};

function personaResolver(question: string): string {
  const lower = question.toLowerCase();
  if (lower.includes('balance') || lower.includes('finance') || lower.includes('bank')) {
    return 'financial';
  }
  return 'general';
}

function personaLookup(name: string): PersonaInfo | null {
  return personaTable[name] ?? null;
}

const llm: GuardedLLM = async ({ question, persona }) => ({
  text: `[${persona.name}] answer to: ${question}`,
  persona: persona.name,
});

interface Harness {
  registry: AskRegistry;
  approvalManager: ApprovalManager;
  gateway: AskApprovalGateway;
  executeFn: AskExecuteFn;
  handleAsk: ReturnType<typeof createAskHandler>;
}

function buildHarness(): Harness {
  const registry = new AskRegistry({
    adapter: new InMemoryAskAdapter(),
    defaultTtlMs: 30_000,
  });
  const approvalManager = new ApprovalManager();
  const executeFn = buildPersonaGuardedExecuteFn({
    personaResolver,
    personaLookup,
    approvalManager,
    llm,
    callerRole: 'brain',
  });
  const gateway = new AskApprovalGateway({
    askRegistry: registry,
    approvalSource: approvalManagerSource(approvalManager),
  });
  const handleAsk = createAskHandler({
    registry,
    executeFn,
    fastPathMs: 50, // tight — every test resolves well within the fast path
  });
  return { registry, approvalManager, gateway, executeFn, handleAsk };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/ask × persona-gate × approval — E2E (Jest)', () => {
  it('default persona answers immediately (fast path, 200 + complete)', async () => {
    const h = buildHarness();
    const result = await h.handleAsk({
      question: "what's the weather in San Francisco?",
      requesterDid: REQUESTER_DID,
    });
    expect(result.kind).toBe('fast_path');
    if (result.kind !== 'fast_path') return;
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('complete');
    expect(result.body.answer).toEqual({
      text: "[general] answer to: what's the weather in San Francisco?",
      persona: 'general',
    });
    // No approval entry created — the gate allowed it outright.
    expect(h.approvalManager.listPending()).toHaveLength(0);
  });

  it('sensitive persona returns pending_approval with a fresh approval_id', async () => {
    const h = buildHarness();
    const result = await h.handleAsk({
      question: "what's my bank balance?",
      requesterDid: REQUESTER_DID,
    });
    expect(result.kind).toBe('fast_path');
    if (result.kind !== 'fast_path') return;
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('pending_approval');
    expect(result.body.approval_id).toBeDefined();
    expect(result.body.approval_id).toBe(approvalIdForAsk(result.body.request_id));

    // Registry is now in pending_approval; ApprovalManager has the
    // matching pending entry tagged to the financial persona.
    const askRecord = await h.registry.get(result.body.request_id);
    expect(askRecord?.status).toBe('pending_approval');
    expect(askRecord?.approvalId).toBe(result.body.approval_id);

    const pending = h.approvalManager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(result.body.approval_id);
    expect(pending[0]?.persona).toBe('financial');
    expect(pending[0]?.requester_did).toBe(REQUESTER_DID);
    expect(pending[0]?.action).toBe('ask_persona_access');
  });

  it('operator approves → ask resumes to in_flight → re-run executeFn → answer', async () => {
    const h = buildHarness();
    const submit = await h.handleAsk({
      question: 'show me my finance summary',
      requesterDid: REQUESTER_DID,
    });
    expect(submit.kind).toBe('fast_path');
    if (submit.kind !== 'fast_path') return;
    expect(submit.body.status).toBe('pending_approval');
    const askId = submit.body.request_id;
    const approvalId = submit.body.approval_id!;

    // Operator action — drives both the ApprovalManager and the
    // AskRegistry transition through the gateway.
    const approveOutcome = await h.gateway.approve(approvalId);
    expect(approveOutcome.ok).toBe(true);

    let resumed = await h.registry.get(askId);
    expect(resumed?.status).toBe('in_flight');
    expect(resumed?.approvalId).toBeUndefined(); // cleared on resume

    // Production wires a subscriber on the `approval_resumed` event;
    // here we re-issue the executeFn manually to drive the second
    // turn. The gate is bypassed via the consumed approval, so the
    // LLM runs and an answer is produced.
    const second = await h.executeFn({
      id: askId,
      question: 'show me my finance summary',
      requesterDid: REQUESTER_DID,
    });
    expect(second.kind).toBe('answer');
    if (second.kind !== 'answer') return;
    expect(second.answer).toEqual({
      text: '[financial] answer to: show me my finance summary',
      persona: 'financial',
    });
    await h.registry.markComplete(askId, JSON.stringify(second.answer));

    const final = await h.registry.get(askId);
    expect(final?.status).toBe('complete');
    expect(JSON.parse(final?.answerJson ?? '{}')).toEqual(second.answer);

    // Approval was consumed — replay would have to request a fresh one.
    expect(h.approvalManager.getRequest(approvalId)).toBeUndefined();
  });

  it('operator denies → ask transitions to failed with operator reason', async () => {
    const h = buildHarness();
    const submit = await h.handleAsk({
      question: 'send 1000 USD to my bank',
      requesterDid: REQUESTER_DID,
    });
    expect(submit.kind).toBe('fast_path');
    if (submit.kind !== 'fast_path') return;
    expect(submit.body.status).toBe('pending_approval');
    const askId = submit.body.request_id;
    const approvalId = submit.body.approval_id!;

    const denyOutcome = await h.gateway.deny(approvalId, 'Not auto-approving outbound transfers');
    expect(denyOutcome.ok).toBe(true);

    const final = await h.registry.get(askId);
    expect(final?.status).toBe('failed');
    expect(final?.errorJson).toBeDefined();
    const err = JSON.parse(final?.errorJson ?? '{}');
    expect(err.reason).toBe('denied');
    expect(err.detail).toBe('Not auto-approving outbound transfers');
  });
});
