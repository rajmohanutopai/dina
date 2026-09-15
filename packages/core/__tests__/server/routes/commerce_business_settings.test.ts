/**
 * `/v1/commerce/settings/business` — the node's own paper identity (§5.D).
 *
 * A third settings kind beside the two roles, because one node is one legal
 * business: the country-pack filings need a legal name, a registration and an
 * address, and nothing in the trade design placed them. The route contract is
 * the same as the other two kinds — owner-only, "absent" and "invalid" are
 * different answers, and a refused write stores nothing.
 */

import { type BusinessSettings } from '../../../src/commerce/commerce_settings';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import {
  InMemoryCommerceSettingsRepository,
  type CommerceSettingsRepository,
} from '../../../src/commerce/settings_store';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

const OWNER_CAP = 'test-owner-capability-secret';
const GSTIN = '27AAPFU0939F1ZV';

function request(
  method: 'GET' | 'PUT',
  path: string,
  body?: Record<string, unknown>,
  overrides: Partial<CoreRequest> = {},
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body: body ?? {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
    ...overrides,
  } as unknown as CoreRequest;
}

const IDENTITY: BusinessSettings = {
  legalName: 'Utopai Furniture LLP',
  registrations: [{ scheme: 'gstin', value: GSTIN }],
  address: { line1: '12 Nehru Road', city: 'Bengaluru', region: 'Karnataka', postalCode: '560001', country: 'IN' },
};

let settings: CommerceSettingsRepository;
let router: CoreRouter;

beforeEach(() => {
  settings = new InMemoryCommerceSettingsRepository();
  installCommerceRuntime({ settings } as unknown as CommerceRuntime);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
});

describe('GET /v1/commerce/settings/business', () => {
  it('answers "not configured" before the owner has filled anything in — a node trades without a filing identity', async () => {
    const res = await router.handle(request('GET', '/v1/commerce/settings/business'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it('returns the stored identity once written', async () => {
    expect(settings.writeBusiness(IDENTITY).ok).toBe(true);
    const res = await router.handle(request('GET', '/v1/commerce/settings/business'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      settings: { legalName: 'Utopai Furniture LLP', registrations: [{ scheme: 'gstin', value: GSTIN }] },
    });
  });

  it('is owner-only — an in-process device or agent caller is refused, and so is a wrong capability', async () => {
    for (const callerType of ['device', 'agent', 'brain'] as const) {
      const res = await router.handle(
        request('GET', '/v1/commerce/settings/business', undefined, {
          callerType,
          ownerCapability: undefined,
        } as Partial<CoreRequest>),
      );
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'access_denied' });
    }
    const wrongCap = await router.handle(
      request('GET', '/v1/commerce/settings/business', undefined, {
        ownerCapability: 'not-the-capability',
      } as Partial<CoreRequest>),
    );
    expect(wrongCap.status).toBe(403);
  });
});

describe('PUT /v1/commerce/settings/business', () => {
  it('stores a valid identity in its normalised form', async () => {
    const res = await router.handle(
      request('PUT', '/v1/commerce/settings/business', {
        ...IDENTITY,
        legalName: '  Utopai   Furniture  LLP ',
        registrations: [{ scheme: 'GSTIN', value: GSTIN.toLowerCase() }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const read = settings.readBusiness();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected settings');
    expect(read.settings.legalName).toBe('Utopai Furniture LLP');
    expect(read.settings.registrations).toEqual([{ scheme: 'gstin', value: GSTIN }]);
  });

  it('refuses a mistyped registration with the finding, and stores nothing', async () => {
    const res = await router.handle(
      request('PUT', '/v1/commerce/settings/business', {
        ...IDENTITY,
        registrations: [{ scheme: 'gstin', value: '27AAPFU0939F1ZW' }],
      }),
    );
    expect(res.status).toBe(400);
    const body = res.body as { ok: boolean; findings: { refusal: string }[] };
    expect(body.ok).toBe(false);
    expect(body.findings.map((f) => f.refusal)).toEqual(['malformed_registration']);
    expect(settings.readBusiness()).toEqual({ ok: false, absent: true });
  });

  it('refuses a body that is not an object', async () => {
    const res = await router.handle(
      request('PUT', '/v1/commerce/settings/business', undefined, { body: 'nope' } as Partial<CoreRequest>),
    );
    expect(res.status).toBe(400);
  });

  it('is owner-only — a device caller writes nothing', async () => {
    const res = await router.handle(
      request('PUT', '/v1/commerce/settings/business', { ...IDENTITY }, {
        callerType: 'device',
        ownerCapability: undefined,
      } as Partial<CoreRequest>),
    );
    expect(res.status).toBe(403);
    expect(settings.readBusiness()).toEqual({ ok: false, absent: true });
  });

  it('answers 503 when commerce is not wired at all', async () => {
    installCommerceRuntime(null);
    const res = await router.handle(request('PUT', '/v1/commerce/settings/business', { ...IDENTITY }));
    expect(res.status).toBe(503);
  });
});

describe('an identity that no longer validates', () => {
  it('is a fault the owner sees (409), not a silent "not configured"', async () => {
    // Reach past the write guard the way a hand-edited row or an older schema
    // would: the read path must still judge what it finds.
    expect(settings.writeBusiness(IDENTITY).ok).toBe(true);
    (settings as unknown as { business: unknown }).business = { legalName: '', registrations: [] };
    const res = await router.handle(request('GET', '/v1/commerce/settings/business'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ configured: true, error: 'settings_invalid' });
  });
});
