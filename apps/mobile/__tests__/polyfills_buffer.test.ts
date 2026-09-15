/**
 * The phone's polyfill entry installs the `Buffer` global (§5.C1-mobile).
 *
 * The repo-proof verifier's AT-Protocol stack reads a CAR varint with
 * `Buffer.concat`; Hermes has no Buffer, and the audit found the polyfill
 * living in `@dina/crypto-expo`, a package the app never imports — so every
 * phone install would have died inside the CAR reader as `record_malformed`,
 * telling the owner a genuine release failed authenticity. This pins that the
 * module the app REALLY evaluates first (`src/polyfills.ts`, imported by
 * `app/_layout.tsx`) is what installs it, on every platform, and that a
 * runtime with its own Buffer is left alone.
 */

// The native branch of the polyfills pulls bridges Jest cannot load; they are
// not what is under test here.
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native-argon2', () => ({ default: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: undefined }));

interface BufferGlobal {
  Buffer?: unknown;
}

const g = globalThis as BufferGlobal;
const nodeBuffer = g.Buffer;

afterEach(() => {
  g.Buffer = nodeBuffer;
  jest.resetModules();
});

describe('src/polyfills — Buffer', () => {
  it('installs the `buffer` package as the global when the runtime has none', () => {
    delete g.Buffer;
    expect(g.Buffer).toBeUndefined();

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/polyfills');
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Buffer: polyfill } = require('buffer') as { Buffer: unknown };
    expect(g.Buffer).toBe(polyfill);
    // What `@atproto/repo`'s CAR reader actually calls.
    const B = g.Buffer as { concat: (parts: Uint8Array[]) => Uint8Array };
    expect(Array.from(B.concat([new Uint8Array([1, 2]), new Uint8Array([3])]))).toEqual([1, 2, 3]);
  });

  it('leaves a runtime that already has a Buffer alone', () => {
    const own = { marker: 'existing' };
    g.Buffer = own;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/polyfills');
    });
    expect(g.Buffer).toBe(own);
  });

  it('runs on the web build too — a browser has no Buffer either', () => {
    delete g.Buffer;
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({ Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web } }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/polyfills');
    });
    expect(g.Buffer).toBeDefined();
  });
});
