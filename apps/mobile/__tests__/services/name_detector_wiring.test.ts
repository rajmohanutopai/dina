/**
 * Stranger-name detection on the phone (docs/PII_ARCHITECTURE_V2.md §7).
 */

import { getStrangerNames, installStrangerNames } from '@dina/brain';

import { nativeNameDetector, wireNameDetector } from '../../src/services/name_detector_wiring';

import type { DinaNamesNative } from '../../modules/dina-names';

function fakeNative(mode: 'model' | 'tagger'): DinaNamesNative & { warmed: boolean } {
  return {
    warmed: false,
    mode: () => mode,
    async prewarm() {
      this.warmed = true;
    },
    async findNames(text: string) {
      return text.includes('Priya') ? [{ value: 'Priya', score: 0.9, source: mode }] : [];
    },
  };
}

afterEach(() => installStrangerNames(null));

describe('wireNameDetector', () => {
  it('installs detection over the native module, loads the model, and says which finder runs', async () => {
    const native = fakeNative('model');
    expect(wireNameDetector(native)).toBe('model');
    expect(native.warmed).toBe(true);
    const strangers = getStrangerNames();
    if (strangers === null) throw new Error('not installed');
    const matcher = await strangers.matcherFor(['Call Priya.']);
    expect(matcher.find('Priya')).toHaveLength(1);
  });

  it('runs the tagger where the model is off', () => {
    expect(wireNameDetector(fakeNative('tagger'))).toBe('tagger');
  });

  it('with no native module (Android), installs nothing', () => {
    expect(wireNameDetector(null)).toBeNull();
    expect(getStrangerNames()).toBeNull();
  });

  it('the detector passes the native answer through as value and score', async () => {
    const d = nativeNameDetector(fakeNative('model'));
    if (d === null) throw new Error('no detector');
    expect(await d.detect('hi Priya', 1000)).toEqual([{ value: 'Priya', score: 0.9 }]);
  });
});
