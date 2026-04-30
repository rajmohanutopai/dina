/**
 * Settings → "About Trust Network" content tests (TN-MOB-028).
 *
 * Pins:
 *   - Body paragraphs are IDENTITY-EQUAL to FIRST_RUN_MODAL_COPY.body
 *     — single source of truth for the disclosure language. A future
 *     mutation that forks the two surfaces would fail this test.
 *   - Plan §13.10 caveat (V1 namespaces are pseudonymous to first-
 *     impression observers, NOT to dedicated investigators) survives
 *     in the body — regression guard against a copy edit that
 *     softens the disclosure.
 *   - Frozen at every level (mutation crashes loudly).
 *   - Settings-screen-specific framing differs from the modal's
 *     own framing (different screenTitle and headerLabel).
 *   - Version label anchors the disclosure to a release.
 *
 * Pure data — runs under plain Jest, no RN deps.
 */

import { ABOUT_SCREEN_CONTENT } from '../../src/trust/about_disclosure';
import { FIRST_RUN_MODAL_COPY } from '../../src/trust/first_run';

describe('ABOUT_SCREEN_CONTENT — body shares source of truth with first-run modal', () => {
  it('body is identity-equal to FIRST_RUN_MODAL_COPY.body (single source of truth)', () => {
    // Same array reference — a copy edit on the modal side
    // automatically propagates to the settings screen.
    expect(ABOUT_SCREEN_CONTENT.body).toBe(FIRST_RUN_MODAL_COPY.body);
  });

  it('preserves all body paragraphs unchanged', () => {
    expect(ABOUT_SCREEN_CONTENT.body).toHaveLength(FIRST_RUN_MODAL_COPY.body.length);
    expect([...ABOUT_SCREEN_CONTENT.body]).toEqual([...FIRST_RUN_MODAL_COPY.body]);
  });
});

describe('ABOUT_SCREEN_CONTENT — disclosure caveat', () => {
  it('discloses the V1 pseudonymity caveat (plan §13.10) — regression guard', () => {
    // The caveat is the load-bearing copy: namespaces are pseudonymous
    // at first glance but NOT to a sophisticated observer correlating
    // signatures over time. A copy edit that drops this guard must
    // fail this test.
    const fullText = ABOUT_SCREEN_CONTENT.body.join(' ');
    // The exact phrasing lives in FIRST_RUN_MODAL_COPY but we assert
    // the load-bearing semantics here.
    expect(fullText).toMatch(/aren't anonymous/i);
    expect(fullText).toMatch(/correlating/i);
  });
});

describe('ABOUT_SCREEN_CONTENT — settings-screen framing', () => {
  it('screenTitle is "About Trust Network" (the navigation header)', () => {
    expect(ABOUT_SCREEN_CONTENT.screenTitle).toBe('About Trust Network');
  });

  it('headerLabel differs from the modal framing (settings screen has its own context)', () => {
    expect(ABOUT_SCREEN_CONTENT.headerLabel).toBe('How Trust Network works');
    // Sanity check: the headerLabel is NOT the same as the modal title.
    expect(ABOUT_SCREEN_CONTENT.headerLabel).not.toBe(FIRST_RUN_MODAL_COPY.title);
  });

  it('versionLabel anchors the disclosure to a release', () => {
    expect(ABOUT_SCREEN_CONTENT.versionLabel).toBe('Trust Network V1');
  });
});

describe('ABOUT_SCREEN_CONTENT — frozen invariants', () => {
  it('content bundle is frozen', () => {
    expect(Object.isFrozen(ABOUT_SCREEN_CONTENT)).toBe(true);
  });

  it('body array is frozen (inherits from FIRST_RUN_MODAL_COPY)', () => {
    expect(Object.isFrozen(ABOUT_SCREEN_CONTENT.body)).toBe(true);
  });

  it('mutation attempts fail (strict mode would throw, sloppy mode silently no-ops)', () => {
    const before = ABOUT_SCREEN_CONTENT.screenTitle;
    try {
      // @ts-expect-error — confirming readonly enforcement at runtime
      ABOUT_SCREEN_CONTENT.screenTitle = 'Hijacked';
    } catch {
      // Strict-mode TypeError — that's also acceptable.
    }
    expect(ABOUT_SCREEN_CONTENT.screenTitle).toBe(before);
  });
});
