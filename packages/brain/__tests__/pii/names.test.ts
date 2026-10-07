/**
 * Known names (docs/PII_ARCHITECTURE_V2.md §5): the matching rules and
 * Brain's copy of the list.
 */

import { NameLexicon, NameMatcher } from '../../src/pii/names';

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

describe('NameLexicon', () => {
  const groups = [{ group: 1, names: ['Sancho'] }];

  it('the first call waits for a copy; later calls use it', async () => {
    let calls = 0;
    const lex = new NameLexicon({
      fetch: async () => {
        calls++;
        return groups;
      },
    });
    expect((await lex.current()).find('Sancho')).toHaveLength(1);
    await lex.current();
    expect(calls).toBe(1);
  });

  it('an old copy is refreshed in the background while the current one is used', async () => {
    let now = 0;
    let names = ['Sancho'];
    const lex = new NameLexicon({
      fetch: async () => [{ group: 1, names }],
      nowMs: () => now,
      refreshAfterMs: 1000,
    });
    await lex.current();
    names = ['Albert'];
    now = 2000;
    // This call still sees the old copy; the refresh lands after.
    expect((await lex.current()).find('Sancho')).toHaveLength(1);
    await new Promise((r) => setImmediate(r));
    expect((await lex.current()).find('Albert')).toHaveLength(1);
  });

  it('when Core does not answer, the last good copy stays', async () => {
    let fail = false;
    let now = 0;
    const lex = new NameLexicon({
      fetch: async () => {
        if (fail) throw new Error('down');
        return groups;
      },
      nowMs: () => now,
      refreshAfterMs: 1000,
    });
    await lex.current();
    fail = true;
    now = 5000;
    await lex.current();
    await new Promise((r) => setImmediate(r));
    expect((await lex.current()).find('Sancho')).toHaveLength(1);
  });

  it('with no copy at all the call goes ahead empty, and the degradation is reported without names', async () => {
    const reasons: string[] = [];
    const lex = new NameLexicon({
      fetch: async () => {
        throw new TypeError('unreachable');
      },
      onDegraded: (r) => reasons.push(r),
    });
    expect((await lex.current()).size).toBe(0);
    expect(lex.loaded).toBe(false);
    expect(reasons).toEqual(['TypeError']);
  });

  it('the first call waits no longer than its limit', async () => {
    const lex = new NameLexicon({
      fetch: () => new Promise(() => undefined),
      firstWaitMs: 20,
    });
    const started = Date.now();
    expect((await lex.current()).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('invalidate fetches a new copy at once', async () => {
    let names = ['Sancho'];
    const lex = new NameLexicon({ fetch: async () => [{ group: 1, names }] });
    await lex.current();
    names = ['Albert'];
    lex.invalidate();
    await new Promise((r) => setImmediate(r));
    expect(lex.peek().find('Albert')).toHaveLength(1);
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

  it('F9: an invalidate during a fetch fetches again once it settles', async () => {
    let names = ['Sancho'];
    let release: () => void = () => undefined;
    let calls = 0;
    const lex = new NameLexicon({
      fetch: async () => {
        calls++;
        const snapshot = names;
        if (calls === 2) await new Promise<void>((r) => (release = r));
        return [{ group: 1, names: snapshot }];
      },
    });
    await lex.current();
    lex.invalidate(); // fetch 2 starts with the old list and stalls
    names = ['Albert']; // the people graph changes during it
    lex.invalidate();
    release();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(calls).toBe(3);
    expect(lex.peek().find('Albert')).toHaveLength(1);
  });
});
