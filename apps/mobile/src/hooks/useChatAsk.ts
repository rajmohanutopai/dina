/**
 * Chat /ask command hook — data layer for the /ask flow.
 *
 * Detects /ask prefix or question intent, submits to the Brain's
 * reasoning pipeline, polls for result, and formats the response
 * with source citations.
 *
 * The hook manages:
 *   - Intent detection (is this a question?)
 *   - Job submission via Brain orchestrator
 *   - Status tracking (processing → completed/failed)
 *   - Source citation formatting
 *   - Response streaming state
 *
 * Source: ARCHITECTURE.md Task 4.9
 */

import { handleChat, type ChatResponse } from '@dina/brain/chat';
import { addMessage, type ChatMessage } from '@dina/brain/chat';

export type AskStatus = 'idle' | 'thinking' | 'completed' | 'failed';

export interface AskJob {
  id: string;
  query: string;
  status: AskStatus;
  persona: string;
  answer?: string;
  sources: string[];
  submittedAt: number;
  completedAt?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Hard cap on a single /ask turn before we mark it failed.
 *
 * 3 minutes is generous: an agentic /ask turn can do 6 reasoning
 * steps × ~10 s each on a slow provider and still come back in
 * under 90 s. Padding to 180 s gives long-context tool-use room
 * without leaving the chat bubble on `...` forever when the
 * provider is genuinely wedged (429-loop, network limbo, etc.).
 *
 * Below this cap, the in-flight `handleChat` still runs to
 * completion; we just stop pretending the chat bubble is "live" so
 * the user can move on or retry with a different provider. Tuning
 * down would require AbortSignal plumbing through `handleChat`
 * which isn't wired today.
 */
const ASK_TIMEOUT_MS = 180_000;

/** Active ask jobs. */
const jobs = new Map<string, AskJob>();
let jobCounter = 0;

/** Question patterns — detect implicit /ask intent. */
const QUESTION_PATTERNS = [
  /\?$/, // ends with question mark
  /^(what|when|where|who|how|why|which|is|are|was|were|do|does|did|can|could|would|should|will)\b/i,
  /^tell me\b/i,
  /^explain\b/i,
  /^describe\b/i,
];

/**
 * Check if a message is an /ask command or has question intent.
 */
export function isAskIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Explicit /ask command
  if (trimmed.startsWith('/ask ') || trimmed === '/ask') return true;

  // Question patterns
  return QUESTION_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Extract the query text from an /ask command.
 */
export function extractAskQuery(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('/ask ')) return trimmed.slice(5).trim();
  if (trimmed === '/ask') return '';
  return trimmed;
}

/**
 * Submit an /ask command. Routes through the Brain orchestrator.
 *
 * @returns The job for status tracking
 */
export async function submitAsk(
  text: string,
  persona?: string,
  threadId?: string,
): Promise<AskJob> {
  const query = extractAskQuery(text);
  const targetPersona = persona ?? 'general';

  if (!query) {
    const job: AskJob = {
      id: `ask-job-${++jobCounter}`,
      query: '',
      status: 'failed',
      persona: targetPersona,
      sources: [],
      submittedAt: Date.now(),
      completedAt: Date.now(),
      error: 'What would you like to know?',
    };
    jobs.set(job.id, job);
    return job;
  }

  const jobId = `ask-job-${++jobCounter}`;
  const startTime = Date.now();

  const job: AskJob = {
    id: jobId,
    query,
    status: 'thinking',
    persona: targetPersona,
    sources: [],
    submittedAt: startTime,
  };
  jobs.set(jobId, job);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Ask took too long.')),
      ASK_TIMEOUT_MS,
    );
  });

  try {
    const response = await Promise.race([
      handleChat(text, threadId ?? 'main'),
      timeoutPromise,
    ]);

    job.status = 'completed';
    job.answer = response.response;
    job.sources = response.sources;
    job.completedAt = Date.now();
    job.latencyMs = Date.now() - startTime;
  } catch (err) {
    job.status = 'failed';
    job.error = humaniseAskError(err);
    job.completedAt = Date.now();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  return job;
}

