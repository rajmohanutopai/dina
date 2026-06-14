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

/** One scripted remember inside a chat step. The demo no longer calls the live
 *  LLM (too slow + network-dependent for a tour); instead it posts the message,
 *  pauses ~2s, and posts a deterministic "Stored in <vault> vault." reply. When
 *  `person` is set it's also seeded into People › Relations (scope-bound), so
 *  that navigable surface stays accurate without the real extraction. */
export interface DemoRemember {
  message: string;
  /** Vault the scripted reply names — e.g. 'General', 'Health', 'Finance'. */
  vault: string;
  /** Optional person to seed (name + relationship) so People › Relations shows it. */
  person?: { name: string; relation: string };
}

/** One scripted reminder enrichment card. The due date is anchored to the
 *  ABSOLUTE next Nov 7 (via {@link nextNovember7}), not an offset from "now"
 *  (a relative "now + N days" would print e.g. "JUN 15" while the body says
 *  "Nov 7" and contradict the copy). `daysBefore` then shifts a card EARLIER
 *  than the birthday: the lead "in a week" reminder fires 7 days before Nov 7
 *  (→ Oct 31), while the day-of reminder omits it and fires on Nov 7. */
export interface DemoReminder {
  text: string;
  /** Days before the event this reminder fires. Omitted/0 = on the day. */
  daysBefore?: number;
}

export interface DemoStep {
  /** Matches the active-demo `step` marker + orchestration order. */
  id: string;
  /** Execution kind. Defaults to 'chat' when omitted. */
  kind?: DemoStepKind;
  /** Which composer chip the step uses (chat steps). */
  mode: DemoMode;
  /** Message pre-filled — the question for recommend/service steps. Chat steps
   *  use `remembers` instead (this is kept as a fallback / for non-chat kinds). */
  message: string;
  /** Scripted remembers for a chat step (one Next tap → one or more, in order). */
  remembers?: readonly DemoRemember[];
  /** Reminder cards posted after the remembers (the birthday step's enrichment). */
  reminders?: readonly DemoReminder[];
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
    // Two remembers in one step: a family member and a friend, both seeded into
    // People › Relations (shown in the next step). The dinosaurs fact rides
    // along with Emma so the birthday reminder can still reference it.
    id: 'remember_people',
    mode: 'remember',
    message: 'Emma is my daughter, and she loves dinosaurs.',
    remembers: [
      {
        message: 'Emma is my daughter, and she loves dinosaurs.',
        vault: 'General',
        person: { name: 'Emma', relation: 'daughter' },
      },
      {
        message: 'Alonso, my friend, loves cold brew.',
        vault: 'General',
        person: { name: 'Alonso', relation: 'friend' },
      },
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
    remembers: [
      { message: "I've been getting a lot of lower back pain lately.", vault: 'Health' },
      { message: "I'm trying to keep my spending under $500 this month.", vault: 'Finance' },
    ],
    caption:
      'Now tell Dina something private. Health goes to your locked Health vault, money to your locked Finance vault.',
  },
  {
    id: 'remember_emma_birthday',
    mode: 'remember',
    message: "Emma's birthday is on Nov 7.",
    remembers: [{ message: "Emma's birthday is on Nov 7.", vault: 'General' }],
    // Scripted enrichment cards — the "it connected the dinosaurs fact" payoff
    // without a live LLM round-trip.
    reminders: [
      { text: "Emma's birthday is in a week (Nov 7). She loves dinosaurs, so maybe a dinosaur-themed gift.", daysBefore: 7 },
      { text: "Today is Emma's birthday! Wish your daughter a happy birthday." },
    ],
    caption:
      'Add a date and Dina sets a reminder. It links to what Dina already knows about Emma.',
  },
  {
    id: 'chair_ask',
    kind: 'recommend',
    mode: 'ask',
    message: 'Find me a good office chair.',
    caption:
      'Ask about anything out there, a product, a video, anything. Dina includes your preferences automatically, then checks ranked reviews from real people to help you choose.',
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
      c.price > DEMO_CHAIR_BUDGET ? `$${c.price}, over your budget` : `reviewers flag ${c.review}`;
    return `${c.product} (${why})`;
  });
  const answer =
    `For your lower-back pain and the $${DEMO_CHAIR_BUDGET} budget you set this month, ` +
    `reviewers point me to the ${pick.product} ($${pick.price}), ` +
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
  /** The reminder Dina sets, enriched from the cold-brew memory from step 1.
   *  Explicit line breaks + a TRAILING newline: this card is measured async and
   *  drops its last rendered line, so the trailing empty line absorbs the drop
   *  and all the real text shows. (Pragmatic demo workaround for a stubborn RN
   *  async-measure quirk specific to this card; the sync birthday reminders are
   *  unaffected. Not worth a deeper fix for a demo item.) */
  reminder: 'Alonso is coming over tomorrow morning.\nHe loves his cold brew, so maybe\nhave some ready.\n',
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
    'Got value from something? Add your own review so others benefit. Real people reviewing real things is what makes it trustworthy.',
} as const;

/** The salon service the user publishes in the FINALE — the flagship Tier-1
 *  scenario ("a phone and a sentence"). Everything here is scripted + scope-
 *  bound: no real persona, no real publish to the AppView, no real grant — all
 *  torn down on Exit. Beats: remember hours (→ scripted Salon vault) → publish
 *  (vault-scoped) → a customer's Dina asks for a slot → owner approves → reply. */
export const DEMO_SALON = {
  /** What the user remembers — seeds the (scripted) Salon vault. */
  hours: 'My salon is open Tue–Sat, 10am–6pm. Last slot 5pm.',
  vault: 'Salon',
  /** Service display name — the title on both salon cards. */
  serviceName: 'Your Salon',
  /** "Service published" card — structured result rendered through the same
   *  service-card path as the (removed) chair-availability card. Field-shape
   *  keys → fielded rows; `status` → a chip. */
  publishedResult: {
    status: 'published',
    answers_from: 'Salon vault',
    visibility: 'Public',
    booking: 'Owner approval',
  },
  publishedContent: 'Your salon is published, answering only from your Salon vault.',
  /** The incoming customer query — a stranger's Dina (services are open to any
   *  Dina via the directory, unlike contact-gated Talk). */
  customer: 'A customer\'s Dina asks your salon: "Any opening around 4pm Thursday?"',
  slot: '4pm Thursday',
  /** "Booking confirmed" card — shown after the owner approves. `confirmed`
   *  status → positive (green) tone. */
  bookingResult: {
    status: 'confirmed',
    appointment: '4pm Thursday',
    reply_sent: 'See you at 4pm Thursday',
  },
  bookingContent: 'Booked 4pm Thursday. Reply sent to the customer.',
  /** Captions for the three finale beats. */
  setupCaption:
    'Last, offer a service of your own. Tell Dina your salon hours, then publish. A phone and a sentence, no business account.',
  bookingCaption:
    'Now a customer\'s Dina asks your salon for a slot. It reads only your Salon vault, and books nothing without your OK.',
  replyCaption:
    'You approved, so Dina booked it and replied. A whole service, run from your phone.',
} as const;
