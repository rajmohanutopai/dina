/**
 * Unit tests for the /remember agent loop's per-item tools. Each
 * tool records into a fresh `RememberSideEffects` collector; the
 * drain (covered separately) reads it back to apply side effects
 * transactionally.
 */

import {
  createBindPreferenceTool,
  createLinkToPersonTool,
  createRouteToPersonaTool,
  emptyRememberSideEffects,
  type RememberSideEffects,
} from '../../src/reasoning/remember_tools';

function fresh(): RememberSideEffects {
  return emptyRememberSideEffects();
}

describe('route_to_persona', () => {
  it('records the primary persona lowercased', async () => {
    const collect = fresh();
    const tool = createRouteToPersonaTool({ collect });
    const out = await tool.execute({ persona: 'Finance' });
    expect(out).toMatchObject({ ok: true, routed_to: 'Finance' });
    expect(collect.routes).toEqual([{ primary: 'finance', secondary: [] }]);
  });

  it('records secondary personas when provided', async () => {
    const collect = fresh();
    const tool = createRouteToPersonaTool({ collect });
    await tool.execute({ persona: 'health', secondary: ['finance'] });
    expect(collect.routes).toEqual([{ primary: 'health', secondary: ['finance'] }]);
  });

  it('rejects empty persona', async () => {
    const collect = fresh();
    const tool = createRouteToPersonaTool({ collect });
    const out = await tool.execute({ persona: '   ' });
    expect(out).toEqual({ error: 'persona is required' });
    expect(collect.routes).toHaveLength(0);
  });

  it('filters non-string entries from secondary', async () => {
    const collect = fresh();
    const tool = createRouteToPersonaTool({ collect });
    await tool.execute({ persona: 'general', secondary: ['work', 5, '', null] });
    expect(collect.routes[0]?.secondary).toEqual(['work']);
  });
});

describe('route_to_persona against the live persona list (REAL_LIFE_FIXES §2.1)', () => {
  it('refuses a name that is not installed and lists the installed ones', async () => {
    const collect = emptyRememberSideEffects();
    const tool = createRouteToPersonaTool({
      collect,
      installedPersonas: () => ['general', 'work', 'garden'],
    });
    const out = (await tool.execute({ persona: 'professional' })) as { error?: string };
    expect(out.error).toContain("'professional'");
    expect(out.error).toContain('general, work, garden');
    expect(collect.routes).toEqual([]);
  });

  it('checks secondary targets too', async () => {
    const collect = emptyRememberSideEffects();
    const tool = createRouteToPersonaTool({ collect, installedPersonas: () => ['general', 'health'] });
    const out = (await tool.execute({ persona: 'health', secondary: ['money'] })) as { error?: string };
    expect(out.error).toContain("'money'");
    expect(collect.routes).toEqual([]);
  });

  it('accepts installed names in any case', async () => {
    const collect = emptyRememberSideEffects();
    const tool = createRouteToPersonaTool({ collect, installedPersonas: () => ['general', 'garden'] });
    expect(await tool.execute({ persona: 'Garden' })).toMatchObject({ ok: true });
    expect(collect.routes).toEqual([{ primary: 'garden', secondary: [] }]);
  });

  it('skips the check while the list is empty (Core parks unknown names)', async () => {
    const collect = emptyRememberSideEffects();
    const tool = createRouteToPersonaTool({ collect, installedPersonas: () => [] });
    expect(await tool.execute({ persona: 'anything' })).toMatchObject({ ok: true });
  });
});

describe('link_to_person', () => {
  it('records person mention with all fields', async () => {
    const collect = fresh();
    const tool = createLinkToPersonTool({ collect });
    await tool.execute({
      canonicalName: 'Emma',
      surface: 'my daughter',
      surfaceType: 'role_phrase',
      relationshipHint: 'daughter',
      sourceExcerpt: 'Emma is my daughter',
    });
    expect(collect.people).toEqual([
      {
        canonicalName: 'Emma',
        surface: 'my daughter',
        surfaceType: 'role_phrase',
        relationshipHint: 'daughter',
        sourceExcerpt: 'Emma is my daughter',
      },
    ]);
  });

  it("defaults surfaceType to 'name' when the input is invalid", async () => {
    const collect = fresh();
    const tool = createLinkToPersonTool({ collect });
    await tool.execute({ canonicalName: 'Emma', surface: 'Emma', surfaceType: 'garbage' });
    expect(collect.people[0]?.surfaceType).toBe('name');
  });

  it('rejects missing canonicalName or surface', async () => {
    const collect = fresh();
    const tool = createLinkToPersonTool({ collect });
    expect(await tool.execute({ canonicalName: '', surface: 'Emma' })).toMatchObject({
      error: expect.any(String),
    });
    expect(collect.people).toHaveLength(0);
  });
});

describe('bind_preference', () => {
  it('records person preference', async () => {
    const collect = fresh();
    const tool = createBindPreferenceTool({ collect });
    await tool.execute({
      subjectKind: 'person',
      subject: 'Emma',
      preference: 'loves dinosaurs',
      sourceExcerpt: 'Emma loves dinosaurs',
    });
    expect(collect.preferences).toEqual([
      {
        subjectKind: 'person',
        subject: 'Emma',
        preference: 'loves dinosaurs',
        sourceExcerpt: 'Emma loves dinosaurs',
      },
    ]);
  });

  it('allows empty subject for self', async () => {
    const collect = fresh();
    const tool = createBindPreferenceTool({ collect });
    await tool.execute({
      subjectKind: 'self',
      subject: '',
      preference: 'dentist on Tuesdays',
    });
    expect(collect.preferences[0]?.subjectKind).toBe('self');
  });

  it('requires subject for person / category', async () => {
    const collect = fresh();
    const tool = createBindPreferenceTool({ collect });
    expect(
      await tool.execute({ subjectKind: 'person', subject: '', preference: 'x' }),
    ).toMatchObject({ error: expect.any(String) });
  });

  it('rejects invalid subjectKind', async () => {
    const collect = fresh();
    const tool = createBindPreferenceTool({ collect });
    expect(
      await tool.execute({ subjectKind: 'bogus', subject: 'Emma', preference: 'x' }),
    ).toMatchObject({ error: expect.any(String) });
  });
});
