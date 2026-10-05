/**
 * The app's claimed account-link callback (UCP plan §3.17): which URLs it
 * takes, and that its label rule is the profile host's own (it is kept free
 * of `@dina/core` for `+native-intent`, so the rule is written twice).
 */

import { LABEL_PATTERN, labelForHostname } from '@dina/ucp';

import { ucpLinkCallbackRoute } from '../../src/services/ucp_link_callback';

const HOST = 'ucp.dinakernel.com';

describe('the claimed callback link', () => {
  it('agrees with the profile host on which names are label hosts', () => {
    for (const label of [
      'abcdefghijklmnopqrstuvwxyz',
      'a234567abcdefghijklmnopqrs',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxy',
      'abcdefghijklmnopqrstuvwxyz1',
      'abcdefghijklmnopqrstuvwxy0',
      'abc.defghijklmnopqrstuvwxyz',
    ]) {
      const url = `https://${label}.${HOST}/oauth/callback?state=s`;
      const hostLabel = labelForHostname(`${label}.${HOST}`, HOST);
      expect(ucpLinkCallbackRoute(url, HOST) !== null).toBe(hostLabel !== null);
      if (hostLabel !== null) expect(LABEL_PATTERN.test(hostLabel)).toBe(true);
    }
  });

  it('keeps the query as it came; honours a configured profile host', () => {
    const label = 'abcdefghijklmnopqrstuvwxyz';
    expect(
      ucpLinkCallbackRoute(
        `https://${label}.${HOST}/oauth/callback?error=access_denied&state=s`,
        HOST,
      ),
    ).toBe('/ucp/oauth/callback?error=access_denied&state=s');
    expect(
      ucpLinkCallbackRoute(`https://${label}.ucp.test/oauth/callback?state=s`, 'ucp.test'),
    ).toBe('/ucp/oauth/callback?state=s');
    expect(
      ucpLinkCallbackRoute(`https://${label}.ucp.test/oauth/callback?state=s`, HOST),
    ).toBeNull();
  });

  it('takes nothing that is not exactly the link', () => {
    const label = 'abcdefghijklmnopqrstuvwxyz';
    for (const url of [
      `http://${label}.${HOST}/oauth/callback?state=s`,
      `https://user@${label}.${HOST}/oauth/callback?state=s`,
      `https://${label}.${HOST}/oauth/callback/more?state=s`,
      `https://${HOST}/oauth/callback?state=s`,
      'not a url',
    ])
      expect(ucpLinkCallbackRoute(url, HOST)).toBeNull();
  });
});
