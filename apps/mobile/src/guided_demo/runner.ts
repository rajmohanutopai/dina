/**
 * Guided-demo runner — sequences the scripted demo actions through the REAL
 * app mechanisms. This module is pure orchestration: every side effect is an
 * injected seam (`GuidedDemoSeams`), so the flow is deterministic and unit
 * testable without a running app / LLM, while production wires the seams to the
 * real composer, approval manager, and chat thread (see `providers.ts`).
 *
 * The plan is the design doc's "smallest path that shows the product":
 *   1–4  scripted Chat messages (Emma memory, private context, chair ask,
 *        availability) sent through the NORMAL /remember + /ask paths;
 *   5    the demo Shopping Agent's Health-read request via the REAL approval
 *        manager (spec: "Do not fake the approval card");
 *   6    the publish-service draft card.
 * Cards/answers come from the real renderers; only the inputs are scripted.
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Functional Flow" + Phase 5.
 */

import { markGuidedDemoStep } from '@dina/core';

import {
  DEMO_AGENT,
  DEMO_D2D,
  DEMO_PUBLISH_DRAFT,
  DEMO_REVIEW,
  DEMO_SERVICE_CAPABILITY,
  DEMO_SERVICE_PROVIDER_DID,
  DEMO_SERVICE_PROVIDER_NAME,
  DEMO_SERVICE_REQUEST,
  DEMO_SERVICE_RESPONSE,
  DEMO_STEPS,
  DEMO_TASK,
  buildChairRecommendation,
  type DemoMode,
  type DemoNavTarget,
  type DemoReminder,
  type DemoStep,
} from './content';

/** Gap between paired remembers (people; health+finance) so the user reads the
 *  first "Stored in <vault>" reply before the next one fires. */
const INTER_MESSAGE_PAUSE_MS = 2000;

/** Stable action ids for the non-chat steps (chat ids come from DemoStep.id). */
export const D2D_MESSAGE_STEP = 'd2d_message';
export const AGENT_APPROVAL_STEP = 'agent_approval';
export const PEERLENS_REVIEW_STEP = 'peerlens_review';
export const PUBLISH_DRAFT_STEP = 'publish_draft';

/** A single agent-approval request the runner asks the user to act on. */
export interface DemoApprovalRequest {
  id: string;
  action: string;
  requesterDid: string;
  persona: string;
  reason: string;
  preview: string;
  /** Plain-language WHAT the agent is asking for (shown on the card). */
  what: string;
  /** Plain-language WHY (shown on the card) so the decision is informed. */
  why: string;
}

/** A resolved service-query card the runner posts for the availability step. */
export interface DemoServiceCard {
  taskId: string;
  capability: string;
  serviceName: string;
  providerDid: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  /** The user's question, posted as a user message before the result card. */
  question: string;
  /** Narrative text shown if the card falls back to the generic renderer. */
  content: string;
}

/**
 * Side-effect seams the runner drives. Production binds these to the real
 * composer / approval manager / chat thread (`makeGuidedDemoSeams`); tests
 * bind fakes and assert ordering + payloads.
 */
export interface GuidedDemoSeams {
  /** Post a scripted remember: the user message, a ~2s pause, then a
   *  deterministic "Stored in <vault> vault." reply. Deliberately NOT the live
   *  LLM path — a tour needs to be fast + reliable + offline-safe + repeatable.
   *  The outcomes (vault routing, people, enrichment) are still accurate, just
   *  scripted; the real app is one tap away for live behaviour. */
  send(mode: DemoMode, message: string, vault: string): Promise<void>;
  /** Seed a person + relationship into People › Relations (scope-bound), so the
   *  nav peek shows it without the live people-extraction. No-op without a repo. */
  seedPerson(person: { name: string; relation: string }): void;
  /** Post scripted reminder cards (the birthday-step enrichment). Each carries
   *  its own `dueInDays` so the rendered due date agrees with the body copy. */
  seedReminders(reminders: readonly DemoReminder[]): void;
  /** Post a grounded recommendation as a real user→Dina chat exchange. Async:
   *  the real impl posts the question, pauses (so the answer doesn't appear
   *  instantly and read as canned), then posts the answer. */
  postRecommendation(question: string, answer: string): Promise<void>;
  /** Post the user's question + a REAL resolved service-query card. Async for
   *  the same realistic "Dina is checking" pause before the card lands. */
  postServiceCard(card: DemoServiceCard): Promise<void>;
  /** Create a real, pending agent-approval request → returns its id. */
  requestApproval(req: DemoApprovalRequest): string;
  /** Deny a previously created approval (teardown if the user never acted). */
  denyApproval(id: string): void;
  /** Post a scope-bound demo card into Chat (used for the publish draft). */
  postDemoCard(text: string): void;
  /** Dina-to-Dina (Talk): post an incoming peer message, pause, then an
   *  enriched reminder. Async so the pause holds Next disabled. */
  postD2DMessage(from: string, message: string, reminder: string): Promise<void>;
  /** Post the PeerLens review card (with an inert Publish button in demo). */
  postReviewCard(review: { product: string; rating: number; text: string }): void;
  /** Post a plain user chat message (the task hand-off, not routed to an LLM). */
  postUserMessage(text: string): void;
  /** Drive the app to another surface (People › Relations / Chat). */
  navigate(target: DemoNavTarget): void;
  /** Pause for a beat. With no argument, the "Dina is checking / the agent is
   *  working" duration; with `ms`, a custom pause (e.g. the short gap between the
   *  two opening remembers). The real impl sleeps; fake seams resolve instantly
   *  so tests stay fast. Used where the pause sits BETWEEN two seam calls. */
  delay(ms?: number): Promise<void>;
}

