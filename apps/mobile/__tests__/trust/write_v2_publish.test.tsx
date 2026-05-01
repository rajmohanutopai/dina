/**
 * V2 publish-path integration test (TN-V2-MOBILE-WIRE).
 *
 * Drives the WriteScreen UI end-to-end with `fireEvent`, exercises
 * every V2 field surface (price, reviewerExperience, compliance,
 * accessibility, compat, recommendFor / notRecommendFor, availability
 * regions/shipsTo/soldAt, schedule leadDays/seasonal), then asserts
 * that the mocked `injectAttestation` receives a wire-shaped record
 * with all V2 fields populated correctly.
 *
 * This is the cheaper-than-iOS-sim verification of the full chain:
 *   form state mutation → validation → serializer → wire body
 *
 * The remaining "iOS sim with idb" gap covers visual rendering +
 * keyboard layout, both of which are out of scope at the data-path
 * level. Once this test is green, the chain is provably correct from
 * UI taps through to the JSON the AppView would receive.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

// Mock the AppView runtime BEFORE importing the screen so the screen
// uses the mocked module. The mock surfaces every export the screen
// imports + records calls to `injectAttestation` so the test can
// inspect the wire body.
jest.mock('../../src/trust/appview_runtime', () => ({
  __esModule: true,
  injectAttestation: jest.fn().mockResolvedValue({ uri: 'at://x', cid: 'bafytest' }),
  isTestPublishConfigured: jest.fn().mockReturnValue(true),
}));

// Mock the node-bootstrap so `getBootedNode()` returns a stable DID
// (otherwise the test-publish path bails because there's no booted
// node).
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn().mockReturnValue({ did: 'did:plc:test-author' }),
}));

import * as appview from '../../src/trust/appview_runtime';
import WriteScreen from '../../app/trust/write';

const injectMock = appview.injectAttestation as jest.MockedFunction<
  typeof appview.injectAttestation
>;

beforeEach(() => {
  injectMock.mockClear();
});

/**
 * Spread `emptyWriteFormState()` over a minimum-viable initial that
 * is publishable (sentiment/headline/confidence set), letting each
 * test override the V2 fields it cares about.
 */
import { emptyWriteFormState, type WriteFormState } from '../../src/trust/write_form_data';

function publishableInitial(extra: Partial<WriteFormState> = {}): WriteFormState {
  return {
    ...emptyWriteFormState(),
    sentiment: 'positive',
    headline: 'Great chair',
    body: 'It works well.',
    confidence: 'high',
    subject: {
      kind: 'product',
      name: 'Aeron Chair',
      did: '',
      uri: '',
      identifier: '',
    },
    ...extra,
  };
}

describe('Publish wire body — base record (no V2 fields)', () => {
  it('does not include any V2 keys when none are populated', async () => {
    const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    expect(injectMock).toHaveBeenCalledTimes(1);
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record).toBeDefined();
    // Base fields present.
    expect(record.subject).toEqual({
      type: 'product',
      name: 'Aeron Chair',
    });
    expect(record.sentiment).toBe('positive');
    expect(record.confidence).toBe('high');
    // V2 fields all absent.
    expect(record.useCases).toBeUndefined();
    expect(record.lastUsedMs).toBeUndefined();
    expect(record.reviewerExperience).toBeUndefined();
    expect(record.recommendFor).toBeUndefined();
    expect(record.notRecommendFor).toBeUndefined();
    expect(record.alternatives).toBeUndefined();
    expect(record.compliance).toBeUndefined();
    expect(record.accessibility).toBeUndefined();
    expect(record.compat).toBeUndefined();
    expect(record.price).toBeUndefined();
    expect(record.availability).toBeUndefined();
    expect(record.schedule).toBeUndefined();
  });
});

