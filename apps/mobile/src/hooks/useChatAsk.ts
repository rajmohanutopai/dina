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

import { handleChat, type ChatResponse } from '@dina/brain/src/chat/orchestrator';
import { addMessage, type ChatMessage } from '@dina/brain/src/chat/thread';

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

  try {
    const response = await handleChat(text, threadId ?? 'main');

    job.status = 'completed';
    job.answer = response.response;
    job.sources = response.sources;
    job.completedAt = Date.now();
    job.latencyMs = Date.now() - startTime;
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.completedAt = Date.now();
  }

  return job;
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
