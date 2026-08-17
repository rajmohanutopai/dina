/**
 * The photo lanes' two injected adapters, MOBILE composition
 * (PHOTO_COMMERCE_LANES_DESIGN §3, §6) — the same pair the server's
 * `image_pipeline.ts` installs, built from what a phone has:
 *
 *   - the IMAGE RE-ENCODER: expo-image-manipulator's decode + re-encode.
 *     The manipulator renders the pixels and writes a fresh file, so EXIF
 *     (location, capture time, device identity) does not survive — the
 *     §3 requirement. Core re-validates the result against its own caps;
 *     this adapter is not the trust boundary.
 *   - the EGRESS BROKER: `gpt-4o-mini` vision, paid by whichever key the
 *     phone has — OpenAI BYOK direct, else an OpenRouter key (BYOK or the
 *     starter-credits grant) through OpenRouter's OpenAI-compatible
 *     endpoint. The credential is read PER CALL from the same stores the
 *     analyst uses, so a key added in settings works without a relaunch;
 *     no key at all throws a named error and the gate answers
 *     `provider_failed`.
 *
 * Dynamic imports throughout, the `install_marker.ts` pattern: jest and
 * the web target never load the native modules.
 */

import { installImageEgressBroker, installImageReencoder } from '@dina/core';

import { getGrantCredential } from '../ai/credits';
import { getApiKey } from '../ai/provider';

import type { CommerceImageMime, ImageEgressBroker, ImageReencoder } from '@dina/core';

// ---------------------------------------------------------------------------
// base64 <-> bytes (Hermes ships atob/btoa; Buffer is the node-test path)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(encoded: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(encoded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(encoded, 'base64'));
}

// ---------------------------------------------------------------------------
// Picked-page normalization
// ---------------------------------------------------------------------------

/**
 * Does the base64 payload begin with a JPEG or PNG signature? The capture
 * gate sniffs BYTES and admits only those two, so this is the same
 * decision it will make — checked here on the base64 prefix without
 * decoding (FF D8 FF → '/9j/', 89 50 4E 47 → 'iVBOR').
 */
export function pageLooksJpegOrPng(base64Page: string): boolean {
  return base64Page.startsWith('/9j/') || base64Page.startsWith('iVBOR');
}

