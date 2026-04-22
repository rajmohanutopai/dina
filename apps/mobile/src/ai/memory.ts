/**
 * Memory Store — dual-write: in-memory for fast search + Core staging for persistence.
 *
 * Stores memories with full-text search for /ask queries (in-memory).
 * Also ingests into Core's staging pipeline for vault persistence,
 * enrichment, encryption, and audit logging.
 */

import { ingest } from '../../../core/src/staging/service';

export interface Memory {
  id: number;
  content: string;
  category: string;
  created_at: string;
  reminder_date: string | null;
  /** Staging item ID for tracking through the pipeline. */
  stagingId?: string;
}

// In-memory store for immediate search — also writes to staging pipeline.
const memories: Memory[] = [];
let nextId = 1;

/** Whether staging pipeline is available (set during app initialization). */
let stagingEnabled = true;

/** Enable/disable staging write-through (for testing). */
export function setStagingEnabled(enabled: boolean): void {
  stagingEnabled = enabled;
}

/**
 * Store a new memory. Returns the created memory.
 *
 * Dual-write: stores in-memory for fast /ask queries AND ingests into
 * Core's staging pipeline for vault persistence + enrichment.
 * Staging errors are non-blocking — the memory is always stored locally.
 */
export function addMemory(
  content: string,
  category: string = 'general',
  reminderDate: string | null = null,
): Memory {
  const memory: Memory = {
    id: nextId++,
    content,
    category,
    created_at: new Date().toISOString(),
    reminder_date: reminderDate,
  };
  memories.push(memory);

  // Write-through to staging pipeline for vault persistence
  if (stagingEnabled) {
    try {
      const { id } = ingest({
        source: 'user_remember',
        source_id: `mem-${memory.id}`,
        data: {
          summary: content,
          body: content,
          type: 'note',
          category,
          reminder_date: reminderDate,
          timestamp: Date.now(),
        },
      });
      memory.stagingId = id;
    } catch {
      // Staging unavailable — memory still saved locally
    }
  }

  return memory;
}

/** Search memories by keyword (case-insensitive). */
export function searchMemories(query: string): Memory[] {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 2);

  return memories.filter((m) => {
    const content = m.content.toLowerCase();
    // Match full query or any significant word
    return content.includes(q) || words.some((w) => content.includes(w));
  });
}

/** Get all memories, most recent first. */
export function getAllMemories(): Memory[] {
  return [...memories].reverse();
}

/**
 * Get memory count.
 *
 * LEGACY API. Since /remember now routes through Brain's staging
 * ingest (see brain/src/chat/orchestrator.ts), nothing in the live
 * UI calls `addMemory` anymore — this counter is stuck at 0 unless
 * legacy callers exist. The real "how many memories" number lives
 * in Core's vault + staging tables and needs a dedicated endpoint
 * (not yet wired). UI code should hide the chip when this returns 0
 * rather than show a misleading zero. Issue #10 tracking.
 */
export function getMemoryCount(): number {
  return memories.length;
}

/** Get memories with upcoming reminders. */
export function getUpcomingReminders(): Memory[] {
  // Review #19: `reminder_date` is stored as `YYYY-MM-DD`. Comparing
  // it against `new Date().toISOString()` (which is
  // `YYYY-MM-DDTHH:MM:SS.sssZ`) sorted today as already past because
  // `"2026-04-18" < "2026-04-18T14:30:00.000Z"`. Compare against the
  // local YYYY-MM-DD prefix so "today" is treated as upcoming until
  // the day actually ends.
  const today = formatLocalDate(new Date());
  return memories
    .filter((m) => m.reminder_date !== null && m.reminder_date >= today)
    .sort((a, b) => (a.reminder_date! > b.reminder_date! ? 1 : -1));
}

/** Format a date as YYYY-MM-DD without timezone issues. */
function formatDate(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Format a Date object as YYYY-MM-DD using local time. */
function formatLocalDate(d: Date): string {
  return formatDate(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Check if a date (year, month 0-indexed, day) has passed. */
function dateHasPassed(year: number, month: number, day: number): boolean {
  const now = new Date();
  const target = new Date(year, month, day);
  target.setHours(23, 59, 59);
  return target < now;
}

/** Extract a date from natural language text. Returns ISO date string or null. */
export function extractDate(text: string): string | null {
  const lower = text.toLowerCase();

  const monthNames = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];

  // "Month Day" or "Month Day, Year"
  for (let i = 0; i < monthNames.length; i++) {
    const pattern = new RegExp(`${monthNames[i]}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i');
    const match = lower.match(pattern);
    if (match) {
      const day = parseInt(match[1], 10);
      let year = match[2] ? parseInt(match[2], 10) : new Date().getFullYear();
      if (!match[2] && dateHasPassed(year, i, day)) {
        year++;
      }
      return formatDate(year, i, day);
    }
  }

  // "Day Month" pattern
  for (let i = 0; i < monthNames.length; i++) {
    const pattern = new RegExp(
      `(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthNames[i]}(?:,?\\s+(\\d{4}))?`,
      'i',
    );
    const match = lower.match(pattern);
    if (match) {
      const day = parseInt(match[1], 10);
      let year = match[2] ? parseInt(match[2], 10) : new Date().getFullYear();
      if (!match[2] && dateHasPassed(year, i, day)) {
        year++;
      }
      return formatDate(year, i, day);
    }
  }

  // Relative dates
  if (lower.includes('tomorrow')) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return formatLocalDate(d);
  }
  if (lower.includes('next week')) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return formatLocalDate(d);
  }
  if (lower.includes('next month')) {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return formatLocalDate(d);
  }

  return null;
}

/** Clear all memories (for testing). */
export function resetMemories(): void {
  memories.length = 0;
  nextId = 1;
}
