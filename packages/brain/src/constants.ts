/**
 * Brain-side constants — single source of truth for Brain-specific values.
 *
 * Core constants are imported from @dina/core where needed.
 * This file covers: LLM thresholds, provider defaults, guardian settings.
 */

// ---------------------------------------------------------------
// LLM routing thresholds
// ---------------------------------------------------------------

export const PERSONA_SELECTOR_THRESHOLD = 0.6;
export const TRIAGE_CONFIDENCE_THRESHOLD = 0.7;
export const LLM_REFINEMENT_THRESHOLD = 0.75;
export const DEFAULT_CONFIDENCE = 0.5;

// ---------------------------------------------------------------
// LLM provider defaults
// ---------------------------------------------------------------

// The non-tier defaults are aliases for the primary tier. Callers
// that don't care about tiering get the same model as
// `getProviderTiers(name).primary`.
//
// All ids below verified live via `curl` against each vendor's API
// on 2026-05-22 — non-existent ids (e.g. `claude-sonnet-4-7`,
// `gpt-5.5-mini`, `gemini-3.5-pro`) return 404 there, so we stay
// on the closest existing version.
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_LOCAL_MODEL = 'llama-3n';
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
export const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------
// Per-provider primary/lite/heavy tiers (PC-BRAIN-17)
// ---------------------------------------------------------------
//
// Each provider block declares its own tier mapping so callers can
// pick the right model once the user has selected a provider — not
// just the default (`DEFAULT_*_MODEL` which is the primary alias).
//
// Tiers:
//   primary — the routing default for the provider.
//   lite    — a cheap / fast model for classification / lightweight
//             turns (intent_classification, guard_scan, silence).
//   heavy   — a strong model for multi-step reasoning / tool-using
//             chat turns that demand instruction-following.
//
// Fallbacks cascade: lite → primary → provider default. If a tier
// is missing at lookup time `getProviderTiers` surfaces `primary`
// as the fallback value so the router never sees an empty string.
//
// Main-dina tier picks (verbatim from models.json on PC's commit
// 630d217) inform the defaults below; mobile follows the same
// conservative preference for the pro-class model on the heavy
// slot because weaker models were observed looping on
// `search_vault` tool calls (PC-BRAIN-17 ref).

// Claude: Opus 4-7 is the newest flagship (verified live 2026-05-22).
// Sonnet 4-7 was reported but doesn't exist on api.anthropic.com yet —
// stay on 4-6 for the chat-default tier so fresh installs work. Heavy
// jumps to Opus since it's actually available.
export const DEFAULT_CLAUDE_PRIMARY_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_CLAUDE_LITE_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_CLAUDE_HEAVY_MODEL = 'claude-opus-4-7';

// OpenAI: GPT-5.5 stays primary + heavy. gpt-5.6-luna ($0.20/$1.20,
// verified live 2026-08-16) was evaluated as a primary candidate on
// the real agentic loop and FAILED the multi-constraint bar — in 2 of
// 3 runs of the 6-constraint party query it dropped the owner's
// HEALTH constraint (once claiming the vault held no such note while
// the diabetes fact sat in the Health vault). Classification calls
// (intent, guard scan) ran clean throughout, so luna takes the LITE
// tier from gpt-5-mini — newer and cheaper. Method + transcripts:
// docs/MODEL_COST_QUALITY_FINDINGS.md (2026-08-16 addendum).
export const DEFAULT_OPENAI_PRIMARY_MODEL = 'gpt-5.5';
export const DEFAULT_OPENAI_LITE_MODEL = 'gpt-5.6-luna';
export const DEFAULT_OPENAI_HEAVY_MODEL = 'gpt-5.5';

// Gemini: 3.5 family currently has only `gemini-3.5-flash` (no
// `3.5-pro`, no `3.5-flash-lite`). Flash 3.5 outperforms the older
// 3.1 Pro across most benchmarks, so it's now the primary + heavy
// default. Lite tier stays on the smaller `3.1-flash-lite` since
// it's strictly cheaper than 3.5-flash for classification turns.
export const DEFAULT_GEMINI_PRIMARY_MODEL = 'gemini-3.5-flash';
export const DEFAULT_GEMINI_LITE_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_GEMINI_HEAVY_MODEL = 'gemini-3.5-flash';

// OpenRouter: DeepSeek V4 Flash 0731 on every tier. The 0423 revision
// was disqualified in June for silently dropping the HEALTH constraint
// under 6-constraint load; the 0731 re-post-train was re-run through
// the same brutal query on the real loop (2026-08-16) and held ALL
// constraints in both runs — including unprompted Health-vault
// retrieval of the owner's diabetes and an actual `schedule_reminder`
// tool call — at ~$0.07/$0.13 per M. It passed the maximum-load query,
// which is exactly what the heavy tier exists for, so heavy uses it
// too (owner's call, 2026-08-17); V4 Pro stays in the picker and the
// credits allowlist. `auto` remains rejected: it routes to cheap
// models that loop on tool-use (verified 2026-05-22). Method +
// transcripts: docs/MODEL_COST_QUALITY_FINDINGS.md.
export const DEFAULT_OPENROUTER_PRIMARY_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_OPENROUTER_LITE_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_OPENROUTER_HEAVY_MODEL = 'deepseek/deepseek-v4-flash-0731';

export const DEFAULT_LOCAL_PRIMARY_MODEL = 'llama-3n';
export const DEFAULT_LOCAL_LITE_MODEL = 'llama-3n';
export const DEFAULT_LOCAL_HEAVY_MODEL = 'llama-3n';

// ---------------------------------------------------------------
// Vault context / reasoning
// ---------------------------------------------------------------

export const MAX_REASONING_TURNS = 6;
export const TOKEN_BUDGET = 8000;
export const TOKEN_PER_CHAR = 0.25;
export const TIERED_LOADING_L0_ALL = true;
export const TIERED_LOADING_L1_TOP = 5;
export const TIERED_LOADING_L2_TOP = 1;

// ---------------------------------------------------------------
// Guardian / silence
// ---------------------------------------------------------------

export const GUARDIAN_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
export const ESCALATION_THRESHOLD = 3;
export const BATCH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------

export const DEFAULT_BRIEFING_HOUR = 8;
export const REMINDER_LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_APP_NAME = 'Dina';
export const OPENROUTER_APP_URL = 'https://dinakernel.com';
