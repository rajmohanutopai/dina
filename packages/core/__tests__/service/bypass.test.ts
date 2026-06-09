/**
 * Tests for `evaluateServiceEgressBypass` / `evaluateServiceIngressBypass`.
 */

import {
  evaluateServiceEgressBypass,
  evaluateServiceIngressBypass,
  type ProviderServiceResolver,
  type RequesterWindowView,
} from '../../src/service/bypass';
import { MsgTypeServiceQuery, MsgTypeServiceResponse } from '../../src/d2d/families';

const validQueryBody = {
  query_id: 'q-1',
  capability: 'eta_query',
  params: { location: { lat: 0, lng: 0 } },
  ttl_seconds: 60,
};

const validResponseBody = {
  query_id: 'q-1',
  capability: 'eta_query',
  status: 'success' as const,
  result: { eta_minutes: 45 },
  ttl_seconds: 60,
};

function resolverThat(answer: boolean): ProviderServiceResolver {
  return {
    isDiscoverableService: async () => answer,
  };
}

function requesterView(hit: boolean): RequesterWindowView {
  return { peek: () => hit };
}

describe('evaluateServiceEgressBypass', () => {
  describe('non-service types', () => {
    it('returns not-service for unknown types', async () => {
      const d = await evaluateServiceEgressBypass(
        'social.update',
        'did:plc:x',
        JSON.stringify({ text: 'hi' }),
      );
      expect(d.kind).toBe('not-service');
    });

    it('returns not-service for safety.alert', async () => {
      const d = await evaluateServiceEgressBypass(
        'safety.alert',
        'did:plc:x',
        JSON.stringify({ message: 'ok', severity: 'low' }),
      );
      expect(d.kind).toBe('not-service');
    });
  });

  describe('service.query', () => {
    it('allow when resolver says public', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:bus42',
        JSON.stringify(validQueryBody),
        resolverThat(true),
      );
      expect(d.kind).toBe('allow');
      if (d.kind === 'allow') {
        expect((d.body as typeof validQueryBody).query_id).toBe('q-1');
      }
    });

    it('deny with not_public_service when resolver says false', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify(validQueryBody),
        resolverThat(false),
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toBe('not_public_service');
        expect(d.detail).toMatch(/eta_query/);
      }
    });

    it('allow when resolver is omitted (caller guarantees precondition)', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:x',
        JSON.stringify(validQueryBody),
      );
      expect(d.kind).toBe('allow');
    });

    it('allow an UNLISTED service via service_uri even when the resolver says not-public (P2#2)', async () => {
      // The requester has the link (service_uri) — that's the access grant.
      // AppView never advertises unlisted, so resolverThat(false) would otherwise
      // deny; the present service_uri short-circuits the public-only check.
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:bus42',
        JSON.stringify({
          ...validQueryBody,
          service_uri: 'at://did:plc:bus42/com.dinakernel.service.profile/store-2',
        }),
        resolverThat(false),
      );
      expect(d.kind).toBe('allow');
    });

    it('deny a service_uri whose authority does not match the recipient (P2#2)', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:bus42',
        JSON.stringify({
          ...validQueryBody,
          service_uri: 'at://did:plc:someone-else/com.dinakernel.service.profile/store-2',
        }),
        resolverThat(true),
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('service_uri_mismatch');
    });

    it('deny body_invalid for malformed JSON', async () => {
      const d = await evaluateServiceEgressBypass(MsgTypeServiceQuery, 'did:plc:x', '{not json');
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toBe('body_invalid');
        expect(d.detail).toMatch(/JSON/);
      }
    });

    it('deny body_invalid for missing fields', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:x',
        JSON.stringify({ capability: 'eta_query', params: {}, ttl_seconds: 30 }),
        resolverThat(true),
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toBe('body_invalid');
        expect(d.detail).toMatch(/query_id/);
      }
    });

    it('deny body_invalid for out-of-range ttl', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceQuery,
        'did:plc:x',
        JSON.stringify({ ...validQueryBody, ttl_seconds: 500 }),
        resolverThat(true),
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('body_invalid');
    });
  });

  describe('service.response', () => {
    it('allow when body is well-formed (provider window handled separately)', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceResponse,
        'did:plc:requester',
        JSON.stringify(validResponseBody),
      );
      expect(d.kind).toBe('allow');
    });

    it('deny for invalid status', async () => {
      const d = await evaluateServiceEgressBypass(
        MsgTypeServiceResponse,
        'did:plc:requester',
        JSON.stringify({ ...validResponseBody, status: 'maybe' }),
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('body_invalid');
    });
  });
});

