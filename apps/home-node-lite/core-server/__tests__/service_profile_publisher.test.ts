/**
 * Task 6.19 — ServiceProfilePublisher tests.
 */

import { buildServiceProfile } from '../src/appview/profile_builder';
import {
  SERVICE_PROFILE_COLLECTION,
  SERVICE_PROFILE_RKEY,
  ServiceProfilePublisher,
  type PublishOutcome,
  type PutRecordFn,
  type ServiceProfilePublisherEvent,
} from '../src/appview/service_profile_publisher';
import type { ServiceProfileRecord } from '../src/appview/profile_builder';

function validProfile(): ServiceProfileRecord {
  return buildServiceProfile({
    name: 'SF Transit Authority',
    isPublic: true,
    capabilitySchemas: {
      eta_query: {
        description: 'Query estimated bus arrival time',
        params: { type: 'object' },
        result: { type: 'object' },
      },
    },
    responsePolicy: { eta_query: 'auto' },
  });
}

describe('ServiceProfilePublisher (task 6.19)', () => {
  describe('construction', () => {
    it('throws without putRecordFn', () => {
      expect(
        () =>
          new ServiceProfilePublisher({
            putRecordFn: undefined as unknown as PutRecordFn,
          }),
      ).toThrow(/putRecordFn/);
    });
  });

  describe('happy path', () => {
    it('publishes to {collection: com.dina.service.profile, rkey: self}', async () => {
      let putInput: unknown = null;
      const putRecordFn: PutRecordFn = async (input) => {
        putInput = input;
        return {
          cid: 'bafy123abc',
          uri: 'at://did:plc:self/com.dina.service.profile/self',
        };
      };
      const pub = new ServiceProfilePublisher({ putRecordFn });
      const out = await pub.publish(validProfile());
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.cid).toBe('bafy123abc');
        expect(out.uri).toMatch(/com.dina.service.profile\/self$/);
      }
      const ctx = putInput as { collection: string; rkey: string; record: unknown };
      expect(ctx.collection).toBe(SERVICE_PROFILE_COLLECTION);
      expect(ctx.rkey).toBe(SERVICE_PROFILE_RKEY);
      expect(ctx.record).toBeTruthy();
    });

    it('fires publishing + published events', async () => {
      const events: ServiceProfilePublisherEvent[] = [];
      const putRecordFn: PutRecordFn = async () => ({
        cid: 'cid-1',
        uri: 'at://x/com.dina.service.profile/self',
      });
      const pub = new ServiceProfilePublisher({
        putRecordFn,
        onEvent: (e) => events.push(e),
      });
      await pub.publish(validProfile());
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['publishing', 'published']);
    });

    it('publishing event carries schema_hash set', async () => {
      const events: ServiceProfilePublisherEvent[] = [];
      const pub = new ServiceProfilePublisher({
        putRecordFn: async () => ({ cid: 'x', uri: 'y' }),
        onEvent: (e) => events.push(e),
      });
      await pub.publish(validProfile());
      const pubEvt = events.find(
        (e) => e.kind === 'publishing',
      ) as Extract<ServiceProfilePublisherEvent, { kind: 'publishing' }>;
      expect(pubEvt.schemaHashSet).toHaveLength(1);
      expect(pubEvt.schemaHashSet[0]).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('malformed profile', () => {
    it.each([
      [
        'wrong $type',
        {
          ...validProfile(),
          $type: 'wrong.type',
        } as unknown as ServiceProfileRecord,
      ],
      [
        'missing name',
        {
          ...validProfile(),
          name: '',
        } as ServiceProfileRecord,
      ],
      [
        'non-boolean isPublic',
        {
          ...validProfile(),
          isPublic: 'yes' as unknown as boolean,
        } as ServiceProfileRecord,
      ],
      [
        'empty capabilities',
        {
          ...validProfile(),
          capabilities: [] as string[],
        } as ServiceProfileRecord,
      ],
    ])('rejects %s with reason=malformed_profile', async (_label, profile) => {
      const putRecordFn: PutRecordFn = jest.fn(async () => ({ cid: 'x', uri: 'y' }));
      const pub = new ServiceProfilePublisher({ putRecordFn });
      const out = await pub.publish(profile);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_profile');
      // putRecordFn never called when validation fails.
      expect(putRecordFn).not.toHaveBeenCalled();
    });

    it('rejects capability without schema_hash', async () => {
      const profile = {
        ...validProfile(),
        capabilitySchemas: {
          eta_query: {
            description: 'x',
            params: {},
            result: {},
            schema_hash: '',
          },
        },
      } as unknown as ServiceProfileRecord;
      const pub = new ServiceProfilePublisher({
        putRecordFn: async () => ({ cid: 'x', uri: 'y' }),
      });
      const out = await pub.publish(profile);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_profile');
    });
  });

  describe('network + PDS failures', () => {
    it('putRecordFn throw with no .status → network_error', async () => {
      const putRecordFn: PutRecordFn = async () => {
        throw new Error('ENETDOWN');
      };
      const pub = new ServiceProfilePublisher({ putRecordFn });
      const out = await pub.publish(validProfile());
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'network_error') {
        expect(out.error).toMatch(/ENETDOWN/);
      }
    });

    it('putRecordFn throw with .status → rejected_by_pds', async () => {
      const putRecordFn: PutRecordFn = async () => {
        const err = new Error('rate limited') as Error & { status?: number };
        err.status = 429;
        throw err;
      };
      const pub = new ServiceProfilePublisher({ putRecordFn });
      const out = await pub.publish(validProfile());
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_pds') {
        expect(out.status).toBe(429);
        expect(out.error).toMatch(/rate limited/);
      }
    });

    it('putRecordFn returns malformed result → rejected_by_pds', async () => {
      const putRecordFn: PutRecordFn = async () =>
        ({ cid: null } as unknown as { cid: string; uri: string });
      const pub = new ServiceProfilePublisher({ putRecordFn });
      const out = await pub.publish(validProfile());
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.reason).toBe('rejected_by_pds');
    });
  });

  describe('events on failure', () => {
    it('fires rejected event on malformed profile', async () => {
      const events: ServiceProfilePublisherEvent[] = [];
      const pub = new ServiceProfilePublisher({
        putRecordFn: async () => ({ cid: 'x', uri: 'y' }),
        onEvent: (e) => events.push(e),
      });
      await pub.publish({
        ...validProfile(),
        isPublic: 42 as unknown as boolean,
      });
      expect(events.some((e) => e.kind === 'rejected')).toBe(true);
    });

    it('fires rejected event on network error', async () => {
      const events: ServiceProfilePublisherEvent[] = [];
      const pub = new ServiceProfilePublisher({
        putRecordFn: async () => {
          throw new Error('net');
        },
        onEvent: (e) => events.push(e),
      });
      await pub.publish(validProfile());
      const rejected = events.find(
        (e) => e.kind === 'rejected',
      ) as Extract<ServiceProfilePublisherEvent, { kind: 'rejected' }>;
      expect(rejected.reason).toBe('network_error');
    });
  });

  describe('realistic flow', () => {
    it('roundtrips a full profile + returns AT URI', async () => {
      const putRecordFn: PutRecordFn = async ({ rkey }) => ({
        cid: 'bafyreib',
        uri: `at://did:plc:sftransit/com.dina.service.profile/${rkey}`,
      });
      const pub = new ServiceProfilePublisher({ putRecordFn });
      const profile = buildServiceProfile({
        name: 'SF Transit',
        isPublic: true,
        capabilitySchemas: {
          eta_query: {
            description: 'Bus ETA',
            params: { type: 'object' },
            result: { type: 'object' },
          },
          schedule_query: {
            description: 'Full schedule',
            params: { type: 'object' },
            result: { type: 'object' },
          },
        },
        responsePolicy: { eta_query: 'auto', schedule_query: 'auto' },
      });
      const out = (await pub.publish(profile)) as Extract<PublishOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.uri).toBe(
        'at://did:plc:sftransit/com.dina.service.profile/self',
      );
    });
  });
});