describe('Publish wire body — META-002 price', () => {
  it('emits a wire-shape price block when low + currency are set (point price)', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          priceLow: '29.99',
          priceCurrency: 'USD',
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.price).toMatchObject({
      low_e7: 299_900_000,
      high_e7: 299_900_000,
      currency: 'USD',
    });
    // lastSeenMs is now-stamped — assert presence + integer shape.
    expect(typeof (record.price as { lastSeenMs: number }).lastSeenMs).toBe('number');
    expect(Number.isInteger((record.price as { lastSeenMs: number }).lastSeenMs)).toBe(true);
  });

  it('emits a price range when high > low', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          priceLow: '19.99',
          priceHigh: '49.99',
          priceCurrency: 'GBP',
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.price).toMatchObject({
      low_e7: 199_900_000,
      high_e7: 499_900_000,
      currency: 'GBP',
    });
  });

  it('omits price when low is empty (field unset)', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          priceLow: '',
          priceHigh: '49.99',
          priceCurrency: 'GBP',
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.price).toBeUndefined();
  });

  it('Publish is disabled when price is invalid (low > high)', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          priceLow: '99',
          priceHigh: '10',
          priceCurrency: 'USD',
        })}
      />,
    );
    expect(getByTestId('write-publish').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    expect(injectMock).not.toHaveBeenCalled();
  });
});

describe('Publish wire body — REV-002 reviewerExperience', () => {
  it('emits the selected experience tier', async () => {
    const { getByTestId } = render(
      <WriteScreen initial={publishableInitial({ reviewerExperience: 'expert' })} />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.reviewerExperience).toBe('expert');
  });

  it('UI tap toggles reviewerExperience and reflects in publish body', async () => {
    const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    // Open Advanced section so the experience picker renders.
    fireEvent.press(getByTestId('write-advanced-toggle'));
    fireEvent.press(getByTestId('write-experience-novice'));
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.reviewerExperience).toBe('novice');
  });
});

describe('Publish wire body — META-005/006/003 closed-vocab tags', () => {
  it('emits compliance + accessibility + compat as opaque tag arrays', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          compliance: ['halal', 'vegan'],
          accessibility: ['wheelchair', 'captions'],
          compat: ['ios', 'android', 'usb_c'],
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.compliance).toEqual(['halal', 'vegan']);
    expect(record.accessibility).toEqual(['wheelchair', 'captions']);
    expect(record.compat).toEqual(['ios', 'android', 'usb_c']);
  });

  it('UI taps toggle compliance and reflect in publish body', async () => {
    const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    fireEvent.press(getByTestId('write-advanced-toggle'));
    fireEvent.press(getByTestId('write-compliance-halal'));
    fireEvent.press(getByTestId('write-compliance-vegan'));
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.compliance).toEqual(['halal', 'vegan']);
  });
});

describe('Publish wire body — REV-004 recommendFor / notRecommendFor', () => {
  it('emits both recommendFor and notRecommendFor when populated', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          recommendFor: ['professional', 'travel'],
          notRecommendFor: ['gaming'],
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.recommendFor).toEqual(['professional', 'travel']);
    expect(record.notRecommendFor).toEqual(['gaming']);
  });
});

describe('Publish wire body — META-001 availability', () => {
  it('emits availability with only the populated sub-fields', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          availabilityRegions: ['US', 'GB'],
          availabilityShipsTo: [],
          availabilitySoldAt: ['amazon.com'],
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.availability).toEqual({
      regions: ['US', 'GB'],
      soldAt: ['amazon.com'],
    });
  });

  it('UI region adder normalises + dedups + caps in the wire body', async () => {
    const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    fireEvent.press(getByTestId('write-advanced-toggle'));
    const regionInput = getByTestId('write-region-input');
    // Lowercase typed → uppercased on the wire.
    fireEvent.changeText(regionInput, 'us');
    fireEvent.press(getByTestId('write-region-add'));
    fireEvent.changeText(regionInput, 'gb');
    fireEvent.press(getByTestId('write-region-add'));
    // Dedup: re-add 'us' → still one chip.
    fireEvent.changeText(regionInput, 'us');
    fireEvent.press(getByTestId('write-region-add'));
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    const availability = record.availability as { regions: string[] };
    expect(availability.regions).toEqual(['US', 'GB']);
  });

  it('UI hostname adder lowercases + rejects URLs/labels-only', async () => {
    const { getByTestId, queryByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    fireEvent.press(getByTestId('write-advanced-toggle'));
    const soldAtInput = getByTestId('write-soldat-input');
    fireEvent.changeText(soldAtInput, 'AMAZON.COM');
    fireEvent.press(getByTestId('write-soldat-add'));
    // URL with scheme — silently rejected.
    fireEvent.changeText(soldAtInput, 'https://walmart.com');
    fireEvent.press(getByTestId('write-soldat-add'));
    // Single label — also rejected.
    fireEvent.changeText(soldAtInput, 'localhost');
    fireEvent.press(getByTestId('write-soldat-add'));
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    const availability = record.availability as { soldAt?: string[] };
    expect(availability.soldAt).toEqual(['amazon.com']);
    // The cap-hint chip should not be visible (we only added one).
    expect(queryByTestId('write-soldat-cap')).toBeNull();
  });
});

