/**
 * The mobile vision broker (§3): row shaping, per-call credential reads,
 * the BYOK → starter-credits resolution order, and the named no-key error
 * the capture screen routes to settings.
 *
 * The re-encoder is native-module work and is exercised on the simulator;
 * the broker is pure request/response shaping and is pinned here.
 */

import {
  createMobileVisionBroker,
  normalizePickedPages,
  pageLooksJpegOrPng,
  resolveVisionCredential,
} from '../../src/services/photo_pipeline';

import type { VisionCredential } from '../../src/services/photo_pipeline';

jest.mock('../../src/ai/provider', () => ({
  getApiKey: jest.fn(),
}));
jest.mock('../../src/ai/credits', () => ({
  getGrantCredential: jest.fn(),
}));

import { getGrantCredential } from '../../src/ai/credits';
import { getApiKey } from '../../src/ai/provider';

const mockGetApiKey = getApiKey as jest.MockedFunction<typeof getApiKey>;
const mockGetGrant = getGrantCredential as jest.MockedFunction<typeof getGrantCredential>;

const PAGE = new TextEncoder().encode('stripped-page-bytes');

const OPENAI_CRED: VisionCredential = {
  apiKey: 'sk-test',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  source: 'openai',
};

function okResponse(content: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  } as unknown as Response;
}

beforeEach(() => {
  mockGetApiKey.mockReset();
  mockGetGrant.mockReset();
});

it('shapes rows with page attribution and drops non-string junk', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const broker = createMobileVisionBroker({
    readCredential: () => Promise.resolve(OPENAI_CRED),
    fetchImpl: (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        okResponse({
          rows: [
            { sku: 'CM-1', name: 'Stool', list_price_minor_units: 450000, junk: { nested: true } },
            'not-an-object',
            { name: '' },
          ],
        }),
      );
    },
  });

  const result = await broker.extractRows({
    purpose: 'catalog_extraction',
    schemaId: 'catalog-rows-1',
    pages: [PAGE, PAGE],
  });

  // One provider call PER PAGE — page attribution cannot be honest any
  // other way.
  expect(calls.length).toBe(2);
  expect(result.rows).toEqual([
    { page_index: 0, cells: { sku: 'CM-1', name: 'Stool', list_price_minor_units: '450000' } },
    { page_index: 1, cells: { sku: 'CM-1', name: 'Stool', list_price_minor_units: '450000' } },
  ]);
  // The key travels in the header and NEVER in the body.
  expect(JSON.stringify(calls[0]?.body)).not.toContain('sk-test');
});

it('a missing credential throws the NAMED error before any transmission', async () => {
  let fetched = 0;
  const broker = createMobileVisionBroker({
    readCredential: () => Promise.resolve(null),
    fetchImpl: () => {
      fetched += 1;
      return Promise.resolve(okResponse({ rows: [] }));
    },
  });
  await expect(
    broker.extractRows({ purpose: 'catalog_extraction', schemaId: 'catalog-rows-1', pages: [PAGE] }),
  ).rejects.toThrow('no vision-capable AI key configured');
  expect(fetched).toBe(0);
});

it('the credential picks the endpoint and model of the call', async () => {
  const calls: { url: string; auth: string; model: unknown }[] = [];
  const broker = createMobileVisionBroker({
    readCredential: () =>
      Promise.resolve({
        apiKey: 'sk-or-grant',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'openai/gpt-4o-mini',
        source: 'starter_credits',
      } satisfies VisionCredential),
    fetchImpl: (url, init) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      calls.push({ url: String(url), auth: headers.authorization, model: body.model });
      return Promise.resolve(okResponse({ rows: [{ sku: 'CM-1' }] }));
    },
  });

  const result = await broker.extractRows({
    purpose: 'catalog_extraction',
    schemaId: 'catalog-rows-1',
    pages: [PAGE],
  });

  expect(calls).toEqual([
    {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      auth: 'Bearer sk-or-grant',
      model: 'openai/gpt-4o-mini',
    },
  ]);
  // The answer reports the model that ACTUALLY read the page.
  expect(result.model).toBe('openai/gpt-4o-mini');
});

it('each purpose gets its own instruction — order pages ask for quantities', async () => {
  const prompts: string[] = [];
  const broker = createMobileVisionBroker({
    readCredential: () => Promise.resolve(OPENAI_CRED),
    fetchImpl: (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        messages: { role: string; content: string }[];
      };
      prompts.push(body.messages[0]?.content ?? '');
      return Promise.resolve(okResponse({ rows: [] }));
    },
  });

  await broker.extractRows({ purpose: 'order_extraction', schemaId: 'order-lines-1', pages: [PAGE] });
  await broker.extractRows({ purpose: 'catalog_extraction', schemaId: 'catalog-rows-1', pages: [PAGE] });

  expect(prompts[0]).toContain('order sheet');
  expect(prompts[0]).toContain('quantity');
  expect(prompts[1]).toContain('price list');
  expect(prompts[1]).toContain('list_price_minor_units');
  expect(prompts[1]).not.toContain('order sheet');
});

