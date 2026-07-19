import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import {
  normalizeIdentifier,
  resolveExistingAtprotoIdentity,
} from '../../src/services/atproto_identity';

const DID = 'did:plc:external123';
const HANDLE = 'alice.bsky.social';
const PDS = 'https://pds.example';
const PLC = 'https://plc.test';

beforeEach(() => {
  resetKeychainMock();
});

function okJson(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('normalizeIdentifier', () => {
  it('normalizes common AT handle forms', () => {
    expect(normalizeIdentifier(' @Alice.Bsky.Social ')).toBe(HANDLE);
    expect(normalizeIdentifier('at://Alice.Bsky.Social')).toBe(HANDLE);
  });
});

describe('resolveExistingAtprotoIdentity', () => {
  it('resolves a did:plc directly from PLC data', async () => {
    const fetchFn = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === `${PLC}/${DID}/data`) {
        return okJson(plcData());
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as unknown as jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

    const result = await resolveExistingAtprotoIdentity(DID, { plcURL: PLC, fetchFn });
    expect(result).toMatchObject({
      did: DID,
      handle: HANDLE,
      pdsUrl: PDS,
      rotationKeys: ['did:key:zQ3rotation'],
    });
  });

  it('resolves a handle via .well-known before reading PLC data', async () => {
    const fetchFn = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === `https://${HANDLE}/.well-known/atproto-did`) {
        return new Response(DID, { status: 200 });
      }
      if (url === `${PLC}/${DID}/data`) {
        return okJson(plcData());
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as unknown as jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

    const result = await resolveExistingAtprotoIdentity(HANDLE, { plcURL: PLC, fetchFn });
    expect(result.did).toBe(DID);
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual([
      `https://${HANDLE}/.well-known/atproto-did`,
      `${PLC}/${DID}/data`,
    ]);
  });

  it('rejects non-PLC DIDs', async () => {
    await expect(
      resolveExistingAtprotoIdentity('did:web:alice.example', {
        plcURL: PLC,
        fetchFn: jest.fn() as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/did:plc/);
  });
});

function plcData(): Record<string, unknown> {
  return {
    rotationKeys: ['did:key:zQ3rotation'],
    alsoKnownAs: [`at://${HANDLE}`],
    verificationMethods: {
      atproto: 'did:key:zQ3atproto',
    },
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: PDS,
      },
    },
  };
}
