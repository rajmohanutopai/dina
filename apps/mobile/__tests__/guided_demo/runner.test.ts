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
  SALON_SETUP_STEP,
  SALON_PUBLISH_STEP,
  SALON_BOOKING_STEP,
  SALON_REPLY_STEP,
  GuidedDemoRunner,
  buildDemoPlan,
  buildDemoApprovalRequest,
  buildSalonApprovalRequest,
  type DemoApprovalRequest,
  type GuidedDemoSeams,
} from '../../src/guided_demo/runner';
import { DEMO_STEPS, DEMO_SALON, type DemoStep } from '../../src/guided_demo/content';

interface Recorded {
  sends: Array<{ mode: string; message: string; vault: string }>;
  recommendations: Array<{ question: string; answer: string }>;
  serviceCards: Array<{ capability: string; serviceName: string; question: string }>;
  servicePreviewCards: Array<{ serviceName: string; capability: string; status: string }>;
  publishConfirms: number;
  approvals: DemoApprovalRequest[];
  denied: string[];
  cards: string[];
  userMessages: string[];
  navigations: string[];
  d2dMessages: Array<{ from: string; message: string; reminder: string }>;
  reviewCards: Array<{ product: string; rating: number; text: string }>;
  delays: (number | undefined)[];
  seededPeople: { name: string; relation: string }[];
  seededReminders: string[];
}

