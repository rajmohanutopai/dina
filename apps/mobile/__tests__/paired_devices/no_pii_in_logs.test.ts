/**
 * MT-33-I1 regression guard. The paired-devices screen used to call
 * `console.log('[paired-devices] code generated', { code })`, which
 * persisted the short-lived shared secret to the iOS native log where
 * `xcrun simctl log show` (or sysdiagnose on a real device) would
 * surface it for hours. The fix dropped the log; this test pins the
 * fix so a future refactor can't reintroduce it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_PATH = path.resolve(__dirname, '../../app/paired-devices.tsx');

describe('paired-devices PII hygiene', () => {
  const source = fs.readFileSync(SCREEN_PATH, 'utf8');

  it('does not console.log the generated pairing code', () => {
    // The forbidden pattern: any console.* call whose argument
    // expression contains a bare `code` reference. We deliberately
    // make the matcher conservative — anything that looks like
    // `{ code }` or `${code}` inside a console call counts.
    const lines = source.split('\n');
    const offenders = lines
      .map((line, i) => ({ line, lineNo: i + 1 }))
      .filter(
        ({ line }) =>
          /console\.(log|info|warn|error|debug)/.test(line) &&
          /[\s({,]code(?:\s*[,})]|\s*})/.test(line),
      );
    expect(offenders).toEqual([]);
  });

  it('does not console.log the live pairing entry (which contains the code)', () => {
    // Same shape, broader: liveCode object includes `code` so logging
    // it leaks the same secret. Defensive — if a future change adds
    // diagnostic logging around setLiveCode, this catches it.
    const matches = source.match(/console\.\w+\([^)]*liveCode[^)]*\)/g) ?? [];
    expect(matches).toEqual([]);
  });
});
