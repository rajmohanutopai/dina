/**
 * Card signatures across implementations (design §6.6, spec §8.4), against
 * the official a2a-sdk (`reference/card_forms.py`, pinned in
 * `reference/requirements.txt`). The SDK signs and verifies over a form of
 * the card that drops every empty value and every member its proto does not
 * know; §8.4.1 keeps both. So:
 * - the card the booted Core serves verifies in the SDK's own verifier, and
 *   only because of the signature Core adds over the SDK's form;
 * - a card the SDK signs verifies in Core's production verifier (the one
 *   registration uses): a v1.0 card with the bearer requirement every bearer
 *   card carries, and a dual-version card whose server adds v0.3 members.
 *
 * Runs when the reference venv exists (`scripts/test/a2a_reference_e2e.sh`)
 * or `DINA_A2A_REFERENCE_PYTHON` names a Python with a2a-sdk; skipped
 * otherwise, unless `DINA_A2A_REFERENCE_REQUIRED=1`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { verifyAgentCardSignatures, type JsonValue } from '@dina/a2a';
import {
  createJkuVerifier,
  deriveDIDKey,
  getPublicKey,
  registerService,
  setServiceConfigDurable,
  signRequest,
  type KeyResolutionNote,
} from '@dina/core';
import { resetCallerTypeState, resetMiddlewareState } from '@dina/core/runtime';

import { bootServer } from '../../src/boot';

const REFERENCE_DIR = path.join(__dirname, 'reference');
const PYTHON = process.env.DINA_A2A_REFERENCE_PYTHON ?? path.join(REFERENCE_DIR, '.venv', 'bin', 'python');
const AVAILABLE = existsSync(PYTHON);
const REQUIRED = process.env.DINA_A2A_REFERENCE_REQUIRED === '1';

const GATEWAY_SEED = new Uint8Array(32).fill(51);
const GATEWAY_DID = deriveDIDKey(getPublicKey(GATEWAY_SEED));

/** One run of `card_forms.py <mode>` with `input` on stdin; its stdout. */
function sdk(mode: 'sign' | 'verify', input: unknown): string {
  const run = spawnSync(PYTHON, [path.join(REFERENCE_DIR, 'card_forms.py'), mode], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.status !== 0) throw new Error(`card_forms.py ${mode}: ${run.stderr}`);
  return run.stdout.trim();
}

// RFC 7515 Appendix A.3's ES256 example key: published test material.
const SDK_KEY = {
  kty: 'EC',
  crv: 'P-256',
  kid: 'sdk-agent-key',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};
const SDK_JKU = 'https://agent.example/jwks.json';
const { d: _private, ...SDK_PUBLIC } = SDK_KEY;

function sdkCard(interfaces: string[]): Record<string, unknown> {
  return {
    name: 'Transit agent',
    description: 'Answers when the next bus comes.',
    supportedInterfaces: interfaces.map((v) => ({ url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: v })),
    version: '1.0.0',
    capabilities: { streaming: true },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'eta_query', name: 'ETA', description: 'When the bus comes.', tags: ['transit'] }],
  };
}

if (!AVAILABLE && REQUIRED) {
  it('has the reference agent’s Python (DINA_A2A_REFERENCE_REQUIRED=1)', () => {
    throw new Error(`no a2a-sdk Python at ${PYTHON}: run scripts/test/a2a_reference_e2e.sh`);
  });
}

(AVAILABLE ? describe : describe.skip)('card signatures between Dina and the a2a-sdk', () => {
  const originalEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    dir = mkdtempSync(path.join(tmpdir(), 'sdk-card-'));
    process.env['DINA_VAULT_DIR'] = dir;
    process.env['DINA_CORE_HOST'] = '127.0.0.1';
    process.env['DINA_CORE_PORT'] = '0';
    process.env['DINA_LOG_LEVEL'] = 'silent';
    process.env['DINA_MSGBOX_ENABLED'] = 'false';
    process.env['DINA_A2A_PUBLIC_URL'] = 'https://dina.example.org';
    process.env['DINA_A2A_GATEWAY_DID'] = GATEWAY_DID;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    resetMiddlewareState();
    resetCallerTypeState();
    jest.restoreAllMocks();
  });

  it('the card Core serves verifies in the SDK’s verifier, by the signature over the SDK’s form', async () => {
    const booted = await bootServer();
    try {
      await setServiceConfigDurable(
        {
          isDiscoverable: true,
          discoverability: 'public',
          status: 'active',
          name: 'Bus 42',
          // Answered in process, so the skill projects with no runner bound.
          capabilities: { eta_query: { responsePolicy: 'auto', instruction: 'Answer from the timetable.', category: 'transit' } },
          capabilitySchemas: {
            eta_query: {
              params: { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } },
              result: { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } },
              schemaHash: 'h-eta',
            },
          },
        },
        'bus',
      );
      registerService(GATEWAY_DID, 'gateway');
      const headers = signRequest('GET', '/v1/a2a/card', '', new Uint8Array(), GATEWAY_SEED, GATEWAY_DID);
      const res = await booted.app.inject({ method: 'GET', url: '/v1/a2a/card', headers });
      expect([res.statusCode, res.statusCode === 200 ? 'card' : res.body]).toEqual([200, 'card']);
      const { card, jwks } = res.json() as { card: Record<string, unknown> & { signatures: unknown[] }; jwks: unknown };
      expect(card.signatures).toHaveLength(2);
      expect(sdk('verify', { card, jwks })).toBe('verified');
      // Control: with the §8.4.1 signature alone, the SDK refuses Dina's card.
      expect(sdk('verify', { card: { ...card, signatures: card.signatures.slice(0, 1) }, jwks })).toBe('InvalidSignaturesError');
    } finally {
      await booted.app.close();
    }
  }, 60_000);

  it.each([
    ['a v1.0 card with a bearer requirement', ['1.0']],
    ['a dual-version card, its v0.3 members added by the SDK’s server', ['1.0', '0.3']],
  ])('%s, signed by the SDK, verifies in Core’s production verifier', async (_name, interfaces) => {
    const signed = JSON.parse(sdk('sign', { card: sdkCard(interfaces), jwk: SDK_KEY, kid: SDK_KEY.kid, jku: SDK_JKU })) as Record<string, unknown>;
    // The SDK checks its own card first: what Core reads is a card the SDK stands behind.
    expect(sdk('verify', { card: signed, jwks: { keys: [SDK_PUBLIC] } })).toBe('verified');
    const notes: KeyResolutionNote[] = [];
    const verify = createJkuVerifier(notes, async (url) =>
      url === SDK_JKU ? { ok: true, keys: [SDK_PUBLIC as unknown as JsonValue] } : { ok: false, reason: 'unreachable' as never },
    );
    const report = await verifyAgentCardSignatures(signed, verify);
    expect(report.state).toBe('verified');
    expect(notes.map((n) => n.outcome)).toEqual(['verified']);
  });
});
