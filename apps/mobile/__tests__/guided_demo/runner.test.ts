/**
 * GuidedDemoRunner — deterministic orchestration over injected seams. Drives
 * the demo plan through real-shaped side effects without a running app / LLM.
 */

import {
  resetKVStore,
} from '../../../core/src/kv/store';
import {
  AGENT_APPROVAL_STEP,
  PUBLISH_DRAFT_STEP,
  GuidedDemoRunner,
  buildDemoPlan,
  buildDemoApprovalRequest,
  describePublishDraft,
  type DemoApprovalRequest,
  type GuidedDemoSeams,
} from '../../src/guided_demo/runner';
import { DEMO_STEPS, type DemoStep } from '../../src/guided_demo/content';

interface Recorded {
  sends: Array<{ mode: string; message: string }>;
  recommendations: Array<{ question: string; answer: string }>;
  serviceCards: Array<{ capability: string; serviceName: string }>;
  approvals: DemoApprovalRequest[];
  denied: string[];
  cards: string[];
}

function fakeSeams(): { seams: GuidedDemoSeams; rec: Recorded } {
  const rec: Recorded = {
    sends: [],
    recommendations: [],
    serviceCards: [],
    approvals: [],
    denied: [],
    cards: [],
  };
  const seams: GuidedDemoSeams = {
    async send(mode, message) {
      rec.sends.push({ mode, message });
    },
    postRecommendation(question, answer) {
      rec.recommendations.push({ question, answer });
    },
    postServiceCard(card) {
      rec.serviceCards.push({ capability: card.capability, serviceName: card.serviceName });
    },
    requestApproval(req) {
      rec.approvals.push(req);
      return req.id;
    },
    denyApproval(id) {
      rec.denied.push(id);
    },
    postDemoCard(text) {
      rec.cards.push(text);
    },
  };
  return { seams, rec };
}

const CHAT_STEPS = DEMO_STEPS.filter((s) => s.kind === undefined || s.kind === 'chat');
const RECOMMEND_STEPS = DEMO_STEPS.filter((s) => s.kind === 'recommend');
const SERVICE_STEPS = DEMO_STEPS.filter((s) => s.kind === 'service');

function planKind(k: DemoStep['kind']): string {
  return k === 'service' ? 'service' : k === 'recommend' ? 'recommend' : 'chat';
}

beforeEach(() => {
  // markGuidedDemoStep writes the active-demo KV record; reset between tests.
  resetKVStore();
});

describe('buildDemoPlan', () => {
  it('mirrors the content steps (chat/service per kind) then approval then publish', () => {
    const plan = buildDemoPlan();
    expect(plan).toHaveLength(DEMO_STEPS.length + 2);
    // Each content step maps to chat / recommend / service per step.kind.
    expect(plan.slice(0, DEMO_STEPS.length).map((a) => a.kind)).toEqual(
      DEMO_STEPS.map((s) => planKind(s.kind)),
    );
    expect(plan[plan.length - 2]).toMatchObject({ kind: 'approval', id: AGENT_APPROVAL_STEP });
    expect(plan[plan.length - 1]).toMatchObject({ kind: 'publish', id: PUBLISH_DRAFT_STEP });
    // content step ids mirror 1:1
    expect(plan.slice(0, DEMO_STEPS.length).map((a) => a.id)).toEqual(
      DEMO_STEPS.map((s) => s.id),
    );
    // exactly one recommend step (chair pick) + one service step (availability)
    expect(RECOMMEND_STEPS).toHaveLength(1);
    expect(SERVICE_STEPS).toHaveLength(1);
  });
});

describe('buildDemoApprovalRequest', () => {
  it('is a Health read_vault request from the demo agent, id keyed by clock', () => {
    const req = buildDemoApprovalRequest(1234);
    expect(req).toMatchObject({
      id: 'guided-demo-approval-1234',
      action: 'read_vault',
      persona: 'health',
    });
    expect(req.requesterDid).toMatch(/^did:plc:/);
    expect(req.preview.toLowerCase()).toContain('health');
  });
});

