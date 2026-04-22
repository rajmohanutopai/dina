/**
 * Task 6.4 — RecordCrudClient tests.
 */

import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  RecordCrudClient,
  type GetOutcome,
  type ListOutcome,
  type RecordCrudEvent,
  type RepoClientFn,
  type RepoClientResult,
  type RepoRequestKind,
  type WriteOutcome,
} from '../src/appview/record_crud_client';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const BEARER = 'bearer-123';

function pds(
  results: Partial<Record<RepoRequestKind, { status: number; body: Record<string, unknown> | null }>>,
): RepoClientFn {
  return async (kind) => {
    const entry = results[kind];
    if (!entry) return { status: 500, body: { error: `no stub for ${kind}` } };
    return entry;
  };
}

function client(opts: Parameters<typeof pds>[0]) {
  return new RecordCrudClient({
    pdsClient: pds(opts),
    did: DID,
    bearer: BEARER,
  });
}

describe('RecordCrudClient (task 6.4)', () => {
  describe('construction', () => {
    it('throws without pdsClient', () => {
      expect(() =>
        new RecordCrudClient({
          pdsClient: undefined as unknown as RepoClientFn,
          did: DID,
          bearer: BEARER,
        }),
      ).toThrow(/pdsClient/);
    });

    it('throws without did', () => {
      expect(() =>
        new RecordCrudClient({
          pdsClient: pds({}),
          did: '',
          bearer: BEARER,
        }),
      ).toThrow(/did/);
    });

    it('throws without bearer', () => {
      expect(() =>
        new RecordCrudClient({
          pdsClient: pds({}),
          did: DID,
          bearer: '',
        }),
      ).toThrow(/bearer/);
    });
  });

  describe('createRecord', () => {
    it('200 → {uri, cid}', async () => {
      const c = client({
        createRecord: {
          status: 200,
          body: { uri: 'at://did/coll/key', cid: 'bafyx' },
        },
      });
      const out = (await c.createRecord({
        collection: 'com.dina.service.profile',
        record: { $type: 'com.dina.service.profile' },
      })) as Extract<WriteOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.result.uri).toBe('at://did/coll/key');
      expect(out.result.cid).toBe('bafyx');
    });

    it('threads repo+collection+record into payload', async () => {
      let seenPayload: Record<string, unknown> | null = null;
      const pdsClient: RepoClientFn = async (_kind, payload) => {
        seenPayload = payload;
        return { status: 200, body: { uri: 'u', cid: 'c' } };
      };
      const c = new RecordCrudClient({ pdsClient, did: DID, bearer: BEARER });
      await c.createRecord({
        collection: 'com.dina.service.profile',
        record: { a: 1 },
      });
      expect(seenPayload!.repo).toBe(DID);
      expect(seenPayload!.collection).toBe('com.dina.service.profile');
      expect(seenPayload!.record).toEqual({ a: 1 });
    });

    it('threads rkey when supplied', async () => {
      let seen: Record<string, unknown> | null = null;
      const pdsClient: RepoClientFn = async (_kind, payload) => {
        seen = payload;
        return { status: 200, body: { uri: 'u', cid: 'c' } };
      };
      const c = new RecordCrudClient({ pdsClient, did: DID, bearer: BEARER });
      await c.createRecord({
        collection: 'com.dina.service.profile',
        rkey: 'self',
        record: {},
      });
      expect(seen!.rkey).toBe('self');
    });

    it('validate flag threaded through', async () => {
      let seen: Record<string, unknown> | null = null;
      const pdsClient: RepoClientFn = async (_kind, payload) => {
        seen = payload;
        return { status: 200, body: { uri: 'u', cid: 'c' } };
      };
      const c = new RecordCrudClient({ pdsClient, did: DID, bearer: BEARER });
      await c.createRecord({
        collection: 'x.y',
        record: {},
        validate: true,
      });
      expect(seen!.validate).toBe(true);
    });

    it.each([
      ['bad collection', { collection: 'BAD-COLL', record: {} }],
      ['bad rkey', { collection: 'x.y', rkey: 'bad/key', record: {} }],
      ['record not object', { collection: 'x.y', record: [] as unknown as Record<string, unknown> }],
    ])('rejects %s with invalid_input', async (_label, input) => {
      const c = client({});
      const out = await c.createRecord(input as Parameters<typeof c.createRecord>[0]);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });

    it('429 → rate_limited', async () => {
      const c = client({
        createRecord: { status: 429, body: { error: 'slow down' } },
      });
      const out = await c.createRecord({ collection: 'x.y', record: {} });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rate_limited') {
        expect(out.status).toBe(429);
      }
    });

    it('network error → network_error', async () => {
      const c = new RecordCrudClient({
        pdsClient: async () => {
          throw new Error('ENET');
        },
        did: DID,
        bearer: BEARER,
      });
      const out = await c.createRecord({ collection: 'x.y', record: {} });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('network_error');
    });

    it('200 with malformed body → malformed_response', async () => {
      const c = client({
        createRecord: { status: 200, body: { cid: 'x' } }, // missing uri
      });
      const out = await c.createRecord({ collection: 'x.y', record: {} });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });

  describe('putRecord', () => {
    it('200 → {uri, cid}', async () => {
      const c = client({
        putRecord: {
          status: 200,
          body: { uri: 'at://x', cid: 'bafyx' },
        },
      });
      const out = (await c.putRecord({
        collection: 'x.y',
        rkey: 'self',
        record: {},
      })) as Extract<WriteOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.result.uri).toBe('at://x');
    });

    it('rkey required — rejected without it', async () => {
      const c = client({});
      const out = await c.putRecord({
        collection: 'x.y',
        rkey: '',
        record: {},
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });
  });

  describe('getRecord', () => {
    it('200 → {uri, cid, value}', async () => {
      const c = client({
        getRecord: {
          status: 200,
          body: { uri: 'at://x', cid: 'bafy', value: { a: 1 } },
        },
      });
      const out = (await c.getRecord({
        collection: 'x.y',
        rkey: 'self',
      })) as Extract<GetOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.result.value).toEqual({ a: 1 });
    });

    it('404 → not_found', async () => {
      const c = client({
        getRecord: { status: 404, body: { error: 'RecordNotFound' } },
      });
      const out = await c.getRecord({ collection: 'x.y', rkey: 'self' });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'not_found') {
        expect(out.status).toBe(404);
      }
    });

    it('can override did (read someone else\'s repo)', async () => {
      const otherDid = 'did:plc:zyxwvutsrqponmlkjihgfedc';
      let seenPayload: Record<string, unknown> | null = null;
      const pdsClient: RepoClientFn = async (_kind, payload) => {
        seenPayload = payload;
        return { status: 200, body: { uri: 'u', cid: 'c', value: {} } };
      };
      const c = new RecordCrudClient({ pdsClient, did: DID, bearer: BEARER });
      await c.getRecord({ did: otherDid, collection: 'x.y', rkey: 'self' });
      expect(seenPayload!.repo).toBe(otherDid);
    });

    it('non-object value → malformed_response', async () => {
      const c = client({
        getRecord: {
          status: 200,
          body: { uri: 'at://x', cid: 'bafy', value: 'wrong' },
        },
      });
      const out = await c.getRecord({ collection: 'x.y', rkey: 'self' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });

  describe('deleteRecord', () => {
    it('200 → ok:true', async () => {
      const c = client({ deleteRecord: { status: 200, body: null } });
      const out = await c.deleteRecord({ collection: 'x.y', rkey: 'self' });
      expect(out.ok).toBe(true);
    });

    it('bad rkey → invalid_input', async () => {
      const c = client({});
      const out = await c.deleteRecord({ collection: 'x.y', rkey: 'bad/key' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });
  });

  describe('listRecords', () => {
    it('200 with records', async () => {
      const c = client({
        listRecords: {
          status: 200,
          body: {
            records: [
              { uri: 'at://x/1', cid: 'c1', value: { a: 1 } },
              { uri: 'at://x/2', cid: 'c2', value: { a: 2 } },
            ],
            cursor: 'next',
          },
        },
      });
      const out = (await c.listRecords({
        collection: 'x.y',
      })) as Extract<ListOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.result.records).toHaveLength(2);
      expect(out.result.cursor).toBe('next');
    });

    it('default limit is 50', async () => {
      let seenPayload: Record<string, unknown> | null = null;
      const pdsClient: RepoClientFn = async (_kind, payload) => {
        seenPayload = payload;
        return {
          status: 200,
          body: { records: [], cursor: null },
        } satisfies RepoClientResult;
      };
      const c = new RecordCrudClient({ pdsClient, did: DID, bearer: BEARER });
      await c.listRecords({ collection: 'x.y' });
      expect(seenPayload!.limit).toBe(DEFAULT_LIST_LIMIT);
    });

    it('limit clamp rejected at input boundary', async () => {
      const c = client({});
      const out = await c.listRecords({ collection: 'x.y', limit: 999 });
      expect(out.ok).toBe(false);
    });

    it('drops malformed records silently', async () => {
      const c = client({
        listRecords: {
          status: 200,
          body: {
            records: [
              { uri: 'at://x/1', cid: 'c1', value: { a: 1 } },
              null,
              { uri: 'at://x/2', cid: 'c2' }, // missing value
              { uri: 'at://x/3', cid: 'c3', value: 'str' }, // wrong value type
              { uri: 'at://x/4', cid: 'c4', value: { b: 2 } },
            ],
          },
        },
      });
      const out = (await c.listRecords({
        collection: 'x.y',
      })) as Extract<ListOutcome, { ok: true }>;
      expect(out.result.records).toHaveLength(2);
      expect(out.result.records.map((r) => r.uri)).toEqual(['at://x/1', 'at://x/4']);
    });

    it('empty cursor → null', async () => {
      const c = client({
        listRecords: {
          status: 200,
          body: { records: [], cursor: '' },
        },
      });
      const out = (await c.listRecords({
        collection: 'x.y',
      })) as Extract<ListOutcome, { ok: true }>;
      expect(out.result.cursor).toBeNull();
    });

    it('MAX_LIST_LIMIT is 100', () => {
      expect(MAX_LIST_LIMIT).toBe(100);
    });
  });

  describe('events', () => {
    it('fires request + response events', async () => {
      const events: RecordCrudEvent[] = [];
      const c = new RecordCrudClient({
        pdsClient: pds({
          createRecord: { status: 200, body: { uri: 'u', cid: 'c' } },
        }),
        did: DID,
        bearer: BEARER,
        onEvent: (e) => events.push(e),
      });
      await c.createRecord({ collection: 'x.y', record: {} });
      expect(events.map((e) => e.kind)).toEqual(['request', 'response']);
    });

    it('fires rejected on invalid input', async () => {
      const events: RecordCrudEvent[] = [];
      const c = new RecordCrudClient({
        pdsClient: pds({}),
        did: DID,
        bearer: BEARER,
        onEvent: (e) => events.push(e),
      });
      await c.createRecord({
        collection: 'BAD',
        record: {},
      } as Parameters<typeof c.createRecord>[0]);
      expect(events.some((e) => e.kind === 'rejected')).toBe(true);
    });
  });

  describe('bearer passed through', () => {
    it('every call passes the bearer', async () => {
      let seenBearer: string | undefined;
      const pdsClient: RepoClientFn = async (_kind, _payload, bearer) => {
        seenBearer = bearer;
        return { status: 200, body: { uri: 'u', cid: 'c' } };
      };
      const c = new RecordCrudClient({
        pdsClient,
        did: DID,
        bearer: 'SECRET-BEARER',
      });
      await c.createRecord({ collection: 'x.y', record: {} });
      expect(seenBearer).toBe('SECRET-BEARER');
    });
  });
});