/** A step in the linear demo plan. Discriminated by `kind`. */
export type DemoAction =
  | { kind: 'chat'; id: string; caption: string; step: DemoStep }
  | { kind: 'recommend'; id: string; caption: string; step: DemoStep }
  | { kind: 'service'; id: string; caption: string; step: DemoStep }
  | { kind: 'navigate'; id: string; caption: string; step: DemoStep }
  | { kind: 'd2d'; id: string; caption: string }
  | { kind: 'approval'; id: string; caption: string }
  | { kind: 'review'; id: string; caption: string }
  | { kind: 'publish'; id: string; caption: string };

/**
 * Build the ordered action plan: the scripted content steps (chat or service,
 * per `step.kind`), then the agent approval, then the publish draft. Derives
 * the content steps from `content.ts` so the data lives in one place.
 */
export function buildDemoPlan(steps: readonly DemoStep[] = DEMO_STEPS): DemoAction[] {
  return [
    ...steps.map((step): DemoAction => {
      const kind: DemoAction['kind'] =
        step.kind === 'service'
          ? 'service'
          : step.kind === 'recommend'
            ? 'recommend'
            : step.kind === 'navigate'
              ? 'navigate'
              : 'chat';
      return { kind, id: step.id, caption: step.caption, step };
    }),
    {
      kind: 'd2d',
      id: D2D_MESSAGE_STEP,
      caption: DEMO_D2D.caption,
    },
    {
      kind: 'approval',
      id: AGENT_APPROVAL_STEP,
      caption: DEMO_TASK.caption,
    },
    {
      kind: 'review',
      id: PEERLENS_REVIEW_STEP,
      caption: DEMO_REVIEW.caption,
    },
    {
      kind: 'publish',
      id: PUBLISH_DRAFT_STEP,
      caption:
        'Provide a service of your own. A bus driver could publish live bus ETAs for other Dinas to query, answered by your OpenClaw or another agent, public or private.',
    },
  ];
}

/** Build the resolved furniture-availability service card payload (+ the
 *  user's question, posted before the card). */
export function buildDemoServiceCard(now: number, question: string): DemoServiceCard {
  const r = DEMO_SERVICE_RESPONSE;
  return {
    taskId: `guided-demo-service-${now}`,
    capability: DEMO_SERVICE_CAPABILITY,
    serviceName: DEMO_SERVICE_PROVIDER_NAME,
    providerDid: DEMO_SERVICE_PROVIDER_DID,
    params: { ...DEMO_SERVICE_REQUEST },
    result: { ...r },
    question,
    content: `${r.product}: ${r.available ? 'available' : 'unavailable'} at ${r.seller}, $${r.price}, ${r.nearby}. ${r.delivery}.`,
  };
}

/** The approval request the demo agent makes (real approval, demo subject).
 *  Carries plain-language what/why so the card prompt is actually decidable. */
export function buildDemoApprovalRequest(now: number): DemoApprovalRequest {
  return {
    id: `guided-demo-approval-${now}`,
    action: 'read_vault',
    requesterDid: 'did:plc:demoshoppingagent',
    persona: DEMO_AGENT.persona,
    reason: DEMO_AGENT.why,
    preview: `${DEMO_AGENT.name}: ${DEMO_AGENT.what}. ${DEMO_AGENT.why}`,
    what: DEMO_AGENT.what,
    why: DEMO_AGENT.why,
  };
}

/** Human-readable summary of the PeerLens review the user contributes back. */
export function describePeerLensReview(): string {
  return (
    `PeerLens review · ${DEMO_REVIEW.product} · ${DEMO_REVIEW.rating}/5 · ` +
    `"${DEMO_REVIEW.text}" Draft only, you choose when to publish.`
  );
}

/** Human-readable summary of the publish-service draft card. */
export function describePublishDraft(): string {
  return (
    `Draft service · ${DEMO_PUBLISH_DRAFT.name} ` +
    `(${DEMO_PUBLISH_DRAFT.capability}, ${DEMO_PUBLISH_DRAFT.visibility}, ` +
    `${DEMO_PUBLISH_DRAFT.responsePolicy}). Draft only, nothing is published.`
  );
}

export interface GuidedDemoRunnerOptions {
  /** Clock injection so action ids are deterministic in tests. */
  now?: () => number;
  /** Override the plan (tests). Defaults to `buildDemoPlan()`. */
  plan?: DemoAction[];
}

/**
 * Drives the demo plan one action at a time. The UI calls `advance()` on each
 * "Next" tap so the user watches every real step happen; `teardown()` denies
 * any approval the user left pending so it doesn't outlive the demo.
 */
