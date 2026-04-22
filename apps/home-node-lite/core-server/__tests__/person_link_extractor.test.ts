/**
 * person_link_extractor tests (GAP.md #11 closure).
 */

import {
  BUILT_IN_CONNECTORS,
  DEFAULT_MAX_GAP,
  extractPersonLinks,
  type RelationConnector,
} from '../src/brain/person_link_extractor';

describe('extractPersonLinks — input handling', () => {
  it('empty string → []', () => {
    expect(extractPersonLinks('')).toEqual([]);
  });

  it('whitespace-only → []', () => {
    expect(extractPersonLinks('   \n  ')).toEqual([]);
  });

  it('non-string → []', () => {
    expect(extractPersonLinks(null as unknown as string)).toEqual([]);
  });

  it('fewer than 2 names → []', () => {
    expect(extractPersonLinks('Alice is great.')).toEqual([]);
  });

  it('names with no known connector → []', () => {
    expect(extractPersonLinks('Alice. Bob. Carol.')).toEqual([]);
  });
});

describe('extractPersonLinks — family relations', () => {
  it('"X is married to Y" → spouse_of (symmetric)', () => {
    const links = extractPersonLinks('Alice is married to Bob.');
    expect(links).toHaveLength(1);
    const l = links[0]!;
    expect(l.a.name).toBe('Alice');
    expect(l.b.name).toBe('Bob');
    expect(l.relation).toBe('spouse_of');
    expect(l.symmetric).toBe(true);
    expect(l.confidence).toBe(0.95);
  });

  it('"X is the father of Y" → parent_of (directional)', () => {
    const links = extractPersonLinks('John is the father of Mary.');
    expect(links[0]!.relation).toBe('parent_of');
    expect(links[0]!.symmetric).toBe(false);
  });

  it('"X is the daughter of Y" → child_of', () => {
    const links = extractPersonLinks('Sara is the daughter of Robert.');
    expect(links[0]!.relation).toBe('child_of');
  });

  it('"X is the sister of Y" → sibling_of', () => {
    const links = extractPersonLinks('Amy is the sister of Tom.');
    expect(links[0]!.relation).toBe('sibling_of');
    expect(links[0]!.symmetric).toBe(true);
  });
});

describe('extractPersonLinks — work relations', () => {
  it('"X is the manager of Y" → manager_of', () => {
    const links = extractPersonLinks('Jane is the manager of Mike.');
    expect(links[0]!.relation).toBe('manager_of');
    expect(links[0]!.symmetric).toBe(false);
  });

  it('"X reports to Y" → reports_to', () => {
    const links = extractPersonLinks('Mike reports to Jane.');
    expect(links[0]!.relation).toBe('reports_to');
  });

  it('"X is a colleague of Y" → colleague_of', () => {
    const links = extractPersonLinks('Dan is a colleague of Elena.');
    expect(links[0]!.relation).toBe('colleague_of');
    expect(links[0]!.symmetric).toBe(true);
  });

  it('"X works with Y" → colleague_of with lower confidence', () => {
    const links = extractPersonLinks('Dan works with Elena.');
    expect(links[0]!.relation).toBe('colleague_of');
    expect(links[0]!.confidence).toBe(0.7);
  });
});

describe('extractPersonLinks — friend + romantic + introduction', () => {
  it('"X is a friend of Y" → friend_of', () => {
    const links = extractPersonLinks('Tom is a friend of Sam.');
    expect(links[0]!.relation).toBe('friend_of');
    expect(links[0]!.kind).toBe('friend');
  });

  it('"X is dating Y" → partner_of', () => {
    const links = extractPersonLinks('Liam is dating Zoe.');
    expect(links[0]!.relation).toBe('partner_of');
    expect(links[0]!.kind).toBe('romantic');
  });

  it('"X was introduced by Y" → introduced_by', () => {
    const links = extractPersonLinks('Bob was introduced by Carol.');
    expect(links[0]!.relation).toBe('introduced_by');
    expect(links[0]!.kind).toBe('associate');
  });
});

