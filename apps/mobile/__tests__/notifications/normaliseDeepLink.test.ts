/**
 * SEC (P1.3) — `resolveSafeDeepLink` is THE single resolver for every untrusted
 * notification/briefing `deepLink` push. It normalises (approval →
 * /notifications, dina:// scheme strip) AND allowlists: external schemes and
 * sensitive routes are rejected. Previously the Notifications screen + briefing
 * card pushed links through a normalise-only path that let `https://…` and
 * `/vault/…` through — this tests the real, unified function.
 *
 * The standalone Approvals screen was merged into the Activity tab; approval
 * deep links now land on `/notifications` (Needs action) where the inline
 * approval cards cover the action.
 */

import { handleColdStartDeepLink, resolveSafeDeepLink } from '../../src/notifications/deep_link';

describe('resolveSafeDeepLink (unified normalise + allowlist)', () => {
  it('normalises Brain approval deep links to /notifications on the Needs-action filter', () => {
    // Approval cards live on Activity's "Needs action" filter, so land taps
    // there directly (not the default "Unread" tab).
    expect(
      resolveSafeDeepLink('dina://approvals/approval-staging-stg-19c9529527531f0a-health'),
    ).toBe('/notifications?filter=needs_action');
    expect(resolveSafeDeepLink('/approvals/abc123')).toBe('/notifications?filter=needs_action');
    expect(resolveSafeDeepLink('/approvals')).toBe('/notifications?filter=needs_action');
    expect(resolveSafeDeepLink('dina://approvals')).toBe('/notifications?filter=needs_action');
  });

  it('strips the dina:// scheme for allowlisted routes', () => {
    expect(resolveSafeDeepLink('dina://reminders/r-42')).toBe('/reminders/r-42');
    expect(resolveSafeDeepLink('dina://chat/main?focus=x')).toBe('/chat/main?focus=x');
    expect(resolveSafeDeepLink('dina://runs')).toBe('/runs');
    expect(resolveSafeDeepLink('dina://subscriptions')).toBe('/subscriptions');
  });

  it('lands briefing notifications on Activity because no detail route exists', () => {
    expect(resolveSafeDeepLink('dina://briefings/brief-42')).toBe('/notifications?filter=all');
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

describe('handleColdStartDeepLink', () => {
  it('routes a retained safe iOS launch URL through the canonical resolver', async () => {
    const routerReplace = jest.fn();

    await expect(
      handleColdStartDeepLink({
        getInitialURL: async () => 'dina://approvals/approval-1',
        routerReplace,
      }),
    ).resolves.toBe(true);
    expect(routerReplace).toHaveBeenCalledWith('/notifications?filter=needs_action');
  });

  it('ignores absent, sensitive, and unreadable initial URLs', async () => {
    const routerReplace = jest.fn();

    await expect(
      handleColdStartDeepLink({ getInitialURL: async () => null, routerReplace }),
    ).resolves.toBe(false);
    await expect(
      handleColdStartDeepLink({
        getInitialURL: async () => 'dina://vault/health',
        routerReplace,
      }),
    ).resolves.toBe(false);
    await expect(
      handleColdStartDeepLink({
        getInitialURL: async () => {
          throw new Error('linking unavailable');
        },
        routerReplace,
      }),
    ).resolves.toBe(false);
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
