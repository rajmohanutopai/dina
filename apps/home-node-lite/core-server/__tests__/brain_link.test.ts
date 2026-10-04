/**
 * Core's calls to Brain are signed with Core's service key (A2A design §4.1,
 * plan §3.18), so Brain's caller check accepts them, and only as sent.
 */

import { NonceCache, checkRequestSignature, deriveDIDKey, getPublicKey } from '@dina/core';

import { createSignedBrainFetch } from '../src/brain_link';

const privateKey = new Uint8Array(32).fill(4);
const did = deriveDIDKey(getPublicKey(privateKey));

function capture() {
  const seen: { url: URL; init: RequestInit }[] = [];
  const base = (async (url: URL, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, signed: createSignedBrainFetch({ did, privateKey }, base) };
}

function check(
  sent: { url: URL; init: RequestInit },
  nonces = new NonceCache(),
  body = (sent.init.body as string | undefined) ?? '',
) {
  const h = sent.init.headers as Record<string, string>;
  return checkRequestSignature(
    {
      method: sent.init.method ?? 'GET',
      path: sent.url.pathname,
      query: sent.url.search.slice(1),
      body: new TextEncoder().encode(body),
      did: h['X-DID'],
      timestamp: h['X-Timestamp'],
      nonce: h['X-Nonce'],
      signature: h['X-Signature'],
    },
    { nonces },
  );
}

it('signs method, path, query and body, and keeps the caller’s headers', async () => {
  const { seen, signed } = capture();
  await signed('http://127.0.0.1:8200/api/v1/ask?trace=1', {
    method: 'post',
    headers: { 'content-type': 'application/json' },
    body: '{"question":"q"}',
  });
  const [sent] = seen;
  if (sent === undefined) throw new Error('nothing sent');
  expect((sent.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  expect(check(sent)).toEqual({ ok: true, did });
  expect(check(sent, new NonceCache(), '{"question":"other"}').ok).toBe(false);
});

it('a replayed request is refused by a nonce cache that saw it', async () => {
  const { seen, signed } = capture();
  await signed('http://127.0.0.1:8200/api/v1/capability/run', { method: 'POST', body: '{}' });
  const nonces = new NonceCache();
  const [sent] = seen;
  if (sent === undefined) throw new Error('nothing sent');
  expect(check(sent, nonces).ok).toBe(true);
  expect(check(sent, nonces)).toEqual(expect.objectContaining({ ok: false, rejectedAt: 'nonce' }));
});

it('refuses a body it cannot sign as sent', async () => {
  const { signed } = capture();
  await expect(
    signed('http://127.0.0.1:8200/api/v1/x', { method: 'POST', body: new Uint8Array([1]) }),
  ).rejects.toThrow(TypeError);
});