async function transcodeUriToJpegBase64(uri: string): Promise<string> {
  const manipulator = await import('expo-image-manipulator');
  const result = await manipulator.manipulateAsync(uri, [], {
    compress: 0.9,
    format: manipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (result.base64 === undefined || result.base64 === '') {
    throw new Error('image manipulator returned no bytes');
  }
  return result.base64;
}

/**
 * Turn picker assets into base64 pages the capture gate will admit.
 *
 * An iPhone camera photo is HEIC, and the picker's `base64` hands over the
 * ORIGINAL file bytes — which the gate's sniffer rightly refuses
 * (`wrong_mime`), before the on-device re-encoder that could have read
 * them ever runs. So anything that is not already JPEG/PNG is transcoded
 * here through the image manipulator (iOS decodes HEIC natively); a page
 * that is one already passes through untouched.
 */
export async function normalizePickedPages(
  assets: readonly { uri: string; base64?: string | null }[],
  transcode: (uri: string) => Promise<string> = transcodeUriToJpegBase64,
): Promise<string[]> {
  const pages: string[] = [];
  for (const asset of assets) {
    const raw = asset.base64 ?? '';
    if (raw !== '' && pageLooksJpegOrPng(raw)) {
      pages.push(raw);
      continue;
    }
    if (asset.uri === '') continue;
    pages.push(await transcode(asset.uri));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Re-encoder
// ---------------------------------------------------------------------------

function createMobileReencoder(): ImageReencoder {
  return async (bytes: Uint8Array, _mime: CommerceImageMime) => {
    const manipulator = await import('expo-image-manipulator');
    // The manipulator takes a URI; a data URI keeps the bytes out of the
    // filesystem entirely — nothing to clean up, nothing left behind if
    // the process dies mid-ingest.
    const result = await manipulator.manipulateAsync(
      `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
      [],
      { compress: 0.85, format: manipulator.SaveFormat.JPEG, base64: true },
    );
    if (result.base64 === undefined || result.base64 === '') {
      throw new Error('image manipulator returned no bytes');
    }
    return { bytes: base64ToBytes(result.base64), mime: 'image/jpeg' as const };
  };
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

/** The §3 catalog extraction prompt — rows, nothing invented, unreadable = omitted. */
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
 * The §5 order extraction prompt. The keys are what the order route
 * consumes: `text`/`product`/`quantity` become line fields, `required_by`
 * and `instruction` become draft requirements. The seam declares a schema
 * per purpose (`catalog-rows-1` vs `order-lines-1`); one catalog-flavored
 * prompt for both meant an order sheet came back priced-list-shaped with
 * no quantities, and every line defaulted to 1.
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

/** One resolved way to pay for a vision call. */
export interface VisionCredential {
  apiKey: string;
  /** The chat-completions URL — OpenAI direct or OpenRouter. */
  endpoint: string;
  /** Provider-local model id (`gpt-4o-mini` vs `openai/gpt-4o-mini`). */
  model: string;
  source: 'openai' | 'openrouter' | 'starter_credits';
}

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * The credits chat pin (`deepseek/…`) reads no images — every DeepSeek
 * model on OpenRouter is text-only — so the photo lane uses this fixed,
 * compiled-in vision model instead. Same underlying model as the direct
 * OpenAI lane, so extraction behaves identically whichever key pays; one
 * page costs well under a tenth of a cent against the grant's spend cap
 * (the minted key is capped by spend, not by model).
 */
const OPENROUTER_VISION_MODEL = 'openai/gpt-4o-mini';

/**
 * BYOK first (OpenAI direct beats OpenRouter — one less hop), then the
 * starter-credits grant. Mirrors `resolveProviderKey`'s BYOK-beats-grant
 * rule in `ai/provider.ts`.
 */
export async function resolveVisionCredential(): Promise<VisionCredential | null> {
  const openai = await getApiKey('openai');
  if (openai !== null && openai !== '') {
    return { apiKey: openai, endpoint: OPENAI_CHAT_URL, model: 'gpt-4o-mini', source: 'openai' };
  }
  const openrouter = await getApiKey('openrouter');
  if (openrouter !== null && openrouter !== '') {
    return {
      apiKey: openrouter,
      endpoint: OPENROUTER_CHAT_URL,
      model: OPENROUTER_VISION_MODEL,
      source: 'openrouter',
    };
  }
  const grant = await getGrantCredential();
  if (grant !== null) {
    return {
      apiKey: grant.key,
      endpoint: OPENROUTER_CHAT_URL,
      model: OPENROUTER_VISION_MODEL,
      source: 'starter_credits',
    };
  }
  return null;
}

export function createMobileVisionBroker(args?: {
  fetchImpl?: typeof fetch;
  readCredential?: () => Promise<VisionCredential | null>;
}): ImageEgressBroker {
  const doFetch = args?.fetchImpl ?? fetch;
  const readCredential = args?.readCredential ?? resolveVisionCredential;
  return {
    provider: 'openai',
    async extractRows(input) {
      const credential = await readCredential();
      if (credential === null) {
        // The gate reports this as `provider_failed`; the capture screen
        // reads it and points the seller at the AI-providers settings.
        throw new Error('no vision-capable AI key configured for photo extraction');
      }
      const rows: { page_index: number; cells: Record<string, string> }[] = [];
      for (const [pageIndex, page] of input.pages.entries()) {
        const response = await doFetch(credential.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credential.apiKey}`,
          },
          body: JSON.stringify({
            model: credential.model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: instructionFor(input.purpose) },
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${bytesToBase64(page)}` },
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
          parsed !== null &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { rows?: unknown }).rows)
            ? (parsed as { rows: unknown[] }).rows
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
      return { rows, model: credential.model };
    },
  };
}

// ---------------------------------------------------------------------------
// Install / teardown
// ---------------------------------------------------------------------------

export function installMobilePhotoPipeline(): void {
  installImageReencoder(createMobileReencoder());
  installImageEgressBroker(createMobileVisionBroker());
}

export function uninstallMobilePhotoPipeline(): void {
  installImageReencoder(null);
  installImageEgressBroker(null);
}
