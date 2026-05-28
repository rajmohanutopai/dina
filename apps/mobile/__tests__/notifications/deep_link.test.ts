/**
 * Push-tap deep-link handler (task 5.68 / 5.70 layer 5).
 */

import { handleNotificationTap } from '../../src/notifications/deep_link';

describe('handleNotificationTap', () => {
  let pushed: string[];
  let marked: string[];
  const deps = {
    routerPush: (p: string): void => {
      pushed.push(p);
    },
    markRead: (id: string): boolean => {
      marked.push(id);
      return true;
    },
  };

  beforeEach(() => {
    pushed = [];
    marked = [];
  });

  it('marks the inbox entry read AND routes to deepLink when both present', () => {
    const result = handleNotificationTap(
      { inboxId: 'nt-1', deepLink: 'dina://approvals/abc' },
      deps,
    );
    expect(result).toEqual({ marked: true, navigated: true });
    expect(marked).toEqual(['nt-1']);
    // resolveSafeDeepLink normalises the approval link to the /approvals index.
    expect(pushed).toEqual(['/approvals']);
  });

  it('only marks read when deepLink missing', () => {
    const result = handleNotificationTap({ inboxId: 'nt-2' }, deps);
    expect(result).toEqual({ marked: true, navigated: false });
    expect(pushed).toEqual([]);
  });

  it('only navigates when inboxId missing', () => {
    const result = handleNotificationTap({ deepLink: 'dina://chat/main' }, deps);
    expect(result).toEqual({ marked: false, navigated: true });
    expect(marked).toEqual([]);
    // Normalised to the scheme-stripped internal path.
    expect(pushed).toEqual(['/chat/main']);
  });

  it('is a no-op for empty / null / undefined data', () => {
    expect(handleNotificationTap(null, deps)).toEqual({ marked: false, navigated: false });
    expect(handleNotificationTap(undefined, deps)).toEqual({ marked: false, navigated: false });
    expect(handleNotificationTap({}, deps)).toEqual({ marked: false, navigated: false });
    expect(pushed).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('ignores non-string inboxId / deepLink defensively', () => {
    const result = handleNotificationTap({ inboxId: 42, deepLink: { not: 'a string' } }, deps);
    expect(result).toEqual({ marked: false, navigated: false });
  });

  it('ignores empty-string deepLink', () => {
    const result = handleNotificationTap({ deepLink: '' }, deps);
    expect(result).toEqual({ marked: false, navigated: false });
  });

  // SEC (P2.12) — `deepLink` can be influenced by remote/peer data, so it is
  // allowlisted to internal, non-sensitive routes. External schemes and
  // sensitive screens must be refused (no navigation).
  it('navigates allowlisted internal routes (normalised to scheme-stripped paths)', () => {
    expect(handleNotificationTap({ deepLink: 'dina://chat/main?focus=r1' }, deps).navigated).toBe(
      true,
    );
    expect(handleNotificationTap({ deepLink: '/peerlens/sub123' }, deps).navigated).toBe(true);
    expect(pushed).toEqual(['/chat/main?focus=r1', '/peerlens/sub123']);
  });

  it('REFUSES external schemes (https/tel/sms/javascript/other-app)', () => {
    for (const bad of [
      'https://evil.example/login',
      'tel:1900555000',
      'sms:+1900555000',
      'javascript:alert(1)',
      'evilapp://launch?cmd=wipe',
    ]) {
      const r = handleNotificationTap({ deepLink: bad }, deps);
      expect(r.navigated).toBe(false);
    }
    expect(pushed).toEqual([]); // nothing was ever routed
  });

  it('REFUSES sensitive internal screens (recovery-phrase / admin / paired-devices / settings)', () => {
    for (const bad of [
      'dina://recovery-phrase',
      '/recovery-phrase',
      'dina://admin',
      'dina://paired-devices',
      '/settings',
      'dina://ai-providers',
    ]) {
      const r = handleNotificationTap({ deepLink: bad }, deps);
      expect(r.navigated).toBe(false);
    }
    expect(pushed).toEqual([]);
  });
});
