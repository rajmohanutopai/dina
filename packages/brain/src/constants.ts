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
export const DEFAULT_OPENROUTER_MODEL = 'auto';
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

// OpenAI: GPT-5.5 is current flagship; `gpt-5.5-mini` is NOT released
// (returns 404), so lite tier stays on `gpt-5-mini` which is.
export const DEFAULT_OPENAI_PRIMARY_MODEL = 'gpt-5.5';
export const DEFAULT_OPENAI_LITE_MODEL = 'gpt-5-mini';
export const DEFAULT_OPENAI_HEAVY_MODEL = 'gpt-5.5';

// Gemini: 3.5 family currently has only `gemini-3.5-flash` (no
// `3.5-pro`, no `3.5-flash-lite`). Flash 3.5 outperforms the older
// 3.1 Pro across most benchmarks, so it's now the primary + heavy
// default. Lite tier stays on the smaller `3.1-flash-lite` since
// it's strictly cheaper than 3.5-flash for classification turns.
export const DEFAULT_GEMINI_PRIMARY_MODEL = 'gemini-3.5-flash';
export const DEFAULT_GEMINI_LITE_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_GEMINI_HEAVY_MODEL = 'gemini-3.5-flash';

// OpenRouter: pin Gemini 3.5 Flash for primary + lite. The seemingly
// natural choice — `auto` — routes per-turn to whichever model OR
// thinks is cheapest, and the cheap ones loop on tool-use until the
// agentic loop hits `max_iterations` (verified 2026-05-22 — a single
// "gift for Emma" query took >5 min on `auto` before bailing). A
// specific tool-use-capable model is dramatically more reliable.
// Users who want `auto` can pick it in the model-picker.
export const DEFAULT_OPENROUTER_PRIMARY_MODEL = 'google/gemini-3.5-flash';
export const DEFAULT_OPENROUTER_LITE_MODEL = 'google/gemini-3.5-flash';
export const DEFAULT_OPENROUTER_HEAVY_MODEL = 'google/gemini-2.5-pro';

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