function fakeSeams(opts: { confirmPublish?: boolean } = {}): {
  seams: GuidedDemoSeams;
  rec: Recorded;
} {
  const publishResult = opts.confirmPublish ?? true;
  const rec: Recorded = {
    sends: [],
    recommendations: [],
    serviceCards: [],
    servicePreviewCards: [],
    publishConfirms: 0,
    approvals: [],
    denied: [],
    cards: [],
    userMessages: [],
    navigations: [],
    d2dMessages: [],
    reviewCards: [],
    delays: [],
    seededPeople: [],
    seededReminders: [],
  };
  const seams: GuidedDemoSeams = {
    async send(mode, message, vault) {
      rec.sends.push({ mode, message, vault });
    },
    seedPerson(person) {
      rec.seededPeople.push(person);
    },
    seedReminders(texts) {
      rec.seededReminders.push(...texts);
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
    postServicePreviewCard(card) {
      rec.servicePreviewCards.push({
        serviceName: card.serviceName,
        capability: card.capability,
        status: card.status,
      });
    },
    async confirmPublish() {
      rec.publishConfirms += 1;
      return publishResult;
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
    async delay(ms) {
      rec.delays.push(ms); // record the requested pause; don't actually wait
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
  it('mirrors the content steps then d2d, approval, review, and the salon finale', () => {
    const plan = buildDemoPlan();
    expect(plan).toHaveLength(DEMO_STEPS.length + 7);
    // Each content step maps to chat / recommend / service per step.kind.
    expect(plan.slice(0, DEMO_STEPS.length).map((a) => a.kind)).toEqual(
      DEMO_STEPS.map((s) => planKind(s.kind)),
    );
    expect(plan[plan.length - 7]).toMatchObject({ kind: 'd2d', id: D2D_MESSAGE_STEP });
    expect(plan[plan.length - 6]).toMatchObject({ kind: 'approval', id: AGENT_APPROVAL_STEP });
    expect(plan[plan.length - 5]).toMatchObject({ kind: 'review', id: PEERLENS_REVIEW_STEP });
    expect(plan[plan.length - 4]).toMatchObject({ kind: 'salon_setup', id: SALON_SETUP_STEP });
    expect(plan[plan.length - 3]).toMatchObject({ kind: 'salon_publish', id: SALON_PUBLISH_STEP });
    expect(plan[plan.length - 2]).toMatchObject({ kind: 'salon_booking', id: SALON_BOOKING_STEP });
    expect(plan[plan.length - 1]).toMatchObject({ kind: 'salon_reply', id: SALON_REPLY_STEP });
    // content step ids mirror 1:1
    expect(plan.slice(0, DEMO_STEPS.length).map((a) => a.id)).toEqual(
      DEMO_STEPS.map((s) => s.id),
    );
    // exactly one recommend step (chair pick); the chair-availability service
    // step was removed in favour of the salon finale.
    expect(RECOMMEND_STEPS).toHaveLength(1);
    expect(SERVICE_STEPS).toHaveLength(0);
  });
});

describe('buildSalonApprovalRequest', () => {
  it('is a booking-confirmation request, id keyed by clock', () => {
    const req = buildSalonApprovalRequest(99);
    expect(req).toMatchObject({ id: 'guided-demo-salon-99', action: 'confirm_booking' });
    expect(req.requesterDid).toMatch(/^did:plc:/);
    expect(req.what.toLowerCase()).toContain('appointment');
    expect(req.why.length).toBeGreaterThan(0);
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
    expect(runner.total).toBe(DEMO_STEPS.length + 7);
    expect(runner.position).toBe(0);

    for (const step of DEMO_STEPS) {
      const action = await runner.advance();
      expect(action?.kind).toBe(planKind(step.kind));
    }
    // chat → send() per remember (scripted reply, no LLM); recommend →
    // recommendation; service → question + card; navigate → navigation. A chat
    // step may have several remembers (Emma + Alonso), so expand them.
    expect(rec.sends).toEqual(
      CHAT_STEPS.flatMap((s) =>
        (s.remembers ?? [{ message: s.message, vault: 'General' }]).map((r) => ({
          mode: s.mode,
          message: r.message,
          vault: r.vault,
        })),
      ),
    );
    // People seeded for every remember that carries a person (Emma, Alonso).
    expect(rec.seededPeople).toEqual(
      CHAT_STEPS.flatMap((s) => (s.remembers ?? []).flatMap((r) => (r.person ? [r.person] : []))),
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

  it('pauses between the two opening remembers (Emma, then Alonso)', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    await runner.advance(); // the opening multi-send step
    expect(rec.sends).toHaveLength(2);
    // One inter-message pause (between the two sends) — the readable 3.5s gap
    // (#368), not the long "thinking" delay.
    expect(rec.delays).toEqual([3500]);
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
    expect(answer).toContain('reviewers'); // explicitly the ranked-reviews flow
    // grounded only — never invents peer names
    expect(answer).not.toMatch(/Rajmohan|Sancho|Aeron/);
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

  it('posts the D2D message, review card, then the salon finale, then completes', async () => {
    const { seams, rec } = fakeSeams();
    const runner = new GuidedDemoRunner(seams, { now: () => 1 });
    await runner.runAll();
    expect(runner.isComplete).toBe(true);
    expect(runner.currentAction).toBeNull();
    // The Talk step posts a peer message + enriched reminder.
    expect(rec.d2dMessages).toHaveLength(1);
    expect(rec.d2dMessages[0]?.from).toBe('Alonso');
    // The review goes through postReviewCard (its own card).
    expect(rec.reviewCards).toHaveLength(1);
    expect(rec.reviewCards[0]?.product).toBe('ErgoFlex Study Chair');
    // Salon finale: setup posts a READ-ONLY services preview (not published
    // yet), then publish (popup confirmed) + booking-confirmed render as
    // structured service cards. Only the customer query is a plain card.
    expect(rec.servicePreviewCards).toEqual([
      {
        serviceName: DEMO_SALON.serviceName,
        capability: DEMO_SALON.preview.capability,
        status: DEMO_SALON.preview.status,
      },
    ]);
    expect(rec.publishConfirms).toBe(1);
    expect(rec.cards).toEqual([DEMO_SALON.customer]);
    expect(rec.serviceCards.map((c) => c.capability)).toEqual([
      'service_listing',
      'appointment_booking',
    ]);
    // advancing past the end is a no-op
    expect(await runner.advance()).toBeNull();
  });

  it('salon_setup shows a read-only preview; publishing waits for the popup confirm', async () => {
    // Decline the popup → the publish step does NOT advance and posts no
    // published card (nothing is shown as live until the user confirms).
    const declined = fakeSeams({ confirmPublish: false });
    const runner = new GuidedDemoRunner(declined.seams, { now: () => 1 });
    // Run up to and including salon_setup.
    const plan = buildDemoPlan();
    const setupIdx = plan.findIndex((a) => a.kind === 'salon_setup');
    for (let i = 0; i <= setupIdx; i += 1) await runner.advance();
    // Preview card posted; nothing published yet.
    expect(declined.rec.servicePreviewCards).toHaveLength(1);
    expect(declined.rec.serviceCards).toHaveLength(0);
    // Now on salon_publish. Decline keeps us on the same step (re-tappable).
    expect(runner.currentAction?.kind).toBe('salon_publish');
    await runner.advance();
    expect(declined.rec.publishConfirms).toBe(1);
    expect(declined.rec.serviceCards).toHaveLength(0); // still nothing published
    expect(runner.currentAction?.kind).toBe('salon_publish'); // stayed put
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
    runner.resumeAfter(SALON_REPLY_STEP);
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