describe('evaluateServiceIngressBypass', () => {
  describe('non-service types', () => {
    it('returns not-service', () => {
      const d = evaluateServiceIngressBypass(
        'coordination.request',
        'did:plc:x',
        JSON.stringify({ action: 'propose_time', context: 'coffee' }),
        {},
      );
      expect(d.kind).toBe('not-service');
    });
  });

  describe('service.query ingress', () => {
    it('allow when capability is configured locally', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify(validQueryBody),
        { isCapabilityConfigured: () => true },
      );
      expect(d.kind).toBe('allow');
    });

    it('deny not_configured when capability is unknown locally', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify(validQueryBody),
        { isCapabilityConfigured: () => false },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toBe('not_configured');
        expect(d.detail).toMatch(/eta_query/);
      }
    });

    it('deny not_configured when checker is omitted', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify(validQueryBody),
        {},
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('not_configured');
    });

    it('PINS the accepted V1 gap: ingress admits a SUBJECT-SCOPED capability by configuration/possession alone', () => {
      // PUBLIC_SERVICES_TAXONOMY known gap (guardrail #8 adjacent): the
      // ingress bypass layer does NOT consult the catalog's
      // `requires_subject_authorization` — a stranger holding a listing's
      // capability/service_uri is admitted, and the requester's relationship
      // to the SUBJECT (whose order/homework/appointment it is) is never
      // checked here. This is a DECISION, not an accident:
      //   - known_only listings are grant-gated upstream (service_grants);
      //   - public/unlisted listings now require responsePolicy 'review' for
      //     subject-scoped caps (listing-validation `subject_auth_needs_review`),
      //     so a human approves every stranger-supplied subject identifier;
      //   - a future subject-grant check at ingress would replace this pin.
      // If this test starts failing because ingress DENIES, the gate was
      // wired — update the taxonomy doc + delete this pin.
      const subjectScopedQuery = {
        query_id: 'q-2',
        capability: 'order_status', // requires_subject_authorization: true
        params: { order_id: 'stranger-chosen-123' },
        ttl_seconds: 60,
      };
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:total-stranger',
        JSON.stringify(subjectScopedQuery),
        { isCapabilityConfigured: () => true },
      );
      expect(d.kind).toBe('allow');
    });

    it('deny body_invalid for malformed body', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:x',
        JSON.stringify({ query_id: '', capability: 'eta_query', params: {}, ttl_seconds: 30 }),
        { isCapabilityConfigured: () => true },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('body_invalid');
    });

    it('checker is called with the capability name from the body', () => {
      const seen: string[] = [];
      evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify(validQueryBody),
        {
          isCapabilityConfigured: (cap) => {
            seen.push(cap);
            return true;
          },
        },
      );
      expect(seen).toEqual(['eta_query']);
    });

    it('allows a service_uri whose authority matches recipientDID (P2 inbound bind)', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify({
          ...validQueryBody,
          service_uri: 'at://did:plc:me/com.dinakernel.service.profile/store-2',
        }),
        { isCapabilityConfigured: () => true, recipientDID: 'did:plc:me' },
      );
      expect(d.kind).toBe('allow');
    });

    it('passes the service_uri rkey to the checker (rkey-aware ingress, P1#2)', () => {
      const seen: { cap: string; rkey?: string }[] = [];
      evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify({
          ...validQueryBody,
          service_uri: 'at://did:plc:me/com.dinakernel.service.profile/store-2',
        }),
        {
          isCapabilityConfigured: (cap, rkey) => {
            seen.push({ cap, rkey });
            return true;
          },
          recipientDID: 'did:plc:me',
        },
      );
      expect(seen).toEqual([{ cap: 'eta_query', rkey: 'store-2' }]);
    });

    it('denies when the TARGETED listing rejects the cap, even if a generic check would pass (P1#2)', () => {
      // checker accepts only rkey 'ride'; the query targets 'store-2' → deny.
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify({
          ...validQueryBody,
          service_uri: 'at://did:plc:me/com.dinakernel.service.profile/store-2',
        }),
        {
          isCapabilityConfigured: (_cap, rkey) => rkey === 'ride',
          recipientDID: 'did:plc:me',
        },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('not_configured');
    });

    it('denies a cross-DID service_uri (authority != recipientDID) — P2 inbound bind', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify({
          // Well-formed listing URI, but for SOMEONE ELSE's DID — a direct peer
          // must not push a listing that doesn't belong to this recipient.
          ...validQueryBody,
          service_uri: 'at://did:plc:attacker/com.dinakernel.service.profile/store-9',
        }),
        { isCapabilityConfigured: () => true, recipientDID: 'did:plc:me' },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('service_uri_mismatch');
    });

    it('skips the cross-DID bind when recipientDID is omitted (back-compat)', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify({
          ...validQueryBody,
          service_uri: 'at://did:plc:attacker/com.dinakernel.service.profile/store-9',
        }),
        { isCapabilityConfigured: () => true },
      );
      expect(d.kind).toBe('allow');
    });

    it('denies a structurally-malformed service_uri via body validation (inbound)', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify({ ...validQueryBody, service_uri: 'not-an-at-uri' }),
        { isCapabilityConfigured: () => true, recipientDID: 'did:plc:me' },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('body_invalid');
    });
  });

  describe('service.query ingress — known_only GRANT gate', () => {
    const knownOnlyBody = {
      query_id: 'q1',
      capability: 'eta_query',
      params: {},
      ttl_seconds: 30,
      service_uri: 'at://did:plc:me/com.dinakernel.service.profile/private-1',
      grant_id: 'grant-1',
    };

    it('ALLOWS a known_only query when a grant authorizes the authenticated caller', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:emma',
        JSON.stringify(knownOnlyBody),
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: (a) =>
            a.granteeDid === 'did:plc:emma' &&
            a.serviceRkey === 'private-1' &&
            a.capability === 'eta_query' &&
            a.grantId === 'grant-1',
        },
      );
      expect(d.kind).toBe('allow');
    });

    it('DENIES (not_authorized) when no grant matches', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:emma',
        JSON.stringify(knownOnlyBody),
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: () => false,
        },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('not_authorized');
    });

    it('DENIES (not_authorized) when no grant checker is wired', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:emma',
        JSON.stringify(knownOnlyBody),
        { recipientDID: 'did:plc:me', knownOnlyCapabilityConfigured: () => true },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('not_authorized');
    });

    it("DENIES when the grant belongs to a DIFFERENT did (Bob can't reuse Emma's grant_id)", () => {
      // Bob sends Emma's grant_id, but the grant check binds to the AUTHENTICATED
      // caller (fromDID). grant-1 is Emma's → Bob is rejected.
      const grantIsEmmas = (a: { granteeDid: string }) => a.granteeDid === 'did:plc:emma';
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:bob',
        JSON.stringify(knownOnlyBody), // still carries grant_id: 'grant-1'
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: grantIsEmmas,
        },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('not_authorized');
    });

    it('passes the authenticated caller + grant_id to the grant check', () => {
      let seen: Record<string, unknown> | undefined;
      evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:emma',
        JSON.stringify(knownOnlyBody),
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: (a) => {
            seen = a as unknown as Record<string, unknown>;
            return true;
          },
        },
      );
      expect(seen).toEqual({
        granteeDid: 'did:plc:emma',
        serviceRkey: 'private-1',
        capability: 'eta_query',
        grantId: 'grant-1',
      });
    });

    it('canonicalizes the capability before the grant check (alias → canonical)', () => {
      // A query sent under the alias `bus_eta` must match a grant stored under
      // the canonical `eta_query` — the grant check receives the canonical form.
      let seen: Record<string, unknown> | undefined;
      evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:emma',
        JSON.stringify({ ...knownOnlyBody, capability: 'bus_eta' }),
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: (a) => {
            seen = a as unknown as Record<string, unknown>;
            return true;
          },
        },
      );
      expect(seen?.capability).toBe('eta_query');
    });

    it('DENIES a known_only query that omits grant_id (grant_id is required)', () => {
      const { grant_id: _omit, ...noGrant } = knownOnlyBody;
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:emma',
        JSON.stringify(noGrant),
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: () => true, // would authorize — but no grant_id was echoed
        },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('not_authorized');
    });

    it('a non-known_only listing is unaffected (falls through to isCapabilityConfigured)', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceQuery,
        'did:plc:stranger',
        JSON.stringify(knownOnlyBody),
        {
          recipientDID: 'did:plc:me',
          knownOnlyCapabilityConfigured: () => false, // public/unlisted
          isCapabilityConfigured: () => true,
          // a grant checker that would REJECT — must not even be consulted
          isGrantAuthorized: () => false,
        },
      );
      expect(d.kind).toBe('allow');
    });
  });

  describe('service.response ingress', () => {
    it('allow when the requester window has a live matching entry', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceResponse,
        'did:plc:bus42',
        JSON.stringify(validResponseBody),
        { requester: requesterView(true) },
      );
      expect(d.kind).toBe('allow');
    });

    it('deny no_window when requester view is omitted', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceResponse,
        'did:plc:bus42',
        JSON.stringify(validResponseBody),
        {},
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('no_window');
    });

    it('deny no_window when no matching entry', () => {
      const d = evaluateServiceIngressBypass(
        MsgTypeServiceResponse,
        'did:plc:bus42',
        JSON.stringify(validResponseBody),
        { requester: requesterView(false) },
      );
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') expect(d.reason).toBe('no_window');
    });

    it('does NOT consume the entry (pipeline consumes after all checks)', () => {
      const peekCalls: number[] = [];
      const requester: RequesterWindowView = {
        peek: () => {
          peekCalls.push(1);
          return true;
        },
      };
      evaluateServiceIngressBypass(
        MsgTypeServiceResponse,
        'did:plc:bus42',
        JSON.stringify(validResponseBody),
        { requester },
      );
      expect(peekCalls).toHaveLength(1);
    });

    it('peek is called with (fromDID, query_id, capability)', () => {
      const calls: Array<[string, string, string]> = [];
      const requester: RequesterWindowView = {
        peek: (...args) => {
          calls.push(args);
          return true;
        },
      };
      evaluateServiceIngressBypass(
        MsgTypeServiceResponse,
        'did:plc:bus42',
        JSON.stringify(validResponseBody),
        { requester },
      );
      expect(calls).toEqual([['did:plc:bus42', 'q-1', 'eta_query']]);
    });
  });
});
