/**
 * Tests for the handle/DID display helpers used by every screen that
 * renders a reviewer / author / contact.
 */

import {
  displayName,
  displayNameWithOverride,
  shortHandle,
  truncateDid,
} from '../../src/trust/handle_display';

describe('truncateDid', () => {
  it('returns short DIDs unchanged', () => {
    expect(truncateDid('did:web:a.b')).toBe('did:web:a.b');
    expect(truncateDid('did:plc:abc')).toBe('did:plc:abc');
  });

  it('truncates a long did:plc to head + ellipsis + tail', () => {
    const long = 'did:plc:abcdefghij1234567890';
    const out = truncateDid(long);
    expect(out.startsWith('did:plc:abcdef')).toBe(true);
    expect(out).toContain('…');
    expect(out.endsWith('7890')).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it('keeps the last 4 chars so two long DIDs with shared prefix stay distinguishable', () => {
    const a = 'did:plc:abcdefghijklmnop1111';
    const b = 'did:plc:abcdefghijklmnop2222';
    expect(truncateDid(a)).not.toBe(truncateDid(b));
  });
});

describe('shortHandle', () => {
  it('returns the first DNS label of a multi-label handle', () => {
    expect(shortHandle('alice.pds.dinakernel.com')).toBe('alice');
    expect(shortHandle('rajmohanddc9.test-pds.dinakernel.com')).toBe(
      'rajmohanddc9',
    );
  });

  it('passes a single-label handle through unchanged', () => {
    expect(shortHandle('alice')).toBe('alice');
  });

  it('returns the empty string when input is empty', () => {
    expect(shortHandle('')).toBe('');
  });

  it('returns the trimmed value for whitespace-only input', () => {
    expect(shortHandle('   ')).toBe('');
  });

  it('treats a leading-dot input defensively (returns the original trimmed value)', () => {
    // A handle starting with `.` is malformed — `dot === 0` would
    // otherwise produce '' and erase the row. Return the trimmed
    // input so the user sees something instead of a blank row.
    expect(shortHandle('.alice')).toBe('.alice');
  });

  it('trims surrounding whitespace before slicing', () => {
    expect(shortHandle('  alice.pds.dinakernel.com  ')).toBe('alice');
  });
});

describe('displayName', () => {
  it('prefers the first label of a non-empty handle', () => {
    // Default render: just the username. The full handle + DID + PLC
    // doc are revealed via the IdentityModal on tap.
    expect(displayName('alice.pds.dinakernel.com', 'did:plc:abc')).toBe(
      'alice',
    );
  });

  it('falls back to truncated DID when handle is null', () => {
    const long = 'did:plc:abcdefghij1234567890';
    expect(displayName(null, long)).toBe(truncateDid(long));
  });

  it('falls back to truncated DID when handle is undefined', () => {
    const long = 'did:plc:abcdefghij1234567890';
    expect(displayName(undefined, long)).toBe(truncateDid(long));
  });

  it('falls back to truncated DID when handle is the empty string', () => {
    // Wire-side `''` sentinel would already be normalised to null
    // upstream; this test pins the defensive path so a sloppy
    // upstream change can't slip a literal empty string into the
    // header text.
    const long = 'did:plc:abcdefghij1234567890';
    expect(displayName('', long)).toBe(truncateDid(long));
  });

  it('handles non-string handle values defensively', () => {
    // Upstream wire types declare handle as `string | null`, but
    // unsafe deserialisation could land any value here. The helper
    // narrows on `typeof === 'string'` so the screen never throws.
    const fn = (h: unknown, d: string): string =>
      displayName(h as string | null | undefined, d);
    expect(fn(42, 'did:plc:abc1234567890123')).toBe(
      truncateDid('did:plc:abc1234567890123'),
    );
  });
});

describe('displayNameWithOverride', () => {
  const SELF = 'did:plc:zaxxz2vts2umzfk2r5fpzes4';
  const OTHER = 'did:plc:abcdefghij1234567890';

  it('returns the override when DID matches selfDid', () => {
    expect(
      displayNameWithOverride('rajmohanddc9.test-pds.dinakernel.com', SELF, SELF, 'Sancho'),
    ).toBe('Sancho');
  });

  it('falls through to short handle when DID does not match selfDid', () => {
    // Pinning self-only behaviour: the override must NEVER overwrite
    // someone else's display label even if the user has set one.
    // Renaming other people would be a per-contact alias feature, not
    // this one.
    expect(
      displayNameWithOverride(
        'alice.pds.dinakernel.com',
        OTHER,
        SELF,
        'Sancho',
      ),
    ).toBe('alice');
  });

  it('falls through to short handle when override is null', () => {
    expect(
      displayNameWithOverride(
        'rajmohanddc9.test-pds.dinakernel.com',
        SELF,
        SELF,
        null,
      ),
    ).toBe('rajmohanddc9');
  });

  it('falls through to short handle when override is the empty string', () => {
    // Defensive: the override service normalises '' to null on write,
    // but a stale render cycle could still pass '' here.
    expect(
      displayNameWithOverride(
        'rajmohanddc9.test-pds.dinakernel.com',
        SELF,
        SELF,
        '',
      ),
    ).toBe('rajmohanddc9');
  });

  it('falls through to truncated DID when handle is null and DID does not match selfDid', () => {
    expect(displayNameWithOverride(null, OTHER, SELF, 'Sancho')).toBe(
      truncateDid(OTHER),
    );
  });

  it('falls through to truncated DID when selfDid is null', () => {
    // Pre-boot or signed-out state: there is no "self" yet, so the
    // override has nothing to attach to. The override must not leak
    // onto random rows just because selfDid hasn't loaded yet.
    expect(displayNameWithOverride(null, SELF, null, 'Sancho')).toBe(
      truncateDid(SELF),
    );
  });
});
