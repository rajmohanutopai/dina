/**
 * The photo lanes' two injected adapters, composed HERE because Core does
 * no I/O and holds no provider credential (PHOTO_COMMERCE_LANES_DESIGN §3,
 * §6):
 *
 *   - the IMAGE RE-ENCODER: sharp's full decode + re-encode, which strips
 *     EXIF (location, capture time, device identity) and disarms
 *     structural decoder attacks. Core re-validates the result against its
 *     own caps — this adapter is not the trust boundary.
 *   - the EGRESS BROKER: the only component in the process holding a
 *     vision-provider credential. It transmits exactly the pages the gate
 *     hands it (already re-hashed against the single-use authorization)
 *     and returns rows with page attribution. It validates nothing and
 *     decides nothing.
 *
 * Both install conditionally, and absence is a NAMED degradation rather
 * than a crash: a node without sharp cannot ingest photographs, a node
 * without an OpenAI key cannot extract — each refuses at its own boundary
 * with a reason the seller can read.
 */

import type { CommerceImageMime, ImageEgressBroker, ImageReencoder } from '@dina/core';

/**
 * sharp is loaded DYNAMICALLY so a deployment without it still boots —
 * the photo lane degrades, the rest of the node does not.
 */
export async function createSharpReencoder(): Promise<ImageReencoder | null> {
  let sharpModule: typeof import('sharp');
  try {
    sharpModule = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    return null;
  }
  return async (bytes: Uint8Array, mime: CommerceImageMime) => {
    // A full decode + re-encode. sharp drops metadata unless asked to keep
    // it (`withMetadata` is never called), which is exactly the §3
    // requirement: EXIF is a disclosure the seller never saw on screen.
    // `.rotate()` with no argument BAKES the EXIF orientation into the
    // pixels first — an iPhone stores portrait photos sideways with an
    // orientation tag, and dropping the tag without applying it hands the
    // vision model a sideways page it cannot read.
    const image = sharpModule(Buffer.from(bytes), { limitInputPixels: 20_000_000 }).rotate();
    const out =
      mime === 'image/png'
        ? await image.png().toBuffer()
        : await image.jpeg({ quality: 88 }).toBuffer();
    return { bytes: new Uint8Array(out), mime };
  };
}

/** The §3 catalog extraction prompt: rows, nothing invented, unreadable = empty. */
const CATALOG_INSTRUCTION = [
  'You are reading a photographed price list.',
  'Return STRICT JSON: {"rows": [{...cells}]}. One object per product row.',
  'Use only these keys where present on the page: sku, name, description,',
  'pack_size, unit_code, list_price_minor_units, currency.',
  'list_price_minor_units is the price in MINOR units (paise, cents) as a string.',
  'NEVER invent a value: a cell you cannot read is OMITTED, not guessed.',
  'Do not include headers, totals, or non-product lines.',
].join(' ');

/**
 * The §5 order extraction prompt — mirrors the mobile broker. The keys are
 * what the order route consumes: `text`/`product`/`quantity` become line
 * fields, `required_by` and `instruction` become draft requirements. One
 * catalog-flavored prompt for both lanes meant an order sheet came back
 * with no quantities and every line defaulted to 1.
 */
const ORDER_INSTRUCTION = [
  'You are reading a photographed order sheet or shopping list.',
  'Return STRICT JSON: {"rows": [{...cells}]}. One object per ordered line.',
  'Use only these keys where present on the page: text, product, quantity,',
  'sku, pack_size, unit_code, required_by, instruction.',
  'text is the whole line exactly as written; quantity is the count in digits;',
  'required_by is a needed-by date if one is written anywhere on the page.',
  'NEVER invent a value: a cell you cannot read is OMITTED, not guessed.',
  'Do not include headers, totals, or non-product lines.',
].join(' ');

function instructionFor(purpose: string): string {
  return purpose === 'order_extraction' ? ORDER_INSTRUCTION : CATALOG_INSTRUCTION;
}

/**
 * An OpenAI-backed broker, one provider call PER PAGE so every returned
 * row carries honest page attribution (§4.1's continuous numbering needs
 * to know which page produced which rows).
 */
export function createOpenAiVisionBroker(args: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): ImageEgressBroker {
  const model = args.model ?? 'gpt-4o-mini';
  const doFetch = args.fetchImpl ?? fetch;
  return {
    provider: 'openai',
    async extractRows(input) {
      const rows: { page_index: number; cells: Record<string, string> }[] = [];
      for (const [pageIndex, page] of input.pages.entries()) {
        const response = await doFetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${args.apiKey}`,
          },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: instructionFor(input.purpose) },
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/png;base64,${Buffer.from(page).toString('base64')}`,
                    },
                  },
                ],
              },
            ],
          }),
        });
        if (!response.ok) {
          throw new Error(`vision provider answered ${String(response.status)}`);
        }
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = payload.choices?.[0]?.message?.content ?? '{}';
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new Error('vision provider returned non-JSON content');
        }
        const pageRows =
          parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
            ? ((parsed as { rows: unknown[] }).rows)
            : [];
        for (const candidate of pageRows) {
          if (candidate === null || typeof candidate !== 'object') continue;
          const cells: Record<string, string> = {};
          for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
            if (typeof value === 'string' && value !== '') cells[key] = value;
            else if (typeof value === 'number') cells[key] = String(value);
          }
          if (Object.keys(cells).length > 0) rows.push({ page_index: pageIndex, cells });
        }
      }
      return { rows, model };
    },
  };
}
