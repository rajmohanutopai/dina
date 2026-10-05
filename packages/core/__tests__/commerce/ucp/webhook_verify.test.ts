/**
 * Webhook verification keys (UCP plan §3.13 step 4): a webhook is checked
 * against the keys of the merchant's ROOT profile, the one its `UCP-Agent`
 * names. A key a version leaf lists, and the root does not, verifies answers
 * Dina asked for through that leaf, never a webhook.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { MerchantConnection } from '../../../src/commerce/ucp/merchant_client';

import type { HttpMessage } from '@dina/ucp';

const URL_ = 'https://node.example/ucp/webhooks/orders';

function key(kid: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' },
  };
}

/** A delivery signed the way the spec's example signs one. */
function signed(k: ReturnType<typeof key>): HttpMessage {
  const body = Buffer.from('{"id":"ord_1","checkout_id":"co_1"}');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-digest': `sha-256=:${createHash('sha256').update(body).digest('base64')}:`,
  };
  const covered = ['@method', '@authority', '@path', 'content-digest', 'content-type'];
  const params = `(${covered.map((c) => `"${c}"`).join(' ')});keyid="${k.kid}"`;
  const value = (c: string) =>
    c === '@method'
      ? 'POST'
      : c === '@authority'
        ? 'node.example'
        : c === '@path'
          ? '/ucp/webhooks/orders'
          : headers[c];
  const base = [
    ...covered.map((c) => `"${c}": ${value(c)}`),
    `"@signature-params": ${params}`,
  ].join('\n');
  const sig = sign('sha256', Buffer.from(base), { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    method: 'POST',
    url: URL_,
    headers: {
      ...headers,
      'signature-input': `sig1=${params}`,
      signature: `sig1=:${sig.toString('base64')}:`,
    },
    body: new Uint8Array(body),
  };
}

function connection(rootKeys: unknown[], leafKeys: unknown[]): MerchantConnection {
  const merchant = {
    origin: 'https://shop.example',
    rootProfile: { keys: rootKeys },
    profile: { keys: leafKeys },
  };
  return new MerchantConnection(
    merchant as never,
    {} as never,
    {} as never,
    () => null,
    'profiles.example',
    async () => null,
  );
}

describe('which keys verify a webhook', () => {
  const root = key('root-1');
  const leafOnly = key('leaf-1');

  it('a key the root profile lists verifies it', async () => {
    expect(
      await connection([root.jwk], [root.jwk, leafOnly.jwk]).verifyWebhook(signed(root)),
    ).toMatchObject({
      ok: true,
      keyid: 'root-1',
    });
  });

  it('a key only the version leaf lists does not: unknown, and the profile re-read finds nothing new', async () => {
    expect(
      await connection([root.jwk], [root.jwk, leafOnly.jwk]).verifyWebhook(signed(leafOnly)),
    ).toEqual({
      ok: false,
      reason: 'key_not_found',
    });
  });
});
