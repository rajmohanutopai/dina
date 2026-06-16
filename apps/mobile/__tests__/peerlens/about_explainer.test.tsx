/**
 * "About Ranked Reviews" explainer — content + screen render tests.
 *
 * The page behind the reviewer dashboard's "How Ranked Reviews work" row.
 * Pins:
 *   - House copy rule: NO em-dashes anywhere in the explainer copy.
 *   - The internal brand "PeerLens" never appears (user-facing = "Ranked
 *     Reviews").
 *   - It explains the load-bearing topics the page exists for: trust
 *     weighting (circle + circles-of-circles + reputation), the signals
 *     that BUILD trust (verified, bought-it, time, vouch), the signals it
 *     FILTERS OUT (bot / paid), no-ad-rank, signed-and-owned reviews, the
 *     forward-looking auto-review vision, and the V1 pseudonymity caveat.
 *   - The namespace caveat is IDENTITY-EQUAL to FIRST_RUN_MODAL_COPY.body
 *     so the disclosure stays single-sourced.
 *   - Deep-frozen (mutation crashes loudly).
 *   - The screen renders the intro + every section, paragraph, and bullet.
 */

import { render } from '@testing-library/react-native';
import React from 'react';

import AboutPeerLensScreen from '../../app/peerlens/about';
import { PEERLENS_EXPLAINER } from '../../src/peerlens/explainer_content';

/** Every string the explainer renders, concatenated. */
function allText(): string {
  const parts: string[] = [PEERLENS_EXPLAINER.screenTitle, PEERLENS_EXPLAINER.intro];
  for (const s of PEERLENS_EXPLAINER.sections) {
    parts.push(s.title);
    if (s.paragraphs) parts.push(...s.paragraphs);
    if (s.bullets) for (const b of s.bullets) parts.push(b.title, b.text);
  }
  return parts.join('\n');
}

const sectionTitles = (): string[] => PEERLENS_EXPLAINER.sections.map((s) => s.title);

describe('PEERLENS_EXPLAINER — copy rules', () => {
  it('contains no em-dash or en-dash anywhere (house copy rule)', () => {
    const text = allText();
    expect(text).not.toContain('—'); // em-dash
    expect(text).not.toContain('–'); // en-dash
  });

  it('never shows the internal brand name "PeerLens" to users', () => {
    expect(allText()).not.toMatch(/PeerLens/i);
  });

  it('uses the user-facing label "Ranked Reviews"', () => {
    expect(allText()).toMatch(/Ranked Reviews/);
  });

  it('screenTitle is "About Ranked Reviews"', () => {
    expect(PEERLENS_EXPLAINER.screenTitle).toBe('About Ranked Reviews');
  });

  it('opens by naming what it is for and the threats it counters', () => {
    expect(PEERLENS_EXPLAINER.intro).toMatch(/finds trustworthy products/i);
    expect(PEERLENS_EXPLAINER.intro).toMatch(/ads and sybil attacks/i);
  });
});

describe('PEERLENS_EXPLAINER — explains the load-bearing topics', () => {
  it('explains how a review counts (proximity + anonymous circles + reputation)', () => {
    expect(sectionTitles()).toContain('What makes a review count');
    const text = allText();
    expect(text).toMatch(/shaped by who is doing the rating/i);
    expect(text).toMatch(/circles too/i); // circles of circles
    expect(text).toMatch(/anonymous combined rating/i); // contacts-of-contacts privacy
    expect(text).toMatch(/much like PageRank/i); // reputation propagation
  });

  it('explains what BUILDS a reviewer trust (verified, bought-it, time, vouch)', () => {
    expect(sectionTitles()).toContain("What builds a reviewer's trust");
    const text = allText();
    expect(text).toMatch(/verified identity/i);
    expect(text).toMatch(/a lot to lose/i); // skin in the game
    expect(text).toMatch(/actually bought it/i);
    expect(text).toMatch(/vouch/i);
  });

  it('explains what gets FILTERED OUT (bots, paid/coordinated reviews)', () => {
    expect(sectionTitles()).toContain('What Dina filters out');
    const text = allText();
    expect(text).toMatch(/looks like a bot/i);
    expect(text).toMatch(/paid or coordinated/i);
  });

  it('explains reviews are signed and owned by the user', () => {
    expect(sectionTitles()).toContain('How a review is created');
    const text = allText();
    expect(text).toMatch(/signs it with your key/i);
    expect(text).toMatch(/you stay the owner/i);
  });

  it('frames the forward-looking auto-review vision (with permission + follow-ups)', () => {
    expect(sectionTitles()).toContain('Future');
    const text = allText();
    expect(text).toMatch(/with permission/i);
    expect(text).toMatch(/draft the review/i);
    expect(text).toMatch(/how is it holding up/i); // the chair follow-up
  });

  it('explains publishing under separate pseudonyms', () => {
    expect(sectionTitles()).toContain('Publishing under different pseudonyms');
    expect(allText()).toMatch(/separate pseudonyms/i);
  });
});

describe('PEERLENS_EXPLAINER — bullet tones are valid', () => {
  it('every bullet tone is positive | negative | neutral (or unset)', () => {
    for (const section of PEERLENS_EXPLAINER.sections) {
      for (const bullet of section.bullets ?? []) {
        expect(['positive', 'negative', 'neutral', undefined]).toContain(bullet.tone);
        expect(bullet.icon.length).toBeGreaterThan(0);
        expect(bullet.title.length).toBeGreaterThan(0);
        expect(bullet.text.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('PEERLENS_EXPLAINER — frozen invariants', () => {
  it('is deep-frozen (top, sections, paragraphs, bullets)', () => {
    expect(Object.isFrozen(PEERLENS_EXPLAINER)).toBe(true);
    expect(Object.isFrozen(PEERLENS_EXPLAINER.sections)).toBe(true);
    for (const section of PEERLENS_EXPLAINER.sections) {
      expect(Object.isFrozen(section)).toBe(true);
      if (section.paragraphs) expect(Object.isFrozen(section.paragraphs)).toBe(true);
      if (section.bullets) {
        expect(Object.isFrozen(section.bullets)).toBe(true);
        for (const bullet of section.bullets) expect(Object.isFrozen(bullet)).toBe(true);
      }
    }
  });
});

describe('AboutPeerLensScreen — render', () => {
  it('renders the intro and every section, paragraph, and bullet', () => {
    const { getByTestId, getByText } = render(<AboutPeerLensScreen />);

    expect(getByTestId('peerlens-about-screen')).toBeTruthy();
    expect(getByTestId('peerlens-about-intro')).toBeTruthy();

    PEERLENS_EXPLAINER.sections.forEach((section, i) => {
      expect(getByTestId(`peerlens-about-section-${i}`)).toBeTruthy();
      expect(getByText(section.title)).toBeTruthy();
      for (const paragraph of section.paragraphs ?? []) {
        expect(getByText(paragraph)).toBeTruthy();
      }
      for (const bullet of section.bullets ?? []) {
        expect(getByText(bullet.title)).toBeTruthy();
        expect(getByText(bullet.text)).toBeTruthy();
      }
    });
  });
});
