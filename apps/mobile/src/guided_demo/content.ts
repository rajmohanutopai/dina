/**
 * Guided-demo scripted content — the step inputs the orchestrator pre-fills and
 * sends through the NORMAL /remember + /ask paths, plus the deterministic demo
 * data providers (PeerLens chair data, furniture-availability service, demo
 * agent). Cards/answers come from the real renderers; only the inputs + seed
 * data are scripted.
 *
 * SCOPE OF FIDELITY (intentional — this is a product-story walkthrough, NOT an
 * end-to-end test): the `remember`/`ask` steps run the REAL pipeline (intent
 * routing, scoped vault writes, people extraction, reminders, enrichment). But
 * the PeerLens recommendation (`recommend`), the service availability check
 * (`service`), and the agent-safety approval are SIMULATED with deterministic
 * seed data + real-shaped cards — they do NOT exercise the real PeerLens
 * AppView, real cross-Dina service D2D resolution, or the real external-agent
 * gateway. That's deliberate (a free /ask hallucinates without live PeerLens
 * data wired into the boot AppView; a real service round-trip needs a second
 * Dina). Real end-to-end coverage of those paths lives elsewhere — the MRS
 * suite + the bus-driver services scenario (docs/BUSDRIVER_SERVICES_SCENARIO.md)
 * + the system tests — not in this in-app demo.
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Functional Flow" + "Demo Data Providers"
 */

export type DemoMode = 'remember' | 'ask';

/**
 * How a step is executed:
 *   'chat'      — the message is sent through the real /remember | /ask composer;
 *   'recommend' — posts the user's question + a deterministic, GROUNDED Dina
 *                 recommendation built from the demo PeerLens chairs + the
 *                 user's stored back-pain/budget. Deterministic on purpose: a
 *                 free /ask hallucinates fake peer reviews when no real PeerLens
 *                 data is wired (the boot AppView can't be runtime-injected),
 *                 which would violate the demo's Verified-Truth premise;
 *   'service'   — posts the user's question + a REAL resolved service-query card
 *                 (the deterministic furniture-availability provider) so the
 *                 service path card always renders;
 *   'navigate'  — drives the app to another surface (e.g. People › Relations)
 *                 so the user SEES where the just-remembered data landed, then
 *                 back to Chat. No message is sent.
 */
export type DemoStepKind = 'chat' | 'recommend' | 'service' | 'navigate';

/** Targets a `navigate` step can drive to. */
export type DemoNavTarget = 'people-relations' | 'chat';

export interface DemoStep {
  /** Matches the active-demo `step` marker + orchestration order. */
  id: string;
  /** Execution kind. Defaults to 'chat' when omitted. */
  kind?: DemoStepKind;
  /** Which composer chip the step uses (chat steps). */
  mode: DemoMode;
  /** Message pre-filled + sent through the real path (chat/recommend/service). */
  message: string;
  /** Optional: send MULTIPLE messages in one step (one Next tap), in order.
   *  Used by the opening step to remember Emma AND Alonso together. When set,
   *  `message` is ignored. */
  messages?: readonly string[];
  /** Short narration shown before the step. */
  caption: string;
  /** For `navigate` steps: where to drive the app. */
  navigateTo?: DemoNavTarget;
  /** Optional override for the dock's advance-button label (navigate steps). */
  nextLabel?: string;
}

/**
 * The smallest path that shows the product (design doc Final Recommendation):
 * Emma relation + dinosaur birthday reminder → back-pain/budget chair rec →
 * service availability. Agent-safety + publish are event/draft steps handled
 * outside this linear list (real approval + draft).
 */