describe('GuidedDemoRunner.advance', () => {
  it('runs each content step through its real seam, marking progress', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    expect(runner.total).toBe(DEMO_STEPS.length + 2);
    expect(runner.position).toBe(0);

    for (const step of DEMO_STEPS) {
      const action = await runner.advance();
      expect(action?.kind).toBe(planKind(step.kind));
    }
    // chat steps → send(); recommend step → recommendation; service → service card.
    expect(rec.sends).toEqual(CHAT_STEPS.map((s) => ({ mode: s.mode, message: s.message })));
    expect(rec.recommendations).toHaveLength(RECOMMEND_STEPS.length);
    expect(rec.serviceCards).toEqual(
      SERVICE_STEPS.map(() => ({
        capability: 'product_availability',
        serviceName: 'Demo Furniture Availability Provider',
      })),
    );
    expect(runner.position).toBe(DEMO_STEPS.length);
    expect(runner.isComplete).toBe(false);
  });

  it('recommends ErgoFlex (grounded in the demo PeerLens chairs, no fake peers)', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    const recIdx = buildDemoPlan().findIndex((a) => a.kind === 'recommend');
    for (let i = 0; i <= recIdx; i += 1) await runner.advance();
    expect(rec.recommendations).toHaveLength(1);
    const { answer } = rec.recommendations[0]!;
    expect(answer).toContain('ErgoFlex');
    expect(answer).toContain('$500'); // user's budget
    expect(answer).toContain('over your budget'); // SpinePro rejected
    expect(answer).toContain('PeerLens'); // explicitly the PeerLens flow
    // grounded only — never invents peer names
    expect(answer).not.toMatch(/Rajmohan|Sancho|Aeron/);
  });

  it('posts a real resolved service card with the furniture result', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1, plan: buildDemoPlan() });
    // Run up to and including the single service step.
    const serviceIdx = buildDemoPlan().findIndex((a) => a.kind === 'service');
    for (let i = 0; i <= serviceIdx; i += 1) await runner.advance();
    expect(rec.serviceCards).toEqual([
      { capability: 'product_availability', serviceName: 'Demo Furniture Availability Provider' },
    ]);
  });

  it('creates a real approval on the approval step', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 42 });
    for (let i = 0; i < DEMO_STEPS.length; i += 1) await runner.advance();
    const action = await runner.advance();
    expect(action?.kind).toBe('approval');
    expect(rec.approvals).toHaveLength(1);
    expect(rec.approvals[0]?.id).toBe('guided-demo-approval-42');
  });

  it('posts the publish-draft card on the final step and then completes', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    await runner.runAll();
    expect(runner.isComplete).toBe(true);
    expect(runner.currentAction).toBeNull();
    expect(rec.cards).toEqual([describePublishDraft()]);
    // advancing past the end is a no-op
    expect(await runner.advance()).toBeNull();
  });

  it('only advances the cursor when the seam succeeds (send throws → no progress)', async () => {
    const { seams } = fakeSeams();
    seams.send = async () => {
      throw new Error('composer offline');
    };
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    await expect(runner.advance()).rejects.toThrow('composer offline');
    expect(runner.position).toBe(0);
    expect(runner.currentAction?.id).toBe(DEMO_STEPS[0]?.id);
  });
});

describe('GuidedDemoRunner.resumeAfter', () => {
  it('positions the cursor at the action after the recorded step', () => {
    const { seams } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    const secondId = DEMO_STEPS[1]?.id as string;
    runner.resumeAfter(secondId);
    // next action is the THIRD chat step
    expect(runner.currentAction?.id).toBe(DEMO_STEPS[2]?.id);
  });

  it('unknown marker resumes from the start', () => {
    const { seams } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    runner.resumeAfter('nope');
    expect(runner.position).toBe(0);
  });

  it('empty marker (crash right after start) resumes from the FIRST step', () => {
    // startGuidedDemo persists step='' before any action runs; resuming must
    // replay step 1 ("Emma is my daughter."), not skip it.
    const { seams } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    runner.resumeAfter('');
    expect(runner.position).toBe(0);
    expect(runner.currentAction?.id).toBe(DEMO_STEPS[0]?.id);
  });

  it('resuming after the last step marks the demo complete', () => {
    const { seams } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    runner.resumeAfter(PUBLISH_DRAFT_STEP);
    expect(runner.isComplete).toBe(true);
  });
});

describe('GuidedDemoRunner.teardown', () => {
  it('denies any approval the user left pending, idempotently', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 7 });
    for (let i = 0; i < DEMO_STEPS.length; i += 1) await runner.advance();
    await runner.advance(); // approval
    runner.teardown();
    expect(rec.denied).toEqual(['guided-demo-approval-7']);
    runner.teardown(); // second call is a no-op
    expect(rec.denied).toEqual(['guided-demo-approval-7']);
  });

  it('swallows denyApproval errors (already resolved)', async () => {
    const { seams } = fakeSeams();
    seams.denyApproval = () => {
      throw new Error('not pending');
    };
    const runner = new GuidedDemoRunner(seams, { now: () => 7 });
    for (let i = 0; i < DEMO_STEPS.length; i += 1) await runner.advance();
    await runner.advance();
    expect(() => runner.teardown()).not.toThrow();
  });
});
