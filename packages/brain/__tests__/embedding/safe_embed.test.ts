/**
 * SEC — `embedMaybeSensitive` enforces Law 3: raw PII must never reach a cloud
 * embedder. A local (on-device) provider embeds the real text; the cloud path
 * (cloud-only deployment, or a local-failure fallback) embeds a PII-scrubbed
 * copy. Closes the enrichment + reminder-planner leak where rehydrated vault
 * content was embedded straight to Gemini.
 */

import {
  resetProviders,
  registerLocalProvider,
  registerCloudProvider,
  type EmbeddingResult,
} from '../../src/embedding/generation';
import { embedMaybeSensitive } from '../../src/embedding/safe_embed';

/** A provider that records the exact text it was handed. */
function capturing(source: 'local' | 'cloud', sink: { text?: string }) {
  return async (text: string): Promise<EmbeddingResult> => {
    sink.text = text;
    return {
      vector: new Float32Array(768).fill(0.1),
      dimensions: 768,
      model: `${source}-x`,
      source,
    };
  };
}

const PII_TEXT = 'Contact jane.doe@example.com about the appointment';

describe('embedMaybeSensitive — PII never reaches a cloud embedder (Law 3)', () => {
  beforeEach(() => resetProviders());
  afterEach(() => resetProviders());

  it('cloud-only: the cloud provider receives SCRUBBED text, not raw PII', async () => {
    const sink: { text?: string } = {};
    registerCloudProvider('gemini-x', capturing('cloud', sink));

    const out = await embedMaybeSensitive(PII_TEXT);

    expect(out.result).not.toBeNull();
    expect(out.result?.source).toBe('cloud');
    expect(out.scrubbedForCloud).toBe(true);
    expect(sink.text).toBeDefined();
    expect(sink.text).not.toContain('jane.doe@example.com'); // the raw PII never left
    expect(sink.text).not.toBe(PII_TEXT);
  });

  it('local provider receives the REAL text (on-device — no scrub needed)', async () => {
    const sink: { text?: string } = {};
    registerLocalProvider('llama-x', capturing('local', sink));

    const out = await embedMaybeSensitive(PII_TEXT);

    expect(out.result?.source).toBe('local');
    expect(out.scrubbedForCloud).toBe(false);
    expect(sink.text).toBe(PII_TEXT);
  });

  it('local FAILS → falls back to cloud with SCRUBBED text (never raw)', async () => {
    const cloudSink: { text?: string } = {};
    registerLocalProvider('llama-x', async () => {
      throw new Error('local embedder down');
    });
    registerCloudProvider('gemini-x', capturing('cloud', cloudSink));

    const out = await embedMaybeSensitive(PII_TEXT);

    expect(out.result?.source).toBe('cloud');
    expect(cloudSink.text).not.toContain('jane.doe@example.com');
  });

  it('no provider registered → null result, no throw', async () => {
    const out = await embedMaybeSensitive(PII_TEXT);
    expect(out.result).toBeNull();
    expect(out.scrubbedForCloud).toBe(false);
  });
});