export const DEMO_STEPS: readonly DemoStep[] = [
  // Each fact is its own message so the user SEES Dina ingest them
  // separately — then watch it connect them (the birthday reminder picks up
  // the dinosaurs fact; the chair rec applies the month's budget). One blob
  // hides that; separate inputs make the "it remembered + connected" obvious.
  {
    // Two remembers in one step: a family member and a friend, so the people
    // graph (next step) shows both. The dinosaurs fact rides along with Emma so
    // the later birthday reminder can still enrich with it.
    id: 'remember_people',
    mode: 'remember',
    message: 'Emma is my daughter, and she loves dinosaurs.',
    messages: [
      'Emma is my daughter, and she loves dinosaurs.',
      'Alonso, my friend, loves cold brew.',
    ],
    caption: 'Start by telling Dina about the people in your life, family and friends.',
  },
  // One nav step (no back-and-forth): peek at People › Relations to SEE both
  // land. The next step's send returns to chat automatically.
  {
    id: 'show_relations',
    kind: 'navigate',
    mode: 'remember',
    message: '',
    navigateTo: 'people-relations',
    caption: 'Dina automatically added Emma and Alonso to People › Relations.',
    nextLabel: 'Show me',
  },
  {
    // Two private facts in one step (like the people step): health and money.
    // Each routes to its own locked vault, so they pair naturally.
    id: 'remember_private',
    mode: 'remember',
    message: "I've been getting a lot of lower back pain lately.",
    messages: [
      "I've been getting a lot of lower back pain lately.",
      "I'm trying to keep my spending under $500 this month.",
    ],
    caption:
      'Now tell Dina something private. Health goes to your locked Health vault, money to your locked Finance vault.',
  },
  {
    id: 'remember_emma_birthday',
    mode: 'remember',
    message: "Emma's birthday is on Nov 7.",
    caption:
      'Add a date and Dina sets a reminder. It links to what Dina already knows about Emma.',
  },
  {
    id: 'chair_ask',
    kind: 'recommend',
    mode: 'ask',
    message: 'Find me a good office chair.',
    caption:
      'Ask about anything out there, a product, a video, anything. Dina includes your preferences automatically, then checks PeerLens, a network of reviews and suggestions, to help you choose.',
  },
  {
    id: 'chair_availability',
    kind: 'service',
    mode: 'ask',
    message: 'Where can I get the ErgoFlex Study Chair?',
    caption:
      'Next is the Service Network, all the other Dinas offering services. Dina finds the best provider and talks to their Dina to get a custom answer. That provider cannot message you, because it is not your contact.',
  },
] as const;

/**
 * Next upcoming November 7 at-or-after `now`, returned as a local Date. The
 * YEAR is derived from `now`, never hardcoded (design doc Step 1 implementation
 * note) — so the demo's reminder is always for the next real birthday.
 */
export function nextNovember7(now: Date): Date {
  const NOV = 10; // month index
  const DAY = 7;
  const candidate = new Date(now.getFullYear(), NOV, DAY);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // "Upcoming" includes today: only roll forward when Nov 7 has already passed.
  return candidate < today ? new Date(now.getFullYear() + 1, NOV, DAY) : candidate;
}

// ── Deterministic demo data providers ──────────────────────────────────────

export interface DemoChair {
  product: string;
  price: number;
  review: string;
  trust: 'high' | 'medium' | 'low';
}

/** PeerLens chair dataset (design doc § "PeerLens Demo Data"). The real /ask
 *  reasons over this: recommend ErgoFlex (in budget + good back support),
 *  reject BudgetLite (poor back support), reject SpinePro (over budget). */
export const DEMO_PEERLENS_CHAIRS: readonly DemoChair[] = [
  { product: 'ErgoFlex Study Chair', price: 420, review: 'good lower-back support', trust: 'high' },
  {
    product: 'BudgetLite Chair',
    price: 350,
    review: 'poor back support after long sessions',
    trust: 'medium',
  },
  { product: 'SpinePro Chair', price: 850, review: 'excellent support', trust: 'high' },
] as const;

/** The user's stated chair budget (from the remember_context step). */
export const DEMO_CHAIR_BUDGET = 500;

/**
 * The grounded chair recommendation, DERIVED from `DEMO_PEERLENS_CHAIRS` +
 * the budget so it stays in sync. Picks the in-budget chair with good back
 * support (ErgoFlex), and explains why the others are out (poor back support /
 * over budget). Returned as the user's question + Dina's answer so the demo
 * renders a real Q→A exchange. This is the demo's PeerLens result: it cites
 * ONLY the seeded demo reviews — never invents peers.
 */
