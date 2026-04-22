/**
 * topic_extractor tests (GAP.md #27 closure).
 */

import {
  DEFAULT_MAX_TOPICS,
  DEFAULT_MIN_WORD_LENGTH,
  STOP_WORDS,
  extractTopics,
} from '../src/brain/topic_extractor';

describe('extractTopics — input handling', () => {
  it('empty string → []', () => {
    expect(extractTopics('')).toEqual([]);
  });

  it('whitespace-only → []', () => {
    expect(extractTopics('   \n\t  ')).toEqual([]);
  });

  it('non-string → []', () => {
    expect(extractTopics(null as unknown as string)).toEqual([]);
    expect(extractTopics(42 as unknown as string)).toEqual([]);
  });
});

describe('extractTopics — single-word extraction', () => {
  it('collects meaningful words with occurrence counts', () => {
    const topics = extractTopics('meeting meeting project deadline');
    const meeting = topics.find((t) => t.label === 'meeting');
    expect(meeting).toBeDefined();
    expect(meeting!.occurrences).toBe(2);
    expect(meeting!.kind).toBe('word');
    const project = topics.find((t) => t.label === 'project');
    expect(project?.occurrences).toBe(1);
  });

  it('filters stop-words', () => {
    const topics = extractTopics('the quick brown fox jumps over the lazy dog');
    const labels = topics.map((t) => t.label);
    // articles / prepositions filtered
    expect(labels).not.toContain('the');
    expect(labels).not.toContain('over');
    // content words survive
    expect(labels).toContain('quick');
    expect(labels).toContain('brown');
  });

  it('stems simple plurals', () => {
    const topics = extractTopics('meetings meeting meeting meetings');
    const meeting = topics.find((t) => t.label === 'meeting');
    expect(meeting).toBeDefined();
    expect(meeting!.occurrences).toBe(4);
  });

  it('stems -ies to -y', () => {
    const topics = extractTopics('strategies strategy strategies');
    const s = topics.find((t) => t.label === 'strategy');
    expect(s).toBeDefined();
    expect(s!.occurrences).toBe(3);
  });

  it('leaves double-s words alone', () => {
    const topics = extractTopics('business business business');
    const b = topics.find((t) => t.label === 'business');
    expect(b).toBeDefined();
    expect(b!.occurrences).toBe(3);
  });

  it('strips trailing possessive ’s', () => {
    const topics = extractTopics("Alice's project and Alice's deadline");
    const alice = topics.find((t) => t.label === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.occurrences).toBeGreaterThanOrEqual(2);
  });

  it('respects minLength option', () => {
    const topics = extractTopics('the of it is a pie', { minLength: 4 });
    expect(topics.map((t) => t.label)).not.toContain('pie');
  });

  it('respects minOccurrences option', () => {
    const topics = extractTopics('apple banana cherry apple', {
      minOccurrences: 2,
    });
    expect(topics.map((t) => t.label)).toEqual(['apple']);
  });

  it('respects extraStopWords', () => {
    const topics = extractTopics('custom-word should-skip noise', {
      extraStopWords: ['noise'],
    });
    expect(topics.map((t) => t.label)).not.toContain('noise');
  });
});

describe('extractTopics — multi-word phrases', () => {
  it('captures double-quoted multi-word phrases verbatim', () => {
    const topics = extractTopics('Discussed "Q4 planning review" extensively');
    const phrase = topics.find((t) => t.label === 'Q4 planning review');
    expect(phrase).toBeDefined();
    expect(phrase!.kind).toBe('phrase');
  });

  it('captures smart-quoted phrases', () => {
    const topics = extractTopics('read “The Dina manifesto” yesterday');
    expect(topics.some((t) => t.label === 'The Dina manifesto')).toBe(true);
  });

  it('single-word quoted content does NOT become a phrase', () => {
    const topics = extractTopics('the word "hello" was typed');
    expect(topics.some((t) => t.label === 'hello' && t.kind === 'phrase')).toBe(false);
  });

  it('captures capitalised noun phrases (2+ tokens)', () => {
    const topics = extractTopics('Met with Sam Altman yesterday at Open AI');
    expect(topics.some((t) => t.label === 'Sam Altman' && t.kind === 'phrase')).toBe(true);
    expect(topics.some((t) => t.label === 'Open AI' && t.kind === 'phrase')).toBe(true);
  });

  it('phrases outweigh single words at equal count (kind bonus)', () => {
    const topics = extractTopics(
      'Project Atlas launch. Project Atlas stakeholders met. budget budget budget.',
    );
    const phrase = topics.find((t) => t.label === 'Project Atlas');
    const word = topics.find((t) => t.label === 'budget');
    expect(phrase).toBeDefined();
    expect(word).toBeDefined();
    // "Project Atlas" gets the 1.5× phrase bonus vs "budget" word.
    expect(phrase!.salience).toBeGreaterThanOrEqual(word!.salience * 0.9);
  });
});

