/**
 * Whisper / nudge — context assembly for conversations and meetings.
 *
 * respectsSilenceTier: pure logic (Tier 1+2 delivered, Tier 3 blocked).
 * Context assembly: stubs until Core HTTP client (task 3.2) ready.
 *
 * Source: tests/integration/test_whisper.py
 */

export interface WhisperContext {
  items: Array<{ summary: string; source: string }>;
  contactName?: string;
  lastInteraction?: number;
}

/** Assemble whisper context for a conversation. Stub until Core HTTP ready. */
export async function assembleWhisperContext(contactDID: string): Promise<WhisperContext> {
  return { items: [], contactName: undefined, lastInteraction: undefined };
}

/** Assemble context for an upcoming meeting. Stub until Core HTTP ready. */
export async function assembleMeetingContext(eventId: string): Promise<WhisperContext> {
  return { items: [] };
}

/** Check if a whisper respects the silence tier. Tier 1+2 delivered, Tier 3 blocked. */
export function respectsSilenceTier(tier: number): boolean {
  return tier <= 2;
}

/** Detect an interrupted conversation. Stub until Core HTTP ready. */
export async function detectInterruptedConversation(contactDID: string): Promise<boolean> {
  return false;
}

/** Pick up social cues from vault. Stub until Core HTTP ready. */
export async function gatherSocialCues(contactDID: string): Promise<string[]> {
  return [];
}
