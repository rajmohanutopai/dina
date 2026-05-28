/**
 * SEC (P1.3) — `resolveSafeDeepLink` is THE single resolver for every untrusted
 * notification/briefing `deepLink` push. It normalises (approval → /approvals,
 * dina:// scheme strip) AND allowlists: external schemes and sensitive routes
 * are rejected. Previously the Notifications screen + briefing card pushed
 * links through a normalise-only path that let `https://…` and `/vault/…`
 * through — this tests the real, unified function.
 */

import { resolveSafeDeepLink } from '../../src/notifications/deep_link';

describe('resolveSafeDeepLink (unified normalise + allowlist)', () => {
  it('normalises Brain approval deep links (with/without scheme, with id) to /approvals', () => {
    expect(
      resolveSafeDeepLink('dina://approvals/approval-staging-stg-19c9529527531f0a-health'),
    ).toBe('/approvals');
    expect(resolveSafeDeepLink('/approvals/abc123')).toBe('/approvals');
    expect(resolveSafeDeepLink('/approvals')).toBe('/approvals');
  });

  it('strips the dina:// scheme for allowlisted routes', () => {
    expect(resolveSafeDeepLink('dina://reminders/r-42')).toBe('/reminders/r-42');
    expect(resolveSafeDeepLink('dina://chat/main?focus=x')).toBe('/chat/main?focus=x');
  });

  it('REJECTS external schemes (was a pass-through bug)', () => {
    expect(resolveSafeDeepLink('https://example.com/x')).toBeNull();
    expect(resolveSafeDeepLink('tel:1900555000')).toBeNull();
    expect(resolveSafeDeepLink('javascript:alert(1)')).toBeNull();
    expect(resolveSafeDeepLink('evilapp://launch')).toBeNull();
  });

  it('REJECTS sensitive internal routes (was a pass-through bug)', () => {
    expect(resolveSafeDeepLink('/vault/general')).toBeNull();
    expect(resolveSafeDeepLink('dina://recovery-phrase')).toBeNull();
    expect(resolveSafeDeepLink('dina://admin')).toBeNull();
    expect(resolveSafeDeepLink('/settings')).toBeNull();
  });
});
