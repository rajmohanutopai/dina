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
