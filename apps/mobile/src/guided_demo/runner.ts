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
  DEMO_PUBLISH_DRAFT,
  DEMO_SERVICE_CAPABILITY,
  DEMO_SERVICE_PROVIDER_DID,
  DEMO_SERVICE_PROVIDER_NAME,
  DEMO_SERVICE_REQUEST,
  DEMO_SERVICE_RESPONSE,
  DEMO_STEPS,
  buildChairRecommendation,
  type DemoMode,
  type DemoStep,
} from './content';

/** Stable action ids for the non-chat steps (chat ids come from DemoStep.id). */
export const AGENT_APPROVAL_STEP = 'agent_approval';
export const PUBLISH_DRAFT_STEP = 'publish_draft';

/** A single agent-approval request the runner asks the user to act on. */
export interface DemoApprovalRequest {
  id: string;
  action: string;
  requesterDid: string;
  persona: string;
  reason: string;
  preview: string;
}

/** A resolved service-query card the runner posts for the availability step. */
export interface DemoServiceCard {
  taskId: string;
  capability: string;
  serviceName: string;
  providerDid: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  /** Narrative text shown if the card falls back to the generic renderer. */
  content: string;
}

/**
 * Side-effect seams the runner drives. Production binds these to the real
 * composer / approval manager / chat thread (`makeGuidedDemoSeams`); tests
 * bind fakes and assert ordering + payloads.
 */
export interface GuidedDemoSeams {
  /** Send a scripted message through the real /remember or /ask path. */
  send(mode: DemoMode, message: string): Promise<void>;
  /** Post a grounded recommendation as a real user→Dina chat exchange. */
  postRecommendation(question: string, answer: string): void;
  /** Post a REAL resolved service-query card (the furniture provider). */
  postServiceCard(card: DemoServiceCard): void;
  /** Create a real, pending agent-approval request → returns its id. */
  requestApproval(req: DemoApprovalRequest): string;
  /** Deny a previously created approval (teardown if the user never acted). */
  denyApproval(id: string): void;
  /** Post a scope-bound demo card into Chat (used for the publish draft). */
  postDemoCard(text: string): void;
}

/** A step in the linear demo plan. Discriminated by `kind`. */
export type DemoAction =
  | { kind: 'chat'; id: string; caption: string; step: DemoStep }
  | { kind: 'recommend'; id: string; caption: string; step: DemoStep }
  | { kind: 'service'; id: string; caption: string; step: DemoStep }
  | { kind: 'approval'; id: string; caption: string }
  | { kind: 'publish'; id: string; caption: string };

/**
 * Build the ordered action plan: the scripted content steps (chat or service,
 * per `step.kind`), then the agent approval, then the publish draft. Derives
 * the content steps from `content.ts` so the data lives in one place.
 */
export function buildDemoPlan(steps: readonly DemoStep[] = DEMO_STEPS): DemoAction[] {
  return [
    ...steps.map((step): DemoAction => {
      const kind =
        step.kind === 'service' ? 'service' : step.kind === 'recommend' ? 'recommend' : 'chat';
      return { kind, id: step.id, caption: step.caption, step };
    }),
    {
      kind: 'approval',
      id: AGENT_APPROVAL_STEP,
      caption: 'An agent asks to read Health — only you can approve it.',
    },
    {
      kind: 'publish',
      id: PUBLISH_DRAFT_STEP,
      caption: 'Turn your own context into a service others can ask — as a draft.',
    },
  ];
}

/** Build the resolved furniture-availability service card payload. */
export function buildDemoServiceCard(now: number): DemoServiceCard {
  const r = DEMO_SERVICE_RESPONSE;
  return {
    taskId: `guided-demo-service-${now}`,
    capability: DEMO_SERVICE_CAPABILITY,
    serviceName: DEMO_SERVICE_PROVIDER_NAME,
    providerDid: DEMO_SERVICE_PROVIDER_DID,
    params: { ...DEMO_SERVICE_REQUEST },
    result: { ...r },
    content: `${r.product} — ${r.available ? 'available' : 'unavailable'}, $${r.price}, ${r.nearby}, ${r.delivery}.`,
  };
}

/** The approval request the demo agent makes (real approval, demo subject). */
export function buildDemoApprovalRequest(now: number): DemoApprovalRequest {
  return {
    id: `guided-demo-approval-${now}`,
    action: 'read_vault',
    requesterDid: 'did:plc:demoshoppingagent',
    persona: DEMO_AGENT.persona,
    reason: DEMO_AGENT.reason,
    preview: `${DEMO_AGENT.name} requests ${DEMO_AGENT.persona} access (${DEMO_AGENT.access}).`,
  };
}

/** Human-readable summary of the publish-service draft card. */
export function describePublishDraft(): string {
  return (
    `Draft service · ${DEMO_PUBLISH_DRAFT.name} ` +
    `(${DEMO_PUBLISH_DRAFT.capability}, ${DEMO_PUBLISH_DRAFT.visibility}, ` +
    `${DEMO_PUBLISH_DRAFT.responsePolicy}). Draft only — nothing is published.`
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
      case 'chat':
        await this.seams.send(action.step.mode, action.step.message);
        break;
      case 'recommend': {
        const rec = buildChairRecommendation();
        this.seams.postRecommendation(rec.question, rec.answer);
        break;
      }
      case 'service':
        this.seams.postServiceCard(buildDemoServiceCard(this.now()));
        break;
      case 'approval': {
        const id = this.seams.requestApproval(buildDemoApprovalRequest(this.now()));
        this.pendingApprovals.push(id);
        break;
      }
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
