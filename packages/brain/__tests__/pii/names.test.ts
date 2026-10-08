/**
 * Known names (docs/PII_ARCHITECTURE_V2.md §5): the matching rules and
 * Brain's copy of the list.
 */

import { piiNamesVersion, type PiiNamesResult } from '@dina/core';

import { NameLexicon, NameMatcher, NamesUnavailableError } from '../../src/pii/names';

const found = (m: NameMatcher, text: string) => m.find(text).map((x) => x.value);

describe('NameMatcher', () => {
  it('matches without regard to case, as a whole word only', () => {
    const m = new NameMatcher([{ group: 1, names: ['Emma'] }]);
    expect(found(m, 'emma and EMMA and Emma.')).toEqual(['emma', 'EMMA', 'Emma']);
    expect(found(m, 'Emmanuel and gemma')).toEqual([]);
    expect(found(m, 'Emma2 Emma_x')).toEqual([]);
  });

  it('a name that is also an everyday word matches only with its capital', () => {
    const m = new NameMatcher([
      { group: 1, names: ['May'] },
      { group: 2, names: ['Will'] },
    ]);
    expect(found(m, 'we may go in may; you will see')).toEqual([]);
    expect(found(m, 'May and Will came')).toEqual(['May', 'Will']);
  });

  it('the longer name wins', () => {
    const m = new NameMatcher([
      { group: 1, names: ['Emma', 'Emma Watson'] },
      { group: 2, names: ['Watson'] },
    ]);
    const hits = m.find('Emma Watson met Watson');
    expect(hits.map((h) => [h.value, h.group])).toEqual([
      ['Emma Watson', 1],
      ['Watson', 2],
    ]);
  });

  it('works on letters outside ASCII', () => {
    const m = new NameMatcher([{ group: 1, names: ['José', 'Zoë'] }]);
    expect(found(m, 'josé and Zoë, not Josées')).toEqual(['josé', 'Zoë']);
  });

  it('scripts without case match as plain text', () => {
    const m = new NameMatcher([{ group: 1, names: ['王芳'] }]);
    expect(found(m, '我和王芳去了')).toEqual(['王芳']);
  });

  it('skips names shorter than two letters', () => {
    const m = new NameMatcher([{ group: 1, names: ['J', ' '] }]);
    expect(m.size).toBe(0);
  });
});

/** A fake Core: the list is versioned by content, as Core does it. */
function fakeCore(initial: string[]) {
  const state = { names: initial, calls: 0, fail: false };
  const fetch = async (known?: string): Promise<PiiNamesResult> => {
    state.calls++;
    if (state.fail) throw new TypeError('unreachable');
    const groups = state.names.length > 0 ? [{ group: 1, names: [...state.names] }] : [];
    const version = piiNamesVersion(groups);
    return known === version ? { version, unchanged: true } : { version, groups };
  };
  return { state, fetch };
}

describe('NameLexicon (REAL_LIFE_FIXES §4.3)', () => {
  it('every call checks with Core; an unchanged list is not sent again', async () => {
    const core = fakeCore(['Sancho']);
    const seen: (string | undefined)[] = [];
    const lex = new NameLexicon({
      fetch: async (known) => {
        seen.push(known);
        return core.fetch(known);
      },
    });
    expect((await lex.freshMatcher()).find('Sancho')).toHaveLength(1);
    expect((await lex.freshMatcher()).find('Sancho')).toHaveLength(1);
    expect(core.state.calls).toBe(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual(expect.any(String));
  });

  it('a name written just before a call is hidden on that call', async () => {
    const core = fakeCore(['Sancho']);
    const lex = new NameLexicon({ fetch: core.fetch });
    await lex.freshMatcher();
    // Another client adds a contact; no notice reaches Brain.
    core.state.names = ['Sancho', 'Ottilie'];
    expect((await lex.freshMatcher()).find('Ottilie is allergic')).toHaveLength(1);
  });

  it('fails closed when Core cannot be asked, even with a good copy in hand', async () => {
    const reasons: string[] = [];
    const core = fakeCore(['Sancho']);
    const lex = new NameLexicon({ fetch: core.fetch, onDegraded: (r) => reasons.push(r) });
    await lex.freshMatcher();
    core.state.fail = true;
    await expect(lex.freshMatcher()).rejects.toBeInstanceOf(NamesUnavailableError);
    expect(reasons).toEqual(['TypeError']);
  });

  it('with no list ever loaded, the call is refused, not sent on patterns alone', async () => {
    const core = fakeCore([]);
    core.state.fail = true;
    const lex = new NameLexicon({ fetch: core.fetch });
    await expect(lex.freshMatcher()).rejects.toBeInstanceOf(NamesUnavailableError);
    expect(lex.loaded).toBe(false);
  });

  it('a slow older answer never replaces a newer list', async () => {
    let release: () => void = () => undefined;
    const knowns: (string | undefined)[] = [];
    const newer = [{ group: 1, names: ['Sancho', 'Albert'] }];
    const lex = new NameLexicon({
      fetch: async (known) => {
        knowns.push(known);
        if (knowns.length === 1) {
          await new Promise<void>((r) => (release = r));
          const groups = [{ group: 1, names: ['Sancho'] }];
          return { version: piiNamesVersion(groups), groups };
        }
        return { version: piiNamesVersion(newer), groups: newer };
      },
    });
    const first = lex.freshMatcher();
    expect((await lex.freshMatcher()).find('Albert')).toHaveLength(1);
    release();
    // The first call answers with the list its own fetch carried...
    expect((await first).find('Albert')).toHaveLength(0);
    // ...but the copy kept for later is the newer one.
    await lex.freshMatcher();
    expect(knowns[2]).toBe(piiNamesVersion(newer));
  });
});

describe('dual review round 1', () => {
  it('F5: a character whose lower case is longer (Turkish İ) does not stop matching elsewhere', () => {
    const m = new NameMatcher([{ group: 1, names: ['Emma', 'İpek'] }]);
    expect(found(m, 'İstanbul: emma said hi')).toEqual(['emma']);
    // İ lowers to i + a combining dot, so "İpek" matches "İPEK" but never a
    // plain "ipek": a Turkish-locale limit, kept local to that one name.
    expect(found(m, 'İPEK and ipek')).toEqual(['İPEK']);
  });

  it('R2-3: Greek final sigma matches in any case', () => {
    const m = new NameMatcher([{ group: 1, names: ['Νίκος'] }]);
    expect(found(m, 'Ο ΝΊΚΟΣ ήρθε, ο νίκος επίσης')).toEqual(['ΝΊΚΟΣ', 'νίκος']);
  });

  it('F6: an everyday-word name stored in lower case still needs a capital in the text', () => {
    const m = new NameMatcher([
      { group: 1, names: ['will'] },
      { group: 2, names: ['ray'] },
    ]);
    expect(found(m, 'Will called, Ray too')).toEqual(['Will', 'Ray']);
    expect(found(m, 'you will see a ray of light')).toEqual([]);
    expect(found(m, 'WILL IS HERE')).toEqual(['WILL']);
  });
});
