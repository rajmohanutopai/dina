/**
 * Tests for the LLM provider key validation + probe path. Covers the
 * MT-08-I1 + MT-08-I2 fix: client-side format check rejects junk keys
 * before the keychain write, and a real verifyKey probe rejects keys
 * the provider itself doesn't recognise — preventing the silent-fallback
 * "your invalid key still seems to work" UX trap.
 */

import { validateKeyFormat, verifyKey } from '../../src/ai/provider';

describe('validateKeyFormat', () => {
  it('rejects an empty key', () => {
    expect(validateKeyFormat('openai', '')).toMatch(/required/i);
    expect(validateKeyFormat('gemini', '   ')).toMatch(/required/i);
  });

  it('rejects an OpenAI key without sk- prefix', () => {
    const err = validateKeyFormat('openai', 'AIza-fake-but-long-enough-still-bad');
    expect(err).toMatch(/should start with "sk-"/);
  });

  it('rejects a Gemini key without AIza prefix', () => {
    const err = validateKeyFormat('gemini', 'sk-fake-but-long-enough-still-bad');
    expect(err).toMatch(/should start with "AIza"/);
  });

  it('rejects an OpenAI key shorter than the documented minimum', () => {
    // The MT-08-I1 case: prefix-correct but obviously truncated.
    const err = validateKeyFormat('openai', 'sk-invalid-test-key-12345');
    expect(err).toMatch(/at least 40 characters/);
  });

  it('rejects a Gemini key shorter than the documented 39 chars', () => {
    const err = validateKeyFormat('gemini', 'AIza-too-short');
    expect(err).toMatch(/at least 39 characters/);
  });

  it('accepts a plausible OpenAI key', () => {
    const ok = `sk-${'x'.repeat(48)}`; // 51 chars total
    expect(validateKeyFormat('openai', ok)).toBeNull();
  });

  it('accepts a Gemini key of the documented 39-char length', () => {
    const ok = `AIza${'x'.repeat(35)}`;
    expect(validateKeyFormat('gemini', ok)).toBeNull();
  });

  it('trims whitespace before checking length', () => {
    const ok = `  AIza${'x'.repeat(35)}  `;
    expect(validateKeyFormat('gemini', ok)).toBeNull();
  });
});

describe('verifyKey', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = realFetch;
  });

  function mockFetch(impl: (url: string) => Promise<Response>) {
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = ((input: RequestInfo | URL) =>
      impl(String(input))) as typeof globalThis.fetch;
  }

  it('returns null for OpenAI 200', async () => {
    mockFetch(async () => new Response('{"data":[]}', { status: 200 }));
    expect(await verifyKey('openai', 'sk-real-key')).toBeNull();
  });

  it('reports OpenAI 401 as a key-rejection message', async () => {
    mockFetch(async () => new Response('unauthorized', { status: 401 }));
    const err = await verifyKey('openai', 'sk-bad-key');
    expect(err).toMatch(/OpenAI rejected this key/);
  });

  it('reports Gemini 403 as a key-rejection message', async () => {
    mockFetch(async () => new Response('forbidden', { status: 403 }));
    const err = await verifyKey('gemini', 'AIza-bad');
    expect(err).toMatch(/Google Gemini rejected this key/);
  });

  it('reports network failures distinctly from key rejection', async () => {
    mockFetch(async () => {
      throw new Error('Network unavailable');
    });
    const err = await verifyKey('openai', 'sk-anything');
    expect(err).toMatch(/Couldn't reach OpenAI/);
  });

  it('reports Gemini 200 as success', async () => {
    mockFetch(async () => new Response('{"models":[]}', { status: 200 }));
    expect(await verifyKey('gemini', 'AIza-real')).toBeNull();
  });

  it('treats an OpenAI 5xx as transient (not a key-rejection)', async () => {
    mockFetch(async () => new Response('upstream timeout', { status: 503 }));
    const err = await verifyKey('openai', 'sk-anything');
    expect(err).toMatch(/HTTP 503/);
    expect(err).not.toMatch(/rejected this key/);
  });
});