/**
 * Map a raw LLM / network error into a user-friendly one-liner.
 *
 * The agentic /ask path surfaces whatever the underlying SDK threw,
 * which is usually a "RetryError: Failed after 3 attempts. Last
 * error: <provider's raw response>" wrapper. That string mentions
 * `platform.openai.com`, talks about "quota", and dumps a docs URL —
 * useful to a developer, opaque to a normal user.
 *
 * This helper sniffs known vendor signals (429 / quota / 401 / 403 /
 * timeout / network) and returns plain English plus an actionable
 * next step. Generic errors fall through with their first sentence
 * preserved so we don't lose information we don't recognise.
 */
export function humaniseAskError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // Quota / rate-limit family. Both manifest as 429s, but vendors
  // distinguish them in body text — quota is "out of credit", rate
  // limit is "too fast right now". Worth keeping the difference.
  if (
    lower.includes('exceeded your current quota') ||
    lower.includes('insufficient_quota')
  ) {
    return "Your AI provider is out of quota. Open Settings → Manage AI providers and switch to a different one (or top up your account).";
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'AI provider rate-limited. Wait a minute and try again, or switch providers in Settings → Manage AI providers.';
  }

  // Invalid / revoked API key. Surfaces as 401 or 403 on every cloud
  // provider we route to.
  if (
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes(' 401') ||
    lower.includes(' 403')
  ) {
    return 'Your API key was rejected. Update it in Settings → Manage AI providers.';
  }

  // Timeout from our own hard cap (see ASK_TIMEOUT_MS below) or from
  // the SDK's `AbortError`.
  if (
    lower.includes('aborterror') ||
    lower.includes('timed out') ||
    lower.includes('took too long')
  ) {
    return "That took too long to come back. The provider may be slow right now — try again, or switch providers in Settings → Manage AI providers.";
  }

  // Network reachability.
  if (
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  ) {
    return "Couldn't reach the AI provider. Check your connection and try again.";
  }

  // Generic fallback — keep the first sentence so we don't lose
  // information we don't recognise. Strip the RetryError wrapper +
  // docs URLs but prefix with "AI provider error:" so the user sees
  // the failure CATEGORY even for unclassified vendor messages.
  const firstLine = raw
    .replace(/^AI provider error:\s*/i, '')
    .replace(/RetryError:\s*Failed after \d+ attempts\.\s*Last error:\s*/i, '')
    .replace(/\s*For more information.*$/i, '')
    .replace(/\s*https?:\/\/\S+/g, '')
    .trim();
  return firstLine.length > 0
    ? `AI provider error: ${firstLine}`
    : 'AI provider error.';
}

/**
 * Get an ask job by ID.
 */
export function getAskJob(jobId: string): AskJob | null {
  return jobs.get(jobId) ?? null;
}

/**
 * Get recent ask jobs (most recent first).
 */
export function getAskHistory(): AskJob[] {
  return [...jobs.values()].reverse();
}

/**
 * Get the last completed answer (for quick re-display).
 */
export function getLastAnswer(): AskJob | null {
  const completed = [...jobs.values()].filter((j) => j.status === 'completed');
  return completed.length > 0 ? completed[completed.length - 1] : null;
}

/**
 * Format an answer with source citations for display.
 *
 * Example: "Emma's birthday is March 15 [Source: general]"
 */
export function formatAnswerWithSources(job: AskJob): string {
  if (!job.answer) return '';

  if (job.sources.length === 0) return job.answer;

  const sourceTag =
    job.sources.length === 1
      ? `[Source: ${job.sources[0]}]`
      : `[Sources: ${job.sources.join(', ')}]`;

  return `${job.answer} ${sourceTag}`;
}

/**
 * Check if any ask job is currently processing.
 */
export function isAnyAskPending(): boolean {
  return [...jobs.values()].some((j) => j.status === 'thinking');
}

/**
 * Reset all ask state (for testing).
 */
export function resetAskState(): void {
  jobs.clear();
  jobCounter = 0;
}
