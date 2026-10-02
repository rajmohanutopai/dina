/**
 * `draft_quote_request` — the chat hand-off for asking suppliers for quotes
 * (ASK_FOR_QUOTES_PLAN §2).
 *
 * The owner says what they want ("ask bakeries near me for a floral cake for
 * 20, budget ₹3,000"); the model calls this with the items, a phrase to find
 * suppliers by, and any limits it heard. The tool checks and bounds that
 * draft and ends the turn; the chat bridge then posts a `quote_request_draft`
 * card whose button opens the "Ask for quotes" screen prefilled.
 *
 * It sends nothing. Asking suppliers is the owner's act on that screen, and
 * Brain holds no owner authority: this tool has no Core client at all.
 */

import type { AgentTool } from './tool_registry';

/** The drafted request as it travels on the card (snake_case wire, minor units). */
export interface QuoteRequestDraftWire {
  lines: { text: string; quantity: string; unit_code: string }[];
  /** What to search suppliers for, e.g. "cakes". */
  supplier_query?: string;
  limits?: {
    target_minor?: string;
    ceiling_minor?: string;
    max_rounds?: number;
    deadline_seconds?: number;
  }; /** The currency the amounts are in, ISO 4217 ("USD"); absent when the owner named none. */
  currency?: string;
  /**
   * What Dina drew from the owner's own notes to shape the draft, in one line
   * ("You love floral celebration cakes"), so the card can say so. Absent when
   * nothing remembered was used.
   */
  from_memory?: string;
}

const UNIT_CODES = new Set(['each', 'kg', 'g', 'l', 'ml', 'case']);
const MAX_LINES = 10;
const MAX_TEXT = 200;
const MAX_FROM_MEMORY = 140;

/** A main-unit amount the model heard (3000, "3,000", "2500.50") → minor units. */
function minorUnits(v: unknown): string | undefined {
  const text =
    typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[,\s]/g, '') : '';
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  if (m === null) return undefined;
  return `${m[1] ?? ''}${(m[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
}

function wholeNumber(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Check and bound the model's arguments; throws when nothing usable is left. */
export function draftFromToolArgs(args: Record<string, unknown>): QuoteRequestDraftWire {
  const rawLines = Array.isArray(args.items) ? args.items : [];
  const lines: QuoteRequestDraftWire['lines'] = [];
  for (const raw of rawLines.slice(0, MAX_LINES)) {
    const item = (raw ?? {}) as { description?: unknown; quantity?: unknown; unit?: unknown };
    const text =
      typeof item.description === 'string' ? item.description.trim().slice(0, MAX_TEXT) : '';
    if (text === '') continue;
    const q =
      typeof item.quantity === 'number' && item.quantity > 0
        ? String(item.quantity)
        : typeof item.quantity === 'string' && /^\d+(\.\d+)?$/.test(item.quantity)
          ? item.quantity
          : '1';
    const unit = typeof item.unit === 'string' && UNIT_CODES.has(item.unit) ? item.unit : 'each';
    lines.push({ text, quantity: q, unit_code: unit });
  }
  if (lines.length === 0) {
    throw new Error(
      'draft_quote_request: describe at least one item the user wants (e.g. "Floral celebration cake, 20 servings").',
    );
  }
  const query =
    typeof args.supplier_search === 'string' ? args.supplier_search.trim().slice(0, 100) : '';
  const target = minorUnits(args.target_amount);
  const ceiling = minorUnits(args.ceiling_amount);
  const rounds = wholeNumber(args.max_rounds, 1, 10);
  const deadline = wholeNumber(args.reply_within_seconds, 10, 86_400);
  const currency =
    typeof args.currency === 'string' && /^[A-Za-z]{3}$/.test(args.currency.trim())
      ? args.currency.trim().toUpperCase()
      : undefined;
  const fromMemory =
    typeof args.from_memory === 'string'
      ? args.from_memory.replace(/\s+/g, ' ').trim().slice(0, MAX_FROM_MEMORY)
      : '';
  const limits = {
    ...(target !== undefined ? { target_minor: target } : {}),
    ...(ceiling !== undefined ? { ceiling_minor: ceiling } : {}),
    ...(rounds !== undefined ? { max_rounds: rounds } : {}),
    ...(deadline !== undefined ? { deadline_seconds: deadline } : {}),
  };
  return {
    lines,
    ...(query !== '' ? { supplier_query: query } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(fromMemory !== '' ? { from_memory: fromMemory } : {}),
  };
}

export function createDraftQuoteRequestTool(): AgentTool {
  return {
    name: 'draft_quote_request',
    terminal: true,
    description:
      'Draft a request for quotes from suppliers when the user wants to buy something and asks you to find sellers or get prices from several ("ask bakeries near me for a cake for 20", "get quotes for 50 kg basmati"). Give each item in the user\'s words with a quantity and unit, a short phrase to find suppliers by (what they sell, e.g. "cakes"), and any target price, ceiling, currency, rounds or reply time the user said. When something the user told you before (their own notes) makes the item more exact, such as a favourite kind or an allergy, use it in the item and say what you used in from_memory. Nothing is sent: a card opens the Ask for quotes screen, where the user picks suppliers and sends. Say in one line that the draft is ready.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'What the user wants, up to 10 items.',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description:
                  'The item in the user\'s words, e.g. "Floral celebration cake, 20 servings".',
              },
              quantity: {
                type: 'number',
                description:
                  'How many of the item to buy, or how much; 1 when unsaid. Not the number of people or servings: "a cake for 20 people" is quantity 1, with "20 servings" in the description.',
              },
              unit: {
                type: 'string',
                enum: ['each', 'kg', 'g', 'l', 'ml', 'case'],
                description: 'The unit; "each" for countable things.',
              },
            },
            required: ['description'],
          },
        },
        supplier_search: {
          type: 'string',
          description: 'What the suppliers sell, a word or two (e.g. "cakes", "rice").',
        },
        target_amount: {
          type: 'number',
          description: 'The price the user hopes for, in their currency.',
        },
        ceiling_amount: {
          type: 'number',
          description: 'The most the user will pay, in their currency.',
        },
        currency: {
          type: 'string',
          description:
            'The currency of the amounts as a three-letter code when the user named one: USD for dollars, INR for rupees, EUR for euros.',
        },
        from_memory: {
          type: 'string',
          description:
            'Only when something the user told you before shaped the items: that thing in one short line in the user\'s words, e.g. "You love floral celebration cakes". Leave it out otherwise; never invent one.',
        },
        max_rounds: { type: 'number', description: 'Rounds of counter-offers, 1 to 10.' },
        reply_within_seconds: {
          type: 'number',
          description: 'How long each round waits for suppliers, in seconds (up to 86400).',
        },
      },
      required: ['items'],
    },
    async execute(args): Promise<{ drafted: true; draft: QuoteRequestDraftWire }> {
      return { drafted: true, draft: draftFromToolArgs(args) };
    },
  };
}
