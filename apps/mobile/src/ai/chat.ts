/**
 * AI Chat Service — orchestrates LLM calls with memory context.
 *
 * Routes user messages through:
 * 1. Intent detection (remember / ask / general chat)
 * 2. Memory operations (store / search)
 * 3. LLM generation (when configured) or local fallback
 */

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { addMemory, searchMemories, getMemoryCount, extractDate, getAllMemories } from './memory';
import { createModel, getConfiguredProviders } from './provider';
import type { ProviderType } from './provider';
import {
  buildClassifyPrompt,
  buildVaultContextPrompt,
  buildChatPrompt,
  buildRememberAckPrompt,
} from './prompts';
import { scrubPII, rehydratePII } from '@dina/core/src/pii/patterns';
import { scanResponse, stripViolations } from '@dina/brain/src/guardian/guard_scan';
import {
  reason,
  registerReasoningLLM,
  resetReasoningLLM,
  type ReasoningResult,
} from '@dina/brain/src/pipeline/chat_reasoning';
import {
  getByShortId,
  completeReminder,
  snoozeReminder,
  deleteReminder,
  type Reminder,
} from '@dina/core/src/reminders/service';

/** LLM call timeout in milliseconds (60 seconds, matching main Dina). */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Classify an LLM error into a user-friendly message.
 *
 * Matches main Dina's error classification pattern:
 * - 401/Unauthorized → invalid API key
 * - 429/rate_limit → rate limited
 * - timeout → timed out
 * - generic → something went wrong
 *
 * Source: Go brain adapter error handling (§A26/A29/A34/A40)
 */
export function classifyLLMError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid') ||
    lower.includes('authentication')
  ) {
    return 'Your API key appears to be invalid. Please check it in Settings.';
  }
  if (
    lower.includes('429') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted')
  ) {
    return 'Rate limited by your AI provider. Please try again in a moment.';
  }
  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('timed out')) {
    return 'The AI provider request timed out. Please try again.';
  }
  return `Something went wrong: ${message}`;
}

/**
 * Scrub structured PII from a prompt before sending to a cloud LLM,
 * then rehydrate the response so the user sees original values.
 *
 * Includes:
 * - PII scrub/rehydrate cycle (emails, phones, cards, SSNs, govt IDs)
 * - 60-second timeout (matching main Dina's dual-layer timeout)
 * - Error classification (401/429/timeout → user-friendly messages)
 *
 * Does NOT scrub names/orgs/locations — matching main Dina's design.
 */
/**
 * @param skipGuardScan — when true, skip guard scan (used when called from
 * brain's reason() pipeline which does its own scan).
 */
