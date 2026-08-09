/**
 * Plural relationship resolution (§10.7, FR-A8 — WS-10.3).
 *
 * §10.7 forbids one implementation by name — "silently choosing whichever
 * merge produces the highest score" — so the first suite is the negative:
 * given views that disagree, the resolver must not return the best answer.
 * Everything else follows from that.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  AUTHORIZE_SUBSTITUTION_BP,
  INHERIT_STANDING_BP,
  SHOW_AS_RELATED_BP,
  describeDisagreement,
  mayAuthorizeSubstitution,
  mayInheritStanding,
  mayShowAsRelated,
  resolveRelationships,
  type AppViewAnswer,
} from '../../src/commerce/relationship_resolver';

const SUBJECT = 'gtin:05012345678900';
const PARENT = 'gtin:05012345678917';
const OTHER_PARENT = 'gtin:05099999999999';

function view(did: string, edges: Partial<AppViewAnswer['edges'][number]>[]): AppViewAnswer {
  return {
    appViewDid: did,
    edges: edges.map((e) => ({
      subjectKey: SUBJECT,
      relationship: 'variant_of',
      objectKey: PARENT,
      confidenceBp: 9500,
      disputed: false,
      ...e,
    })),
  };
}

describe('the forbidden rule: never the highest score (§10.7)', () => {
  it('takes the consensus FLOOR when views disagree about strength', () => {
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: 9800 }]),
      view('did:web:b', [{ confidenceBp: 4000 }]),
    ]);
    expect(resolved.edges).toHaveLength(1);
    // 9800 would be "whichever produces the highest score".
    expect(resolved.edges[0]?.confidenceBp).toBe(4000);
  });

  it('refuses to authorize a substitution one view alone would permit', () => {
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: AUTHORIZE_SUBSTITUTION_BP + 400 }]),
      view('did:web:b', [{ confidenceBp: AUTHORIZE_SUBSTITUTION_BP - 1 }]),
    ]);
    const edge = resolved.edges[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    expect(mayAuthorizeSubstitution(edge)).toBe(false);
    // And the disagreement is visible rather than resolved away.
    expect(resolved.disagreements.map((d) => d.kind)).toContain('threshold_split');
  });

  it('permits what every view agrees is permitted', () => {
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: 9600 }]),
      view('did:web:b', [{ confidenceBp: 9500 }]),
    ]);
    const edge = resolved.edges[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    expect(edge.confidenceBp).toBe(9500);
    expect(edge.contested).toBe(false);
    expect(mayAuthorizeSubstitution(edge)).toBe(true);
    expect(resolved.disagreements).toEqual([]);
  });
});

describe('material disagreement, and what is not material', () => {
  it('says nothing about two views inside one band', () => {
    // 3100 and 3300 agree about everything a caller can DO with the edge.
    // Reporting it would train an owner to ignore the display.
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: 3100 }]),
      view('did:web:b', [{ confidenceBp: 3300 }]),
    ]);
    expect(resolved.disagreements).toEqual([]);
    expect(resolved.edges[0]?.contested).toBe(false);
  });

  it('reports a split at every threshold boundary', () => {
    const pairs: [number, number][] = [
      [SHOW_AS_RELATED_BP - 1, SHOW_AS_RELATED_BP],
      [INHERIT_STANDING_BP - 1, INHERIT_STANDING_BP],
      [AUTHORIZE_SUBSTITUTION_BP - 1, AUTHORIZE_SUBSTITUTION_BP],
    ];
    for (const [low, high] of pairs) {
      const resolved = resolveRelationships([
        view('did:web:a', [{ confidenceBp: low }]),
        view('did:web:b', [{ confidenceBp: high }]),
      ]);
      expect(resolved.disagreements.map((d) => d.kind)).toContain('threshold_split');
      expect(resolved.edges[0]?.confidenceBp).toBe(low);
    }
  });

  it('reports conflicting parents as the sharpest disagreement', () => {
    // `variant_of` names ONE parent. Picking a winner erases the other's
    // lineage, which §10.7 says a score may never do.
    const resolved = resolveRelationships([
      view('did:web:a', [{ objectKey: PARENT }]),
      view('did:web:b', [{ objectKey: OTHER_PARENT }]),
    ]);
    const conflict = resolved.disagreements.find((d) => d.kind === 'conflicting_object');
    expect(conflict).toBeDefined();
    // BOTH edges survive. Neither is deleted.
    expect(resolved.edges.map((e) => e.objectKey).sort()).toEqual([PARENT, OTHER_PARENT].sort());
    // And neither authorises anything, whatever its number.
    for (const edge of resolved.edges) {
      expect(edge.contested).toBe(true);
      expect(mayAuthorizeSubstitution(edge)).toBe(false);
      expect(mayInheritStanding(edge)).toBe(false);
    }
  });

  it('does not call two objects a conflict for a many-to-many relationship', () => {
    // A product can replace several others. Two `replaces` edges are not in
    // conflict, and calling them one would bury a real conflict in noise.
    //
    // TWO DIFFERENT VIEWS, deliberately: the conflict check records one object
    // per view, so passing the same DID twice would leave a single position
    // and the test would pass whatever the rule said.
    const resolved = resolveRelationships([
      view('did:web:a', [{ relationship: 'replaces', objectKey: PARENT }]),
      view('did:web:b', [{ relationship: 'replaces', objectKey: OTHER_PARENT }]),
    ]);
    expect(resolved.disagreements.filter((d) => d.kind === 'conflicting_object')).toEqual([]);
  });

  it('contests an edge for a conflicting object ALONE', () => {
    // Both views record BOTH candidate parents, so every edge is unanimous —
    // not partial, not split, not upstream-disputed. The single-object
    // conflict is then the only thing that can contest them, which is what
    // makes this the test for that rule rather than for the cap.
    const both = [{ objectKey: PARENT }, { objectKey: OTHER_PARENT }];
    const resolved = resolveRelationships([view('did:web:a', both), view('did:web:b', both)]);
    expect(resolved.edges).toHaveLength(2);
    for (const edge of resolved.edges) {
      expect(edge.supportingViews).toBe(2);
      expect(edge.confidenceBp).toBe(9500);
      expect(edge.contested).toBe(true);
      expect(mayAuthorizeSubstitution(edge)).toBe(false);
    }
    expect(resolved.disagreements.map((d) => d.kind)).toEqual(['conflicting_object']);
  });

  it('carries an upstream dispute through rather than flattening it', () => {
    // BOTH ORDERS. With the disputed view first, the seeded value already
    // carries the flag and a broken fold still passes; with it second, only
    // the fold can carry it.
    for (const answers of [
      [view('did:web:a', [{ disputed: true }]), view('did:web:b', [{}])],
      [view('did:web:a', [{}]), view('did:web:b', [{ disputed: true }])],
    ]) {
      const resolved = resolveRelationships(answers);
      expect(resolved.disagreements.map((d) => d.kind)).toContain('upstream_dispute');
      expect(resolved.edges[0]?.contested).toBe(true);
    }
  });
});

describe('an edge only some views report', () => {
  it('is kept, and capped below the standing threshold', () => {
    // §10.7 lets weaker semantic edges improve recall, so it is shown; it may
    // not inherit standing on the word of a subset.
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: 9800 }]),
      { appViewDid: 'did:web:b', edges: [] },
    ]);
    const edge = resolved.edges[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    expect(edge.confidenceBp).toBe(INHERIT_STANDING_BP - 1);
    expect(edge.supportingViews).toBe(1);
    expect(edge.consultedViews).toBe(2);
    expect(mayShowAsRelated(edge)).toBe(true);
    expect(mayInheritStanding(edge)).toBe(false);
    expect(mayAuthorizeSubstitution(edge)).toBe(false);
  });

  it('counts views CONSULTED, not views that answered', () => {
    // "two of three report this" and "two of two" are different facts.
    const resolved = resolveRelationships([
      view('did:web:a', [{}]),
      view('did:web:b', [{}]),
      { appViewDid: 'did:web:c', edges: [] },
    ]);
    expect(resolved.edges[0]).toMatchObject({ supportingViews: 2, consultedViews: 3 });
    expect(resolved.disagreements.map((d) => d.kind)).toContain('partial_support');
  });

  it('shows silence as null, never as a zero confidence', () => {
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: 9500 }]),
      { appViewDid: 'did:web:silent', edges: [] },
    ]);
    const partial = resolved.disagreements.find((d) => d.kind === 'partial_support');
    expect(partial?.positions).toEqual([
      { appViewDid: 'did:web:a', objectKey: PARENT, confidenceBp: 9500 },
      // Zero is a confidence; silence is the absence of one, and an owner
      // reading "0" would think the view had looked and disagreed.
      { appViewDid: 'did:web:silent', objectKey: null, confidenceBp: null },
    ]);
  });
});

describe('contested overrides the number, not the other way round', () => {
  it('refuses standing and substitution on a unanimous, high-confidence, disputed edge', () => {
    // Every view reports it, at 9500, so nothing CAPS it — the only thing
    // between this edge and authorising a substitution is `contested`. An
    // earlier version of these tests only ever contested edges that were also
    // capped, so removing the contested check changed nothing they measured.
    const resolved = resolveRelationships([
      view('did:web:a', [{ confidenceBp: 9500 }]),
      view('did:web:b', [{ confidenceBp: 9500, disputed: true }]),
    ]);
    const edge = resolved.edges[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    expect(edge.confidenceBp).toBe(9500);
    expect(edge.supportingViews).toBe(2);
    expect(edge.consultedViews).toBe(2);
    expect(edge.contested).toBe(true);
    expect(mayAuthorizeSubstitution(edge)).toBe(false);
    expect(mayInheritStanding(edge)).toBe(false);
    // And it is still shown, with its dispute.
    expect(mayShowAsRelated(edge)).toBe(true);
  });
});

describe('a contested edge may still be shown', () => {
  it('shows a disputed relationship WITH its dispute', () => {
    // Hiding it would be the silent choice §10.7 forbids, made in the other
    // direction.
    const resolved = resolveRelationships([
      view('did:web:a', [{ objectKey: PARENT }]),
      view('did:web:b', [{ objectKey: OTHER_PARENT }]),
    ]);
    for (const edge of resolved.edges) expect(mayShowAsRelated(edge)).toBe(true);
  });
});

describe('edge cases', () => {
  it('answers empty for no consulted views', () => {
    expect(resolveRelationships([])).toEqual({ edges: [], disagreements: [] });
  });

  it('answers empty when every view reported nothing', () => {
    expect(
      resolveRelationships([
        { appViewDid: 'did:web:a', edges: [] },
        { appViewDid: 'did:web:b', edges: [] },
      ]),
    ).toEqual({ edges: [], disagreements: [] });
  });

  it('treats one view as unanimous rather than partial', () => {
    const resolved = resolveRelationships([view('did:web:a', [{ confidenceBp: 9500 }])]);
    expect(resolved.edges[0]).toMatchObject({
      confidenceBp: 9500,
      supportingViews: 1,
      consultedViews: 1,
      contested: false,
    });
    expect(resolved.disagreements).toEqual([]);
  });

  it('does not let a key containing a space collide two edges', () => {
    const resolved = resolveRelationships([
      {
        appViewDid: 'did:web:a',
        edges: [
          {
            subjectKey: 'custom:A B',
            relationship: 'replaces',
            objectKey: 'C',
            confidenceBp: 9500,
            disputed: false,
          },
          {
            subjectKey: 'custom:A',
            relationship: 'B replaces',
            objectKey: 'C',
            confidenceBp: 4000,
            disputed: false,
          },
        ],
      },
    ]);
    // Two distinct edges, not one merged row with the wrong confidence.
    expect(resolved.edges).toHaveLength(2);
  });

  it('is deterministic across two identical reads', () => {
    const answers = [
      view('did:web:b', [{ objectKey: OTHER_PARENT }, { relationship: 'replaces' }]),
      view('did:web:a', [{ objectKey: PARENT }]),
    ];
    expect(resolveRelationships(answers)).toEqual(resolveRelationships(answers));
  });
});

describe('the thresholds match the AppView projection', () => {
  it('is the same three numbers, checked rather than assumed', () => {
    // The copies exist because an AppView deploys standalone and Core must not
    // trust it to say where the substitution bar is. Two copies that drifted
    // would let an index lower the bar by reporting its own number.
    //
    // Read as TEXT rather than imported. The AppView is an ESM package with
    // `.js` import specifiers that Core's module resolver cannot follow, and
    // an `import()` that fails to resolve would make this guard fail for a
    // reason unrelated to the numbers — or, worse, be deleted for being
    // flaky. A static read has no resolver to go wrong.
    const source = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'appview',
        'src',
        'shared',
        'commerce',
        'relationship-projection.ts',
      ),
      'utf8',
    );
    const constant = (name: string): number => {
      const match = new RegExp(`export const ${name} = (\\d+)`).exec(source);
      if (match === null) throw new Error(`the AppView no longer exports ${name}`);
      return Number(match[1]);
    };
    expect(SHOW_AS_RELATED_BP).toBe(constant('SHOW_AS_RELATED_BP'));
    expect(INHERIT_STANDING_BP).toBe(constant('INHERIT_STANDING_BP'));
    expect(AUTHORIZE_SUBSTITUTION_BP).toBe(constant('AUTHORIZE_SUBSTITUTION_BP'));
  });

  it('orders them the way §10.7 states', () => {
    expect(SHOW_AS_RELATED_BP).toBeLessThan(INHERIT_STANDING_BP);
    expect(INHERIT_STANDING_BP).toBeLessThan(AUTHORIZE_SUBSTITUTION_BP);
  });
});

describe('the owner-facing sentence', () => {
  it('says what each kind of disagreement means, in their words', () => {
    const resolved = resolveRelationships([
      view('did:web:a', [{ objectKey: PARENT }]),
      view('did:web:b', [{ objectKey: OTHER_PARENT }]),
    ]);
    const headlines = resolved.disagreements.map(describeDisagreement);
    expect(headlines.some((h) => h.includes('disagree'))).toBe(true);
    for (const headline of headlines) {
      // No codes, no basis points: this is what an owner reads.
      expect(headline).not.toMatch(/_|\bbp\b|\d{4}/);
    }
  });

  it('counts the views for a partial-support headline', () => {
    const resolved = resolveRelationships([
      view('did:web:a', [{}]),
      { appViewDid: 'did:web:b', edges: [] },
      { appViewDid: 'did:web:c', edges: [] },
    ]);
    const partial = resolved.disagreements.find((d) => d.kind === 'partial_support');
    expect(partial).toBeDefined();
    if (partial !== undefined) {
      expect(describeDisagreement(partial)).toBe('1 of 3 directories report this relationship.');
    }
  });
});
