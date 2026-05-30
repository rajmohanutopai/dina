import { describe, it, expect } from '@jest/globals';

import { buildResultCardSpec } from '../../src/service/result_card_mapper';

const kinds = (s: any) => s.blocks.map((b: any) => b.kind);
const find = (s: any, kind: string) => s.blocks.find((b: any) => b.kind === kind);

describe('buildResultCardSpec — deterministic, capability-agnostic, no badges', () => {
  it('eta_query → title(transit) + stat(min) + map(coords); status is a toned keyValue', () => {
    const spec = buildResultCardSpec({
      capability: 'eta_query',
      serviceName: 'Demo ETA Provider',
      result: {
        status: 'on_route',
        eta_minutes: 8,
        vehicle_type: 'bus',
        route_name: 'Route 38 Geary',
        stop_name: 'Geary Street (Union Square)',
        location: { lat: 37.787, lng: -122.408 },
        message: 'stub_eta_runner (canned test data)',
      },
    });
    expect(spec).not.toBeNull();
    expect(kinds(spec)).toContain('title');
    expect(kinds(spec)).toContain('stat');
    expect(kinds(spec)).toContain('map');

    // NO badge — provider status is a toned keyValue instead.
    expect(kinds(spec)).not.toContain('badge');
    const status = spec!.blocks.find((b: any) => b.kind === 'keyValue' && b.label === 'Status') as any;
    expect(status.value).toBe('On route');
    expect(status.tone).toBe('positive');

    expect((find(spec, 'title') as any).text).toBe('Route 38 Geary');
    expect((find(spec, 'title') as any).icon).toBe('transit');
    const stat = find(spec, 'stat') as any;
    expect(stat.value).toBe('8');
    expect(stat.unit).toBe('min');
    expect(stat.caption).toContain('Geary Street');

    const map = find(spec, 'map') as any;
    expect(map.lat).toBe(37.787);
    expect(map.lng).toBe(-122.408);
    expect(map.url).toBeUndefined(); // structured, never a URL

    // canned marker not surfaced as body
    expect(kinds(spec)).not.toContain('body');
  });

  it('appointment_status → title(calendar) + toned Status keyValue + keyValues + body', () => {
    const spec = buildResultCardSpec({
      capability: 'appointment_status',
      serviceName: "Dr Carl's Clinic",
      result: {
        status: 'confirmed',
        date: 'Tuesday, June 3',
        time: '2:30 PM',
        note: 'Please arrive 10 minutes early and bring your insurance card.',
      },
    });
    expect((find(spec, 'title') as any).text).toBe("Dr Carl's Clinic");
    expect((find(spec, 'title') as any).icon).toBe('calendar');
    expect(kinds(spec)).not.toContain('badge');
    const status = spec!.blocks.find((b: any) => b.kind === 'keyValue' && b.label === 'Status') as any;
    expect(status.value).toBe('Confirmed');
    expect(status.tone).toBe('positive');
    const kvLabels = spec!.blocks.filter((b: any) => b.kind === 'keyValue').map((b: any) => b.label);
    expect(kvLabels).toEqual(expect.arrayContaining(['Date', 'Time']));
    expect((find(spec, 'body') as any).text).toContain('insurance card');
  });

  it('cancelled → critical-toned Status keyValue', () => {
    const spec = buildResultCardSpec({
      capability: 'appointment_status',
      serviceName: 'Clinic',
      result: { status: 'cancelled', note: 'Provider unavailable.' },
    });
    const status = spec!.blocks.find((b: any) => b.kind === 'keyValue' && b.label === 'Status') as any;
    expect(status.tone).toBe('critical');
  });

  it('NEW price_check capability renders with ZERO bespoke code (title/stat/link/keyValues)', () => {
    const spec = buildResultCardSpec({
      capability: 'price_check',
      serviceName: 'Corner Market',
      result: {
        status: 'in_stock',
        product_name: 'Organic Bananas (1 lb)',
        price: 0.79,
        currency: 'USD',
        product_url: 'https://store.example.com/p/bananas',
        as_of: '2026-05-30T08:31:00.000Z',
      },
    });
    expect((find(spec, 'title') as any).text).toBe('Organic Bananas (1 lb)');
    expect((find(spec, 'title') as any).icon).toBe('price');
    const status = spec!.blocks.find((b: any) => b.kind === 'keyValue' && b.label === 'Status') as any;
    expect(status.tone).toBe('positive');
    expect((find(spec, 'stat') as any).value).toBe('0.79');
    const link = find(spec, 'link') as any;
    expect(link.label).toBe('View item');
    expect(link.url).toBe('https://store.example.com/p/bananas');
    expect(link.action).toBe('open_url');
    // staleness lifted to the card level
    expect(spec!.generatedAt).toBe('2026-05-30T08:31:00.000Z');
  });

  it('restaurant place_lookup → rating + dimension bars + map (the beautiful card)', () => {
    const spec = buildResultCardSpec({
      capability: 'place_lookup',
      serviceName: 'PeerLens Places',
      result: {
        name: 'Tartine Bakery',
        status: 'open',
        rating: 4.3,
        rating_count: 1280,
        price_level: '$$',
        cuisine: 'Bakery · Cafe',
        dimensions: { food: 0.92, service: 0.7, ambiance: 0.82 },
        summary: 'Famous for morning buns and country bread.',
        lat: 37.7615,
        lng: -122.4241,
      },
    });
    expect((find(spec, 'rating') as any).value).toBe(4.3);
    expect((find(spec, 'rating') as any).count).toBe(1280);
    const bars = spec!.blocks.filter((b: any) => b.kind === 'bar') as any[];
    expect(bars.map((b) => b.label)).toEqual(['Food', 'Service', 'Ambiance']);
    expect(bars[0].ratio).toBeCloseTo(0.92);
    expect(bars[0].tone).toBe('positive');
    expect(bars[1].tone).toBe('caution'); // 0.7
    expect(find(spec, 'map')).toBeTruthy();
    expect((find(spec, 'body') as any).text).toContain('morning buns');
    expect(kinds(spec)).not.toContain('badge');
  });

  it('weather_now → stat(°) + keyValues, unknown domain icon', () => {
    const spec = buildResultCardSpec({
      capability: 'weather_now',
      serviceName: 'Weather Co',
      result: { name: 'San Francisco', temperature: 68, conditions: 'Sunny', humidity: '44%' },
    });
    expect((find(spec, 'title') as any).icon).toBe('weather');
    const stat = find(spec, 'stat') as any;
    expect(stat.value).toBe('68');
    expect(stat.unit).toBe('°');
  });

  it('drops a non-https url (no link, no crash)', () => {
    const spec = buildResultCardSpec({
      capability: 'x',
      serviceName: 'S',
      result: { name: 'Thing', link: 'javascript:alert(1)' },
    });
    expect(spec).not.toBeNull();
    expect(kinds(spec)).not.toContain('link');
  });

  it('returns null on empty / non-object / array', () => {
    expect(buildResultCardSpec({ capability: 'x', result: null })).toBeNull();
    expect(buildResultCardSpec({ capability: 'x', result: {} })).toBeNull();
    expect(buildResultCardSpec({ capability: 'x', result: [] })).toBeNull();
    expect(buildResultCardSpec({ capability: 'x', result: 'plain' })).toBeNull();
  });

  it('an attempt to inject a trust word is harmless (it is just keyValue text, no badge)', () => {
    const spec = buildResultCardSpec({
      capability: 'price_check',
      serviceName: 'Sketchy Seller',
      result: { name: 'Gadget', status: 'verified', price: 9.99 },
    });
    // "verified" lands as a Status keyValue value (provider data), NOT a badge.
    expect(kinds(spec)).not.toContain('badge');
    const status = spec!.blocks.find((b: any) => b.kind === 'keyValue' && b.label === 'Status') as any;
    expect(status.value).toBe('Verified');
  });
});
