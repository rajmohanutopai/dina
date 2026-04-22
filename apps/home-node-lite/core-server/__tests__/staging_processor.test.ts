/**
 * staging_processor tests (GAP.md #22 closure).
 */

import {
  DEFAULT_MAX_TOPICS,
  DEFAULT_MIN_TOPIC_SALIENCE,
  processStagingInput,
  type StagingInput,
} from '../src/brain/staging_processor';

function baseInput(overrides: Partial<StagingInput> = {}): StagingInput {
  return {
    taskId: 't-1',
    text: 'The quarterly planning meeting is on Tuesday.',
    source: 'email',
    receivedAt: 1_700_000_000,
    proposedPersona: 'work',
    ...overrides,
  };
}

describe('processStagingInput — input validation', () => {
  it.each([
    ['null input', null],
    ['non-object input', 'bogus' as unknown as StagingInput],
    ['empty taskId', baseInput({ taskId: '' })],
    ['non-string text', baseInput({ text: 42 as unknown as string })],
    ['unknown source', baseInput({ source: 'bogus' as unknown as StagingInput['source'] })],
    ['empty persona', baseInput({ proposedPersona: '' })],
    ['non-finite receivedAt', baseInput({ receivedAt: Number.NaN })],
  ] as const)('%s → reject with reject_invalid_input', (_label, bad) => {
    const d = processStagingInput(bad as StagingInput);
    expect(d.disposition).toBe('reject');
    expect(d.reason).toBe('reject_invalid_input');
  });

  it('empty text → reject_empty_text', () => {
    const d = processStagingInput(baseInput({ text: '   ' }));
    expect(d.disposition).toBe('reject');
    expect(d.reason).toBe('reject_empty_text');
  });
});

describe('processStagingInput — decision rules', () => {
  it('local_only content → reject_local_only', () => {
    const d = processStagingInput(
      baseInput({ text: 'API key: sk-ant-abc123def456ghi7890jklmn' }),
    );
    expect(d.disposition).toBe('reject');
    expect(d.reason).toBe('reject_local_only');
    expect(d.enrichment.tier).toBe('local_only');
    expect(d.enrichment.targetPersona).toBeNull();
  });

  it('general content + default-tier persona → accept', () => {
    const d = processStagingInput(
      baseInput({ text: 'Picnic on Saturday at the park.' }),
    );
    expect(d.disposition).toBe('accept');
    expect(d.reason).toBe('accept_default_persona_fit');
    expect(d.enrichment.tier).toBe('general');
    expect(d.enrichment.targetPersona).toBe('work');
  });

  it('elevated content into default-tier persona → review', () => {
    const d = processStagingInput(
      baseInput({
        text: 'I was diagnosed with depression and prescribed fluoxetine.',
        proposedPersona: 'general',
      }),
    );
    expect(d.disposition).toBe('review');
    expect(d.reason).toBe('review_tier_exceeds_persona');
  });

  it('sensitive content into a persona that allows sensitive → accept', () => {
    const d = processStagingInput(
      baseInput({
        text: 'I was diagnosed with depression and prescribed fluoxetine.',
        proposedPersona: 'health',
      }),
      { personaAllowedTiers: { health: 'sensitive' } },
    );
    expect(d.disposition).toBe('accept');
    expect(d.reason).toBe('accept_tier_matches_persona');
    expect(d.enrichment.tier).toBe('sensitive');
  });

  it('subject attributed to unknown contact → review_unknown_contact', () => {
    const d = processStagingInput(
      baseInput({
        text: 'Zoe Reynolds sent the proposal. Zoe Reynolds is the manager of the project.',
        contacts: [{ id: 'c-zoe', fullName: 'Zoe Reynolds' }],
      }),
      { knownContactIds: ['c-alice'] }, // zoe's id not in known list
    );
    expect(d.disposition).toBe('review');
    expect(d.reason).toBe('review_unknown_contact');
  });

  it('subject attributed to known contact → accept', () => {
    const d = processStagingInput(
      baseInput({
        text: 'Alice Smith sent the monthly report. Alice Smith reviewed the numbers.',
        contacts: [{ id: 'c-alice', fullName: 'Alice Smith' }],
      }),
      { knownContactIds: ['c-alice'] },
    );
    expect(d.disposition).toBe('accept');
  });

  it('knownContactIds empty → unknown-contact rule does not fire', () => {
    // Without a known-contact list the caller is opting out of that check;
    // subject attribution doesn't force review.
    const d = processStagingInput(
      baseInput({
        text: 'Carol Green reported the issue. Carol Green is waiting for a reply.',
        contacts: [{ id: 'c-carol', fullName: 'Carol Green' }],
      }),
    );
    expect(d.disposition).toBe('accept');
  });
});