describe('extractTopics — spans', () => {
  it('word spans cover the exact matched range', () => {
    const text = 'the important meeting tomorrow';
    const topics = extractTopics(text);
    const meeting = topics.find((t) => t.label === 'meeting');
    expect(meeting!.spans).toHaveLength(1);
    const { start, end } = meeting!.spans[0]!;
    expect(text.slice(start, end)).toBe('meeting');
  });

  it('repeated words accumulate spans', () => {
    const topics = extractTopics('alpha alpha alpha');
    const alpha = topics.find((t) => t.label === 'alpha');
    expect(alpha!.spans).toHaveLength(3);
  });
});

describe('extractTopics — ordering + cap', () => {
  it('sorted by salience desc, deterministic', () => {
    const text = 'apple apple apple banana banana cherry';
    const a = extractTopics(text);
    const b = extractTopics(text);
    expect(a).toEqual(b);
    expect(a[0]!.label).toBe('apple');
    expect(a[1]!.label).toBe('banana');
    expect(a[2]!.label).toBe('cherry');
  });

  it('stable tiebreak alphabetically on equal salience', () => {
    const topics = extractTopics('zzz aaa mmm');
    expect(topics.map((t) => t.label)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('respects maxTopics cap', () => {
    // Use a fixed pool of letter-only distinct tokens so each is
    // preserved by the word tokenizer (which skips digits).
    const words = [
      'alpha', 'bravo', 'charlie', 'delta', 'echo',
      'foxtrot', 'golf', 'hotel', 'india', 'juliet',
      'kilo', 'lima', 'mike', 'november', 'oscar',
      'papa', 'quebec', 'romeo', 'sierra', 'tango',
    ];
    const topics = extractTopics(words.join(' '), { maxTopics: 5 });
    expect(topics).toHaveLength(5);
  });

  it('defaults to DEFAULT_MAX_TOPICS when not set', () => {
    const words = Array.from({ length: 25 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)).repeat(5 + i),
    );
    const topics = extractTopics(words.join(' '));
    expect(topics.length).toBeLessThanOrEqual(DEFAULT_MAX_TOPICS);
  });
});

describe('extractTopics — salience shape', () => {
  it('salience always in [0, 1]', () => {
    const topics = extractTopics(
      'urgent urgent urgent meeting review review planning',
    );
    for (const t of topics) {
      expect(t.salience).toBeGreaterThanOrEqual(0);
      expect(t.salience).toBeLessThanOrEqual(1);
    }
  });

  it('dominant topic gets highest salience', () => {
    const topics = extractTopics('signal signal signal signal noise');
    expect(topics[0]!.label).toBe('signal');
  });
});

describe('STOP_WORDS contract', () => {
  it.each(['the', 'and', 'of', 'is', 'i', 'my'])(
    '%s is a stop word',
    (word) => {
      expect(STOP_WORDS.has(word)).toBe(true);
    },
  );

  it.each(['meeting', 'project', 'code', 'data'])(
    '%s is NOT a stop word',
    (word) => {
      expect(STOP_WORDS.has(word)).toBe(false);
    },
  );
});

describe('constants', () => {
  it('DEFAULT_MAX_TOPICS = 10', () => {
    expect(DEFAULT_MAX_TOPICS).toBe(10);
  });
  it('DEFAULT_MIN_WORD_LENGTH = 3', () => {
    expect(DEFAULT_MIN_WORD_LENGTH).toBe(3);
  });
});
