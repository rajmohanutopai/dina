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
 *   'service'   — posts a REAL resolved service-query card (the deterministic
 *                 furniture-availability provider) so the service path card
 *                 always renders.
 */
export type DemoStepKind = 'chat' | 'recommend' | 'service';

export interface DemoStep {
  /** Matches the active-demo `step` marker + orchestration order. */
  id: string;
  /** Execution kind. Defaults to 'chat' when omitted. */
  kind?: DemoStepKind;
  /** Which composer chip the step uses (chat steps). */
  mode: DemoMode;
  /** Message pre-filled + sent through the real path. */
  message: string;
  /** Short narration shown before the step. */
  caption: string;
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
    id: 'remember_emma_relation',
    mode: 'remember',
    message: 'Emma is my daughter.',
    caption: 'Start by telling Dina about someone in your life.',
  },
  {
    id: 'remember_emma_likes',
    mode: 'remember',
    message: 'Emma loves dinosaurs.',
    caption: 'Add something she likes — Dina just quietly remembers it.',
  },
  {
    id: 'remember_back',
    mode: 'remember',
    message: "I've been getting a lot of lower back pain lately.",
    caption: 'Now switch topics — tell Dina something about your health.',
  },
  {
    id: 'remember_budget',
    mode: 'remember',
    message: "I'm trying to keep my spending under $500 this month.",
    caption: 'And set yourself a budget for the month.',
  },
  {
    id: 'remember_emma_birthday',
    mode: 'remember',
    message: "Emma's birthday is on Nov 7.",
    caption: 'Add a date — watch Dina tie it back to what you said earlier.',
  },
  {
    id: 'chair_ask',
    kind: 'recommend',
    mode: 'ask',
    message: 'Find me a good office chair.',
    caption: 'Now ask — Dina draws on everything above, no need to repeat yourself.',
  },
  {
    id: 'chair_availability',
    kind: 'service',
    mode: 'ask',
    message: 'Is the ErgoFlex chair available near me?',
    caption: 'Dina checks the service network — sharing only the minimum.',
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
    `PeerLens reviewers point me to the ${pick.product} ($${pick.price}) — ` +
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

/** Canned response from the demo furniture-availability provider. */
export const DEMO_SERVICE_RESPONSE = {
  product: 'ErgoFlex Study Chair',
  available: true,
  price: 420,
  nearby: 'San Francisco',
  delivery: '2 days',
} as const;

export const DEMO_SERVICE_PROVIDER_NAME = 'Demo Furniture Availability Provider';
export const DEMO_SERVICE_PROVIDER_DID = 'did:plc:demofurniture';
export const DEMO_SERVICE_CAPABILITY = 'product_availability';
/** The minimal params shared with the provider — no health/budget/person facts. */
export const DEMO_SERVICE_REQUEST: DemoServiceParams = {
  product: 'ErgoFlex Study Chair',
  location: 'near me',
};

/** The demo agent that requests Health access through the REAL approval flow. */
export const DEMO_AGENT = {
  name: 'Demo Shopping Agent',
  persona: 'health',
  access: 'read, this task only',
  reason: 'compare ergonomic fit for office chairs',
} as const;

/** The publish-service draft shown in Step 7 (draft only — never auto-published). */
export const DEMO_PUBLISH_DRAFT = {
  name: 'Chair availability checker',
  capability: 'product_availability',
  visibility: 'unlisted',
  responsePolicy: 'review',
} as const;