describe('processStagingInput — enrichment', () => {
  it('topics are extracted + capped at maxTopics', () => {
    const d = processStagingInput(
      baseInput({
        text: 'meeting meeting meeting meeting meeting review review review planning planning test test',
      }),
      { maxTopics: 2 },
    );
    expect(d.enrichment.topics.length).toBeLessThanOrEqual(2);
    expect(d.enrichment.topics[0]!.label).toBe('meeting');
  });

  it('topics respect minTopicSalience', () => {
    const d = processStagingInput(
      baseInput({
        text: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
      }),
      { minTopicSalience: 0.2 },
    );
    for (const t of d.enrichment.topics) {
      expect(t.salience).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('signals are detected + populated', () => {
    const d = processStagingInput(
      baseInput({
        text: "I was diagnosed with anxiety. Account 4111111111111111 was charged.",
      }),
    );
    const types = new Set(d.enrichment.signals.map((s) => s.type));
    expect(types.has('health')).toBe(true);
    expect(types.has('financial')).toBe(true);
  });

  it('subject attribution reflects contacts', () => {
    const d = processStagingInput(
      baseInput({
        text: 'I have a meeting with Alice Smith about the project.',
        contacts: [{ id: 'c-alice', fullName: 'Alice Smith' }],
      }),
    );
    // "I" and "Alice Smith" — self vs contact; score 1 vs 2, margin 2/1 >= 1.5 → contact wins.
    if (d.enrichment.subject.kind === 'contact') {
      expect(d.enrichment.subject.contactId).toBe('c-alice');
    } else {
      expect(d.enrichment.subject.kind).toBe('contact');
    }
  });

  it('targetPersona echoed on accept + review dispositions', () => {
    const accept = processStagingInput(baseInput({ text: 'Lunch plans.' }));
    expect(accept.enrichment.targetPersona).toBe('work');

    const review = processStagingInput(
      baseInput({
        text: 'I was diagnosed with depression.',
        proposedPersona: 'general',
      }),
    );
    expect(review.enrichment.targetPersona).toBe('general');
  });

  it('targetPersona cleared on reject_local_only', () => {
    const d = processStagingInput(
      baseInput({
        text: '-----BEGIN RSA PRIVATE KEY-----\nxyz',
      }),
    );
    expect(d.enrichment.targetPersona).toBeNull();
  });
});

describe('processStagingInput — determinism', () => {
  it('same input → same decision', () => {
    const input = baseInput({
      text: 'Alice Smith sent the status report. We discussed the plan.',
      contacts: [{ id: 'c-alice', fullName: 'Alice Smith' }],
    });
    const a = processStagingInput(input);
    const b = processStagingInput(input);
    expect(a).toEqual(b);
  });
});

describe('processStagingInput — metadata echo', () => {
  it('echoes taskId + receivedAt in the decision', () => {
    const d = processStagingInput(
      baseInput({ taskId: 'task-99', receivedAt: 1_800_000_000 }),
    );
    expect(d.taskId).toBe('task-99');
    expect(d.receivedAt).toBe(1_800_000_000);
  });
});

describe('constants', () => {
  it('DEFAULT_MIN_TOPIC_SALIENCE is 0.1', () => {
    expect(DEFAULT_MIN_TOPIC_SALIENCE).toBe(0.1);
  });
  it('DEFAULT_MAX_TOPICS is 5', () => {
    expect(DEFAULT_MAX_TOPICS).toBe(5);
  });
});
