import { redirectSystemPath } from '../../app/+native-intent';

describe('native Dina deep links', () => {
  it('normalizes supported notification and direct-link destinations', () => {
    expect(
      redirectSystemPath({ path: 'dina://approvals/appr-1', initial: true }),
    ).toBe('/notifications?filter=needs_action');
    expect(redirectSystemPath({ path: 'dina://reminders', initial: false })).toBe(
      '/reminders',
    );
    expect(redirectSystemPath({ path: 'dina://runs', initial: false })).toBe('/runs');
  });

  it('keeps the OAuth callback and development-client bootstrap routable', () => {
    expect(
      redirectSystemPath({
        path: 'dina://oauth/callback?code=abc&state=expected',
        initial: true,
      }),
    ).toBe('/oauth/callback?code=abc&state=expected');
    expect(
      redirectSystemPath({
        path: 'dina://expo-development-client/?url=http://localhost:8081',
        initial: true,
      }),
    ).toBe('dina://expo-development-client/?url=http://localhost:8081');
  });

  it('rejects sensitive and external Dina routes without throwing', () => {
    expect(redirectSystemPath({ path: 'dina://admin', initial: false })).toBeNull();
    expect(redirectSystemPath({ path: 'dina://recovery-phrase', initial: true })).toBeNull();
    expect(redirectSystemPath({ path: null, initial: true })).toBeNull();
  });

  it('does not rewrite non-Dina URLs used by other registered flows', () => {
    const callback = 'com.dinakernel.mobile:/oauth/callback?code=abc';
    expect(redirectSystemPath({ path: callback, initial: true })).toBe(callback);
  });
});