export function buildChairRecommendation(): { question: string; answer: string } {
  const inBudgetGoodBack = DEMO_PEERLENS_CHAIRS.find(
    (c) => c.price <= DEMO_CHAIR_BUDGET && /back/i.test(c.review) && !/poor/i.test(c.review),
  );
  const pick = inBudgetGoodBack ?? DEMO_PEERLENS_CHAIRS[0];
  const rejects = DEMO_PEERLENS_CHAIRS.filter((c) => c.product !== pick.product).map((c) => {
    const why =
      c.price > DEMO_CHAIR_BUDGET ? `$${c.price}, over your budget` : `PeerLens flags ${c.review}`;
    return `${c.product} (${why})`;
  });
  const answer =
    `For your lower-back pain and the $${DEMO_CHAIR_BUDGET} budget you set this month, ` +
    `PeerLens reviewers point me to the ${pick.product} ($${pick.price}), ` +
    `rated well for ${pick.review} (trust: ${pick.trust}). ` +
    `I set aside ${rejects.join(' and ')}. ` +
    `Want me to check if it's available near you?`;
  return { question: 'Find me a good office chair.', answer };
}

/** The minimal, typed request the demo furniture service receives. It must
 *  NOT carry the user's health/budget/person facts (design doc Step 5). */
export interface DemoServiceParams {
  product: string;
  location: string;
}

/** Canned response from the demo furniture-availability provider. Richer than a
 *  yes/no so the resolved card reads like a real availability result. */
export const DEMO_SERVICE_RESPONSE = {
  product: 'ErgoFlex Study Chair',
  available: true,
  price: 420,
  currency: 'USD', // → the card money-formats price as "$420"
  seller: 'ChairMaker (verified)',
  nearby: 'San Francisco · 2.3 mi',
  stock: 'In stock',
  delivery: 'Free delivery in 2 days',
} as const;

export const DEMO_SERVICE_PROVIDER_NAME = 'Demo Furniture Availability Provider';
export const DEMO_SERVICE_PROVIDER_DID = 'did:plc:demofurniture';
export const DEMO_SERVICE_CAPABILITY = 'product_availability';
/** The minimal params shared with the provider — no health/budget/person facts. */
export const DEMO_SERVICE_REQUEST: DemoServiceParams = {
  product: 'ErgoFlex Study Chair',
  location: 'near me',
};

/** The task the user hands off, which the agent then executes — needing Health
 *  access along the way (the demo's agent-safety moment). A draft-an-email task
 *  (NOT a purchase: Dina never touches money — see the Four Laws) that naturally
 *  needs the Health vault (the lower-back note from the earlier remember step). */
export const DEMO_TASK = {
  /** What the user types to delegate the task. */
  message: 'Email my manager about my health condition.',
  caption:
    'Hand off a task to OpenClaw or another agent. Dina is the safety layer: for locked data or risky actions, the agent can get your approval through Dina.',
} as const;

/** The demo agent that requests Health access through the REAL approval flow.
 *  `what`/`why` are shown verbatim on the approval card so the decision is
 *  actually informed (not a generic "an agent wants access"). */
export const DEMO_AGENT = {
  name: 'Email assistant',
  persona: 'health',
  access: 'read, this task only',
  /** Plain-language WHAT is being requested. */
  what: 'Read your Health vault',
  /** Plain-language WHY — tied to the task in flight. */
  why: 'To draft your email to your manager about your health condition.',
} as const;

/** The Dina-to-Dina (Talk) moment: a friend's Dina messages yours, and the
 *  reminder Dina sets is enriched from memory (the cold-brew fact remembered in
 *  step 1). Contact-gated: only mutual contacts can reach you. */
export const DEMO_D2D = {
  from: 'Alonso',
  message: 'Heading over tomorrow morning, looking forward to it!',
  /** The reminder Dina sets, enriched from the cold-brew memory from step 1. */
  reminder: 'Alonso is coming over tomorrow morning. He loves his cold brew, so maybe have some ready.',
  caption:
    'Talk to your friends over end-to-end encrypted channels. Dina reads what comes in, tells you what matters, and sets reminders enriched with what it already knows. Only people you have both added as contacts can reach you.',
} as const;

/** The PeerLens review the user contributes back. Grounded in the chair they
 *  just researched, so the "give back" step ties to the earlier ask. */
export const DEMO_REVIEW = {
  product: 'ErgoFlex Study Chair',
  rating: 5,
  text: 'Solid lower-back support, worth it.',
  caption:
    'Got value from something? Add a PeerLens review so others benefit. Real people reviewing real things is what makes PeerLens trustworthy.',
} as const;

/** The publish-service draft shown in the final step (draft only, never
 *  auto-published). */
export const DEMO_PUBLISH_DRAFT = {
  name: 'Chair availability checker',
  capability: 'product_availability',
  visibility: 'unlisted',
  responsePolicy: 'review',
} as const;