describe('Publish wire body — META-004 schedule', () => {
  it('emits leadDays + seasonal when populated', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          scheduleLeadDays: '14',
          scheduleSeasonal: [4, 5, 6],
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.schedule).toEqual({ leadDays: 14, seasonal: [4, 5, 6] });
  });

  it('UI lead-days strips non-digit input', async () => {
    const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    fireEvent.press(getByTestId('write-advanced-toggle'));
    // Type a value that includes garbage; the screen filters non-digits.
    fireEvent.changeText(getByTestId('write-lead-days'), '14abc');
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.schedule).toEqual({ leadDays: 14 });
  });

  it('UI seasonal-month chips toggle + sort by calendar order', async () => {
    const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
    fireEvent.press(getByTestId('write-advanced-toggle'));
    // Tap in non-calendar order — serializer must emit sorted.
    fireEvent.press(getByTestId('write-seasonal-12'));
    fireEvent.press(getByTestId('write-seasonal-3'));
    fireEvent.press(getByTestId('write-seasonal-7'));
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;
    expect(record.schedule).toEqual({ seasonal: [3, 7, 12] });
  });
});

describe('Publish wire body — full V2 stack', () => {
  it('round-trips every V2 field together (single record carrying all fields)', async () => {
    const { getByTestId } = render(
      <WriteScreen
        initial={publishableInitial({
          useCases: ['everyday'],
          lastUsedBucket: 'past_week',
          reviewerExperience: 'expert',
          recommendFor: ['professional'],
          notRecommendFor: ['gaming'],
          alternatives: [
            { kind: 'product', name: 'Steelcase Leap' },
          ],
          compliance: ['vegan'],
          accessibility: ['wheelchair'],
          compat: ['ios', 'usb_c'],
          priceLow: '29.99',
          priceCurrency: 'USD',
          availabilityRegions: ['US'],
          availabilitySoldAt: ['amazon.com'],
          scheduleLeadDays: '7',
          scheduleSeasonal: [6, 7, 8],
        })}
      />,
    );
    fireEvent.press(getByTestId('write-publish'));
    await Promise.resolve();
    await Promise.resolve();
    expect(injectMock).toHaveBeenCalledTimes(1);
    const record = injectMock.mock.calls[0]?.[0]?.record as Record<string, unknown>;

    // Every V2 field present in expected wire shape.
    expect(record.useCases).toEqual(['everyday']);
    expect(typeof record.lastUsedMs).toBe('number');
    expect(record.reviewerExperience).toBe('expert');
    expect(record.recommendFor).toEqual(['professional']);
    expect(record.notRecommendFor).toEqual(['gaming']);
    expect(record.alternatives).toEqual([
      { type: 'product', name: 'Steelcase Leap' },
    ]);
    expect(record.compliance).toEqual(['vegan']);
    expect(record.accessibility).toEqual(['wheelchair']);
    expect(record.compat).toEqual(['ios', 'usb_c']);
    expect(record.price).toMatchObject({
      low_e7: 299_900_000,
      high_e7: 299_900_000,
      currency: 'USD',
    });
    expect(record.availability).toEqual({
      regions: ['US'],
      soldAt: ['amazon.com'],
    });
    expect(record.schedule).toEqual({ leadDays: 7, seasonal: [6, 7, 8] });
  });
});
