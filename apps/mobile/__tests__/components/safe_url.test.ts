/**
 * SEC — `safeHttpsUrl` gates untrusted, peer-supplied URLs before
 * `Linking.openURL`. A `service.response` body (e.g. an ETA card's `map_url`)
 * is attacker-controlled, so only real https:// links may be opened — never
 * tel:/sms:/javascript:/app-deep-link schemes a hostile provider could use to
 * launch a premium dialer, phishing page, or another app's intent handler.
 */

import { safeHttpsUrl } from '../../src/components/safe_url';

describe('safeHttpsUrl', () => {
  it('accepts a real https URL (the only legitimate maps link)', () => {
    const u = 'https://www.google.com/maps/place/Stop+42';
    expect(safeHttpsUrl(u)).toBe(u);
  });

  it.each([
    ['tel: premium-rate dialer', 'tel:1900555000'],
    ['sms: premium short-code', 'sms:+1900555000'],
    ['javascript: URI', 'javascript:alert(1)'],
    ['app deep-link scheme', 'evilapp://launch?cmd=wipe'],
    ['plain http (not https)', 'http://maps.example.com'],
    ['file scheme', 'file:///etc/passwd'],
  ])('rejects %s → null', (_label, raw) => {
    expect(safeHttpsUrl(raw)).toBeNull();
  });

  it.each([
    ['non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['malformed URL', 'not a url ::::'],
  ])('rejects %s → null', (_label, raw) => {
    expect(safeHttpsUrl(raw as unknown)).toBeNull();
  });
});