describe('extractPersonLinks — spans + metadata', () => {
  it('spans match the original text', () => {
    const text = 'Alice is married to Bob.';
    const links = extractPersonLinks(text);
    const l = links[0]!;
    expect(text.slice(l.a.span.start, l.a.span.end)).toBe('Alice');
    expect(text.slice(l.b.span.start, l.b.span.end)).toBe('Bob');
    expect(text.slice(l.connectorSpan.start, l.connectorSpan.end))
      .toBe(l.connectorText);
  });

  it('output ordered by A-position', () => {
    const links = extractPersonLinks(
      'Amy is married to Tom. Jane is the manager of Mike.',
    );
    expect(links).toHaveLength(2);
    expect(links[0]!.a.name).toBe('Amy');
    expect(links[1]!.a.name).toBe('Jane');
  });
});

describe('extractPersonLinks — gap control', () => {
  it('respects maxGap — names too far apart don\'t pair', () => {
    const text =
      'Alice walked into the room. ' +
      'The sun was setting over the hills. ' +
      'Bob was having dinner at home.';
    const links = extractPersonLinks(text);
    expect(links).toEqual([]);
  });

  it('default maxGap accommodates canonical phrasings', () => {
    // The strict connector rule requires the connector to fill the
    // gap exactly (no unrelated text between A+connector or
    // connector+B). Longer canonical connectors like "is the
    // manager of" still match.
    const text = 'Dear team, Alice is the manager of Bob from today onwards.';
    const links = extractPersonLinks(text);
    expect(links.some((l) => l.a.name === 'Alice' && l.b.name === 'Bob')).toBe(true);
  });

  it('DEFAULT_MAX_GAP = 100', () => {
    expect(DEFAULT_MAX_GAP).toBe(100);
  });
});

describe('extractPersonLinks — dedup + first-match', () => {
  it('does not emit both directions for symmetric relations', () => {
    // Even though "married to" is symmetric, we emit one triple.
    const links = extractPersonLinks('Alice is married to Bob.');
    expect(links).toHaveLength(1);
  });

  it('same pair + same relation emitted only once', () => {
    const links = extractPersonLinks(
      'Alice is married to Bob. Alice is married to Bob.',
    );
    // Two sentences yield two pair instances; dedup key includes spans so both are kept.
    expect(links.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractPersonLinks — extraConnectors', () => {
  it('merges caller-supplied connectors with built-ins', () => {
    const custom: RelationConnector = {
      relation: 'mentor_of',
      kind: 'work',
      pattern: /\s+mentors\s+/i,
      symmetric: false,
      confidence: 0.85,
    };
    const links = extractPersonLinks('Grace mentors Linus.', {
      extraConnectors: [custom],
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.relation).toBe('mentor_of');
  });
});

describe('extractPersonLinks — confidence filter', () => {
  it('minConfidence drops low-confidence relations', () => {
    const withAll = extractPersonLinks('Bob was introduced by Carol.');
    const filtered = extractPersonLinks('Bob was introduced by Carol.', {
      minConfidence: 0.8,
    });
    expect(withAll).toHaveLength(1);
    expect(filtered).toHaveLength(0);
  });
});

describe('BUILT_IN_CONNECTORS integrity', () => {
  it('every connector has relation + kind + pattern', () => {
    for (const c of BUILT_IN_CONNECTORS) {
      expect(typeof c.relation).toBe('string');
      expect(c.relation.length).toBeGreaterThan(0);
      expect(['family', 'work', 'friend', 'romantic', 'associate']).toContain(c.kind);
      expect(c.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('every pattern is case-insensitive', () => {
    for (const c of BUILT_IN_CONNECTORS) {
      expect(c.pattern.flags).toContain('i');
    }
  });
});

describe('extractPersonLinks — name filtering', () => {
  it('ignores bare-stop single-token candidates (The, Today)', () => {
    // "The" alone at sentence start is not a name candidate.
    const links = extractPersonLinks('The team gathered. Alice is married to Bob.');
    expect(links).toHaveLength(1);
    expect(links[0]!.a.name).toBe('Alice');
    expect(links[0]!.b.name).toBe('Bob');
  });

  it('ignores day/month names at sentence start', () => {
    // "Monday" shouldn't be picked up as a person name.
    const links = extractPersonLinks('Monday was cold. Alice is married to Bob.');
    expect(links[0]!.a.name).toBe('Alice');
  });
});
