/**
 * GuidedDemoRunner — deterministic orchestration over injected seams. Drives
 * the demo plan through real-shaped side effects without a running app / LLM.
 */

import {
  resetKVStore,
} from '../../../core/src/kv/store';
import {
  D2D_MESSAGE_STEP,
  AGENT_APPROVAL_STEP,
  PEERLENS_REVIEW_STEP,
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
  serviceCards: Array<{ capability: string; serviceName: string; question: string }>;
  approvals: DemoApprovalRequest[];
  denied: string[];
  cards: string[];
  userMessages: string[];
  navigations: string[];
  d2dMessages: Array<{ from: string; message: string; reminder: string }>;
  reviewCards: Array<{ product: string; rating: number; text: string }>;
}

function fakeSeams(): { seams: GuidedDemoSeams; rec: Recorded } {
  const rec: Recorded = {
    sends: [],
    recommendations: [],
    serviceCards: [],
    approvals: [],
    denied: [],
    cards: [],
    userMessages: [],
    navigations: [],
    d2dMessages: [],
    reviewCards: [],
  };
  const seams: GuidedDemoSeams = {
    async send(mode, message) {
      rec.sends.push({ mode, message });
    },
    async postRecommendation(question, answer) {
      rec.recommendations.push({ question, answer });
    },
    async postServiceCard(card) {
      rec.serviceCards.push({
        capability: card.capability,
        serviceName: card.serviceName,
        question: card.question,
      });
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
    postUserMessage(text) {
      rec.userMessages.push(text);
    },
    navigate(target) {
      rec.navigations.push(target);
    },
    async postD2DMessage(from, message, reminder) {
      rec.d2dMessages.push({ from, message, reminder });
    },
    postReviewCard(review) {
      rec.reviewCards.push(review);
    },
    async delay() {
      /* no pause in tests */
    },
  };
  return { seams, rec };
}

const CHAT_STEPS = DEMO_STEPS.filter((s) => s.kind === undefined || s.kind === 'chat');
const RECOMMEND_STEPS = DEMO_STEPS.filter((s) => s.kind === 'recommend');
const SERVICE_STEPS = DEMO_STEPS.filter((s) => s.kind === 'service');
const NAVIGATE_STEPS = DEMO_STEPS.filter((s) => s.kind === 'navigate');

function planKind(k: DemoStep['kind']): string {
  return k === 'service'
    ? 'service'
    : k === 'recommend'
      ? 'recommend'
      : k === 'navigate'
        ? 'navigate'
        : 'chat';
}

beforeEach(() => {
  // markGuidedDemoStep writes the active-demo KV record; reset between tests.
  resetKVStore();
});

describe('buildDemoPlan', () => {
  it('mirrors the content steps then d2d, approval, review, publish', () => {
    const plan = buildDemoPlan();
    expect(plan).toHaveLength(DEMO_STEPS.length + 4);
    // Each content step maps to chat / recommend / service per step.kind.
    expect(plan.slice(0, DEMO_STEPS.length).map((a) => a.kind)).toEqual(
      DEMO_STEPS.map((s) => planKind(s.kind)),
    );
    expect(plan[plan.length - 4]).toMatchObject({ kind: 'd2d', id: D2D_MESSAGE_STEP });
    expect(plan[plan.length - 3]).toMatchObject({ kind: 'approval', id: AGENT_APPROVAL_STEP });
    expect(plan[plan.length - 2]).toMatchObject({ kind: 'review', id: PEERLENS_REVIEW_STEP });
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
    // Carries plain-language what/why so the approval card is decidable.
    expect(req.what.toLowerCase()).toContain('health');
    expect(req.why.length).toBeGreaterThan(0);
  });
});

describe('GuidedDemoRunner.advance', () => {
  it('runs each content step through its real seam, marking progress', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    expect(runner.total).toBe(DEMO_STEPS.length + 4);
    expect(runner.position).toBe(0);

    for (const step of DEMO_STEPS) {
      const action = await runner.advance();
      expect(action?.kind).toBe(planKind(step.kind));
    }
    // chat → send(); recommend → recommendation; service → question + card;
    // navigate → navigation. Each per its kind. A chat step may send MULTIPLE
    // messages (the opening step remembers Emma AND Alonso), so expand them.
    expect(rec.sends).toEqual(
      CHAT_STEPS.flatMap((s) =>
        (s.messages ?? [s.message]).map((message) => ({ mode: s.mode, message })),
      ),
    );
    expect(rec.recommendations).toHaveLength(RECOMMEND_STEPS.length);
    expect(rec.serviceCards).toEqual(
      SERVICE_STEPS.map((s) => ({
        capability: 'product_availability',
        serviceName: 'Demo Furniture Availability Provider',
        question: s.message,
      })),
    );
    expect(rec.navigations).toEqual(NAVIGATE_STEPS.map((s) => s.navigateTo));
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
      {
        capability: 'product_availability',
        serviceName: 'Demo Furniture Availability Provider',
        question: SERVICE_STEPS[0]!.message,
      },
    ]);
    // The user's question was posted (as a user message) before the card.
    expect(rec.serviceCards[0]?.question).toMatch(/ErgoFlex Study Chair/);
  });

  it('creates a real approval on the approval step', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 42 });
    // Content steps, then the D2D step, land us on the approval step next.
    for (let i = 0; i < DEMO_STEPS.length + 1; i += 1) await runner.advance();
    const action = await runner.advance();
    expect(action?.kind).toBe('approval');
    expect(rec.approvals).toHaveLength(1);
    expect(rec.approvals[0]?.id).toBe('guided-demo-approval-42');
    // The approval step is framed as a delegated task — the hand-off message is
    // posted before the agent's access request.
    expect(rec.userMessages.some((m) => /Email my manager/.test(m))).toBe(true);
  });

  it('posts the D2D message, review card, then publish-draft card, then completes', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    await runner.runAll();
    expect(runner.isComplete).toBe(true);
    expect(runner.currentAction).toBeNull();
    // The Talk step posts a peer message + enriched reminder.
    expect(rec.d2dMessages).toHaveLength(1);
    expect(rec.d2dMessages[0]?.from).toBe('Alonso');
    // The review goes through postReviewCard (its own card); only the publish
    // draft uses postDemoCard now.
    expect(rec.reviewCards).toHaveLength(1);
    expect(rec.reviewCards[0]?.product).toBe('ErgoFlex Study Chair');
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
    for (let i = 0; i < DEMO_STEPS.length + 1; i += 1) await runner.advance(); // content + d2d
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
    for (let i = 0; i < DEMO_STEPS.length + 1; i += 1) await runner.advance(); // content + d2d
    await runner.advance();
    expect(() => runner.teardown()).not.toThrow();
  });
});