it('a provider error status and non-JSON content each throw rather than inventing rows', async () => {
  const failing = createMobileVisionBroker({
    readCredential: () => Promise.resolve(OPENAI_CRED),
    fetchImpl: () =>
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) } as unknown as Response),
  });
  await expect(
    failing.extractRows({ purpose: 'catalog_extraction', schemaId: 'catalog-rows-1', pages: [PAGE] }),
  ).rejects.toThrow('429');

  const garbled = createMobileVisionBroker({
    readCredential: () => Promise.resolve(OPENAI_CRED),
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: 'not json at all' } }] }),
      } as unknown as Response),
  });
  await expect(
    garbled.extractRows({ purpose: 'catalog_extraction', schemaId: 'catalog-rows-1', pages: [PAGE] }),
  ).rejects.toThrow('non-JSON');
});

// ---------------------------------------------------------------------------
// normalizePickedPages — HEIC (or anything else) becomes JPEG before capture
// ---------------------------------------------------------------------------

// Real signatures, base64'd: FF D8 FF → '/9j/', 89 50 4E 47 → 'iVBOR',
// and an ISO-BMFF 'ftypheic' box — what an iPhone camera photo starts with.
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64');
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const HEIC_B64 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]).toString('base64');

it('recognizes JPEG and PNG base64 signatures and nothing else', () => {
  expect(pageLooksJpegOrPng(JPEG_B64)).toBe(true);
  expect(pageLooksJpegOrPng(PNG_B64)).toBe(true);
  expect(pageLooksJpegOrPng(HEIC_B64)).toBe(false);
  expect(pageLooksJpegOrPng('')).toBe(false);
});

it('passes JPEG/PNG pages through untouched and transcodes everything else', async () => {
  const transcoded: string[] = [];
  const transcode = (uri: string): Promise<string> => {
    transcoded.push(uri);
    return Promise.resolve('/9j/transcoded');
  };
  const pages = await normalizePickedPages(
    [
      { uri: 'file:///a.jpg', base64: JPEG_B64 },
      { uri: 'file:///b.heic', base64: HEIC_B64 },
      { uri: 'file:///c.png', base64: PNG_B64 },
      // No base64 at all — the uri is still readable by the manipulator.
      { uri: 'file:///d.heic' },
    ],
    transcode,
  );
  expect(pages).toEqual([JPEG_B64, '/9j/transcoded', PNG_B64, '/9j/transcoded']);
  expect(transcoded).toEqual(['file:///b.heic', 'file:///d.heic']);
});

it('an asset with neither usable base64 nor a uri is dropped, not sent', async () => {
  const pages = await normalizePickedPages([{ uri: '', base64: '' }], () =>
    Promise.reject(new Error('must not be called')),
  );
  expect(pages).toEqual([]);
});

// ---------------------------------------------------------------------------
// resolveVisionCredential — the BYOK → starter-credits order
// ---------------------------------------------------------------------------

it('an OpenAI BYOK key wins and goes direct', async () => {
  mockGetApiKey.mockImplementation((p) => Promise.resolve(p === 'openai' ? 'sk-byok' : 'sk-or-byok'));
  mockGetGrant.mockResolvedValue({ key: 'sk-or-grant', modelPin: 'deepseek/deepseek-v4-pro' });

  await expect(resolveVisionCredential()).resolves.toEqual({
    apiKey: 'sk-byok',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    source: 'openai',
  });
});

it('an OpenRouter BYOK key beats the grant', async () => {
  mockGetApiKey.mockImplementation((p) =>
    Promise.resolve(p === 'openrouter' ? 'sk-or-byok' : null),
  );
  mockGetGrant.mockResolvedValue({ key: 'sk-or-grant', modelPin: 'deepseek/deepseek-v4-pro' });

  await expect(resolveVisionCredential()).resolves.toEqual({
    apiKey: 'sk-or-byok',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-4o-mini',
    source: 'openrouter',
  });
});

it('with no BYOK key the starter-credits grant pays — on a VISION model, never the text-only chat pin', async () => {
  mockGetApiKey.mockResolvedValue(null);
  mockGetGrant.mockResolvedValue({ key: 'sk-or-grant', modelPin: 'deepseek/deepseek-v4-pro' });

  const credential = await resolveVisionCredential();
  expect(credential).toEqual({
    apiKey: 'sk-or-grant',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-4o-mini',
    source: 'starter_credits',
  });
  expect(credential?.model).not.toContain('deepseek');
});

it('nothing configured resolves to null', async () => {
  mockGetApiKey.mockResolvedValue(null);
  mockGetGrant.mockResolvedValue(null);
  await expect(resolveVisionCredential()).resolves.toBeNull();
});
