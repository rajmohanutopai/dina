# LLM Cost × Quality — Live Findings (2026-06-12)

Measured live on the iOS sim against the real agentic loop (not estimates),
via the `[LLM-USAGE]` adapter telemetry (logs the **resolved** model id —
e.g. `deepseek/deepseek-v4-flash` — so the model under test is provable, not
assumed; cross-checked against the OpenRouter dashboard per-model usage).
Prices: Gemini 3.5 Flash $1.50/$9.00 per M (in/out); DeepSeek V4 Pro
$0.435/$0.87; DeepSeek V4 Flash $0.098/$0.196; ~₹87/$. Caching where the
conversation was warm.

## Per-query cost (measured)

| Query | Gemini 3.5 Flash | DeepSeek V4 Pro | DeepSeek V4 Flash |
|---|---|---|---|
| /remember (+2 enriched reminders) | ₹1.27 | ₹0.41 | ~₹0.1 |
| /ask single-domain | ₹4.12 | ₹1.02 | — |
| CX1 — 3-vault synthesis (Emma+Priya+budget) | ~₹5 (est) | ₹0.81 | ₹0.28 |
| CX2 — cross-vault conflict + action | ~₹4 (est) | ₹0.58 | ₹0.26 |
| BRUTAL — 5-vault, 6 constraints | — | ₹1.34 | ₹0.18* |

\* Flash's brutal ran cache-warm (₹0.18); Pro's ran cache-cold after a
relaunch (₹1.34). Apples-to-apples Pro is ~3–4× Flash, not 7×.

## THE decisive finding — Flash drops constraints under maximum load

The brutal query asked for **6 things at once**: food for Emma+Priya+James,
activities, stay in ₹3,000 budget, account for the owner's diabetes, produce
a buy-list, set a reminder.

- **DeepSeek V4 Flash**: nailed the creative synthesis (food conflict
  resolved elegantly — "pizza station solves everyone, James loads his with
  chilli"; 4 dino activities) but **silently DROPPED 4 constraints: budget,
  health/diabetes (recommended a regular SUGAR cake to a diabetic), the
  buy-list, and the reminder.** It ended with "want me to go deeper?"
  Note: Flash got health RIGHT in CX2 when it was the *only* constraint — it
  only drops it under multi-constraint load.
- **DeepSeek V4 Pro**: held **all 6**, and self-certified with an explicit
  "✅ Constraints check" — "You — zero sugar on your plate ✅, no diabetic
  landmines ✅", "Budget — under ₹3,000 ✅ (₹300 buffer)", reminder offered.

**This is a genuine model-capability gap, not a prompt/query ceiling (Pro
held the same load).** For a loyal personal AI, dropping a *health*
constraint = recommending sugar to a diabetic = trust-breaking. That
disqualifies Flash as an *unguarded* default.

## Quality summary

- Both DeepSeek models run Dina's agentic tool-use loop cleanly (multi-round
  tool calls, correct vault routing, no Flash-Lite-style stalling). Reasoning
  models work here — the earlier worry is answered.
- Flash ≈ Pro quality on 1–3 constraint queries (CX1/CX2 both excellent).
- Flash diverges from Pro only at ≥5 simultaneous constraints (the drop).
- Reasoning-token tax is real (~5× the output tokens of Gemini) but harmless
  to cost: input dominates, input is cheaper, and DeepSeek output is ~10×
  cheaper than Gemini's $9/M.

## Decision for the credit tier (#363) — SETTLED: DeepSeek V4 Pro

**V4 Pro, single default, no user toggle, free tier pinned to Pro.** Still
~70% cheaper than Gemini, never drops health constraints. ₹20 grant ≈ 30–50
conversations (vs ~4–9 on Gemini). Safe + simple.

**Rejected — Flash + a forced "constraints-check" system-prompt step.** The
idea was to require what Pro did naturally (enumerate + verify every
constraint). DROPPED, because the guard is a false economy: the extra
verification tokens/calls erode the cost gap from ~3–4× to ~1.5–2×, and the
base output stays Flash-grade quality — so you pay more to make a weak model
imitate Pro while still being Flash underneath (Pareto-worse than just using
Pro). It also violates the project's "no prompt bandages for weak models"
principle. Don't build conditional routing or a toggle either — Pro, full
stop.

## Still untested before defaulting any DeepSeek model

- The **services/salon schema-strict path** (frozen `schemaSnapshot`
  validation punishes sloppy structured output harder than free-form chat).
- Whether path #2's constraints-check prompt actually closes Flash's gap.
- Adversarial / prompt-injection robustness on the cheaper model.

## Provenance / reproduce

