/**
 * permission_token tests.
 */

import {
  MIN_KEY_BYTES,
  PermissionTokenError,
  createPermissionTokenSigner,
  type IssueInput,
  type SignerOptions,
} from '../src/brain/permission_token';

function key(byte = 0x7): Uint8Array {
  const b = new Uint8Array(MIN_KEY_BYTES);
  for (let i = 0; i < b.length; i++) b[i] = (byte + i) & 0xff;
  return b;
}

class Clock {
  private t = 1_000_000;
  now = (): number => this.t;
  set(s: number): void { this.t = s; }
  advance(s: number): void { this.t += s; }
}

function issueBase(overrides: Partial<IssueInput> = {}): IssueInput {
  return { sub: 'did:plc:x', cap: 'export_download', ttlSec: 60, ...overrides };
}

describe('createPermissionTokenSigner — construction', () => {
  it.each([
    ['null opts', null],
    ['missing key', {}],
    ['key not Uint8Array', { key: 'x' }],
    ['key too short', { key: new Uint8Array(4) }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      createPermissionTokenSigner(bad as unknown as SignerOptions),
    ).toThrow(PermissionTokenError);
  });

  it('rejects acceptedVerifyKeys with short key', () => {
    expect(() =>
      createPermissionTokenSigner({
        key: key(),
        acceptedVerifyKeys: [{ key: new Uint8Array(4) }],
      }),
    ).toThrow(PermissionTokenError);
  });

  it('MIN_KEY_BYTES is 16', () => {
    expect(MIN_KEY_BYTES).toBe(16);
  });

  it('signer exposes keyId', () => {
    const signer = createPermissionTokenSigner({ key: key(), keyId: 'sig-2026-04' });
    expect(signer.keyId).toBe('sig-2026-04');
  });
});

