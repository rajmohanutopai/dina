/**
 * Dina's RFC 9421 request signatures against the official UCP samples'
 * implementation (UCP plan §3.2, T-U2-1): the samples' verifier accepts a
 * request Dina signed (REST with a body, an MCP call, a GET with none), and
 * Dina's verifier accepts a request the samples signed. Neither side wrote
 * the other's code.
 *
 * Needs a checkout of github.com/Universal-Commerce-Protocol/samples
 * (`DINA_UCP_SAMPLES_DIR`) and a Python with `cryptography`
 * (`DINA_UCP_SAMPLES_PYTHON`); skipped without them, or failed when
 * `DINA_UCP_SAMPLES_REQUIRED=1`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  requiredRequestComponents,
  verifyMessage,
  type HttpMessage,
  type MerchantProfile,
} from '@dina/ucp';

import { deriveUcpIdentity } from '../../../src/commerce/ucp/identity';
import { merchantKeyLookup } from '../../../src/commerce/ucp/merchant_client';
import { UcpTransport } from '../../../src/commerce/ucp/transport';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const SAMPLES = process.env.DINA_UCP_SAMPLES_DIR ?? '';
const PYTHON = process.env.DINA_UCP_SAMPLES_PYTHON ?? 'python3';
const AVAILABLE =
  SAMPLES !== '' && existsSync(path.join(SAMPLES, 'rest', 'python', 'server', 'ucp_signing.py'));
const REQUIRED = process.env.DINA_UCP_SAMPLES_REQUIRED === '1';

function samples(mode: 'verify' | 'sign', input: unknown): Record<string, unknown> {
  const run = spawnSync(PYTHON, [path.join(__dirname, 'samples_signing.py'), mode], {
    input: JSON.stringify(input),
    env: { ...process.env, DINA_UCP_SAMPLES_DIR: SAMPLES },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`samples ${mode} failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

const IDENTITY = deriveUcpIdentity(new Uint8Array(32).fill(9), 0);

/** Every request the transport would send, signed, captured instead of sent. */
async function captured(
  run: (t: UcpTransport) => Promise<unknown>,
): Promise<PolicySocketRequest[]> {
  const sent: PolicySocketRequest[] = [];
  const transport = new UcpTransport({
    signer: () => ({ keyid: IDENTITY.key.jwk.kid, sign: IDENTITY.key.sign }),
    fetch: async (r): Promise<UcpFetchResult> => {
      sent.push(r);
      return { ok: false, error: 'connect_failed', sent: false };
    },
  });
  await run(transport);
  return sent;
}

const toSamples = (r: PolicySocketRequest) => ({
  method: r.method,
  url: r.url,
  headers: r.headers,
  body_b64: Buffer.from(r.body ?? new Uint8Array()).toString('base64'),
  jwk: IDENTITY.key.jwk,
});

if (!AVAILABLE && REQUIRED)
  throw new Error('DINA_UCP_SAMPLES_REQUIRED=1 but no samples checkout at DINA_UCP_SAMPLES_DIR');

(AVAILABLE ? describe : describe.skip)(
  'request signatures between Dina and the UCP samples',
  () => {
    it('the samples verify what Dina signs: REST with a body and an idempotency key, an MCP post, a GET with none', async () => {
      const requests = await captured(async (t) => {
        await t.call({
          transport: 'rest',
          endpoint: 'https://shop.example/ucp',
          profileUrl: 'https://abc.ucp.dinakernel.com/.well-known/ucp',
          operation: 'create_cart',
          idempotencyKey: '7f1c0c1e-3a5e-4c0e-9d5f-1d1b2a3c4d5e',
          payload: { line_items: [{ item: { id: 'v1' }, quantity: 2 }] },
        });
        await t.call({
          transport: 'rest',
          endpoint: 'https://shop.example/ucp',
          profileUrl: 'https://abc.ucp.dinakernel.com/.well-known/ucp',
          operation: 'get_cart',
          id: 'cart 1/ü',
        });
        await t.call({
          transport: 'mcp',
          endpoint: 'https://shop.example:8443/api/ucp/mcp?shop=1',
          profileUrl: 'https://abc.ucp.dinakernel.com/.well-known/ucp',
          operation: 'search_catalog',
          payload: { query: 'tea' },
        });
      });
      expect(requests.length).toBeGreaterThanOrEqual(3);
      for (const r of requests) {
        expect(samples('verify', toSamples(r))).toEqual({ ok: IDENTITY.key.jwk.kid });
      }
      // The same requests altered after signing are refused by the samples.
      const first = requests[0] as PolicySocketRequest;
      const altered = {
        ...toSamples(first),
        body_b64: Buffer.from('{"line_items":[]}').toString('base64'),
      };
      expect(samples('verify', altered)).toEqual({ error: 'digest_mismatch' });
    });

    it('Dina verifies what the samples sign', () => {
      const body = new TextEncoder().encode('{"query":"tea"}');
      const request = {
        method: 'POST',
        url: 'https://shop.example/ucp/catalog/search?x=1',
        headers: {
          'content-type': 'application/json',
          'ucp-agent': 'profile="https://platform.example/.well-known/ucp"',
        },
        body_b64: Buffer.from(body).toString('base64'),
      };
      const signed = samples('sign', request) as {
        headers: Record<string, string>;
        jwk: Record<string, unknown>;
      };
      const msg: HttpMessage = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(
          Object.entries({ ...request.headers, ...signed.headers }).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body,
      };
      const keyFor = merchantKeyLookup({ keys: [signed.jwk] } as unknown as MerchantProfile);
      expect(
        verifyMessage({ msg, required: requiredRequestComponents(msg), keyFor, sha256 }),
      ).toMatchObject({ ok: true, keyid: 'samples-key' });
    });
  },
);
