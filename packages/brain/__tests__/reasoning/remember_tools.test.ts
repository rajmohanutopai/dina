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
