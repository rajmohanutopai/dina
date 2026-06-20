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
  DEMO_SALON,
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
 *  first "Stored in <vault>" reply before the next one fires. Bumped from 2000
 *  — health/finance ran too fast to read on a real device. */
const INTER_MESSAGE_PAUSE_MS = 3500;

/** Stable action ids for the non-chat steps (chat ids come from DemoStep.id). */
export const D2D_MESSAGE_STEP = 'd2d_message';
export const AGENT_APPROVAL_STEP = 'agent_approval';
export const PEERLENS_REVIEW_STEP = 'peerlens_review';
/** Salon finale — three beats: publish from vault, customer booking + approval,
 *  reply back. (Replaces the old abstract publish-draft step.) */
export const SALON_SETUP_STEP = 'salon_setup';
export const SALON_PUBLISH_STEP = 'salon_publish';
export const SALON_BOOKING_STEP = 'salon_booking';
export const SALON_REPLY_STEP = 'salon_reply';

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

/** A READ-ONLY services-page preview card — the salon listing shown before the
 *  publish popup (status: "Not published yet"). No actions; purely informational. */
export interface DemoServicePreviewCard {
  serviceName: string;
  capability: string;
  answersFrom: string;
  status: string;
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
  /** Wipe the demo chat stage so each step demos on a clean screen instead of
   *  an ever-growing pile of bubbles. SCOPE-BOUND: the impl clears the `main`
   *  thread, whose persisted delete filters on the active `guided_demo:*` data
   *  scope — it never touches the user's real (`data_scope='user'`) chat, which
   *  isn't even in memory during the demo. Called by the runner at the start of
   *  a step unless `step.clearStageBefore === false`. */
  clearStage(): void;
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
  /** Post a READ-ONLY "your services page" preview card (the salon listing as it
   *  would appear in My Listings) — shown after the hours are stored, before the
   *  publish popup, so the user sees what they are about to publish. */
  postServicePreviewCard(card: DemoServicePreviewCard): void;
  /** Show the publish confirmation popup (real native Alert). Resolves true when
   *  the user confirms, false on cancel/dismiss. */
  confirmPublish(): Promise<boolean>;
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

/** Fields shared by every demo action, regardless of `kind`. */
interface DemoActionShared {
  id: string;
  caption: string;
  /**
   * Whether to wipe the (demo-scoped) chat stage when this action BEGINS.
   * Defaults to `true` (each action demos one capability on a clean screen).
   * Set `false` for an action that intentionally BUILDS on what the previous
   * action left on screen:
   *   - scripted content steps carry it up from {@link DemoStep.clearStageBefore}
   *     (the recall/synthesis moments where the prior bubbles are the proof);
   *   - the salon finale's `salon_publish` / `salon_reply` beats continue the
   *     scene the beat before them set up. Clearing there blanks the chat during
   *     the publish/booking `await` (the user sees the empty pre-demo screen) and
   *     breaks the "one continuous flow" — the publish flow is a single action.
   */
  clearStageBefore?: boolean;
}

/** A step in the linear demo plan. Discriminated by `kind`. */
export type DemoAction = DemoActionShared &
  (
    | { kind: 'chat'; step: DemoStep }
    | { kind: 'recommend'; step: DemoStep }
    | { kind: 'service'; step: DemoStep }
    | { kind: 'navigate'; step: DemoStep }
    | { kind: 'd2d' }
    | { kind: 'approval' }
    | { kind: 'review' }
    | { kind: 'salon_setup' }
    | { kind: 'salon_publish' }
    | { kind: 'salon_booking' }
    | { kind: 'salon_reply' }
  );

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
      // Carry the step's own clear policy up to the action level so the runner
      // reads one field for every action kind.
      return { kind, id: step.id, caption: step.caption, step, clearStageBefore: step.clearStageBefore };
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
    // ── Salon finale: two continuous scenes, not four isolated clears. ──
    // Scene 1 (publish): salon_setup clears (fresh start after the review card),
    // then salon_publish BUILDS on the listing preview it left — so the preview
    // stays under the publish popup and the published card joins it, with no
    // blank chat during the publish await.
    {
      kind: 'salon_setup',
      id: SALON_SETUP_STEP,
      caption: DEMO_SALON.setupCaption,
    },
    {
      kind: 'salon_publish',
      id: SALON_PUBLISH_STEP,
      caption: DEMO_SALON.publishCaption,
      clearStageBefore: false,
    },
    // Scene 2 (booking): salon_booking clears (a customer arrives — new scene),
    // then salon_reply BUILDS on the approval card it left — the confirmation
    // lands under the approved request, again with no blank chat during the await.
    {
      kind: 'salon_booking',
      id: SALON_BOOKING_STEP,
      caption: DEMO_SALON.bookingCaption,
    },
    {
      kind: 'salon_reply',
      id: SALON_REPLY_STEP,
      caption: DEMO_SALON.replyCaption,
      clearStageBefore: false,
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
    `Ranked Reviews · ${DEMO_REVIEW.product} · ${DEMO_REVIEW.rating}/5 · ` +
    `"${DEMO_REVIEW.text}" Draft only, you choose when to publish.`
  );
}

