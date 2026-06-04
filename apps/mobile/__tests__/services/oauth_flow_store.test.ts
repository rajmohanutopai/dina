/**
 * OAuth redirect bridge — state-aware delivery.
 *
 * Regression guard: a leftover callback from a PREVIOUS login (e.g.
 * surfaced by Linking.getInitialURL() on the next attempt) must NOT be
 * consumed by a fresh flow — otherwise completeOAuth's CSRF state check
 * fails and the new login dies immediately.
 */
import { deliverRedirect, awaitRedirect, resetRedirect } from '../../src/services/oauth_flow_store';

const CB = (state: string, code = 'abc'): string =>
  `com.dinakernel.test:/oauth/callback?code=${code}&state=${state}`;

describe('oauth_flow_store — state-aware bridge', () => {
  afterEach(() => resetRedirect());

  it("delivers the current flow's callback (matching state)", async () => {
    resetRedirect('s-current');
    const p = awaitRedirect(1000);
    expect(deliverRedirect(CB('s-current'))).toBe(true);
    await expect(p).resolves.toContain('state=s-current');
  });

  it('IGNORES a stale callback whose state does not match the current flow', async () => {
    resetRedirect('s-new');
    // Leftover callback from a previous login (different state) — not ours.
    expect(deliverRedirect(CB('s-old'))).toBe(false);
    // The real (matching) callback still resolves the wait.
    const p = awaitRedirect(1000);
    expect(deliverRedirect(CB('s-new'))).toBe(true);
    await expect(p).resolves.toContain('state=s-new');
  });

  it('drops a stale callback (no buffering) so the flow keeps waiting', async () => {
    resetRedirect('s-fresh');
    // getInitialURL-style stale URL arrives before anyone waits — dropped,
    // not buffered, so awaitRedirect does not resolve with it.
    expect(deliverRedirect(CB('s-stale'))).toBe(false);
    await expect(awaitRedirect(50)).rejects.toThrow(/timed out/i);
  });

  it('without a declared state, accepts any callback (cold-start legacy path)', async () => {
    resetRedirect(); // no state
    const p = awaitRedirect(1000);
    expect(deliverRedirect(CB('whatever'))).toBe(true);
    await expect(p).resolves.toContain('oauth/callback');
  });

  it('ignores non-callback URLs regardless of state', () => {
    resetRedirect('s');
    expect(deliverRedirect('https://example.com/foo')).toBe(false);
    expect(deliverRedirect('com.dinakernel.test:/other?code=x')).toBe(false);
  });
});