export class GuidedDemoRunner {
  private readonly plan: DemoAction[];
  private readonly now: () => number;
  private index = 0;
  private readonly pendingApprovals: string[] = [];

  constructor(
    private readonly seams: GuidedDemoSeams,
    options: GuidedDemoRunnerOptions = {},
  ) {
    this.plan = options.plan ?? buildDemoPlan();
    this.now = options.now ?? (() => Date.now());
  }

  /** Total number of actions in the plan. */
  get total(): number {
    return this.plan.length;
  }

  /** Zero-based index of the NEXT action to run (== completed count). */
  get position(): number {
    return this.index;
  }

  /** The next action to run, or null when the demo is complete. */
  get currentAction(): DemoAction | null {
    return this.plan[this.index] ?? null;
  }

  /** True once every action has run. */
  get isComplete(): boolean {
    return this.index >= this.plan.length;
  }

  /**
   * Resume after the last COMPLETED step (the marker persisted by
   * `markGuidedDemoStep`). Positions the cursor at the action AFTER the match,
   * so a recovered demo continues where it left off. Unknown/empty marker →
   * start from the beginning.
   */
  resumeAfter(stepId: string): void {
    const idx = this.plan.findIndex((a) => a.id === stepId);
    this.index = idx < 0 ? 0 : Math.min(idx + 1, this.plan.length);
  }

  /**
   * Run the next action through its real seam and advance. Returns the action
   * that ran, or null if the demo was already complete. Throws are propagated
   * so the UI can surface a step failure; the index only advances on success.
   */
  async advance(): Promise<DemoAction | null> {
    const action = this.currentAction;
    if (action === null) return null;
    switch (action.kind) {
      case 'chat': {
        // Scripted remembers (no live LLM): one or several per step, each posts
        // the message, pauses, then a deterministic "Stored in <vault>" reply.
        // A short gap between them so the user reads each reply before the next
        // remember fires. People are seeded so the nav peek stays accurate.
        const remembers = action.step.remembers ?? [
          { message: action.step.message, vault: 'General' },
        ];
        for (const [i, r] of remembers.entries()) {
          if (i > 0) await this.seams.delay(INTER_MESSAGE_PAUSE_MS);
          await this.seams.send(action.step.mode, r.message, r.vault);
          if (r.person !== undefined) this.seams.seedPerson(r.person);
        }
        // Step-level enrichment cards (e.g. the birthday reminders).
        if (action.step.reminders !== undefined && action.step.reminders.length > 0) {
          this.seams.seedReminders(action.step.reminders);
        }
        break;
      }
      case 'recommend': {
        const rec = buildChairRecommendation();
        // Awaited so the "Dina is checking" pause holds Next disabled until the
        // answer actually lands (no instant, obviously-canned response).
        await this.seams.postRecommendation(rec.question, rec.answer);
        break;
      }
      case 'service':
        await this.seams.postServiceCard(buildDemoServiceCard(this.now(), action.step.message));
        break;
      case 'navigate':
        // Drive the app to another surface (People › Relations / Chat). No
        // message; the navigation IS the step.
        if (action.step.navigateTo !== undefined) this.seams.navigate(action.step.navigateTo);
        break;
      case 'approval': {
        // Task hand-off: the user delegates a task (email the manager); the agent
        // then works on it and comes back asking to read Health. Pause between the
        // hand-off and the approval card so it reads like the agent processed the
        // task, not an instant canned prompt.
        this.seams.postUserMessage(DEMO_TASK.message);
        await this.seams.delay();
        const id = this.seams.requestApproval(buildDemoApprovalRequest(this.now()));
        this.pendingApprovals.push(id);
        break;
      }
      case 'd2d':
        // Dina-to-Dina Talk: a friend's Dina messages; Dina sets an enriched
        // reminder (from the cold-brew memory). Pauses internally like service.
        await this.seams.postD2DMessage(DEMO_D2D.from, DEMO_D2D.message, DEMO_D2D.reminder);
        break;
      case 'review':
        // Give back: contribute a PeerLens review card (inert Publish in demo).
        this.seams.postReviewCard({
          product: DEMO_REVIEW.product,
          rating: DEMO_REVIEW.rating,
          text: DEMO_REVIEW.text,
        });
        break;
      case 'publish':
        this.seams.postDemoCard(describePublishDraft());
        break;
    }
    // Persist progress for crash recovery, then advance the cursor.
    await markGuidedDemoStep(action.id);
    this.index += 1;
    return action;
  }

  /** Run every remaining action in order (used by tests / non-interactive runs). */
  async runAll(): Promise<void> {
    while (!this.isComplete) {
      await this.advance();
    }
  }

  /**
   * Deny any approval the runner created that the user never resolved, so a
   * demo approval can't survive the demo. Idempotent.
   */
  teardown(): void {
    while (this.pendingApprovals.length > 0) {
      const id = this.pendingApprovals.pop();
      if (id === undefined) break;
      try {
        this.seams.denyApproval(id);
      } catch {
        /* already resolved / removed — nothing to do */
      }
    }
  }
}
