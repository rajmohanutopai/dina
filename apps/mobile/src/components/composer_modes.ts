/**
 * Composer mode definitions + the user-bubble chip resolver.
 *
 * Extracted from app/index.tsx so the chip-display contract is unit-testable
 * without rendering the whole ChatScreen (which pulls in the bootstrap, the live
 * thread store, the router, etc.). The contract: a sent user message shows its
 * CLEAN content plus a mode chip, and the slash prefix never leaks into the
 * bubble (docs/COMPOSER_MODES_DESIGN.md section 7.1).
 *
 * The chips drive three things in index.tsx: the scrollable mode strip, the
 * mode-switch popover, and — via `resolveUserChip` — the chip drawn on each
 * sent user bubble. Task routes through `/task ` (delegate to a paired agent);
 * Services/Reviews force the external lane in the brain; Ask/Remember keep
 * today's behaviour. Talk is NOT here: it is a navigation action (contact
 * picker), not a text mode, so it is rendered as a separate chip in index.tsx.
 */

export const ACTIONS = [
  {
    key: 'ask',
    label: 'Ask',
    description: 'Search across everything you’ve stored in your vault',
    prefix: '/ask ',
    placeholder: "e.g. When is Emma's birthday?",
  },
  {
    key: 'remember',
    label: 'Remember',
    description: 'Store a fact, preference, or anything you want Dina to keep',
    prefix: '/remember ',
    placeholder: "e.g. Emma's birthday is March 15",
  },
  {
    key: 'task',
    label: 'Task',
    description: 'Hand work to an agent. Fetch email, run a workflow, …',
    prefix: '/task ',
    placeholder: 'e.g. Fetch my new email',
  },
  {
    key: 'services',
    label: 'Services',
    description: 'Find a public service on the network',
    prefix: '/services ',
    placeholder: 'e.g. any salon openings around 4pm Thursday?',
  },
  {
    key: 'reviews',
    label: 'Reviews',
    description: 'Ask the Ranked Reviews network',
    prefix: '/reviews ',
    placeholder: 'e.g. is the Sony XM5 any good?',
  },
] as const;

export type ComposerAction = (typeof ACTIONS)[number];

/**
 * Resolve the chip label + display content for a USER message bubble.
 *
 * New messages carry clean `content` + the mode in `metadata.mode` (the brain
 * stores them that way — no slash prefix). Prefer that. Older persisted
 * messages may still embed the prefix in `content`; for those, fall back to a
 * prefix-match and strip it for display. A message with neither (plain typed
 * text) gets no chip and is shown verbatim.
 */
export function resolveUserChip(
  content: string,
  mode: unknown,
): { chipLabel: string | null; displayContent: string } {
  const m = typeof mode === 'string' ? mode : null;
  const byMode = m !== null ? ACTIONS.find((a) => a.key === m) : undefined;
  if (byMode !== undefined) {
    // Clean content already; the mode metadata names the chip.
    return { chipLabel: byMode.label, displayContent: content };
  }
  // Legacy fallback: a persisted message that still embeds the slash prefix.
  for (const action of ACTIONS) {
    if (content.startsWith(action.prefix)) {
      return { chipLabel: action.label, displayContent: content.slice(action.prefix.length) };
    }
  }
  return { chipLabel: null, displayContent: content };
}
