/**
 * TRADE_FIRST_STRATEGY §6.2/§6.6 — the staff caller type and its
 * fail-closed matrix.
 *
 * The load-bearing boundary: a staff-role device that fell through to
 * the generic `device` caller class would inherit vault query, persona
 * listing and the user-facing API. The §6.2 mandate is a distinct
 * caller type whose matrix allows exactly the commerce trade surface —
 * nothing else — with the refusals proven route by route.
 */

import { isAuthorized } from '../../src/auth/authz';
import {
  registerDevice,
  resetCallerTypeState,
  resolveCallerType,
  setDeviceRoleResolver,
} from '../../src/auth/caller_type';

const STAFF_DID = 'did:key:zstaffclerk';

describe("resolveCallerType — staff role (§6.2)", () => {
  beforeEach(() => {
    resetCallerTypeState();
    registerDevice(STAFF_DID, 'Order clerk phone');
  });
  afterEach(() => resetCallerTypeState());

  it("role='staff' resolves to callerType 'staff' — NEVER 'device'", () => {
    setDeviceRoleResolver(() => 'staff');
    const identity = resolveCallerType(STAFF_DID);
    expect(identity.callerType).toBe('staff');
    expect(identity.callerType).not.toBe('device');
  });
});

describe('authz matrix — the staff surface is the trade prefix and nothing else (§6.6)', () => {
  const ALLOWED: [string, string][] = [
    ['POST', '/v1/commerce/trade/delivery-receipt'],
    ['POST', '/v1/commerce/trade/staff-presence'],
    ['GET', '/v1/commerce/trade/unanswered'],
    ['GET', '/v1/commerce/trade/inbox'],
    // §6.5's table, exactly: the three scopes' operations.
    ['POST', '/v1/commerce/orders/drafts/confirm'],
    ['POST', '/v1/commerce/orders/drafts/approve'],
    ['POST', '/v1/commerce/orders/drafts/submit'],
    ['POST', '/v1/commerce/orders/decide'],
  ];

  it.each(ALLOWED)('staff MAY reach %s %s (the handler gate decides further)', (method, path) => {
    expect(isAuthorized('staff', method, path)).toBe(true);
  });

  const DENIED: [string, string][] = [
    // §6.6 by name: vault, personas, approvals, pairing, devices,
    // export, settings-equivalents, the user-facing API.
    ['POST', '/v1/vault/query'],
    ['POST', '/v1/vault/store'],
    ['GET', '/v1/vault/item/42'],
    ['GET', '/v1/personas'],
    ['POST', '/v1/persona/unlock'],
    ['GET', '/v1/approvals'],
    ['POST', '/v1/pair/initiate'],
    ['GET', '/v1/devices'],
    ['DELETE', '/v1/devices/self'],
    ['POST', '/v1/export'],
    ['POST', '/api/v1/ask'],
    ['POST', '/api/v1/remember'],
    ['POST', '/v1/workflow/tasks'],
    ['POST', '/v1/workflow/tasks/claim'],
    ['POST', '/v1/staging/ingest'],
    ['GET', '/v1/contacts'],
    ['GET', '/v1/reminders'],
    ['POST', '/v1/msg/send'],
    ['GET', '/v1/d2d/quarantine'],
    ['POST', '/v1/agent/validate'],
    ['GET', '/v1/session/current'],
    // The staff-grant CEREMONY routes sit outside the trade prefix so
    // the matrix itself refuses a staff caller (§6.6: staff can never
    // create or edit grants) — the generic /v1/commerce rule is
    // owner-only.
    ['POST', '/v1/commerce/staff-grants'],
    ['POST', '/v1/commerce/staff-grants/revoke'],
    ['GET', '/v1/commerce/staff-grants'],
    ['GET', '/v1/commerce/reconciliation'],
    // Boundary safety: a path that merely STARTS with the trade string
    // must not match the prefix rule.
    ['POST', '/v1/commerce/tradefoo'],
    // §6.2 — "the commerce operations its grant names — nothing else":
    // the owner-only trade routes, refused BY THE MATRIX, route by
    // route. These once rode a broad trade-prefix admission where only
    // the handler's ownerOnlyGuard stood between staff and, say, the
    // firm's books; a copy-paste guard swap would have opened them with
    // no failing test.
    ['POST', '/v1/commerce/trade/delivery-note'],
    ['POST', '/v1/commerce/trade/payment-note'],
    ['POST', '/v1/commerce/trade/payment-ack'],
    ['POST', '/v1/commerce/trade/quote-decline'],
    ['GET', '/v1/commerce/trade/statement'],
    ['GET', '/v1/commerce/trade/books-export'],
    ['POST', '/v1/commerce/trade/tender'],
    ['GET', '/v1/commerce/trade/tender/comparison'],
    ['POST', '/v1/commerce/trade/revshare/propose'],
    ['POST', '/v1/commerce/trade/revshare/decide'],
    ['POST', '/v1/commerce/trade/revshare/terminate'],
    ['POST', '/v1/commerce/trade/revshare/settle'],
    ['POST', '/v1/commerce/trade/revshare/ack-settlement'],
    ['GET', '/v1/commerce/trade/revshare/statement'],
    // The staff rows are exact + method-bound: other verbs refuse.
    ['GET', '/v1/commerce/trade/delivery-receipt'],
    ['POST', '/v1/commerce/trade/inbox'],
    ['GET', '/v1/commerce/trade/staff-presence'],
    // The four operation rows are EXACT and POST-only: no sub-path, no
    // read verb, no sibling route inherits the admission.
    ['GET', '/v1/commerce/orders/drafts/confirm'],
    ['POST', '/v1/commerce/orders/drafts/confirm/extra'],
    ['POST', '/v1/commerce/orders/drafts'],
    ['POST', '/v1/commerce/orders/submit'],
    ['GET', '/v1/commerce/orders/pending-decisions'],
  ];

  it.each(DENIED)('staff may NOT reach %s %s', (method, path) => {
    expect(isAuthorized('staff', method, path)).toBe(false);
  });

  it('an unknown path stays fail-closed', () => {
    expect(isAuthorized('staff', 'GET', '/v1/anything/else')).toBe(false);
  });
});
describe('the SIGNED pipeline admits a staff device (the harnesses preset callerType and never noticed)', () => {
  const { TEST_ED25519_SEED } = jest.requireActual<typeof import('@dina/test-harness')>('@dina/test-harness');
  const { signRequest } = jest.requireActual<typeof import('../../src/auth/canonical')>('../../src/auth/canonical');
  const {
    authenticateRequest,
    registerPublicKeyResolver,
    resetMiddlewareState,
  } = jest.requireActual<typeof import('../../src/auth/middleware')>('../../src/auth/middleware');
  const {
    registerDevice: registerCallerDevice,
    resetCallerTypeState,
    setDeviceRoleResolver,
  } = jest.requireActual<typeof import('../../src/auth/caller_type')>('../../src/auth/caller_type');
  const { getPublicKey } = jest.requireActual<typeof import('../../src/crypto/ed25519')>('../../src/crypto/ed25519');

  const staffDid = 'did:key:z6MkSignedStaffPhone';
  const pubKey = getPublicKey(TEST_ED25519_SEED);

  function signed(method: string, path: string) {
    const body = new Uint8Array();
    const headers = signRequest(method, path, '', body, TEST_ED25519_SEED, staffDid);
    return { method, path, query: '', body, headers };
  }

  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
    registerPublicKeyResolver((d: string) => (d === staffDid ? pubKey : null));
    registerCallerDevice(staffDid, 'clerk-phone');
    setDeviceRoleResolver(() => 'staff');
  });

  afterEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
  });

  it('a signed staff call reaches its allowed route — the live bug refused EVERY staff phone here', () => {
    const r = authenticateRequest(signed('GET', '/v1/commerce/trade/inbox'));
    expect(r.authenticated).toBe(true);
    expect(r.callerType).toBe('staff');
  });

  it('the same signed device still refuses on an owner-only route (matrix, not mapping)', () => {
    const r = authenticateRequest(signed('GET', '/v1/commerce/trade/statement'));
    expect(r.authenticated).toBe(false);
    expect(r.rejectedAt).toBe('authorization');
  });
});