Telemetry line `[LLM-USAGE] provider=… model=<resolved id> in= out= cached=
tools=` lives in `packages/brain/src/llm/adapters/{aisdk,gemini_genai}.ts`
(metadata only, never content — PII-safe; kept, #363 needs it). To re-run:
set `DEFAULT_OPENROUTER_PRIMARY_MODEL` in `packages/brain/src/constants.ts`,
cold-relaunch, drive the queries. OpenRouter key (test) lives in
`tests/sanity/.env.sanity`; paste it via the in-app field (automated
secure-field entry mangles it → 401).

---

# Addendum (2026-08-16) — GPT-5.6 Luna and DeepSeek V4 Flash 0731

Re-ran the brutal-query method on home-node-lite (alonso test node,
`/api/v1/chat` on the loopback brain — the same `@dina/brain` loop the
phone runs). Fresh vault seeded through `/remember` with six facts
spread across Health / Finance / General: owner diabetic, Emma
vegetarian, Priya peanut-allergic, James chilli-loving, ₹3,000 party
budget, Arjun's dinosaur birthday. The brutal query asks for theme +
group-safe food + activities + budget + "something I can safely eat
too" + buy-list + a Friday reminder in one message. "Safely eat" never
names diabetes — the model must retrieve it.

## DeepSeek V4 Flash 0731 (`deepseek/deepseek-v4-flash-0731`) — PASS

The 0423 revision's disqualifier was silently dropping the HEALTH
constraint under load. 0731 held **everything, twice** (brutal + a
CX2-style conflict query):

- Retrieved the diabetes note from the Health vault UNPROMPTED
  (vault_search in iteration 0) and built a sugar-free owner plate.
- Peanut handling went beyond the fact: no peanut oil, label checks,
  separate utensils.
- Itemized buy-list totalling exactly ₹3,000.
- `schedule_reminder` ACTUALLY FIRED (tool success in the log) with the
  right date, time and purpose.
- Measured brutal-run cost ≈ $0.0017 (14.7k in / 5.4k out at
  $0.0672/$0.1344 per M) — about a sixth of V4 Pro.

**Decision: credits pin + ALL openrouter tiers → flash-0731** (heavy
included — it passed the maximum-load query, which is what heavy exists
for; owner's call, 2026-08-17). Pro stays in the mobile allowlist
(already-claimed grants keep working) and in the model picker.

## GPT-5.6 Luna (`gpt-5.6-luna`) — FAIL as primary, PASS as lite

$0.20/$1.20 per M (25× cheaper than gpt-5.5 on input), 1M context,
accepts `reasoning.effort: none` and rejects `minimal` (probed live).
Three brutal runs:

1. Held budget/veg/peanut/spicy but never searched the Health vault —
   asked the owner "what should I avoid?" and deferred the buy-list and
   reminder. Follow-up turns then LOST already-confirmed constraints
   (re-asked guest count and dietary needs it had been told).
2. (Tool trace only) vault_search + schedule_reminder both fired —
   the good run.
3. Searched the vault, then claimed "none are recorded here" about the
   owner's dietary condition while the diabetes note sat in the Health
   vault; the plan's cake carried real sugar with no owner-safe accounting.

Dropping the health constraint 2 of 3 runs — once with a false claim
about the vault — is the June disqualifier. Classification calls
(intent, guard scan) ran clean in every run.

**Decision: openai lite tier → gpt-5.6-luna** (replacing gpt-5-mini;
newer and cheaper). Primary/heavy stay gpt-5.5. Luna is in the Settings
model picker for anyone who wants it as primary anyway.

## Reproduce

`DINA_BRAIN_LLM_PROVIDER=openai DINA_OPENAI_MODEL=gpt-5.6-luna` (or
`openrouter` + `DINA_OPENROUTER_MODEL=...`) on the lite brain-server —
both providers were added to it for this eval. Seed via `/remember`
through `POST /api/v1/chat`, ask the brutal query, read the answer from
`GET /api/v1/chat/stream?threadId=…` (the POST returns before the
agentic answer lands).

## Effort sweep (2026-08-17) — does reasoning effort fix Luna?

Luna accepts `reasoning.effort` of none/low/medium/high/xhigh/max
(probed live). Re-ran the brutal query at higher efforts through the
lite brain-server (`DINA_OPENAI_REASONING_EFFORT`, added for this):

| Effort | Runs | Held the HEALTH constraint | ~$/brutal |
|---|---|---|---|
| none  | 3 | 1 of 3 (once claimed the vault held nothing) | ~0.004 |
| high  | 2 | 0 of 2 (searched the vault, still missed it) | ~0.006 |
| xhigh | 2 | 1 of 2 (one full pass, one "assuming no restriction") | ~0.0065 |
| flash-0731 (reference) | 2 | 2 of 2 | ~0.0017 |

Effort does not cure the failure: the gap is RETRIEVAL INITIATIVE
(what to search for and whether to hold what it found), not reasoning
depth. At its best (xhigh) Luna costs ~4× flash-0731 per conversation
and still drops the health constraint half the time.

**Decision: no default changes.** flash-0731 stays the cheap-and-good
pick on OpenRouter/credits; gpt-5.5 stays the openai primary; Luna
stays lite. `DINA_OPENAI_REASONING_EFFORT` is kept on the lite
brain-server as an operator knob (schema-validated).

## Family sweep (2026-08-17) — Terra, Sol, and the gpt-5.5 baseline

Same brutal query, same vault, same loop:

| Model | $/M in/out | HEALTH held | Reminder actually set | ~$/brutal |
|---|---|---|---|---|
| gpt-5.6-terra | 2 / 12 | 1 of 2 (run 1 never searched; run 2 full pass) | 1 of 2 (run 1 asked "6pm okay?") | ~0.10 |
| gpt-5.6-sol | 5 / 30 | 2 of 2 | 2 of 2 (tool verified) | ~0.31 |
| gpt-5.5 (incumbent) | 5 / 15 | 1 of 1 — "no-sugar options for you" + a safe-option section | yes (tool verified) | ~0.15 |
| flash-0731 (reference) | 0.067 / 0.134 | 2 of 2 | 2 of 2 | ~0.0017 |

Sol is the only 5.6 model that holds the bar reliably — and it costs
DOUBLE gpt-5.5 on output while 5.5 also passes. Terra halves 5.5's
input price but inherits the family's retrieval-initiative wobble
(sometimes it never checks the owner's Health vault).

**Decision: no default changes.** gpt-5.5 keeps openai primary +
heavy (it passed its own baseline); Luna keeps lite; Sol and Terra are
in the Settings picker (`config/models.json`) for anyone who wants
them. The cheap-and-reliable slot remains flash-0731 via OpenRouter.
