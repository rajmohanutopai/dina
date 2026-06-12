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