/** The salon booking-approval request (real approval manager, demo subject —
 *  teardown-denied). A customer's Dina wants to book a slot; the owner approves. */
export function buildSalonApprovalRequest(now: number): DemoApprovalRequest {
  return {
    id: `guided-demo-salon-${now}`,
    action: 'confirm_booking',
    requesterDid: 'did:plc:demosaloncustomer',
    persona: 'general',
    reason: `A customer wants to book ${DEMO_SALON.slot}.`,
    preview: `Booking request: ${DEMO_SALON.slot}. Approve to confirm and reply.`,
    what: `Confirm a ${DEMO_SALON.slot} appointment`,
    why: 'A customer asked your salon for this slot; approving books it and replies.',
  };
}

/** Read-only "your services page" preview — the salon listing as it would appear
 *  in My Listings, shown BEFORE the publish popup (status: not published yet). */
export function buildSalonPreviewCard(): DemoServicePreviewCard {
  return {
    serviceName: DEMO_SALON.serviceName,
    capability: DEMO_SALON.preview.capability,
    answersFrom: DEMO_SALON.preview.answersFrom,
    status: DEMO_SALON.preview.status,
  };
}

/** "Service published" card — rendered through the same resolved service-card
 *  path as the (removed) chair availability card, so publishing is a proper
 *  fielded card, not a plain line. */
export function buildSalonPublishedCard(now: number): DemoServiceCard {
  return {
    taskId: `guided-demo-salon-pub-${now}`,
    capability: 'service_listing',
    serviceName: DEMO_SALON.serviceName,
    providerDid: 'did:plc:demosalon',
    params: {},
    result: { ...DEMO_SALON.publishedResult },
    question: '', // you published — you weren't asked, so no user question
    content: DEMO_SALON.publishedContent,
  };
}

/** "Booking confirmed" card — rendered after the owner approves. */
export function buildSalonBookingCard(now: number): DemoServiceCard {
  return {
    taskId: `guided-demo-salon-book-${now}`,
    capability: 'appointment_booking',
    serviceName: DEMO_SALON.serviceName,
    providerDid: 'did:plc:demosalon',
    params: {},
    result: { ...DEMO_SALON.bookingResult },
    question: '',
    content: DEMO_SALON.bookingContent,
  };
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

  /** The action whose result is currently ON SCREEN — the last one that ran —
   *  or null before any step has run. The dock uses this to describe the step
   *  the user is looking at, rather than the next one the button will run. */
  get previousAction(): DemoAction | null {
    return this.index > 0 ? (this.plan[this.index - 1] ?? null) : null;
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
    // Declutter: wipe the demo stage as this action BEGINS (so the prior step's
    // result stayed readable until the user tapped Next). Default on; an action
    // opts out with `clearStageBefore: false` to build on what's already on
    // screen — the recall/synthesis chat steps AND the salon finale's
    // publish/reply beats (which continue the scene the prior beat set up; see
    // buildDemoPlan + DemoActionShared). A multi-message action that DOES clear
    // (approval / d2d / salon_setup / salon_booking) clears once here, never
    // mid-flow — its own messages then accumulate within the single action.
    // Scope-bound to guided_demo:* (see GuidedDemoSeams.clearStage); never
    // touches real chat.
    if (action.clearStageBefore !== false) {
      this.seams.clearStage();
    }
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
        // Task hand-off: the user delegates a task (email the manager); Dina
        // relays it to the connected agent, which then works on it and comes back
        // asking to read Health. The "sending to the agent" status line makes
        // Dina's gateway role explicit. Pause after it so it reads like the agent
        // processed the task, not an instant canned prompt.
        this.seams.postUserMessage(DEMO_TASK.message);
        this.seams.postDemoCard(DEMO_TASK.dispatch);
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
      case 'salon_setup':
        // Provider side: remember the salon's hours (→ scripted Salon vault),
        // then a READ-ONLY services-page preview so the user SEES the listing
        // before publishing. Nothing is live yet. All scope-bound.
        await this.seams.send('remember', DEMO_SALON.hours, DEMO_SALON.vault);
        await this.seams.delay();
        this.seams.postServicePreviewCard(buildSalonPreviewCard());
        break;
      case 'salon_publish': {
        // Explicit publish act: a confirmation popup, then the "Service
        // published" card. Decline → stay on this step (re-tappable) so nothing
        // is shown as published until the user actually confirms.
        const published = await this.seams.confirmPublish();
        if (!published) return action; // no mark/advance — user can publish later
        await this.seams.postServiceCard(buildSalonPublishedCard(this.now()));
        break;
      }
      case 'salon_booking': {
        // A customer's Dina queries the published salon, then a REAL booking
        // approval card (demo subject, teardown-denied — nothing is granted).
        this.seams.postDemoCard(DEMO_SALON.customer);
        await this.seams.delay();
        const salonId = this.seams.requestApproval(buildSalonApprovalRequest(this.now()));
        this.pendingApprovals.push(salonId);
        break;
      }
      case 'salon_reply':
        // Owner approved → Dina books it and replies; a structured "Booking
        // confirmed" card (positive tone) closes the demo.
        await this.seams.postServiceCard(buildSalonBookingCard(this.now()));
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
