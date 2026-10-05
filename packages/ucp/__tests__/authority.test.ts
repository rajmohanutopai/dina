import { authorityPrefixOf, checkAuthorityBinding } from '../src/authority';

describe('authority binding — the spec table (overview/index.md:916-926)', () => {
  it.each([
    ['dev.ucp.shopping.checkout', 'ucp.dev', true],
    ['dev.ucp.shopping.checkout', 'shopping.ucp.dev', true],
    ['com.example.payments.installments', 'example.com', true],
    ['com.example.pay', 'pay.example.com', true],
    ['com.example.pay', 'example.com', true],
    ['com.example.pay', 'evil.example', false],
    ['dev.ucp.shopping.checkout', 'evil.example', false],
    ['com.examplecorp.pay', 'example.com', false],
    ['com.example.pay', 'cdn.example.com', false],
  ])('%s from %s → %s', (name, host, accept) => {
    expect(checkAuthorityBinding(name, `https://${host}/2026-08-25/schemas/x.json`).ok).toBe(
      accept,
    );
  });
});

describe('authority binding — URL rules', () => {
  it('reads the host after userinfo, never a substring: ucp.dev@evil.example is refused', () => {
    expect(
      checkAuthorityBinding('dev.ucp.shopping.checkout', 'https://ucp.dev@evil.example/x.json'),
    ).toEqual({
      ok: false,
      reason: 'userinfo',
    });
  });
  it.each([
    ['http', 'http://ucp.dev/x.json', 'not_https'],
    ['IPv4 literal', 'https://203.0.113.10/x.json', 'ip_literal'],
    ['IPv6 literal', 'https://[2001:db8::1]/x.json', 'ip_literal'],
    ['single label', 'https://localhost/x.json', 'single_label'],
    ['garbage', 'not a url', 'unparseable'],
  ])('refuses %s', (_n, url, reason) => {
    expect(authorityPrefixOf(url)).toEqual({ ok: false, reason });
  });
  it('lower-cases, strips a trailing dot, and ignores the port', () => {
    expect(authorityPrefixOf('https://Shopping.UCP.dev.:8443/x.json')).toEqual({
      ok: true,
      authorityPrefix: 'dev.ucp.shopping',
    });
  });
  it('turns an IDN host into A-labels before reversing', () => {
    expect(authorityPrefixOf('https://bücher.example/x.json')).toEqual({
      ok: true,
      authorityPrefix: 'example.xn--bcher-kva',
    });
  });
});