describe('issue — input validation', () => {
  const signer = createPermissionTokenSigner({ key: key() });
  it.each([
    ['null input', null],
    ['empty sub', { sub: '', cap: 'c', ttlSec: 60 }],
    ['empty cap', { sub: 's', cap: '', ttlSec: 60 }],
    ['zero ttl', { sub: 's', cap: 'c', ttlSec: 0 }],
    ['fraction ttl', { sub: 's', cap: 'c', ttlSec: 1.5 }],
    ['negative nbf', { sub: 's', cap: 'c', ttlSec: 60, nbfOffsetSec: -1 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      signer.issue(bad as IssueInput),
    ).toThrow(PermissionTokenError);
  });
});

describe('issue + verify — round trip', () => {
  it('fresh token verifies successfully', () => {
    const clock = new Clock();
    const signer = createPermissionTokenSigner({ key: key(), nowSecFn: clock.now });
    const token = signer.issue(issueBase());
    const r = signer.verify(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sub).toBe('did:plc:x');
      expect(r.payload.cap).toBe('export_download');
      expect(r.payload.exp).toBe(1_000_060);
    }
  });

  it('token includes iat + jti', () => {
    const clock = new Clock();
    const signer = createPermissionTokenSigner({ key: key(), nowSecFn: clock.now });
    const token = signer.issue(issueBase());
    const r = signer.verify(token);
    if (r.ok) {
      expect(r.payload.iat).toBe(1_000_000);
      expect(r.payload.jti).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('extra field echoes', () => {
    const signer = createPermissionTokenSigner({ key: key() });
    const token = signer.issue(issueBase({ extra: { documentId: 'doc-42' } }));
    const r = signer.verify(token);
    if (r.ok) expect(r.payload.extra).toEqual({ documentId: 'doc-42' });
  });

  it('nbfOffsetSec sets not-before', () => {
    const clock = new Clock();
    const signer = createPermissionTokenSigner({ key: key(), nowSecFn: clock.now });
    const token = signer.issue(issueBase({ nbfOffsetSec: 30 }));
    const r = signer.verify(token);
    if (r.ok) expect(r.payload.nbf).toBe(1_000_030);
  });
});

describe('verify — failure reasons', () => {
  const signer = createPermissionTokenSigner({ key: key() });

  it.each([
    ['empty', ''],
    ['non-string', null],
    ['single part', 'onlyone'],
    ['empty part', '.x'],
  ] as const)('malformed: %s', (_l, bad) => {
    const r = signer.verify(bad as string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('bad base64url in payload', () => {
    const r = signer.verify('!!!.sig');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('payload not JSON', () => {
    // base64url of "not json"
    const body = Buffer.from('not json', 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const r = signer.verify(`${body}.sig`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('tampered signature', () => {
    const token = signer.issue(issueBase());
    const [body] = token.split('.');
    const tampered = `${body}.BADSIG${'A'.repeat(40)}`;
    const r = signer.verify(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('tampered payload → bad_signature', () => {
    const token = signer.issue(issueBase());
    const [, sig] = token.split('.');
    // Craft a differently-signed payload.
    const badBody = Buffer.from('{"sub":"x","cap":"c","exp":9999999999,"iat":1,"jti":"a"}', 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const r = signer.verify(`${badBody}.${sig}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });
});

describe('verify — temporal', () => {
  it('expired token → expired with payload echoed', () => {
    const clock = new Clock();
    const signer = createPermissionTokenSigner({ key: key(), nowSecFn: clock.now });
    const token = signer.issue(issueBase({ ttlSec: 60 }));
    clock.advance(100);
    const r = signer.verify(token);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('expired');
      expect(r.payload).toBeDefined();
    }
  });

  it('not-yet-valid → not_yet_valid', () => {
    const clock = new Clock();
    const signer = createPermissionTokenSigner({ key: key(), nowSecFn: clock.now });
    const token = signer.issue(issueBase({ ttlSec: 60, nbfOffsetSec: 30 }));
    // Before nbf (clock at 1_000_000, nbf at 1_000_030).
    const r = signer.verify(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_yet_valid');
  });

  it('exactly at expiry → expired (inclusive boundary)', () => {
    const clock = new Clock();
    const signer = createPermissionTokenSigner({ key: key(), nowSecFn: clock.now });
    const token = signer.issue(issueBase({ ttlSec: 60 }));
    clock.advance(60);
    const r = signer.verify(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('nowSecFn override in verify', () => {
    const signer = createPermissionTokenSigner({
      key: key(),
      nowSecFn: () => 1000, // "current" time when issuing
    });
    const token = signer.issue(issueBase({ ttlSec: 60 }));
    // Verify 2000s later using an explicit verifier clock.
    const r = signer.verify(token, { nowSecFn: () => 2000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });
});

describe('verify — expected-match', () => {
  const signer = createPermissionTokenSigner({ key: key() });

  it('cap_mismatch with expected payload', () => {
    const token = signer.issue(issueBase({ cap: 'read' }));
    const r = signer.verify(token, { expectedCap: 'write' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cap_mismatch');
      expect(r.payload).toBeDefined();
    }
  });

  it('sub_mismatch', () => {
    const token = signer.issue(issueBase({ sub: 'did:plc:a' }));
    const r = signer.verify(token, { expectedSub: 'did:plc:b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('sub_mismatch');
  });

  it('matching expected → ok', () => {
    const token = signer.issue(issueBase({ sub: 'did:plc:alice', cap: 'export' }));
    const r = signer.verify(token, { expectedSub: 'did:plc:alice', expectedCap: 'export' });
    expect(r.ok).toBe(true);
  });
});

describe('verify — key rotation', () => {
  it('acceptedVerifyKeys lets old keys still verify', () => {
    const oldKey = key(0x01);
    const newKey = key(0x02);
    const oldSigner = createPermissionTokenSigner({ key: oldKey });
    const token = oldSigner.issue(issueBase());
    // New signer accepts old key for verify.
    const newSigner = createPermissionTokenSigner({
      key: newKey,
      acceptedVerifyKeys: [{ key: oldKey }],
    });
    expect(newSigner.verify(token).ok).toBe(true);
  });

  it('verify fails when neither primary nor accepted key matches', () => {
    const oldSigner = createPermissionTokenSigner({ key: key(0x01) });
    const token = oldSigner.issue(issueBase());
    const newSigner = createPermissionTokenSigner({ key: key(0x02) });
    const r = newSigner.verify(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });
});

describe('token format', () => {
  it('format: <b64url>.<b64url>', () => {
    const signer = createPermissionTokenSigner({ key: key() });
    const token = signer.issue(issueBase());
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('two different issues produce different jti', () => {
    const signer = createPermissionTokenSigner({ key: key() });
    const t1 = signer.issue(issueBase());
    const t2 = signer.issue(issueBase());
    expect(t1).not.toBe(t2);
  });
});
