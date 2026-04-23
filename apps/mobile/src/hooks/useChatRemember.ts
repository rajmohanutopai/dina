/**
 * Chat /remember command hook — data layer for the /remember flow.
 *
 * Detects /remember prefix or explicit remember intent, calls the
 * Core /api/v1/remember endpoint, and tracks job status through
 * the processing → stored/needs_approval/failed lifecycle.
 *
 * The hook manages:
 *   - Intent detection (is this a /remember command?)
 *   - Job submission via Core API
 *   - Status polling (processing → completed/failed)
 *   - Result formatting for the chat thread
 *
 * Source: ARCHITECTURE.md Task 4.8
 */

// Funnel through the package root so Metro can't duplicate this module
// (see note in ai/memory.ts on the same issue splitting the `inbox` Map).
import { stagingIngest as ingest, type StagingItem } from '@dina/core';
import { addSystemMessage } from '@dina/brain/src/chat/thread';

export type RememberStatus =
  | 'idle'
  | 'processing'
  | 'stored'
  | 'needs_approval'
  | 'failed'
  | 'duplicate';

export interface RememberJob {
  id: string;
  text: string;
  status: RememberStatus;
  persona: string;
  submittedAt: number;
  completedAt?: number;
  error?: string;
  duplicate: boolean;
}

/** Active remember jobs. */
const jobs = new Map<string, RememberJob>();
let jobCounter = 0;

/** Keywords that indicate explicit remember intent (beyond /remember prefix). */
const REMEMBER_INTENTS = [
  /^remember\s+/i,
  /^save\s+this/i,
  /^store\s+/i,
  /^note\s+that\s+/i,
  /^keep\s+in\s+mind\s+/i,
  /^don't\s+forget\s+/i,
];

/**
 * Check if a message is a /remember command or has remember intent.
 */
export function isRememberIntent(text: string): boolean {
  const trimmed = text.trim();

  // Explicit /remember command
  if (trimmed.startsWith('/remember ') || trimmed === '/remember') {
    return true;
  }

  // Keyword-based intent detection
  return REMEMBER_INTENTS.some((pattern) => pattern.test(trimmed));
}

/**
 * Extract the text to remember from a /remember command.
 */
export function extractRememberText(text: string): string {
  const trimmed = text.trim();

  // Strip /remember prefix
  if (trimmed.startsWith('/remember ')) {
    return trimmed.slice('/remember '.length).trim();
  }
  if (trimmed === '/remember') {
    return '';
  }

  // Strip intent keywords
  for (const pattern of REMEMBER_INTENTS) {
    const match = trimmed.match(pattern);
    if (match) {
      return trimmed.slice(match[0].length).trim();
    }
  }

  return trimmed;
}

/**
 * Submit a /remember command. Creates a staging item and tracks the job.
 *
 * @returns The job for status tracking
 */
export function submitRemember(text: string, persona?: string, threadId?: string): RememberJob {
  const rememberText = extractRememberText(text);
  const targetPersona = persona ?? 'general';

  if (!rememberText) {
    const job: RememberJob = {
      id: `rem-job-${++jobCounter}`,
      text: '',
      status: 'failed',
      persona: targetPersona,
      submittedAt: Date.now(),
      completedAt: Date.now(),
      error: 'Nothing to remember — provide text after /remember',
      duplicate: false,
    };
    jobs.set(job.id, job);
    return job;
  }

  // Ingest into staging pipeline
  const { id, duplicate } = ingest({
    source: 'user_remember',
    source_id: rememberText,
    producer_id: 'user',
    data: {
      summary: rememberText,
      type: 'user_memory',
      body: rememberText,
    },
  });

  const job: RememberJob = {
    id: `rem-job-${++jobCounter}`,
    text: rememberText,
    status: duplicate ? 'duplicate' : 'stored',
    persona: targetPersona,
    submittedAt: Date.now(),
    completedAt: Date.now(),
    duplicate,
  };

  jobs.set(job.id, job);

  // Add confirmation to chat thread
  const message = duplicate ? 'I already have that stored.' : `Got it — I'll remember that.`;
  if (threadId) {
    addSystemMessage(threadId, message);
  }

  return job;
}

/**
 * Get a remember job by ID.
 */
export function getRememberJob(jobId: string): RememberJob | null {
  return jobs.get(jobId) ?? null;
}

/**
 * Get all remember jobs (most recent first).
 */
export function getRememberHistory(): RememberJob[] {
  return [...jobs.values()].reverse();
}

/**
 * Get the most recent remember job.
 */
export function getLastRememberJob(): RememberJob | null {
  const all = getRememberHistory();
  return all.length > 0 ? all[0] : null;
}

/**
 * Format a job status for display in the chat.
 */
export function formatRememberStatus(job: RememberJob): string {
  switch (job.status) {
    case 'processing':
      return 'Storing...';
    case 'stored':
      return `Got it — I'll remember that.`;
    case 'duplicate':
      return 'I already have that stored.';
    case 'needs_approval':
      return 'This needs your approval to store.';
    case 'failed':
      return job.error ?? 'Failed to store. Please try again.';
    default:
      return '';
  }
}

/**
 * Reset all remember state (for testing).
 */
export function resetRememberState(): void {
  jobs.clear();
  jobCounter = 0;
}