async function generateTextWithPIIScrub(
  model: LanguageModel,
  system: string,
  prompt: string,
  skipGuardScan: boolean = false,
): Promise<string> {
  const { scrubbed: scrubbedSystem, entities: sysEntities } = scrubPII(system);
  const { scrubbed: scrubbedPrompt, entities: promptEntities } = scrubPII(prompt);
  const allEntities = [...sysEntities, ...promptEntities];

  // Race the LLM call against a timeout to prevent infinite hangs
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const { text } = await generateText({
      model,
      system: scrubbedSystem,
      prompt: scrubbedPrompt,
      abortSignal: controller.signal,
    });

    // Rehydrate the LLM response so user sees original values
    let response = allEntities.length > 0 ? rehydratePII(text, allEntities) : text;

    // Guard scan: strip safety violations from the rehydrated response.
    // Skipped when called from brain's reason() pipeline (which does its own scan).
    if (!skipGuardScan) {
      const scan = await scanResponse(response, { piiScrubbed: allEntities.length > 0 });
      if (!scan.safe) {
        response = stripViolations(response);
        if (!response.trim()) {
          response =
            'I can help you with information from your vault. Try asking a specific question.';
        }
      }
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface ChatResponse {
  text: string;
  action: 'remember' | 'ask' | 'chat' | 'help';
  reminderDate: string | null;
  memoryCount: number;
  sources: number;
  /** Whether Anti-Her pre-screening redirected to humans. */
  antiHerRedirect?: boolean;
  /** Trust density tier of the vault context. */
  densityTier?: string;
  /** Guard scan violations stripped from the answer. */
  guardViolations?: number;
  /** Request ID from reasoning trace (for audit correlation). */
  requestId?: string;
}

// The legacy module-level `activeProvider` state used to live here.
// It's been consolidated into `active_provider.ts` — the single
// persistent store that Settings, brain_wiring, and buildBootInputs
// all read from (review finding #16). We keep thin compat shims so
// callers that only need the synchronous setter/getter (chat tests,
// legacy processMessage) keep working against the same source of
// truth.
import { peekActiveProvider, saveActiveProvider, loadActiveProvider } from './active_provider';

let activeModelId: string | null = null;

/**
 * Synchronous setter — fires the persisted store asynchronously but
 * updates the in-memory cache before returning, so follow-up
 * `getActiveProvider()` reads see the new value. Tests that only
 * need the in-memory state can `void` the returned promise.
 */
export function setActiveProvider(provider: ProviderType | null, modelId?: string): void {
  activeModelId = modelId ?? null;
  // Fire-and-forget the keychain write. `saveActiveProvider` updates
  // the cache synchronously via its in-module assignment, so
  // `peekActiveProvider` returns the right thing immediately.
  void saveActiveProvider(provider);
}

export function getActiveProvider(): ProviderType | null {
  return peekActiveProvider();
}

/**
 * Auto-select the first configured provider if none is active. Reads
 * the durable store first; falls back to keychain-order when nothing
 * has been persisted.
 */
export async function autoSelectProvider(): Promise<ProviderType | null> {
  const persisted = await loadActiveProvider();
  if (persisted !== null) return persisted;
  const configured = await getConfiguredProviders();
  if (configured.length > 0) {
    await saveActiveProvider(configured[0]);
    return configured[0];
  }
  return null;
}

/** Get an AI model, or null if no provider configured. */
async function getModel(): Promise<LanguageModel | null> {
  const provider = await autoSelectProvider();
  if (!provider) return null;
  return createModel(provider, activeModelId ?? undefined);
}

/** Process a user message and return a response. */
export async function processMessage(text: string): Promise<ChatResponse> {
  const trimmed = text.trim();

  // /help \u2014 kept as a chat-level fallback for users typing the slash
  // command. The primary help surface is `app/help.tsx`, reached via
  // the "What can Dina do?" tap card on the empty-state chat screen.
  if (trimmed === '/help') {
    return {
      text: [
        'Tap "What can Dina do?" on the home screen for the full guide.',
        '',
        'Quick version:',
        '\u2022 Type naturally \u2014 "Emma\u2019s birthday is March 15", "When is Emma\u2019s birthday?"',
        '\u2022 Tap an action card to scope your message (Remember / Ask).',
        '\u2022 Reminders fire as cards in this thread \u2014 tap Snooze or Mark done.',
        '',
        `You have ${getMemoryCount()} memories stored.`,
      ].join('\n'),
      action: 'help',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }

  // /remember or remember intent
  if (trimmed.startsWith('/remember ')) {
    return handleRemember(trimmed.slice('/remember '.length).trim());
  }

  // /ask or ask intent
  if (trimmed.startsWith('/ask ')) {
    return handleAsk(trimmed.slice('/ask '.length).trim());
  }

  // Reminder commands via short_id
  if (trimmed.startsWith('/snooze ')) {
    return handleReminderCommand('snooze', trimmed.slice('/snooze '.length).trim());
  }
  if (trimmed.startsWith('/complete ')) {
    return handleReminderCommand('complete', trimmed.slice('/complete '.length).trim());
  }
  if (trimmed.startsWith('/dismiss ')) {
    return handleReminderCommand('dismiss', trimmed.slice('/dismiss '.length).trim());
  }

  // General chat — use LLM if available, fallback otherwise
  return handleChat(trimmed);
}

async function handleRemember(content: string): Promise<ChatResponse> {
  if (!content) {
    return {
      text: 'What would you like me to remember?',
      action: 'remember',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }

  const model = await getModel();
  let category = 'general';
  let hasEvent = false;
  let eventHint = '';

  // Step 1: LLM classification — route to correct vault + detect temporal events
  if (model) {
    try {
      const classify = buildClassifyPrompt(content);
      const classifyResult = await generateTextWithPIIScrub(model, classify.system, classify.user);

      // Parse classification JSON
      const jsonMatch = classifyResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        category = parsed.primary ?? 'general';
        hasEvent = parsed.has_event ?? false;
        eventHint = parsed.event_hint ?? '';
      }
    } catch {
      // Classification failed — fallback to general + local date extraction
    }
  }

  // Step 2: Date extraction — LLM event detection + local fallback
  let reminderDate = extractDate(content);
  if (!reminderDate && hasEvent && eventHint) {
    // Try extracting from the LLM's event hint
    reminderDate = extractDate(eventHint);
  }

  // Step 3: Store the memory in the classified vault
  addMemory(content, category, reminderDate);

  // Step 4: Generate acknowledgment
  let response = `Got it \u2014 I'll remember that.`;
  if (category !== 'general') {
    response += ` Stored in your ${category} notes.`;
  }

  if (reminderDate) {
    const dateStr = new Date(reminderDate + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    response += `\n\nReminder set for ${dateStr}.`;
  }

  // Use LLM for a richer acknowledgment if available
  if (model) {
    try {
      const classInfo =
        category !== 'general' ? `Classified as: ${category}` : 'Stored in general vault';
      const reminderInfo = reminderDate ? `Reminder set for ${reminderDate}` : 'No reminder needed';
      const ackPrompt = buildRememberAckPrompt(content, classInfo, reminderInfo);

      response = await generateTextWithPIIScrub(model, ackPrompt.system, ackPrompt.prompt);
    } catch {
      // LLM ack failed, keep the local response
    }
  }

  return {
    text: response,
    action: 'remember',
    reminderDate,
    memoryCount: getMemoryCount(),
    sources: 0,
  };
}

/**
 * Handle /ask queries through brain's full reasoning pipeline.
 *
 * Pipeline: Anti-Her pre-screen → vault context assembly → cloud gate (PII scrub)
 *         → LLM reasoning → guard scan + strip → PII rehydrate → density disclosure
 *
 * Falls back to local memory search when the brain pipeline is unavailable.
 */
async function handleAsk(query: string): Promise<ChatResponse> {
  if (!query) {
    return {
      text: 'What would you like to know?',
      action: 'ask',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }

  // Try brain's full reasoning pipeline first
  const model = await getModel();
  if (model) {
    try {
      registerReasoningLLM(async (q, context) => {
        return generateTextWithPIIScrub(model, context, q, true);
      });

      const result = await reason({
        query,
        persona: 'general',
        provider: peekActiveProvider() ?? 'none',
      });

      return {
        text: result.answer,
        action: 'ask',
        reminderDate: null,
        memoryCount: getMemoryCount(),
        sources: result.sources.length,
        antiHerRedirect: result.antiHerRedirect,
        densityTier: result.densityTier,
        guardViolations: result.guardViolations,
        requestId: result.trace.requestId,
      };
    } catch {
      // Brain pipeline failed — fall through to local search
    } finally {
      resetReasoningLLM();
    }
  }

  // Local-only fallback (no LLM or brain pipeline failed)
  const matches = searchMemories(query);

  if (matches.length > 0) {
    const results = matches.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    return {
      text: `${results}\n\n[${matches.length} match${matches.length > 1 ? 'es' : ''} from your vault]`,
      action: 'ask',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: matches.length,
    };
  }

  return {
    text: `I don't have any memories matching \u201C${query}\u201D.`,
    action: 'ask',
    reminderDate: null,
    memoryCount: getMemoryCount(),
    sources: 0,
  };
}

/**
 * Handle general chat through brain's reasoning pipeline.
 *
 * Same pipeline as handleAsk — both go through Anti-Her, guard scan, etc.
 * Falls back to direct LLM call when brain pipeline is unavailable.
 */
async function handleChat(text: string): Promise<ChatResponse> {
  const model = await getModel();

  if (!model) {
    return {
      text: `I heard you, but I need an AI provider to have a conversation. You can set one up in Settings.\n\nIn the meantime, try Remember or Ask to use your vault.`,
      action: 'chat',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }

  try {
    registerReasoningLLM(async (q, context) => {
      return generateTextWithPIIScrub(model, context, q, true);
    });

    const result = await reason({
      query: text,
      persona: 'general',
      provider: peekActiveProvider() ?? 'none',
    });

    return {
      text: result.answer,
      action: 'chat',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: result.sources.length,
      antiHerRedirect: result.antiHerRedirect,
      densityTier: result.densityTier,
      guardViolations: result.guardViolations,
      requestId: result.trace.requestId,
    };
  } catch (err: unknown) {
    return {
      text: classifyLLMError(err),
      action: 'chat',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  } finally {
    resetReasoningLLM();
  }
}

/**
 * Handle reminder commands via short_id.
 *
 * Supports:
 *   /snooze <short_id> [duration] — snooze reminder (default: 1 hour)
 *   /complete <short_id> — mark reminder as completed
 *   /dismiss <short_id> — delete reminder
 *
 * Short IDs are 4-char hex strings (e.g., "abc1", "f3e2") for voice/chat UX.
 */
function handleReminderCommand(
  command: 'snooze' | 'complete' | 'dismiss',
  args: string,
): ChatResponse {
  const parts = args.split(/\s+/);
  const shortId = parts[0];

  if (!shortId) {
    return {
      text: `Usage: /${command} <short_id>`,
      action: 'chat',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }

  const reminder = getByShortId(shortId);
  if (!reminder) {
    return {
      text: `No reminder found with ID "${shortId}".`,
      action: 'chat',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }

  try {
    switch (command) {
      case 'snooze': {
        const durationStr = parts[1] ?? '1h';
        const durationMs = parseDuration(durationStr);
        // Calculate display time BEFORE mutation (snoozeReminder adds durationMs to due_at)
        const newTime = new Date(reminder.due_at + durationMs).toLocaleString();
        snoozeReminder(reminder.id, durationMs);
        return {
          text: `Snoozed "${reminder.message}" until ${newTime}.`,
          action: 'chat',
          reminderDate: null,
          memoryCount: getMemoryCount(),
          sources: 0,
        };
      }
      case 'complete': {
        completeReminder(reminder.id);
        return {
          text: `Completed: "${reminder.message}"`,
          action: 'chat',
          reminderDate: null,
          memoryCount: getMemoryCount(),
          sources: 0,
        };
      }
      case 'dismiss': {
        deleteReminder(reminder.id);
        return {
          text: `Dismissed: "${reminder.message}"`,
          action: 'chat',
          reminderDate: null,
          memoryCount: getMemoryCount(),
          sources: 0,
        };
      }
    }
  } catch (err) {
    return {
      text: `Failed to ${command} reminder: ${err instanceof Error ? err.message : String(err)}`,
      action: 'chat',
      reminderDate: null,
      memoryCount: getMemoryCount(),
      sources: 0,
    };
  }
}

/**
 * Parse a human-friendly duration string into milliseconds.
 *
 * Supports: 30m, 1h, 2h, 1d, 15m (default: 1h).
 */
export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(m|h|d)$/i);
  if (!match) return 60 * 60 * 1000; // default: 1 hour

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
}
